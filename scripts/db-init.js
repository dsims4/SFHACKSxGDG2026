const path = require("node:path");
require("dotenv").config({
    path: [path.join(__dirname, "..", ".env.local"), path.join(__dirname, "..", ".env")]
});
const { readDatabaseConfig, createDatabasePool, initializeSchema } = require("../services/db");

async function main() {
    const config = readDatabaseConfig();
    if (!config) throw new Error("Configure DATABASE_URL or INSTANCE_CONNECTION_NAME before initializing PostgreSQL.");
    const database = createDatabasePool(config);

    try {
        await initializeSchema(database);
        console.log("PostgreSQL database initialized.");
    } finally {
        await database.end();
    }
}

main().catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exitCode = 1;
});
