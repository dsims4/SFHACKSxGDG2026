const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseViewerQuery, likePattern, listEntries } = require("../routes/viewer");

test("viewer query parsing rejects invalid pages and trims search text", () => {
    assert.deepEqual(parseViewerQuery({}), { page: 1, q: "", sort: "published", dir: "desc" });
    assert.deepEqual(parseViewerQuery({ page: "0", q: "  paris  " }), {
        page: 1,
        q: "paris",
        sort: "published",
        dir: "desc"
    });
    assert.equal(parseViewerQuery({ page: "999999" }).page, 10000);
    assert.equal(parseViewerQuery({ q: "x".repeat(250) }).q.length, 200);
    assert.deepEqual(parseViewerQuery({ sort: "source;drop", dir: "sideways" }), {
        page: 1,
        q: "",
        sort: "published",
        dir: "desc"
    });
    assert.deepEqual(parseViewerQuery({ sort: "source", dir: "desc" }), {
        page: 1,
        q: "",
        sort: "source",
        dir: "desc"
    });
});

test("search text is escaped for LIKE patterns", () => {
    assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
});

test("listEntries pages stored stories and drops unsafe links", async () => {
    const calls = [];
    const pool = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes("COUNT")) return { rows: [{ total: 30 }] };
            return {
                rows: [{
                    id: 7,
                    title: null,
                    content: "Body",
                    source: "Reuters",
                    publication_date: new Date("2026-01-02T00:00:00.000Z"),
                    link: "javascript:alert(1)",
                    location_name: "Paris",
                    location_country: "France"
                }]
            };
        }
    };

    const result = await listEntries(pool, { page: 2, q: "50%_off" });

    assert.equal(calls[0].params[0], "%50\\%\\_off%");
    assert.match(calls[1].sql, /ORDER BY publication_date DESC NULLS LAST, id DESC/);
    assert.match(calls[1].sql, /location_name/);
    assert.deepEqual(calls[1].params.slice(1), [25, 25]);
    assert.equal(result.total, 30);
    assert.equal(result.pageCount, 2);
    assert.equal(result.entries[0].title, "(untitled)");
    assert.equal(result.entries[0].link, null);
    assert.equal(result.entries[0].location, "Paris, France");
    assert.equal(result.entries[0].published, "2026-01-02T00:00:00.000Z");
    assert.equal(result.sort, "published");
    assert.equal(result.columns[1].href, "/viewer?q=50%25_off&sort=source");
    assert.equal(result.nextHref, "/viewer?q=50%25_off&page=3");
});

test("listEntries sorts by an allowed column and keeps the search", async () => {
    let order = "";
    const pool = {
        async query(sql) {
            order = sql;
            if (sql.includes("COUNT")) return { rows: [{ total: 1 }] };
            return { rows: [] };
        }
    };

    const result = await listEntries(pool, { page: 1, q: "paris", sort: "title", dir: "asc" });

    assert.match(order, /ORDER BY title ASC NULLS LAST, id DESC/);
    assert.equal(result.columns.find((column) => column.key === "title").ariaSort, "ascending");
    assert.equal(result.columns.find((column) => column.key === "title").href, "/viewer?q=paris&sort=title&dir=desc");
});
