const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { Pool } = require("pg");
const geoHints = require("./geo-hints.json");

const SKIP_PATTERNS = {
    "New York Times": ["here is the latest", "here's the latest", "this is what happened on "],
    "ABC News": ["live updates:", "live: ", "watch: "],
    "BBC News": ["watch: "]
};

const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; RSSReader/1.0; +https://github.com)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
};

const GEO_PATTERNS = [...geoHints]
    .sort((first, second) => second.alias.length - first.alias.length)
    .map((geo) => ({
        // Unicode word boundaries match the Python implementation's behavior.
        pattern: new RegExp(
            `(?<![\\p{L}\\p{N}_])${RegExp.escape(geo.alias)}(?![\\p{L}\\p{N}_])`,
            "iu"
        ),
        geo
    }));

function readPositiveInteger(value, fallback, name) {
    const number = Number(value ?? fallback);

    if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`${name} must be a positive integer.`);
    }

    return number;
}

function readConfig(env = process.env) {
    if (env.RSS_ENABLED && !["true", "false"].includes(env.RSS_ENABLED)) {
        throw new Error("RSS_ENABLED must be true or false.");
    }

    const enabled = env.RSS_ENABLED === undefined
        ? Boolean(env.DATABASE_URL && env.TYPESENSE_API_KEY)
        : env.RSS_ENABLED === "true";

    if (!enabled) return null;
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for RSS.");
    if (!env.TYPESENSE_API_KEY) throw new Error("TYPESENSE_API_KEY is required for RSS.");

    return {
        databaseURL: env.DATABASE_URL,
        typesenseURL: (env.TYPESENSE_URL || "http://localhost:8108").replace(/\/+$/, ""),
        typesenseAPIKey: env.TYPESENSE_API_KEY,
        typesenseCollection: env.TYPESENSE_COLLECTION || "timeline_entries",
        feedsFile: env.FEEDS_FILE || path.join(__dirname, "feeds.json"),
        pollSeconds: readPositiveInteger(env.RSS_POLL_SECONDS, 600, "RSS_POLL_SECONDS"),
        maxWorkers: readPositiveInteger(env.RSS_MAX_WORKERS, 10, "RSS_MAX_WORKERS")
    };
}

function parseDate(entry) {
    for (const value of [entry.pubDate, entry.published, entry.updated, entry.isoDate]) {
        if (!value) continue;
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
            // feedparser timestamps have whole-second precision.
            return new Date(Math.floor(date.getTime() / 1000) * 1000);
        }
    }

    return null;
}

function inCurrentYearWindow(date, now = new Date()) {
    if (!date) return false;
    const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
    return date.getTime() >= yearStart && date <= now;
}

function getContent(entry) {
    return entry.summary || entry.content || entry.description || entry["content:encoded"] || "";
}

function shouldSkip(source, title, content) {
    if (title.includes("Opinion | ")) return true;
    if (source === "CNET" && (title.includes("Today's ") || content.includes("Today's "))) {
        return true;
    }

    const combined = `${title} ${content}`.toLowerCase();
    return (SKIP_PATTERNS[source] || []).some((pattern) => combined.includes(pattern));
}

function extractLocation(title, content) {
    const blob = `${title || ""} ${content || ""}`;
    const match = GEO_PATTERNS.find(({ pattern }) => pattern.test(blob));
    const geo = match?.geo;

    return {
        location_name: geo?.name ?? null,
        location_level: geo?.level ?? null,
        location_country: geo?.country ?? null,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        country_lat: geo?.country_lat ?? null,
        country_lng: geo?.country_lng ?? null,
        has_location: Boolean(geo)
    };
}

function storyID(source, link, title, date) {
    const raw = `${source}|${link || ""}|${title || ""}|${Math.trunc(date.getTime() / 1000)}`;
    return crypto.createHash("sha1").update(raw, "utf8").digest("hex");
}

function buildDoc(story) {
    return {
        ...story,
        title: story.title || "",
        content: story.content || "",
        source: story.source || "",
        link: story.link || "",
        publication_date: Math.trunc(story.publication_date.getTime() / 1000),
        publication_date_iso: story.publication_date.toISOString().replace(".000Z", "+00:00"),
        has_location: Boolean(story.has_location)
    };
}

async function loadFeeds(feedsFile) {
    const data = JSON.parse(await fs.readFile(feedsFile, "utf8"));
    const feeds = data.feeds || [];
    if (!Array.isArray(feeds)) throw new Error("The feeds file must contain a feeds array.");
    return feeds;
}

async function fetchSingleFeed(feed, { signal, now = new Date() } = {}) {
    const name = feed.name || "Unknown";
    if (!feed.url) return { name, entries: [], error: "No URL provided" };

    try {
        const requestSignal = AbortSignal.timeout(20000);
        const response = await fetch(feed.url, {
            headers: REQUEST_HEADERS,
            signal: signal ? AbortSignal.any([signal, requestSignal]) : requestSignal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const Parser = require("rss-parser");
        const parser = new Parser({ customFields: { item: ["published", "updated"] } });
        const parsed = await parser.parseString(await response.text());
        const entries = [];

        for (const entry of parsed.items) {
            let title = (entry.title || "").trim();
            const content = getContent(entry).trim();
            if (shouldSkip(name, title, content)) continue;

            if (name === "Reuters" && title.endsWith(" - Reuters")) {
                title = title.slice(0, -10).trim();
            }

            const date = parseDate(entry);
            if (!inCurrentYearWindow(date, now)) continue;

            const link = (entry.link || "").trim() || null;
            entries.push({
                id: storyID(name, link, title, date),
                title,
                content,
                source: name,
                publication_date: date,
                link,
                ...extractLocation(title, content)
            });
        }

        return { name, entries, error: null };
    } catch (error) {
        if (signal?.aborted) throw error;
        return { name, entries: [], error: error.message };
    }
}

// Limit concurrent requests without creating one worker process per feed.
async function fetchFeeds(feeds, maxWorkers, options = {}) {
    const results = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < feeds.length) {
            options.signal?.throwIfAborted();
            const feed = feeds[nextIndex++];
            results.push(await fetchSingleFeed(feed, options));
        }
    }

    await Promise.all(Array.from({ length: Math.min(maxWorkers, feeds.length) }, worker));
    return results;
}

async function ensureSchema(database) {
    const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
    await database.query(schema);
}

async function typesenseRequest(config, route, options = {}, signal) {
    const timeout = AbortSignal.timeout(20000);
    return fetch(`${config.typesenseURL}${route}`, {
        ...options,
        headers: {
            "X-TYPESENSE-API-KEY": config.typesenseAPIKey,
            ...options.headers
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
}

async function ensureTypesenseCollection(config, signal) {
    const health = await typesenseRequest(config, "/health", {}, signal);
    await health.text();
    if (!health.ok) throw new Error(`Typesense not ready: HTTP ${health.status}`);

    const collection = `/collections/${encodeURIComponent(config.typesenseCollection)}`;
    const existing = await typesenseRequest(config, collection, {}, signal);
    const existingBody = await existing.text();
    if (existing.status === 200) return;
    if (existing.status !== 404) {
        throw new Error(`Typesense collection check failed: ${existing.status} ${existingBody}`);
    }

    const schema = {
        name: config.typesenseCollection,
        fields: [
            { name: "title", type: "string", optional: true },
            { name: "content", type: "string", optional: true },
            { name: "source", type: "string", facet: true },
            { name: "link", type: "string", optional: true },
            { name: "publication_date", type: "int64", sort: true },
            { name: "publication_date_iso", type: "string" },
            { name: "location_name", type: "string", facet: true, optional: true },
            { name: "location_level", type: "string", facet: true, optional: true },
            { name: "location_country", type: "string", facet: true, optional: true },
            { name: "lat", type: "float", optional: true },
            { name: "lng", type: "float", optional: true },
            { name: "country_lat", type: "float", optional: true },
            { name: "country_lng", type: "float", optional: true },
            { name: "has_location", type: "bool", facet: true }
        ],
        default_sorting_field: "publication_date"
    };

    const created = await typesenseRequest(config, "/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schema)
    }, signal);
    const body = await created.text();
    // Another application instance may have created the collection first.
    if (![200, 201, 409].includes(created.status)) {
        throw new Error(`Failed to create Typesense collection: ${created.status} ${body}`);
    }
}

async function upsertTypesenseDocuments(stories, config, signal) {
    for (let offset = 0; offset < stories.length; offset += 200) {
        const batch = stories.slice(offset, offset + 200);
        const route = `/collections/${encodeURIComponent(config.typesenseCollection)}/documents/import?action=upsert`;
        const response = await typesenseRequest(config, route, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: batch.map((story) => JSON.stringify(buildDoc(story))).join("\n")
        }, signal);
        const body = await response.text();
        if (!response.ok) throw new Error(`Typesense import failed: ${response.status} ${body}`);

        // Typesense can return HTTP 200 even when individual documents failed.
        const results = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const failures = results.filter((result) => result.success !== true);
        if (results.length !== batch.length || failures.length) {
            throw new Error(`Typesense rejected an import batch: ${failures[0]?.error || "incomplete results"}`);
        }
    }
}

async function backfillTypesense(database, config, signal) {
    const result = await database.query(`
        SELECT title, content, source, publication_date, link,
               location_name, location_level, location_country,
               location_lat AS lat, location_lng AS lng,
               country_lat, country_lng, has_location
        FROM entries
        WHERE publication_date >= (
            date_trunc('year', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ) AND publication_date <= NOW()
        ORDER BY publication_date DESC
    `);
    const stories = result.rows.map((row) => ({
        ...row,
        ...(!row.has_location ? extractLocation(row.title, row.content) : {}),
        id: storyID(row.source, row.link, row.title, row.publication_date)
    }));

    await upsertTypesenseDocuments(stories, config, signal);
    if (stories.length) console.log(`Backfilled ${stories.length} stories into Typesense`);
}

async function insertStories(database, stories) {
    if (!stories.length) return;
    const client = await database.connect();

    try {
        await client.query("BEGIN");
        for (let offset = 0; offset < stories.length; offset += 200) {
            const values = [];
            const rows = stories.slice(offset, offset + 200).map((story) => {
                const row = [
                    story.title, story.content, story.source, story.publication_date,
                    story.link, story.location_name, story.location_level,
                    story.location_country, story.lat, story.lng,
                    story.country_lat, story.country_lng, story.has_location
                ];
                const placeholders = row.map((value) => {
                    values.push(value);
                    return `$${values.length}`;
                });
                return `(${placeholders.join(", ")})`;
            });

            await client.query(`
                INSERT INTO entries (
                    title, content, source, publication_date, link,
                    location_name, location_level, location_country,
                    location_lat, location_lng, country_lat, country_lng, has_location
                ) VALUES ${rows.join(", ")}
                ON CONFLICT (source, link) DO NOTHING
            `, values);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function fetchOnce(database, config, signal) {
    const feeds = await loadFeeds(config.feedsFile);
    if (!feeds.length) {
        console.log("No feeds configured.");
        return;
    }

    const start = Date.now();
    const results = await fetchFeeds(feeds, config.maxWorkers, { signal });
    const stories = [];
    let failed = 0;

    for (const result of results) {
        if (result.error) {
            console.error(`[${result.name}] ${result.error}`);
            failed++;
        } else {
            stories.push(...result.entries);
            if (result.entries.length) {
                console.log(`[${result.name}] parsed ${result.entries.length} candidate entries`);
            }
        }
    }

    signal?.throwIfAborted();
    await insertStories(database, stories);
    await upsertTypesenseDocuments(stories, config, signal);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Processed ${stories.length} candidates from ${feeds.length} feeds in ${elapsed}s (${failed} feeds failed) and synced Typesense`);
}

// Start asynchronously so database or search outages do not block the web server.
function startRSSBuilder(config, database) {
    if (!config) return null;
    const pool = database || new Pool({
        connectionString: config.databaseURL,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        max: 2
    });
    pool.on("error", (error) => console.error("RSS database error:", error.message));
    const controller = new AbortController();
    const { signal } = controller;

    async function run() {
        let initialized = false;
        try {
            while (!signal.aborted) {
                let delay = config.pollSeconds * 1000;
                try {
                    if (!initialized) {
                        await ensureSchema(pool);
                        await ensureTypesenseCollection(config, signal);
                        await backfillTypesense(pool, config, signal);
                        initialized = true;
                        console.log("RSS builder started.");
                    }
                    await fetchOnce(pool, config, signal);
                } catch (error) {
                    if (signal.aborted) break;
                    console.error("RSS cycle failed:", error.message);
                    delay = initialized ? delay : 3000;
                    // Backfill again after an import failure to repair committed rows.
                    initialized = false;
                }
                await sleep(delay, undefined, { signal });
            }
        } catch (error) {
            if (!signal.aborted) throw error;
        } finally {
            await pool.end();
        }
    }

    const done = run();
    return {
        done,
        async stop() {
            controller.abort();
            await done;
        }
    };
}

module.exports = {
    readConfig,
    parseDate,
    inCurrentYearWindow,
    getContent,
    shouldSkip,
    extractLocation,
    storyID,
    buildDoc,
    loadFeeds,
    fetchSingleFeed,
    fetchFeeds,
    ensureSchema,
    ensureTypesenseCollection,
    upsertTypesenseDocuments,
    backfillTypesense,
    insertStories,
    fetchOnce,
    startRSSBuilder
};
