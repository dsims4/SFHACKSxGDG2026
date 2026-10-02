const { readGemmaConfig, createGemmaGenerator } = require("../services/gemma");
const { buildSummaryPrompt, parseSummaryText } = require("../services/article-summaries");

async function main() {
    const config = readGemmaConfig();
    const generateText = createGemmaGenerator(config);
    const response = await generateText(buildSummaryPrompt({
        id: "1",
        content: "A public library opened Monday. It has 200 seats. Admission is free. It offers computer classes. It closes at 6 p.m."
    }));
    const summary = parseSummaryText(response.text);
    console.log(`Gemma inference passed: ${summary.length} JSON summary bullets received.`);
}

main().catch((error) => {
    console.error("Gemma check failed:", error.message);
    process.exitCode = 1;
});
