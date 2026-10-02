const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { readDatabaseConfig, createDatabasePool, initializeSchema: ensureSchema } = require("../services/db");
const geoHints = require("./geo-hints.json");
const { getContent } = require("./content");

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

    const databaseConfig = readDatabaseConfig(env);
    const enabled = env.RSS_ENABLED === undefined
        ? Boolean(databaseConfig)
        : env.RSS_ENABLED === "true";

    if (!enabled) return null;
    if (!databaseConfig) throw new Error("DATABASE_URL or INSTANCE_CONNECTION_NAME is required for RSS.");

    return {
        databaseConfig,
        typesenseURL: (env.TYPESENSE_URL || "http://localhost:8108").replace(/\/+$/, ""),
        typesenseAPIKey: env.TYPESENSE_API_KEY || null,
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

function inTodayWindow(date, now = new Date()) {
    if (!date) return false;
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return date.getTime() >= dayStart && date <= now;
}

// Outermost <item> or <entry> elements, skipping CDATA and comments so markup
// inside a description cannot split the real item.
function extractElements(xml, localTag) {
    const segments = [];
    const wanted = localTag.toLowerCase();
    let depth = 0;
    let start = -1;
    let index = 0;

    while (index < xml.length) {
        if (xml.startsWith("<![CDATA[", index)) {
            const end = xml.indexOf("]]>", index + 9);
            index = end === -1 ? xml.length : end + 3;
            continue;
        }
        if (xml.startsWith("<!--", index)) {
            const end = xml.indexOf("-->", index + 4);
            index = end === -1 ? xml.length : end + 3;
            continue;
        }
        if (xml[index] !== "<") {
            index++;
            continue;
        }

        const closing = xml[index + 1] === "/";
        const nameStart = closing ? index + 2 : index + 1;
        let nameEnd = nameStart;
        while (nameEnd < xml.length && /[A-Za-z0-9:_.-]/.test(xml[nameEnd])) nameEnd++;
        const rawName = xml.slice(nameStart, nameEnd);
        const local = rawName.slice(rawName.lastIndexOf(":") + 1).toLowerCase();
        const tagEnd = xml.indexOf(">", index);
        if (tagEnd === -1) break;

        if (rawName && local === wanted) {
            const selfClosing = !closing && xml[tagEnd - 1] === "/";
            if (closing) {
                if (depth > 0) depth -= 1;
                if (depth === 0 && start !== -1) {
                    segments.push(xml.slice(start, tagEnd + 1));
                    start = -1;
                }
            } else if (selfClosing) {
                if (depth === 0) segments.push(xml.slice(index, tagEnd + 1));
            } else {
                if (depth === 0) start = index;
                depth += 1;
            }
        }

        index = tagEnd + 1;
    }

    return segments;
}

function pickSegments(itemSegments, entrySegments, count) {
    if (itemSegments.length === count) return itemSegments;
    if (entrySegments.length === count) return entrySegments;
    const itemDistance = Math.abs(itemSegments.length - count);
    const entryDistance = Math.abs(entrySegments.length - count);
    if (entrySegments.length && entryDistance < itemDistance) return entrySegments;
    return itemSegments.length ? itemSegments : entrySegments;
}

function itemXmlList(xml, items) {
    const segments = pickSegments(
        extractElements(xml, "item"),
        extractElements(xml, "entry"),
        items.length
    );
    if (segments.length === items.length) return segments;

    const used = new Set();
    return items.map((item) => {
        const needles = [item.link, item.guid, item.id]
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter(Boolean);
        for (const needle of needles) {
            const found = segments.findIndex((segment, index) => !used.has(index) && segment.includes(needle));
            if (found !== -1) {
                used.add(found);
                return segments[found];
            }
        }
        return null;
    });
}

function imageList(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function mediaAttributes(node) {
    if (!node || typeof node !== "object") return {};
    return node.$ && typeof node.$ === "object" ? node.$ : node;
}

function resolveImageUrl(url, base) {
    const trimmed = String(url || "").trim();
    if (!trimmed || /^(?:data|javascript|blob):/i.test(trimmed)) return null;

    try {
        const resolved = new URL(trimmed, base || undefined);
        if (!["http:", "https:"].includes(resolved.protocol)) return null;
        return resolved.href;
    } catch {
        return null;
    }
}

function isImage(attrs, source) {
    const type = String(attrs.type || "").toLowerCase();
    const medium = String(attrs.medium || "").toLowerCase();
    if (source === "media:thumbnail") return true;
    if (type.startsWith("audio/") || type.startsWith("video/") || medium === "audio" || medium === "video") {
        return false;
    }
    if (source === "enclosure") return !type || type.startsWith("image/");
    return !type || type.startsWith("image/") || medium === "image";
}

function tagAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"));
    return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
}

function firstSrcsetUrl(srcset) {
    return String(srcset || "").split(",")[0].trim().split(/\s+/)[0] || "";
}

function imageUrls(images) {
    if (!Array.isArray(images)) return [];
    return images.flatMap((image) => {
        const url = typeof image === "string" ? image : image?.url;
        return url ? [url] : [];
    });
}

// Enclosure, Media RSS, and HTML images. Summary text often omits the photo.
function extractImages(entry) {
    const images = [];
    const seen = new Set();
    const base = entry.link || "";

    function add(url, mime, source) {
        const resolved = resolveImageUrl(url, base);
        if (!resolved || seen.has(resolved)) return;
        seen.add(resolved);
        const type = String(mime || "").toLowerCase();
        images.push({
            url: resolved,
            mime: type.startsWith("image/") ? type : null,
            source
        });
    }

    function addMedia(nodes, source) {
        for (const node of imageList(nodes)) {
            const attrs = mediaAttributes(node);
            if (node && (node["media:content"] || node["media:thumbnail"]) && !attrs.url) {
                addMedia(node["media:content"], "media:content");
                addMedia(node["media:thumbnail"], "media:thumbnail");
                continue;
            }
            if (!isImage(attrs, source)) continue;
            add(attrs.url || attrs.href, attrs.type, source);
        }
    }

    if (entry.enclosure?.url && isImage(entry.enclosure, "enclosure")) {
        add(entry.enclosure.url, entry.enclosure.type, "enclosure");
    }

    addMedia(entry["media:content"], "media:content");
    addMedia(entry["media:thumbnail"], "media:thumbnail");
    addMedia(entry["media:group"], "media:content");

    const html = [entry.summary, entry.content, entry.description, entry["content:encoded"]]
        .filter((value) => typeof value === "string" && value)
        .join("\n");
    for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
        add(tagAttribute(tag, "src") || firstSrcsetUrl(tagAttribute(tag, "srcset")), null, "html");
    }

    return images;
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
        has_location: Boolean(story.has_location),
        images: imageUrls(story.images)
    };
}

async function loadFeeds(feedsFile) {
    const data = JSON.parse(await fs.readFile(feedsFile, "utf8"));
    const feeds = data.feeds || [];
    if (!Array.isArray(feeds)) throw new Error("The feeds file must contain a feeds array.");
    return feeds;
}

function createFeedParser() {
    const Parser = require("rss-parser");
    class FeedParser extends Parser {
        parseItemAtom(entry) {
            return { ...super.parseItemAtom(entry), isAtom: true };
        }

        async parseString(xml) {
            const parsed = await super.parseString(xml);
            const segments = itemXmlList(xml, parsed.items || []);
            for (const [index, entry] of (parsed.items || []).entries()) {
                entry.item_xml = segments[index] || null;
                if (!entry.isAtom) continue;
                for (const key of ["content", "summary"]) {
                    if (!["xhtml", "application/xhtml+xml"].includes(entry[`raw_${key}`]?.[0]?.$?.type)) continue;
                    // rss-parser's XML-object serialization reorders mixed text
                    // and inline elements. Convert the original XHTML instead.
                    entry[key] = extractElements(entry.item_xml || "", key)[0] || entry[key];
                }
            }
            return parsed;
        }
    }
    return new FeedParser({
        customFields: {
            item: [
                "published",
                "updated",
                ["source", "feedSource"],
                ["content", "raw_content", { keepArray: true }],
                ["summary", "raw_summary", { keepArray: true }],
                ["media:description", "media:description", { keepArray: true }],
                ["media:content", "media:content", { keepArray: true }],
                ["media:thumbnail", "media:thumbnail", { keepArray: true }],
                ["media:group", "media:group", { keepArray: true }]
            ]
        }
    });
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

        const parser = createFeedParser();
        const rawXml = await response.text();
        const parsed = await parser.parseString(rawXml);
        const entries = [];

        for (const entry of parsed.items || []) {
            let title = (entry.title || "").trim();
            const content = getContent(entry, { source: name });
            if (shouldSkip(name, title, content)) continue;

            if (name === "Reuters" && title.endsWith(" - Reuters")) {
                title = title.slice(0, -10).trim();
            }

            const date = parseDate(entry);
            if (!inTodayWindow(date, now)) continue;

            const link = (entry.link || "").trim() || null;
            entries.push({
                id: storyID(name, link, title, date),
                title,
                content,
                source: name,
                publication_date: date,
                link,
                ...extractLocation(title, content),
                images: extractImages(entry),
                item_xml: entry.item_xml
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
    if (existing.status === 200) {
        const current = JSON.parse(existingBody);
        if ((current.fields || []).some((field) => field.name === "images")) return;

        const patched = await typesenseRequest(config, collection, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fields: [{ name: "images", type: "string[]", optional: true }]
            })
        }, signal);
        const patchBody = await patched.text();
        if (!patched.ok) {
            throw new Error(`Typesense images field update failed: ${patched.status} ${patchBody}`);
        }
        return;
    }
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
            { name: "has_location", type: "bool", facet: true },
            { name: "images", type: "string[]", optional: true }
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
               country_lat, country_lng, has_location, images
        FROM entries
        WHERE publication_date >= (
            date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
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

function storiesForInsert(stories) {
    const byKey = new Map();
    const unique = [];

    for (const story of stories) {
        if (!story.link) {
            unique.push(story);
            continue;
        }

        const key = `${story.source}\0${story.link}`;
        const previous = byKey.get(key);
        if (!previous) {
            if (!story.images) story.images = [];
            byKey.set(key, story);
            unique.push(story);
            continue;
        }

        for (const image of story.images || []) {
            if (!image?.url || previous.images.some((existing) => existing.url === image.url)) continue;
            previous.images.push(image);
        }
        if (!previous.item_xml && story.item_xml) previous.item_xml = story.item_xml;
    }

    return unique;
}

async function insertStories(database, stories) {
    const unique = storiesForInsert(stories);
    if (!unique.length) return;
    const client = await database.connect();

    try {
        await client.query("BEGIN");
        for (let offset = 0; offset < unique.length; offset += 200) {
            const values = [];
            const rows = unique.slice(offset, offset + 200).map((story) => {
                const row = [
                    story.title, story.content, story.source, story.publication_date,
                    story.link, story.location_name, story.location_level,
                    story.location_country, story.lat, story.lng,
                    story.country_lat, story.country_lng, story.has_location,
                    JSON.stringify(story.images || []),
                    story.item_xml || null
                ];
                const placeholders = row.map((value) => {
                    values.push(value);
                    return `$${values.length}`;
                });
                placeholders[placeholders.length - 2] += "::jsonb";
                return `(${placeholders.join(", ")})`;
            });

            await client.query(`
                INSERT INTO entries (
                    title, content, source, publication_date, link,
                    location_name, location_level, location_country,
                    location_lat, location_lng, country_lat, country_lng, has_location,
                    images, item_xml
                ) VALUES ${rows.join(", ")}
                ON CONFLICT (source, link) DO UPDATE SET
                    content = EXCLUDED.content,
                    location_name = EXCLUDED.location_name,
                    location_level = EXCLUDED.location_level,
                    location_country = EXCLUDED.location_country,
                    location_lat = EXCLUDED.location_lat,
                    location_lng = EXCLUDED.location_lng,
                    country_lat = EXCLUDED.country_lat,
                    country_lng = EXCLUDED.country_lng,
                    has_location = EXCLUDED.has_location,
                    images = EXCLUDED.images,
                    item_xml = COALESCE(EXCLUDED.item_xml, entries.item_xml)
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
        return [];
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
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Stored ${stories.length} candidates in PostgreSQL from ${feeds.length} feeds in ${elapsed}s (${failed} feeds failed)`);
    return stories;
}

// Start asynchronously so database or search outages do not block the web server.
function startRSSBuilder(config, database) {
    if (!config) return null;
    const pool = database || createDatabasePool(config.databaseConfig);
    const controller = new AbortController();
    const { signal } = controller;

    async function run() {
        let initialized = false;
        let searchReady = false;
        try {
            while (!signal.aborted) {
                let delay = config.pollSeconds * 1000;
                try {
                    if (!initialized) {
                        await ensureSchema(pool);
                        initialized = true;
                        console.log("RSS builder started.");
                        if (!config.typesenseAPIKey) {
                            console.log("Typesense indexing disabled. RSS stories will be stored in PostgreSQL.");
                        }
                    }
                    const stories = await fetchOnce(pool, config, signal);

                    if (config.typesenseAPIKey) {
                        try {
                            if (!searchReady) {
                                await ensureTypesenseCollection(config, signal);
                                // Include this poll and any rows saved during a search outage.
                                await backfillTypesense(pool, config, signal);
                                searchReady = true;
                            } else {
                                await upsertTypesenseDocuments(stories, config, signal);
                            }
                        } catch (error) {
                            if (signal.aborted) break;
                            searchReady = false;
                            console.error("Typesense sync failed; PostgreSQL stories are saved and indexing will retry:", error.message);
                        }
                    }
                } catch (error) {
                    if (signal.aborted) break;
                    console.error("RSS cycle failed:", error.message);
                    delay = initialized ? delay : 3000;
                    initialized = false;
                    searchReady = false;
                }
                await sleep(delay, undefined, { signal });
            }
        } catch (error) {
            if (!signal.aborted) throw error;
        } finally {
            if (!database) await pool.end();
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
    inTodayWindow,
    getContent,
    shouldSkip,
    extractImages,
    extractLocation,
    storyID,
    buildDoc,
    loadFeeds,
    createFeedParser,
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
