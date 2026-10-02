const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const projectRoot = path.join(__dirname, "..");
const mockCLI = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.SFHACKS_GEMMA_MOCK_DIR;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(directory, "state.json")));
fs.appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify(args) + "\\n");
const command = args.slice(0, 3).join(" ");
const format = args.find((arg) => arg.startsWith("--format=")) || "";
const print = (value) => process.stdout.write(value + "\\n");
if (command === "run services describe") {
    print(format.includes("status.url") ? "https://test-gemma-example.run.app" : "app@example.iam.gserviceaccount.com");
} else if (args.includes("list")) {
    if (state.existing) print("existing-resource");
} else if (command === "storage buckets describe") {
    print(state.wrongRegion ? "US-WEST2" : "US-CENTRAL1");
} else if (command === "compute networks subnets" && args[3] === "describe") {
    print(format.includes("ipCidrRange") ? "10.90.0.0/24" : "sfhacksxgdg2026-gemma");
} else if (args[0] === "builds" && args[1] === "submit") {
    if (state.copyFails) process.exit(2);
} else if (args[0] === "auth" && args[1] === "print-identity-token") {
    print("private-test-identity-token");
} else if (!args.some((arg) => ["create", "enable", "update", "add-iam-policy-binding", "deploy"].includes(arg))) {
    throw new Error("Unexpected mock command: " + JSON.stringify(args));
}
`;

function runSetup(t, state = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sfhacks-gemma-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(directory, "gcloud"), mockCLI, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "node"), `#!${process.execPath}
        const fs = require("node:fs");
        const path = require("node:path");
        const directory = process.env.SFHACKS_GEMMA_MOCK_DIR;
        const state = JSON.parse(fs.readFileSync(path.join(directory, "state.json")));
        if (!process.argv[2].endsWith("/scripts/check-gemma.js")) process.exit(3);
        if (process.env.GEMMA_ID_TOKEN !== "private-test-identity-token") process.exit(4);
        if (process.env.GEMMA_URL !== "https://test-gemma-example.run.app") process.exit(5);
        fs.appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify(["smoke-check"]) + "\\n");
        process.exit(state.inferenceFails ? 1 : 0);
    `, { mode: 0o700 });
    const result = spawnSync("bash", ["scripts/setup-gemma.sh"], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, SFHACKS_GEMMA_MOCK_DIR: directory }
    });
    const calls = fs.readFileSync(path.join(directory, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    return { result, calls };
}

test("Gemma setup deploys an authenticated GPU service and only connects the app after inference succeeds", (t) => {
    const { result, calls } = runSetup(t);
    assert.equal(result.status, 0, result.stderr);
    const build = calls.find((args) => args[0] === "builds");
    assert(build.includes("--no-source"));
    assert(build.some((arg) => arg.includes("sfhacks-gemma-copy@")));
    const deploy = calls.find((args) => args.slice(0, 3).join(" ") === "beta run deploy");
    for (const option of ["--region=us-central1", "--gpu-type=nvidia-rtx-pro-6000", "--cpu=20", "--memory=80Gi",
        "--no-allow-unauthenticated", "--invoker-iam-check", "--min=0", "--max=1", "--max-instances=1", "--vpc-egress=all-traffic"]) {
        assert(deploy.includes(option), option);
    }
    const args = deploy.find((arg) => arg.startsWith("--args="));
    assert(args.includes("--served-model-name=google/gemma-4-31B-it"));
    assert(args.includes("--load-format=runai_streamer"));
    assert(calls.some((args) => args.includes("--role=roles/run.invoker") && args.includes("--member=serviceAccount:app@example.iam.gserviceaccount.com")));
    const appUpdate = calls.findIndex((args) => args.slice(0, 3).join(" ") === "run services update");
    assert(appUpdate > calls.findIndex((args) => args[0] === "smoke-check"));
    assert(calls[appUpdate].includes("--region=us-west2"));
    assert(!(result.stdout + result.stderr + JSON.stringify(calls)).includes("private-test-identity-token"));
});

test("Gemma setup reuses existing resources without recreating accounts, storage, or networking", (t) => {
    const { result, calls } = runSetup(t, { existing: true });
    assert.equal(result.status, 0, result.stderr);
    assert(!calls.some((args) => args.includes("create")));
    assert(calls.some((args) => args[0] === "builds" && args[1] === "submit"));
});

test("Gemma setup stops before changing the app when storage, copying, or inference fails", (t) => {
    for (const state of [{ existing: true, wrongRegion: true }, { existing: true, copyFails: true }, { existing: true, inferenceFails: true }]) {
        const { result, calls } = runSetup(t, state);
        assert.notEqual(result.status, 0);
        assert(!calls.some((args) => args.slice(0, 3).join(" ") === "run services update"));
        if (state.copyFails || state.wrongRegion) {
            assert(!calls.some((args) => args.slice(0, 3).join(" ") === "beta run deploy"));
        }
    }
});
