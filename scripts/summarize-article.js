const path = require("node:path");
require("dotenv").config({
    path: [path.join(__dirname, "..", ".env.local"), path.join(__dirname, "..", ".env")]
});
const { readDatabaseConfig, createDatabasePool, initializeSchema } = require("../services/db");
const { summarizeWithGemma, readGemmaConfig } = require("../services/gemma");

async function main() {
    const [articleId, extra] = process.argv.slice(2);
    if (!articleId || extra) throw new Error("Usage: npm run summarize -- ARTICLE_ID");
    const config = readDatabaseConfig();
    if (!config) throw new Error("Configure PostgreSQL before summarizing an article.");
    if (!readGemmaConfig()) throw new Error("Set GEMMA_URL before summarizing an article.");
    const database = createDatabasePool(config);

    try {
        await initializeSchema(database);
        const saved = await summarizeWithGemma(database, articleId);
        console.log(JSON.stringify({ article_id: saved.article_id, summary: saved.summary }));
    } finally {
        await database.end();
    }
}

main().catch((error) => {
    console.error("Summarization failed:", error.message);
    process.exitCode = 1;
});
