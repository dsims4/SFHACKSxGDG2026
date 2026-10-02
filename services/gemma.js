const { summarizeArticle, parseSummaryText } = require("./article-summaries");

const DEFAULT_MODEL = "google/gemma-4-31B-it";
const METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

function readGemmaConfig(env = process.env) {
    if (!env.GEMMA_URL) return null;
    let url;
    try {
        url = new URL(env.GEMMA_URL);
    } catch {
        throw new Error("GEMMA_URL must be the HTTPS root URL of the Cloud Run service.");
    }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".run.app") ||
        url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
        throw new Error("GEMMA_URL must be the HTTPS root URL of the Cloud Run service.");
    }
    const timeoutMs = Number(env.GEMMA_TIMEOUT_MS ?? 900000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
        throw new Error("GEMMA_TIMEOUT_MS must be between 1000 and 3600000 milliseconds.");
    }

    const model = (env.GEMMA_MODEL ?? DEFAULT_MODEL).trim();
    if (!model) throw new Error("GEMMA_MODEL must not be empty.");

    return { url: url.origin, model, timeoutMs, idToken: env.GEMMA_ID_TOKEN || null };
}

function createGemmaGenerator(config, fetchImplementation = fetch) {
    if (!config) throw new Error("Set GEMMA_URL before requesting summaries.");

    return async function generateText(prompt, { model = config.model, signal } = {}) {
        if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A nonempty prompt is required.");
        const timeout = AbortSignal.timeout(config.timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        requestSignal.throwIfAborted();
        let token = config.idToken;

        if (!token) {
            const identityURL = new URL(METADATA_IDENTITY_URL);
            identityURL.searchParams.set("audience", config.url);
            identityURL.searchParams.set("format", "full");
            const identity = await fetchImplementation(identityURL.href, {
                headers: { "Metadata-Flavor": "Google" },
                signal: AbortSignal.any([requestSignal, AbortSignal.timeout(10000)]),
                redirect: "error"
            });
            if (!identity.ok) {
                await identity.body?.cancel();
                throw new Error(`Cloud Run identity token request failed: HTTP ${identity.status}.`);
            }
            token = (await identity.text()).trim();
        }
        if (!token || /\s/.test(token)) throw new Error("Cloud Run identity token is missing or invalid.");

        const response = await fetchImplementation(`${config.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            signal: requestSignal,
            redirect: "error",
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2,
                max_tokens: 1024,
                stream: false,
                chat_template_kwargs: { enable_thinking: false },
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "article_summary",
                        strict: true,
                        schema: {
                            type: "array", minItems: 5, maxItems: 5,
                            items: { type: "string", minLength: 1 }
                        }
                    }
                }
            })
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Gemma inference failed: HTTP ${response.status}.`);
        }
        const result = await response.json();
        const choice = result?.choices?.[0];
        if (choice?.finish_reason !== "stop") {
            throw new Error("Gemma did not return a completed summary.");
        }

        // vLLM returns message.content; normalize it to our existing { text } contract.
        const summary = parseSummaryText(choice.message?.content);
        return { text: JSON.stringify(summary) };
    };
}

async function summarizeWithGemma(database, articleId, env = process.env) {
    const config = readGemmaConfig(env);
    const generateText = createGemmaGenerator(config);
    return summarizeArticle(database, articleId, { generateText, model: config.model });
}

module.exports = { DEFAULT_MODEL, readGemmaConfig, createGemmaGenerator, summarizeWithGemma };
