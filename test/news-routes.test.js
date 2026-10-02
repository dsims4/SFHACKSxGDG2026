const test = require("node:test");
const assert = require("node:assert/strict");
const { createNewsRouter } = require("../routes/news");

async function request(path, { params = {}, query = {}, rows = [] } = {}) {
    const calls = [];
    const router = createNewsRouter({ query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows };
    } });
    const layer = router.stack.find((item) => item.route &&
        (Array.isArray(item.route.path) ? item.route.path.includes(path) : item.route.path === path));
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
    await layer.route.stack[0].handle({ path, params, query }, response);
    return { ...response, calls };
}
const summary = ["One", "Two", "Three", "Four", "Five"];

test("feed cards expose five numbered events and preserve string IDs", async () => {
    const result = await request("/feed", { query: { date: "2026-10-02" }, rows: [
        { id: "9223372036854775807", topic: "economics", date: "2026-10-02", summary }
    ] });
    assert.equal(result.body.cards[0].id, "9223372036854775807");
    assert.deepEqual(result.body.cards[0].events, summary.map((text, index) => ({ event: index + 1, text })));
    assert.deepEqual(result.calls[0].values, ["2026-10-02"]);
    assert.deepEqual((await request("/feed")).body.cards, []);
});

test("topic page supplies summary and selected event with parameterized filtering", async () => {
    const row = { id: "1", topic: "economics", date: "2026-10-02", summary, articles: [] };
    const result = await request("/topics/:id", { params: { id: "1" }, query: { event: "3" }, rows: [row] });
    assert.deepEqual(result.calls[0].values, ["1", 3]);
    assert.equal(result.body.selected_event, 3);
    assert.deepEqual(result.body.summary, summary);
    assert.deepEqual(result.body.articles, []);
    const unfiltered = await request("/topics/:id", { params: { id: "1" }, rows: [row] });
    assert.deepEqual(unfiltered.calls[0].values, ["1", null]);
});

test("bad dates, IDs and repeated/out-of-range events fail before querying", async () => {
    for (const date of ["2026-02-30", "not-a-date", ["2026-10-02"]]) {
        const result = await request("/feed", { query: { date } });
        assert.equal(result.statusCode, 400);
        assert.equal(result.calls.length, 0);
    }
    for (const event of ["0", "6", "1 OR true", ["1", "2"]]) {
        const result = await request("/topics/:id", { params: { id: "1" }, query: { event } });
        assert.equal(result.statusCode, 400);
        assert.equal(result.calls.length, 0);
    }
    assert.equal((await request("/topics/:id", { params: { id: "0" } })).statusCode, 400);
    assert.equal((await request("/topics/:id", { params: { id: "1" } })).statusCode, 404);
    assert.equal((await request("/articles/:id", { params: { id: "1" } })).statusCode, 404);
});

test("article page returns stored summary and images without model invocation", async () => {
    const row = { id: "7", topic: "science", title: "Discovery", link: "https://example.com", images: [], summary };
    const result = await request("/articles/:id", { params: { id: "7" }, rows: [row] });
    assert.deepEqual(result.body, row);
});
