const path = require("node:path");
const { createFeedParser, getContent, extractLocation, backfillTypesense, ensureTypesenseCollection } = require("../rss-builder/rss_builder");
const { readDatabaseConfig, createDatabasePool } = require("../services/db");

async function contentFromStoredRow(row, parser = createFeedParser()) {
    if (!row.item_xml) return getContent(row, { source: row.source });
    const isAtom = /^\s*<entry(?:\s|>)/i.test(row.item_xml);
    // Item fragments inherit these common namespaces from their original feed.
    const namespaces = `xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:media="http://search.yahoo.com/mrss/"
        xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
        xmlns:atom="http://www.w3.org/2005/Atom"`;
    const xml = isAtom
        ? `<feed xmlns="http://www.w3.org/2005/Atom" ${namespaces}>${row.item_xml}</feed>`
        : `<rss version="2.0" ${namespaces}><channel>${row.item_xml}</channel></rss>`;
    const parsed = await parser.parseString(xml);
    if (parsed.items.length !== 1) throw new Error("Expected exactly one saved feed item.");
    return getContent(parsed.items[0], { source: row.source });
}

async function repairContent(database, { apply = false, batchSize = 200 } = {}) {
    const parser = createFeedParser();
    const stats = { scanned: 0, changed: 0, updated: 0, unavailable: 0, skipped: 0, concurrent: 0, sources: {} };
    let afterID = "0";

    while (true) {
        const { rows } = await database.query(`
            SELECT id, title, content, source, item_xml
            FROM entries WHERE id > $1 ORDER BY id LIMIT $2
        `, [afterID, batchSize]);
        if (!rows.length) break;
        const changes = [];
        for (const row of rows) {
            stats.scanned++;
            try {
                const content = await contentFromStoredRow(row, parser);
                if (content === row.content) continue;
                stats.changed++;
                stats.sources[row.source] = (stats.sources[row.source] || 0) + 1;
                if (!content) stats.unavailable++;
                changes.push({ row, content });
            } catch (error) {
                stats.skipped++;
                console.error(`Skipped entry ${row.id}: ${error.message}`);
            }
        }

        if (apply && changes.length) {
            const client = await database.connect();
            try {
                await client.query("BEGIN");
                for (const { row, content } of changes) {
                    const geo = extractLocation(row.title, content);
                    const result = await client.query(`
                        UPDATE entries SET content = $1,
                            location_name = $2, location_level = $3, location_country = $4,
                            location_lat = $5, location_lng = $6, country_lat = $7,
                            country_lng = $8, has_location = $9
                        WHERE id = $10 AND content IS NOT DISTINCT FROM $11
                            AND item_xml IS NOT DISTINCT FROM $12
                    `, [content, geo.location_name, geo.location_level, geo.location_country,
                        geo.lat, geo.lng, geo.country_lat, geo.country_lng, geo.has_location,
                        row.id, row.content, row.item_xml]);
                    stats.updated += result.rowCount;
                    stats.concurrent += 1 - result.rowCount;
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }
        afterID = rows.at(-1).id;
    }
    return stats;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
        throw new Error("Usage: npm run rss:repair-content -- [--dry-run | --apply]");
    }
    require("dotenv").config({ path: [path.join(__dirname, "../.env.local"), path.join(__dirname, "../.env")], quiet: true });
    const config = readDatabaseConfig();
    if (!config) throw new Error("PostgreSQL is not configured.");
    const database = createDatabasePool(config);
    const apply = args.includes("--apply");
    try {
        const stats = await repairContent(database, { apply });
        console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...stats }, null, 2));
        // Also retry indexing when a previous run repaired PostgreSQL but could
        // not reach Typesense, even if this run has no further content changes.
        if (apply && process.env.TYPESENSE_API_KEY) {
            const search = {
                typesenseURL: (process.env.TYPESENSE_URL || "http://localhost:8108").replace(/\/+$/, ""),
                typesenseAPIKey: process.env.TYPESENSE_API_KEY,
                typesenseCollection: process.env.TYPESENSE_COLLECTION || "timeline_entries"
            };
            await ensureTypesenseCollection(search);
            await backfillTypesense(database, search);
        }
    } finally {
        await database.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Content repair failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { contentFromStoredRow, repairContent };
