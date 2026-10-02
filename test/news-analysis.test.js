const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArticle, parseTopic, analyzePending } = require("../services/news-analysis");
const { validID } = require("../routes/news");

test("article analysis requires a known topic and five summary strings", () => {
    const summary = ["one", "two", "three", "four", "five"];
    assert.deepEqual(parseArticle(JSON.stringify({ topics: ["economics"], summary })), { topics: ["economics"], summary });
    assert.throws(() => parseArticle(JSON.stringify({ topics: ["made-up"], summary })));
    assert.throws(() => parseArticle(JSON.stringify({ topics: ["economics"], summary: [1] })));
});

test("topic citations must reference supplied article IDs and preserve bigint precision", () => {
    const id = "9223372036854775807";
    const bullets = Array.from({ length: 5 }, () => ({ text: "Fact", article_ids: [id, id] }));
    assert.deepEqual(parseTopic(JSON.stringify({ bullets }), [{ id }])[0].article_ids, [id]);
    bullets[0].article_ids = ["2"];
    assert.throws(() => parseTopic(JSON.stringify({ bullets }), [{ id }]));
    bullets[0].article_ids = [];
    assert.throws(() => parseTopic(JSON.stringify({ bullets }), [{ id }]));
    assert.equal(validID(id), true);
    assert.equal(validID("9223372036854775808"), false);
    assert.equal(validID("1 OR true"), false);
});

test("invalid model output is never persisted", async () => {
    const statements = [];
    const client = { query: async (sql) => {
        statements.push(sql);
        return { rows: statements.length === 1 ? [{ id: "1", content: "News" }] : [] };
    } };
    await analyzePending(client, async () => ({ text: '{"topic":"economics","summary":[]}' }), "gemma");
    assert.equal(statements.length, 2);
    assert.ok(statements.every((sql) => !sql.includes("INSERT")));
});

test("topic persistence rolls back if citation insertion fails", async () => {
    const statements = [];
    const client = { query: async (sql) => {
        statements.push(sql);
        if (sql.includes("GROUP BY")) return { rows: [{ topic: "economics", date: "2026-10-02" }] };
        if (sql.includes("SELECT e.id::text")) return { rows: [{ id: "1", summary: ["A", "B", "C", "D", "E"] }] };
        if (sql.includes("INSERT INTO topic_summaries")) return { rows: [{ id: "9" }] };
        if (sql.includes("INSERT INTO topic_bullet_articles")) throw new Error("Foreign key failure");
        return { rows: [] };
    } };
    const bullets = Array.from({ length: 5 }, () => ({ text: "Fact", article_ids: ["1"] }));
    await analyzePending(client, async (prompt, { schema }) => {
        // The deployed vLLM grammar rejects uniqueItems; parseTopic deduplicates IDs.
        assert.equal(JSON.stringify(schema).includes('"uniqueItems"'), false);
        return { text: JSON.stringify({ bullets }) };
    }, "gemma");
    assert.ok(statements.includes("ROLLBACK"));
    assert.ok(!statements.includes("COMMIT"));
});


test("articles can cover several topics and duplicate labels are removed", () => {
    const result = parseArticle(JSON.stringify({
        topics: ["economics", "environment", "economics"],
        summary: ["One", "Two", "Three", "Four", "Five"]
    }));
    assert.deepEqual(result.topics, ["economics", "environment"]);
    assert.throws(() => parseArticle(JSON.stringify({ topics: [], summary: result.summary })));
    assert.throws(() => parseArticle(JSON.stringify({ topics: ["science", "unknown"], summary: result.summary })));
});


test("topic summaries may be empty or partial without empty bullet slots", () => {
    assert.deepEqual(parseTopic('{"bullets":[]}', []), []);
    assert.deepEqual(parseTopic(JSON.stringify({ bullets: [
        { text: "", article_ids: [] },
        { text: "Supported fact", article_ids: ["7"] }
    ] }), [{ id: "7" }]), [{ text: "Supported fact", article_ids: ["7"] }]);
});
