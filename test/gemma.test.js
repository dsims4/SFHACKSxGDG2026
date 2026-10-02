const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DEFAULT_MODEL, readGemmaConfig, createGemmaGenerator, summarizeWithGemma } = require("../services/gemma");

const serviceURL = "https://test-gemma-example.run.app";
const bullets = ["First", "Second", "Third", "Fourth", "Fifth"];
const completed = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(bullets) } }] });

test("Gemma stays optional and configuration requires a Cloud Run HTTPS root URL", () => {
    assert.equal(readGemmaConfig({}), null);
    assert.throws(() => createGemmaGenerator(null), /GEMMA_URL/);
    assert.deepEqual(readGemmaConfig({ GEMMA_URL: `${serviceURL}/` }), {
        url: serviceURL, model: DEFAULT_MODEL, timeoutMs: 900000, idToken: null
    });
    for (const url of ["invalid", "http://test.run.app", "https://example.com", `${serviceURL}/v1`, `${serviceURL}?key=x`, "https://user:secret@test.run.app"]) {
        assert.throws(() => readGemmaConfig({ GEMMA_URL: url }), /GEMMA_URL/);
    }
    for (const timeout of ["0", "100.5", "abc", "3600001"]) {
        assert.throws(() => readGemmaConfig({ GEMMA_URL: serviceURL, GEMMA_TIMEOUT_MS: timeout }), /GEMMA_TIMEOUT_MS/);
    }
});

test("the adapter obtains a correctly scoped identity token and normalizes structured vLLM output", async () => {
    const calls = [];
    const generateText = createGemmaGenerator(readGemmaConfig({ GEMMA_URL: serviceURL }), async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
            const identityURL = new URL(url);
            assert.equal(identityURL.hostname, "metadata.google.internal");
            assert.equal(identityURL.searchParams.get("audience"), serviceURL);
            assert.equal(options.headers["Metadata-Flavor"], "Google");
            assert.equal(options.redirect, "error");
            return new Response("short-lived-test-token");
        }
        assert.equal(url, `${serviceURL}/v1/chat/completions`);
        assert.equal(options.headers.Authorization, "Bearer short-lived-test-token");
        assert.equal(options.redirect, "error");
        const request = JSON.parse(options.body);
        assert.equal(request.model, DEFAULT_MODEL);
        assert.deepEqual(request.messages, [{ role: "user", content: "Summarize the article" }]);
        assert.equal(request.chat_template_kwargs.enable_thinking, false);
        assert.equal(request.stream, false);
        assert.deepEqual(request.response_format.json_schema.schema, {
            type: "array", minItems: 0, maxItems: 5, items: { type: "string", minLength: 1 }
        });
        return completed();
    });
    assert.deepEqual(await generateText("Summarize the article"), { text: JSON.stringify(bullets) });
    assert.equal(calls.length, 2);
});

test("a local identity token bypasses metadata and cancellation prevents any requests", async () => {
    let calls = 0;
    const config = readGemmaConfig({ GEMMA_URL: serviceURL, GEMMA_ID_TOKEN: "local-test-token" });
    const generateText = createGemmaGenerator(config, async (url, options) => {
        calls++;
        assert.equal(url, `${serviceURL}/v1/chat/completions`);
        assert.equal(options.headers.Authorization, "Bearer local-test-token");
        return completed();
    });
    await generateText("Article");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(generateText("Article", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("metadata failures prevent inference and upstream errors do not disclose response bodies", async () => {
    let calls = 0;
    const noIdentity = createGemmaGenerator(readGemmaConfig({ GEMMA_URL: serviceURL }), async () => {
        calls++;
        return new Response("private error details", { status: 403 });
    });
    await assert.rejects(noIdentity("Article"), /identity token request failed: HTTP 403/);
    assert.equal(calls, 1);
    const denied = createGemmaGenerator(readGemmaConfig({ GEMMA_URL: serviceURL, GEMMA_ID_TOKEN: "test" }), async () =>
        new Response("private article content", { status: 503 }));
    await assert.rejects(denied("Article"), (error) => error.message === "Gemma inference failed: HTTP 503.");
});

test("truncated, malformed, and invalid model responses are rejected", async () => {
    for (const choice of [
        { finish_reason: "length", message: { content: JSON.stringify(bullets) } },
        { finish_reason: "stop", message: { content: "{}" } },
        { finish_reason: "stop", message: { content: "not JSON" } },
        { finish_reason: "stop", message: {} },
        {}
    ]) {
        const generateText = createGemmaGenerator(readGemmaConfig({ GEMMA_URL: serviceURL, GEMMA_ID_TOKEN: "test" }), async () =>
            Response.json({ choices: [choice] }));
        await assert.rejects(generateText("Article"));
    }
});

test("the Gemma helper uses the existing summary persistence flow", async (t) => {
    const queries = [];
    const database = {
        async query(sql, values) {
            queries.push({ sql, values });
            return { rows: queries.length === 1
                ? [{ id: "42", content: "<p>Article</p>" }]
                : [{ article_id: values[0], summary: JSON.parse(values[1]) }] };
        }
    };
    t.mock.method(globalThis, "fetch", async () => completed());
    const saved = await summarizeWithGemma(database, "42", { GEMMA_URL: serviceURL, GEMMA_ID_TOKEN: "test" });
    assert.deepEqual(saved, { article_id: "42", summary: bullets });
    assert.equal(queries[1].values[2], DEFAULT_MODEL);
});
