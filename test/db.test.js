const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readDatabaseConfig, initializeSchema, waitForDatabase } = require("../services/db");
const { readConfig } = require("../rss-builder/rss_builder");

test("PostgreSQL accepts local URLs or Cloud SQL sockets and requires a Cloud SQL password", () => {
    assert.equal(readDatabaseConfig({}), null);
    const url = "postgresql://localhost/timeline?sslmode=verify-full";
    assert.deepEqual(readDatabaseConfig({ DATABASE_URL: url }), { connectionString: url });
    const env = {
        INSTANCE_CONNECTION_NAME: "sfsu-hackathon-2026:us-west2:sfhacksxgdg2026-db",
        DATABASE_URL: "unused",
        DB_PASSWORD: "test-password"
    };
    assert.deepEqual(readDatabaseConfig(env), {
        host: `/cloudsql/${env.INSTANCE_CONNECTION_NAME}`,
        database: "timeline",
        user: "timeline",
        password: "test-password"
    });
    assert.equal(readDatabaseConfig({ ...env, DB_NAME: "other", DB_USER: "reader" }).user, "reader");
    assert.throws(() => readDatabaseConfig({ ...env, DB_PASSWORD: "" }), /DB_PASSWORD/);
    assert.throws(() => readDatabaseConfig({ ...env, INSTANCE_CONNECTION_NAME: "bad/name" }), /project:region:instance/);
    assert.equal(readConfig(env).databaseConfig.host, `/cloudsql/${env.INSTANCE_CONNECTION_NAME}`);
    assert.equal(readConfig(env).typesenseAPIKey, null);
    assert.equal(readConfig({ ...env, TYPESENSE_API_KEY: "key" }).databaseConfig.host, `/cloudsql/${env.INSTANCE_CONNECTION_NAME}`);
});

test("schema initialization serializes concurrent startups and rolls back failed changes", async () => {
    const queries = [];
    let released = 0;
    let failSchema = false;
    const database = {
        async connect() {
            return {
                async query(sql) {
                    queries.push(sql);
                    if (failSchema && sql.includes("CREATE TABLE")) throw new Error("Schema failed");
                },
                release() { released++; }
            };
        }
    };
    await initializeSchema(database);
    assert.equal(queries[0], "BEGIN");
    assert.match(queries[1], /pg_advisory_xact_lock/);
    assert.match(queries[2], /publication_date TIMESTAMPTZ/);
    assert.equal(queries.at(-1), "COMMIT");
    assert.equal(released, 1);
    failSchema = true;
    await assert.rejects(initializeSchema(database), /Schema failed/);
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.equal(released, 2);
});

test("shutdown cancels database initialization retries", async (t) => {
    const controller = new AbortController();
    let connections = 0;
    t.mock.method(console, "error", () => controller.abort());
    await waitForDatabase({
        async connect() {
            connections++;
            throw new Error("Unavailable");
        }
    }, controller.signal);
    assert.equal(connections, 1);
});
