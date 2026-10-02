const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const {
    readConfig, parseDate, inCurrentYearWindow, getContent, shouldSkip,
    extractLocation, storyID, buildDoc, fetchSingleFeed, fetchFeeds,
    ensureTypesenseCollection, upsertTypesenseDocuments, backfillTypesense,
    insertStories, fetchOnce, startRSSBuilder
} = require("../rss-builder/rss_builder");
const geoHints = require("../rss-builder/geo-hints.json");

const config = {
    databaseConfig: { connectionString: "postgresql://unused" },
    typesenseURL: "https://search.example",
    typesenseAPIKey: "test-key",
    typesenseCollection: "timeline_entries",
    feedsFile: path.join(__dirname, "../rss-builder/feeds.json"),
    pollSeconds: 600,
    maxWorkers: 3
};

function makeStory() {
    const date = new Date(1772366400000);
    return {
        id: storyID("Reuters", "https://example.com/story", "Paris news", date),
        title: "Paris news",
        content: "News from Paris",
        source: "Reuters",
        publication_date: date,
        link: "https://example.com/story",
        ...extractLocation("Paris news", "")
    };
}

function rss(items) {
    return `<?xml version="1.0"?><rss version="2.0"
        xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>News</title>${items}</channel></rss>`;
}

function item(title, date, content = "News", extra = "") {
    return `<item><title>${title}</title><link>https://example.com/story</link>
        <pubDate>${date}</pubDate><description><![CDATA[${content}]]></description>
        ${extra}</item>`;
}

function fakeDatabase(failInsert = false) {
    const calls = [];
    const database = {
        calls,
        released: 0,
        ended: 0,
        on() {},
        async query(sql, values) {
            calls.push({ sql, values });
            if (failInsert && sql.includes("INSERT INTO")) throw new Error("Insert failed");
            return { rows: [] };
        },
        async connect() {
            return {
                query: database.query,
                release() { database.released++; }
            };
        },
        async end() { database.ended++; }
    };
    return database;
}

test("RSS is optional until configured, with explicit enable/disable and validated limits", () => {
    assert.equal(readConfig({}), null);
    assert.equal(readConfig({ RSS_ENABLED: "false", DATABASE_URL: "set", TYPESENSE_API_KEY: "set" }), null);
    assert.throws(() => readConfig({ RSS_ENABLED: "true" }), /DATABASE_URL/);
    assert.throws(() => readConfig({ RSS_ENABLED: "true", DATABASE_URL: "set" }), /TYPESENSE_API_KEY/);
    assert.throws(() => readConfig({ RSS_ENABLED: "yes" }), /true or false/);
    const env = { DATABASE_URL: "set", TYPESENSE_API_KEY: "set" };
    assert.equal(readConfig(env).maxWorkers, 10);
    assert.equal(readConfig(env).pollSeconds, 600);
    assert.equal(readConfig(env).feedsFile, config.feedsFile);
    assert.throws(() => readConfig({ ...env, RSS_MAX_WORKERS: "0" }), /positive integer/);
    assert.throws(() => readConfig({ ...env, RSS_POLL_SECONDS: "1.5" }), /positive integer/);
});

test("date filtering respects UTC year boundaries, invalid dates, and future stories", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    assert.equal(parseDate({ pubDate: "invalid", updated: "2026-01-01T00:00:00Z" }).toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(parseDate({ pubDate: "bad" }), null);
    assert.equal(parseDate({ pubDate: "2026-01-01T00:00:00.999Z" }).getUTCMilliseconds(), 0);
    assert.equal(inCurrentYearWindow(new Date("2025-12-31T23:59:59Z"), now), false);
    assert.equal(inCurrentYearWindow(new Date("2026-01-01T00:00:00Z"), now), true);
    assert.equal(inCurrentYearWindow(now, now), true);
    assert.equal(inCurrentYearWindow(new Date("2026-03-01T12:00:01Z"), now), false);
    assert.equal(inCurrentYearWindow(null, now), false);
});

test("source exclusions and summary preference match the Python worker", () => {
    assert.equal(shouldSkip("Other", "Opinion | A story", ""), true);
    assert.equal(shouldSkip("CNET", "Offers", "Today's deals"), true);
    assert.equal(shouldSkip("ABC News", "LIVE: Updates", ""), true);
    assert.equal(shouldSkip("BBC News", "Watch: Event", ""), true);
    assert.equal(shouldSkip("New York Times", "News", "Here is the latest"), true);
    assert.equal(shouldSkip("Reuters", "Live: Event", ""), false);
    assert.equal(getContent({ summary: "Summary", content: "Full text" }), "Summary");
    assert.equal(getContent({ "content:encoded": "Full text" }), "Full text");
});

test("all original location hints and longest-name priority are retained", () => {
    assert.equal(geoHints.length, 50);
    for (const geo of geoHints) {
        const result = extractLocation(geo.alias.toUpperCase(), "");
        assert.equal(result.location_name, geo.name);
        assert.equal(result.lat, geo.lat);
        assert.equal(result.country_lng, geo.country_lng);
    }
    assert.equal(extractLocation("France and New York City", "").location_name, "New York City");
    assert.equal(extractLocation("Indianapolis", "").has_location, false);
    assert.equal(extractLocation("éparisé", "").has_location, false);
    assert.equal(extractLocation("", "").lat, null);
});

test("document hashes and timestamp serialization stay compatible with Python", () => {
    const story = makeStory();
    assert.equal(story.id, "37b40ada1d6bb6930d3ffe254f8769bada49cb92");
    const doc = buildDoc(story);
    assert.equal(doc.publication_date, 1772366400);
    assert.equal(doc.publication_date_iso, "2026-03-01T12:00:00+00:00");
    assert.equal(doc.location_country, "France");
});

test("RSS parsing handles CDATA, content fallback, dates, Reuters titles, and exclusions", async (t) => {
    const date = "Sun, 01 Mar 2026 12:00:00 GMT";
    const xml = rss([
        item("Paris &amp; London - Reuters", date, "<p>Summary</p>", "<content:encoded><![CDATA[Full text]]></content:encoded>"),
        item("Opinion | Skip", date),
        item("Old story", "Wed, 01 Jan 2025 00:00:00 GMT"),
        item("Future story", "Fri, 01 Jan 2027 00:00:00 GMT"),
        item("Undated story", "invalid"),
        `<item><title>Tokyo</title><dc:date>2026-03-01T12:00:00Z</dc:date>
            <content:encoded><![CDATA[Full text]]></content:encoded></item>`
    ].join(""));
    t.mock.method(global, "fetch", async () => new Response(xml));
    const result = await fetchSingleFeed({ name: "Reuters", url: "https://news.example" }, {
        now: new Date("2026-03-02T00:00:00Z")
    });
    assert.equal(result.error, null);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].title, "Paris & London");
    assert.equal(result.entries[0].content, "<p>Summary</p>");
    assert.equal(result.entries[1].content, "Full text");
    assert.equal(result.entries[1].link, null);
    assert.equal(result.entries[1].location_name, "Tokyo");
});

test("Atom summaries, published dates, and updated-only entries are supported", async (t) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title>
        <entry><title>London news</title><link href="https://example.com/atom"/>
            <published>2026-03-01T12:00:00Z</published><updated>2026-03-02T12:00:00Z</updated>
            <summary type="html">&lt;p&gt;Summary&lt;/p&gt;</summary><content>Full text</content>
        </entry>
        <entry><title>Paris</title><updated>2026-03-01T12:00:00Z</updated><content>News</content></entry>
        </feed>`;
    t.mock.method(global, "fetch", async () => new Response(xml));
    const result = await fetchSingleFeed({ name: "Other", url: "https://news.example" }, {
        now: new Date("2026-03-03T00:00:00Z")
    });
    assert.equal(result.error, null);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].content, "<p>Summary</p>");
    assert.equal(result.entries[0].publication_date.toISOString(), "2026-03-01T12:00:00.000Z");
    assert.equal(result.entries[1].publication_date.toISOString(), "2026-03-01T12:00:00.000Z");
});

test("feed errors are isolated and parallel fetches honor the worker limit", async (t) => {
    let active = 0;
    let maximum = 0;
    t.mock.method(global, "fetch", async (url) => {
        active++;
        maximum = Math.max(maximum, active);
        await sleep(5);
        active--;
        return url.endsWith("/bad") ? new Response("invalid XML") : new Response(rss(""));
    });
    const feeds = Array.from({ length: 7 }, (_, index) => ({ name: `Feed ${index}`, url: `https://example.com/${index}` }));
    feeds.push({ name: "Bad", url: "https://example.com/bad" });
    feeds.push({ name: "Missing" });
    const results = await fetchFeeds(feeds, 3);
    assert.equal(maximum, 3);
    assert.equal(results.length, feeds.length);
    assert.equal(results.filter((result) => result.error).length, 2);
});

test("batched SQL uses parameters, commits all batches, and rolls back failed inserts", async () => {
    const database = fakeDatabase();
    const story = { ...makeStory(), title: "'); DROP TABLE entries; --" };
    await insertStories(database, Array.from({ length: 201 }, () => story));
    const inserts = database.calls.filter((call) => call.sql.includes("INSERT INTO"));
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].values.length, 200 * 13);
    assert.equal(inserts[1].values.length, 13);
    assert.equal(inserts[0].values[0], story.title);
    assert(!inserts[0].sql.includes(story.title));
    assert.match(inserts[0].sql, /ON CONFLICT \(source, link\) DO NOTHING/);
    assert.equal(database.calls.at(-1).sql, "COMMIT");
    assert.equal(database.released, 1);

    const failed = fakeDatabase(true);
    await assert.rejects(insertStories(failed, [story]), /Insert failed/);
    assert.equal(failed.calls.at(-1).sql, "ROLLBACK");
    assert.equal(failed.released, 1);
});

test("Typesense creates missing collections and reports authentication failures", async (t) => {
    let created;
    t.mock.method(global, "fetch", async (url, options) => {
        assert.equal(options.headers["X-TYPESENSE-API-KEY"], "test-key");
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (options.method === "POST") {
            created = JSON.parse(options.body);
            return Response.json(created, { status: 201 });
        }
        return new Response("missing", { status: 404 });
    });
    await ensureTypesenseCollection(config);
    assert.equal(created.name, "timeline_entries");
    assert.equal(created.fields.length, 14);
    assert.equal(created.default_sorting_field, "publication_date");
    t.mock.method(global, "fetch", async (url) => {
        return url.endsWith("/health") ? Response.json({ ok: true }) : new Response("denied", { status: 401 });
    });
    await assert.rejects(ensureTypesenseCollection(config), /401/);
});

test("Typesense checks every NDJSON import result even after HTTP 200", async (t) => {
    const sizes = [];
    t.mock.method(global, "fetch", async (url, options) => {
        assert(url.endsWith("/documents/import?action=upsert"));
        const docs = options.body.split("\n").map(JSON.parse);
        sizes.push(docs.length);
        assert.equal(docs[0].id, makeStory().id);
        return new Response(docs.map(() => JSON.stringify({ success: true })).join("\n"));
    });
    await upsertTypesenseDocuments(Array.from({ length: 201 }, makeStory), config);
    assert.deepEqual(sizes, [200, 1]);
    t.mock.method(global, "fetch", async () => Response.json({ success: false, error: "Invalid field" }));
    await assert.rejects(upsertTypesenseDocuments([makeStory()], config), /Invalid field/);
});

test("backfill preserves existing IDs and adds location hints to older rows", async (t) => {
    let imported;
    t.mock.method(global, "fetch", async (url, options) => {
        imported = JSON.parse(options.body);
        return Response.json({ success: true });
    });
    const story = makeStory();
    await backfillTypesense({
        async query() { return { rows: [{ ...story, has_location: false, location_name: null, lat: null }] }; }
    }, config);
    assert.equal(imported.id, story.id);
    assert.equal(imported.location_name, "Paris");
    assert.equal(imported.lat, 48.8566);
});

test("a full poll reads the bundled feeds, commits candidates, and imports them", async (t) => {
    const database = fakeDatabase();
    let imported = 0;
    const date = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toUTCString();
    t.mock.method(global, "fetch", async (url, options) => {
        if (url.startsWith(config.typesenseURL)) {
            assert.equal(database.calls.at(-1).sql, "COMMIT");
            const docs = options.body.split("\n");
            imported += docs.length;
            return new Response(docs.map(() => JSON.stringify({ success: true })).join("\n"));
        }
        return new Response(rss(item("London news", date)));
    });
    await fetchOnce(database, config);
    assert.equal(imported, 17);
    assert.equal(database.released, 1);
});

test("shutdown cancels an in-flight feed request and leaves a shared database pool open", async (t) => {
    const database = fakeDatabase();
    let feedStarted;
    const started = new Promise((resolve) => { feedStarted = resolve; });
    t.mock.method(global, "fetch", async (url, options) => {
        if (url.startsWith(config.typesenseURL)) return Response.json({ ok: true });
        feedStarted();
        return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
    });
    const builder = startRSSBuilder(config, database);
    await started;
    await builder.stop();
    assert.equal(database.ended, 0);
});
