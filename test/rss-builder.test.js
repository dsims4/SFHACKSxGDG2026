const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const {
    readConfig, parseDate, inTodayWindow, getContent, shouldSkip,
    extractImages, extractLocation, storyID, buildDoc, fetchSingleFeed, fetchFeeds,
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
    assert.equal(readConfig({ RSS_ENABLED: "true", DATABASE_URL: "set" }).typesenseAPIKey, null);
    assert.throws(() => readConfig({ RSS_ENABLED: "yes" }), /true or false/);
    const env = { DATABASE_URL: "set", TYPESENSE_API_KEY: "set" };
    assert.equal(readConfig(env).maxWorkers, 10);
    assert.equal(readConfig(env).pollSeconds, 600);
    assert.equal(readConfig(env).feedsFile, config.feedsFile);
    assert.throws(() => readConfig({ ...env, RSS_MAX_WORKERS: "0" }), /positive integer/);
    assert.throws(() => readConfig({ ...env, RSS_POLL_SECONDS: "1.5" }), /positive integer/);
});

test("date filtering respects UTC day boundaries, invalid dates, and future stories", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    assert.equal(parseDate({ pubDate: "invalid", updated: "2026-01-01T00:00:00Z" }).toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(parseDate({ pubDate: "bad" }), null);
    assert.equal(parseDate({ pubDate: "2026-01-01T00:00:00.999Z" }).getUTCMilliseconds(), 0);
    assert.equal(inTodayWindow(new Date("2025-12-31T23:59:59Z"), now), false);
    assert.equal(inTodayWindow(new Date("2026-03-01T00:00:00Z"), now), true);
    assert.equal(inTodayWindow(new Date("2026-02-28T23:59:59Z"), now), false);
    assert.equal(inTodayWindow(new Date("invalid"), now), false);
    assert.equal(inTodayWindow(now, now), true);
    assert.equal(inTodayWindow(new Date("2026-03-01T12:00:01Z"), now), false);
    assert.equal(inTodayWindow(null, now), false);
});

test("source exclusions are retained while full feed content takes priority", () => {
    assert.equal(shouldSkip("Other", "Opinion | A story", ""), true);
    assert.equal(shouldSkip("CNET", "Offers", "Today's deals"), true);
    assert.equal(shouldSkip("ABC News", "LIVE: Updates", ""), true);
    assert.equal(shouldSkip("BBC News", "Watch: Event", ""), true);
    assert.equal(shouldSkip("New York Times", "News", "Here is the latest"), true);
    assert.equal(shouldSkip("Reuters", "Live: Event", ""), false);
    assert.equal(getContent({ summary: "Summary", content: "Full text" }), "Full text");
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
        item("Paris &amp; London - Reuters", date, "<p>Summary</p></item>", "<content:encoded><![CDATA[Full text]]></content:encoded>"),
        item("Opinion | Skip", date),
        item("Old story", "Wed, 01 Jan 2025 00:00:00 GMT"),
        item("Future story", "Fri, 01 Jan 2027 00:00:00 GMT"),
        item("Undated story", "invalid"),
        `<item><title>Tokyo</title><dc:date>2026-03-01T12:00:00Z</dc:date>
            <content:encoded><![CDATA[Full text]]></content:encoded></item>`
    ].join(""));
    t.mock.method(global, "fetch", async () => new Response(xml));
    const result = await fetchSingleFeed({ name: "Reuters", url: "https://news.example" }, {
        now: new Date("2026-03-01T23:59:59Z")
    });
    assert.equal(result.error, null);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].title, "Paris & London");
    assert.equal(result.entries[0].content, "Full text");
    assert.equal(result.entries[1].content, "Full text");
    assert.equal(result.entries[1].link, null);
    assert.equal(result.entries[1].location_name, "Tokyo");
    assert.match(result.entries[0].item_xml, /^<item>[\s\S]*<\/item>$/);
    assert.match(result.entries[0].item_xml, /Paris &amp; London - Reuters/);
    assert.match(result.entries[0].item_xml, /<!\[CDATA\[<p>Summary<\/p><\/item>\]\]>/);
    assert.doesNotMatch(result.entries[0].item_xml, /Opinion \| Skip/);
    assert.match(result.entries[1].item_xml, /<title>Tokyo<\/title>/);
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
        now: new Date("2026-03-01T23:59:59Z")
    });
    assert.equal(result.error, null);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].content, "Full text");
    assert.equal(result.entries[0].publication_date.toISOString(), "2026-03-01T12:00:00.000Z");
    assert.equal(result.entries[1].publication_date.toISOString(), "2026-03-01T12:00:00.000Z");
    assert.match(result.entries[0].item_xml, /<entry>[\s\S]*London news[\s\S]*<\/entry>/);
    assert.match(result.entries[1].item_xml, /<title>Paris<\/title>/);
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
    const stories = Array.from({ length: 201 }, (_, index) => ({
        ...story,
        link: `https://example.com/story-${index}`
    }));
    const extra = { url: "https://cdn.example/extra.jpg", mime: null, source: "html" };
    stories.push({ ...stories[0], images: [extra] });
    await insertStories(database, stories);
    const inserts = database.calls.filter((call) => call.sql.includes("INSERT INTO"));
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].values.length, 200 * 15);
    assert.equal(inserts[1].values.length, 15);
    assert.equal(inserts[0].values[0], story.title);
    assert.equal(inserts[0].values[13], JSON.stringify([extra]));
    assert.equal(inserts[0].values[14], null);
    assert.equal(inserts[1].values[4], "https://example.com/story-200");
    assert.equal(inserts[1].values[13], "[]");
    assert(!inserts[0].sql.includes(story.title));
    assert.match(inserts[0].sql, /item_xml/);
    assert.match(inserts[0].sql, /ON CONFLICT \(source, link\) DO UPDATE SET\s+content = EXCLUDED\.content/);
    assert.match(inserts[0].sql, /location_name = EXCLUDED\.location_name/);
    assert.match(inserts[0].sql, /images = EXCLUDED\.images,\s+item_xml = COALESCE\(EXCLUDED\.item_xml, entries\.item_xml\)/);
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
    assert.equal(created.fields.length, 15);
    assert.equal(created.fields.at(-1).name, "images");
    assert.equal(created.default_sorting_field, "publication_date");
    t.mock.method(global, "fetch", async (url) => {
        return url.endsWith("/health") ? Response.json({ ok: true }) : new Response("denied", { status: 401 });
    });
    await assert.rejects(ensureTypesenseCollection(config), /401/);
});

test("Typesense adds the images field when the collection already exists", async (t) => {
    let patched = null;
    t.mock.method(global, "fetch", async (url, options) => {
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (options.method === "PATCH") {
            patched = JSON.parse(options.body);
            return Response.json({ ok: true });
        }
        return Response.json({
            name: "timeline_entries",
            fields: [{ name: "title", type: "string" }]
        });
    });
    await ensureTypesenseCollection(config);
    assert.deepEqual(patched.fields, [{ name: "images", type: "string[]", optional: true }]);
});

test("image extraction keeps enclosure, media, and html urls and skips non-images", async (t) => {
    const date = "Sun, 01 Mar 2026 12:00:00 GMT";
    const xml = `<?xml version="1.0"?><rss version="2.0"
        xmlns:media="http://search.yahoo.com/mrss/"
        xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel><title>News</title>
        <item>
            <title>Paris photo</title>
            <link>https://example.com/story</link>
            <pubDate>${date}</pubDate>
            <description><![CDATA[<p>Summary</p>]]></description>
            <enclosure url="https://cdn.example/enc.jpg" type="image/jpeg"/>
            <enclosure url="https://cdn.example/audio.mp3" type="audio/mpeg"/>
            <media:content url="https://cdn.example/clip.mp4" medium="video" type="video/mp4"/>
            <media:content url="https://cdn.example/hero.jpg" medium="image" type="image/jpeg"/>
            <media:thumbnail url="https://cdn.example/thumb.jpg"/>
            <media:group>
                <media:content url="https://cdn.example/group.jpg" medium="image"/>
            </media:group>
            <content:encoded><![CDATA[
                <img src="/inline.png">
                <img srcset="https://cdn.example/hero.jpg 640w">
                <img src="data:image/gif;base64,AAAA">
            ]]></content:encoded>
        </item>
        </channel></rss>`;
    t.mock.method(global, "fetch", async () => new Response(xml));
    const result = await fetchSingleFeed({ name: "Other", url: "https://news.example" }, {
        now: new Date("2026-03-01T23:59:59Z")
    });
    assert.equal(result.error, null);
    assert.deepEqual(result.entries[0].images, [
        { url: "https://cdn.example/enc.jpg", mime: "image/jpeg", source: "enclosure" },
        { url: "https://cdn.example/hero.jpg", mime: "image/jpeg", source: "media:content" },
        { url: "https://cdn.example/thumb.jpg", mime: null, source: "media:thumbnail" },
        { url: "https://cdn.example/group.jpg", mime: null, source: "media:content" },
        { url: "https://example.com/inline.png", mime: null, source: "html" }
    ]);
    assert.deepEqual(extractImages({
        link: "https://example.com/story",
        enclosure: { url: "https://cdn.example/audio.mp3", type: "audio/mpeg" }
    }), []);
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
        async query() {
            return {
                rows: [{
                    ...story,
                    has_location: false,
                    location_name: null,
                    lat: null,
                    images: [{ url: "https://cdn.example/a.jpg", mime: "image/jpeg", source: "enclosure" }]
                }]
            };
        }
    }, config);
    assert.equal(imported.id, story.id);
    assert.equal(imported.location_name, "Paris");
    assert.equal(imported.lat, 48.8566);
    assert.deepEqual(imported.images, ["https://cdn.example/a.jpg"]);
});

test("a full poll stores stories in PostgreSQL without Typesense credentials", async (t) => {
    const database = fakeDatabase();
    const date = new Date().toUTCString();
    t.mock.method(global, "fetch", async (url) => {
        assert(!url.startsWith(config.typesenseURL));
        return new Response(rss(item("London news", date)));
    });
    const stories = await fetchOnce(database, { ...config, typesenseAPIKey: null });
    assert.equal(stories.length, 17);
    assert.equal(database.calls.at(-1).sql, "COMMIT");
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

test("the worker automatically ingests with PostgreSQL alone", { timeout: 3000 }, async (t) => {
    const database = fakeDatabase();
    let stored;
    const committed = new Promise((resolve) => { stored = resolve; });
    const query = database.query;
    database.query = async (sql, values) => {
        const result = await query(sql, values);
        if (sql === "COMMIT" && database.calls.some((call) => call.sql.includes("INSERT INTO"))) stored();
        return result;
    };
    const date = new Date().toUTCString();
    t.mock.method(global, "fetch", async (url) => {
        assert(!url.startsWith(config.typesenseURL));
        return new Response(rss(item("Paris news", date)));
    });
    const databaseConfig = readConfig({ DATABASE_URL: "postgresql://unused" });
    const builder = startRSSBuilder({ ...databaseConfig, typesenseURL: config.typesenseURL }, database);
    t.after(() => builder.stop());
    await committed;
    await builder.stop();
    assert(database.calls.some((call) => call.sql.includes("INSERT INTO entries")));
    assert.equal(database.ended, 0);
});

test("search outages do not stop database writes and recovery backfills stored rows", { timeout: 3000 }, async (t) => {
    const database = fakeDatabase();
    let polls = 0;
    let imports = 0;
    let recovered;
    const recovery = new Promise((resolve) => { recovered = resolve; });
    const errors = [];
    const query = database.query;
    database.query = async (sql, values) => {
        const result = await query(sql, values);
        if (sql.includes("INSERT INTO entries")) polls++;
        if (sql.includes("SELECT title, content, source")) {
            return { rows: [{ ...makeStory(), images: [] }] };
        }
        return result;
    };
    t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
    const date = new Date().toUTCString();
    t.mock.method(global, "fetch", async (url, options) => {
        if (!url.startsWith(config.typesenseURL)) return new Response(rss(item("Paris news", date)));
        assert(polls > 0, "Stories must be saved before search is contacted.");
        if (url.endsWith("/health")) {
            return polls === 1 ? new Response("Unavailable", { status: 503 }) : Response.json({ ok: true });
        }
        if (url.includes("/documents/import")) {
            const docs = options.body.split("\n").map(JSON.parse);
            imports++;
            // The first successful import comes from the database backfill.
            if (imports === 1) assert.equal(docs[0].id, makeStory().id);
            if (imports === 2) recovered();
            return new Response(docs.map(() => JSON.stringify({ success: true })).join("\n"));
        }
        return Response.json({ fields: [{ name: "images" }] });
    });
    const builder = startRSSBuilder({ ...config, pollSeconds: 0.01 }, database);
    t.after(() => builder.stop());
    await recovery;
    await builder.stop();
    assert(polls >= 3);
    assert(errors.some((error) => error.includes("Typesense sync failed")));
    assert.equal(database.ended, 0);
});
