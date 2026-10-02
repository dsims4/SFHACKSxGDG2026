const assert = require("node:assert/strict");
const { test } = require("node:test");
const { contentFromStoredRow, repairContent } = require("../scripts/repair-rss-content");

function savedRow(overrides = {}) {
    return {
        id: "1", title: "News", source: "Other", content: "<p>Teaser</p>",
        item_xml: `<item><title>News</title><description>Teaser</description>
            <content:encoded><![CDATA[<p>Reporting from Paris.</p>]]></content:encoded></item>`,
        ...overrides
    };
}

// Emulate paging, updates, and rollback to check the observable repair behavior
// without needing a configured PostgreSQL database for the test suite.
function databaseFor(rows, { concurrent = false, failAfter = Infinity } = {}) {
    let backup;
    let updates = 0;
    return {
        rows: structuredClone(rows),
        connects: 0,
        releases: 0,
        async query(sql, values) {
            if (sql.includes("SELECT id")) {
                return { rows: structuredClone(this.rows.filter((row) => BigInt(row.id) > BigInt(values[0])).slice(0, values[1])) };
            }
            if (sql === "BEGIN") backup = structuredClone(this.rows);
            if (sql === "ROLLBACK") this.rows = backup;
            if (!sql.includes("UPDATE entries")) return { rows: [] };
            if (++updates > failAfter) throw new Error("Database write failed");
            const row = this.rows.find((candidate) => candidate.id === values[9]);
            if (concurrent) row.content = "A newer poll updated this row.";
            if (row.content !== values[10] || row.item_xml !== values[11]) return { rowCount: 0 };
            row.content = values[0];
            row.location_name = values[1];
            return { rowCount: 1 };
        },
        async connect() {
            this.connects++;
            return { query: this.query.bind(this), release: () => this.releases++ };
        }
    };
}

test("repair recovers full saved RSS content and mixed Atom XHTML", async () => {
    assert.equal(await contentFromStoredRow(savedRow()), "Reporting from Paris.");
    assert.equal(await contentFromStoredRow(savedRow({
        item_xml: `<entry><title>News</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
            <p>First <b>bold</b> words.</p><p>Next paragraph.</p></div></content></entry>`
    })), "First bold words.\n\nNext paragraph.");
    assert.equal(await contentFromStoredRow(savedRow({ item_xml: null })), "Teaser");
});

test("repair defaults to dry run and applying it is idempotent with saved XML", async () => {
    const original = savedRow({ images: [{ url: "https://example.com/a.jpg" }], link: "https://example.com/story" });
    const database = databaseFor([original]);
    const preview = await repairContent(database);
    assert.equal(preview.changed, 1);
    assert.equal(preview.updated, 0);
    assert.equal(database.connects, 0);
    assert.deepEqual(database.rows, [original]);

    const applied = await repairContent(database, { apply: true });
    assert.equal(applied.updated, 1);
    assert.equal(database.rows[0].content, "Reporting from Paris.");
    assert.equal(database.rows[0].location_name, "Paris");
    for (const key of ["id", "title", "source", "link", "images", "item_xml"]) {
        assert.deepEqual(database.rows[0][key], original[key]);
    }
    assert.equal((await repairContent(database, { apply: true })).changed, 0);
    assert.equal(database.releases, 1);
});

test("repairs page past unchanged rows, skip malformed XML, and preserve concurrent edits", async (t) => {
    t.mock.method(console, "error", () => {});
    const database = databaseFor([
        savedRow({ id: "1", content: "Reporting from Paris." }),
        savedRow({ id: "2", item_xml: "<item>broken" }),
        savedRow({ id: "3" })
    ], { concurrent: true });
    const stats = await repairContent(database, { apply: true, batchSize: 1 });
    assert.equal(stats.scanned, 3);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.changed, 1);
    assert.equal(stats.concurrent, 1);
    assert.equal(stats.updated, 0);
    assert.equal(database.rows[2].content, "A newer poll updated this row.");
});

test("a failed repair rolls back the batch and releases its connection", async () => {
    const rows = [savedRow(), savedRow({ id: "2" })];
    const database = databaseFor(rows, { failAfter: 1 });
    await assert.rejects(repairContent(database, { apply: true }), /Database write failed/);
    assert.deepEqual(database.rows, rows);
    assert.equal(database.releases, 1);
});
