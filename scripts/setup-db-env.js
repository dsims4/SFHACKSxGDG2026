const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dotenv = require("dotenv");

function buildDatabaseURL(env, password) {
    if (!password) throw new Error("The database password secret is empty.");
    const host = env.DB_HOST || "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
        throw new Error("DB_HOST must point to the local Cloud SQL Auth Proxy.");
    }
    const port = Number(env.DB_PORT || "5433");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("DB_PORT must be an integer from 1 through 65535.");
    }

    const url = new URL(`postgresql://${host === "::1" ? "[::1]" : host}:${port}`);
    url.username = encodeURIComponent(env.DB_USER || "timeline");
    url.password = encodeURIComponent(password);
    url.pathname = `/${encodeURIComponent(env.DB_NAME || "timeline")}`;
    return url.href;
}

function main() {
    const root = path.join(__dirname, "..");
    const target = path.join(root, ".env.local");
    if (fs.existsSync(target)) {
        throw new Error(".env.local already exists. Keep it, or move it aside before generating new credentials.");
    }
    dotenv.config({ path: path.join(root, ".env"), quiet: true });
    const project = process.env.GCP_PROJECT_ID;
    const secret = process.env.DB_PASSWORD_SECRET;
    if (!project || !secret) throw new Error("GCP_PROJECT_ID and DB_PASSWORD_SECRET must be configured in .env.");

    let password;
    try {
        password = execFileSync("gcloud", [
            "secrets", "versions", "access", "latest",
            `--project=${project}`, `--secret=${secret}`
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    } catch (error) {
        if (error.code === "ENOENT") throw new Error("gcloud must be available before running db:env.");
        throw new Error("Could not retrieve the database password. Sign in with gcloud auth login and ask for Secret Manager access.");
    }

    const databaseURL = buildDatabaseURL(process.env, password);
    fs.writeFileSync(target, `# Generated database credentials. This file is ignored by Git.\nDATABASE_URL=${databaseURL}\n`, {
        mode: 0o600,
        flag: "wx"
    });
    console.log("Created .env.local with database credentials. Start the Cloud SQL Auth Proxy before running npm start.");
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error("Database environment setup failed:", error.message);
        process.exitCode = 1;
    }
}

module.exports = { buildDatabaseURL };
