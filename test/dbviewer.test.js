const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseDbViewerQuery, buildFilters, searchEntries, listSources } = require("../routes/dbviewer");

test("database viewer query keeps only known filters", () => {
    assert.deepEqual(parseDbViewerQuery({}), {
        page: 1,
        q: "",
        source: "",
        start: "",
        end: "",
        hasLocation: "",
        sort: "date_desc",
        perPage: 25
    });
    assert.deepEqual(parseDbViewerQuery({
        page: "0",
        q: "  paris  ",
        source: " Reuters ",
        start: "2026-01-01",
        end: "2026-13-40",
        hasLocation: "sideways",
        sort: "source_asc;drop",
        perPage: "1000"
    }), {
        page: 1,
        q: "paris",
        source: "Reuters",
        start: "2026-01-01",
        end: "",
        hasLocation: "",
        sort: "date_desc",
        perPage: 25
    });
    assert.equal(parseDbViewerQuery({ page: "999999" }).page, 10000);
    assert.equal(parseDbViewerQuery({ q: "x".repeat(250) }).q.length, 200);
    assert.equal(parseDbViewerQuery({ sort: "source_asc", perPage: "10", hasLocation: "false" }).sort, "source_asc");
});

test("filters are parameterized and sort stays on the whitelist", () => {
    const filters = buildFilters(parseDbViewerQuery({
        q: "50%",
        source: "BBC News",
        start: "2026-01-01",
        end: "2026-02-01",
        hasLocation: "true"
    }));

    assert.deepEqual(filters.params, ["50%", "BBC News", "2026-01-01", "2026-02-01"]);
    assert.match(filters.where, /position\(lower\(\$1::text\)/);
    assert.match(filters.where, /source = \$2/);
    assert.match(filters.where, /publication_date::date >= \$3::date/);
    assert.match(filters.where, /publication_date::date <= \$4::date/);
    assert.match(filters.where, /has_location = TRUE/);
    assert.doesNotMatch(filters.where, /50%/);
});

test("searchEntries pages stories and drops unsafe links", async () => {
    const calls = [];
    const pool = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes("COUNT")) return { rows: [{ total: 30 }] };
            return {
                rows: [{
                    id: 4,
                    title: null,
                    content: "Body",
                    source: "Reuters",
                    publication_date: new Date("2026-03-01T12:00:00.000Z"),
                    link: "javascript:alert(1)",
                    location_name: "Paris",
                    location_country: "France",
                    has_location: false
                }]
            };
        }
    };

    const result = await searchEntries(pool, {
        page: "2",
        q: "paris",
        sort: "id_desc",
        perPage: "10"
    });

    assert.match(calls[1].sql, /ORDER BY id DESC/);
    assert.deepEqual(calls[1].params, ["paris", 10, 10]);
    assert.equal(result.total, 30);
    assert.equal(result.page, 2);
    assert.equal(result.pageCount, 3);
    assert.equal(result.rows[0].title, "—");
    assert.equal(result.rows[0].link, null);
    assert.equal(result.rows[0].location, "Paris — France");
    assert.equal(result.rows[0].published, "2026-03-01 12:00:00Z");
    assert.equal(result.rows[0].hasLocation, false);
    assert.equal(result.nextHref, "/dbviewer?q=paris&sort=id_desc&perPage=10&page=3");
});

test("listSources returns distinct source names", async () => {
    const pool = {
        async query() {
            return { rows: [{ source: "BBC News" }, { source: "Reuters" }] };
        }
    };

    assert.deepEqual(await listSources(pool), ["BBC News", "Reuters"]);
});
