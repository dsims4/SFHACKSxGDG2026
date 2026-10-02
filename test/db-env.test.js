const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildDatabaseURL } = require("../scripts/setup-db-env");

test("database environment generation safely encodes passwords and names", () => {
    const password = "secret:@/#%? space\n";
    const connection = new URL(buildDatabaseURL({ DB_USER: "reader:name", DB_NAME: "shared/data" }, password));
    assert.equal(connection.hostname, "127.0.0.1");
    assert.equal(connection.port, "5433");
    assert.equal(decodeURIComponent(connection.username), "reader:name");
    assert.equal(decodeURIComponent(connection.password), password);
    assert.equal(decodeURIComponent(connection.pathname), "/shared/data");
    assert(!connection.href.includes("\n"));
});

test("database environment generation requires a secret and a local proxy endpoint", () => {
    assert.throws(() => buildDatabaseURL({}, ""), /secret is empty/);
    assert.throws(() => buildDatabaseURL({ DB_HOST: "34.94.72.124" }, "password"), /local Cloud SQL Auth Proxy/);
    assert.throws(() => buildDatabaseURL({ DB_PORT: "0" }, "password"), /DB_PORT/);
    assert.throws(() => buildDatabaseURL({ DB_PORT: "5433.5" }, "password"), /DB_PORT/);
    assert.equal(new URL(buildDatabaseURL({ DB_HOST: "::1" }, "password")).hostname, "[::1]");
});
