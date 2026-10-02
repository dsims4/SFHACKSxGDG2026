const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { Pool } = require("pg");

function readDatabaseConfig(env = process.env) {
    if (env.INSTANCE_CONNECTION_NAME) {
        if (!/^[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/.test(env.INSTANCE_CONNECTION_NAME)) {
            throw new Error("INSTANCE_CONNECTION_NAME must use project:region:instance format.");
        }
        if (!env.DB_PASSWORD) throw new Error("DB_PASSWORD is required for Cloud SQL.");

        return {
            host: `/cloudsql/${env.INSTANCE_CONNECTION_NAME}`,
            database: env.DB_NAME || "timeline",
            user: env.DB_USER || "timeline",
            password: env.DB_PASSWORD
        };
    }

    return env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : null;
}

function createDatabasePool(config) {
    const database = new Pool({
        ...config,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        max: 2
    });
    database.on("error", (error) => console.error("Database connection error:", error.message));
    return database;
}

async function initializeSchema(database) {
    const schema = await fs.readFile(path.join(__dirname, "..", "rss-builder", "schema.sql"), "utf8");
    const client = await database.connect();

    try {
        await client.query("BEGIN");
        // Serialize schema changes when Cloud Run starts multiple instances.
        await client.query("SELECT pg_advisory_xact_lock(2026, 1)");
        await client.query(schema);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function waitForDatabase(database, signal) {
    while (!signal.aborted) {
        try {
            await initializeSchema(database);
            return;
        } catch (error) {
            if (signal.aborted) return;
            console.error("Database initialization failed; retrying:", error.message);
        }

        try {
            await sleep(3000, undefined, { signal });
        } catch (error) {
            if (!signal.aborted) throw error;
        }
    }
}

module.exports = { readDatabaseConfig, createDatabasePool, initializeSchema, waitForDatabase };
