const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const projectRoot = path.join(__dirname, "..");
const mockCLI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.SFHACKS_MOCK_DIR;
const args = process.argv.slice(2);
const stateFile = path.join(directory, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile));
fs.appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify(args) + "\\n");
const command = args.slice(0, 3).join(" ");
const format = args.find((arg) => arg.startsWith("--format=")) || "";
const print = (value) => process.stdout.write(value + "\\n");
if (command === "run services describe") {
    print("app@example.iam.gserviceaccount.com");
} else if (args.includes("list")) {
    if (state.existing) print("existing-resource");
} else if (command === "compute networks subnets" && args[3] === "describe") {
    print(format.includes("ipCidrRange") ? "10.89.0.0/24" : "sfhacksxgdg2026-search");
} else if (command === "compute instances describe") {
    if (format.includes("networkIP")) print(state.wrongVM ? "10.89.0.99" : "10.89.0.10");
    else if (format.includes("serviceAccounts")) print("sfhacks-typesense@sfsu-hackathon-2026.iam.gserviceaccount.com");
    else if (format.includes("disks.source")) print("sfhacksxgdg2026-typesense-data");
    else if (format.includes("status")) print("RUNNING");
    else throw new Error("Unexpected instance description");
} else if (args[0] === "compute" && args[1] === "ssh") {
    print(JSON.stringify({ ok: !state.unhealthy }));
} else if (command === "secrets create sfhacksxgdg2026-typesense-key") {
    state.key = fs.readFileSync(0, "utf8");
    fs.writeFileSync(stateFile, JSON.stringify(state));
} else if (!args.includes("create") && !args.includes("enable") && !args.includes("add-iam-policy-binding") && command !== "run services update") {
    throw new Error("Unexpected mock command: " + JSON.stringify(args));
}
`;

function runSetup(t, state = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sfhacks-typesense-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(directory, "gcloud"), mockCLI, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "openssl"), "#!/usr/bin/env node\nprocess.stdout.write('ab'.repeat(32) + '\\n');\n", { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    const result = spawnSync("bash", ["scripts/setup-typesense.sh"], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, SFHACKS_MOCK_DIR: directory },
        timeout: 20000
    });
    const calls = fs.readFileSync(path.join(directory, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    return { result, calls, state: JSON.parse(fs.readFileSync(path.join(directory, "state.json"))) };
}

test("Typesense setup connects Cloud Run only after health passes and keeps the API key out of arguments", (t) => {
    const { result, calls, state } = runSetup(t);
    assert.equal(result.status, 0, result.stderr);
    assert.match(state.key, /^[a-f0-9]{64}$/);
    assert(!(result.stdout + result.stderr + JSON.stringify(calls)).includes(state.key));
    const vm = calls.find((args) => args.slice(0, 3).join(" ") === "compute instances create");
    assert(vm.includes("--machine-type=e2-standard-2"));
    assert(vm.includes("--image-family=cos-stable"));
    assert(vm.some((arg) => arg.includes("auto-delete=no")));
    const firewall = calls.find((args) => args.includes("sfhacksxgdg2026-typesense-private"));
    assert(firewall.includes("--source-ranges=10.89.0.0/24"));
    const deployIndex = calls.findIndex((args) => args.slice(0, 3).join(" ") === "run services update");
    assert(deployIndex > calls.findIndex((args) => args[0] === "compute" && args[1] === "ssh"));
    assert(calls[deployIndex].includes("--vpc-egress=private-ranges-only"));
    assert(calls[deployIndex].includes("--update-secrets=TYPESENSE_API_KEY=sfhacksxgdg2026-typesense-key:latest"));
});

test("Typesense setup reruns preserve existing credentials, VM, and disks", (t) => {
    const { result, calls } = runSetup(t, { existing: true });
    assert.equal(result.status, 0, result.stderr);
    assert(!calls.some((args) => args.includes("create")));
    assert(!calls.some((args) => args.includes("versions")));
    assert(calls.some((args) => args.slice(0, 3).join(" ") === "run services update"));
});

test("unhealthy Typesense and mismatched VMs leave Cloud Run untouched", (t) => {
    for (const state of [{ existing: true, unhealthy: true }, { existing: true, wrongVM: true }]) {
        const { result, calls } = runSetup(t, state);
        assert.equal(result.status, 1);
        assert(!calls.some((args) => args.slice(0, 3).join(" ") === "run services update"));
    }
});

test("Typesense startup formats only blank disks and preserves existing ext4 data", () => {
    const script = fs.readFileSync(path.join(projectRoot, "scripts/typesense-startup.sh"), "utf8");
    const diskSetup = script.slice(script.indexOf("if ! mountpoint"), script.indexOf("cat > /var/lib/typesense/start.sh"));
    for (const [signature, status, outcome] of [
        ["", 2, "FORMAT\nMOUNT\n"],
        ["UUID=existing\nTYPE=ext4", 0, "MOUNT\n"],
        ["TYPE=xfs", 0, ""],
        ["PTTYPE=gpt", 0, ""],
        ["", 4, ""]
    ]) {
        const result = spawnSync("bash", ["-c", `set -euo pipefail
            device=mock-device
            data_directory=mock-mount
            mountpoint() { return 1; }
            blkid() { printf '%s' "$SFHACKS_SIGNATURE"; return "$SFHACKS_SIGNATURE_STATUS"; }
            mkfs.ext4() { printf 'FORMAT\\n'; }
            mount() { printf 'MOUNT\\n'; }
            ${diskSetup}`], {
            encoding: "utf8",
            env: { ...process.env, SFHACKS_SIGNATURE: signature, SFHACKS_SIGNATURE_STATUS: String(status) }
        });
        assert.equal(result.stdout, outcome);
        assert.equal(result.status, outcome ? 0 : 1);
    }
});
