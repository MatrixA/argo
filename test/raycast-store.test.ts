import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Raycast Store source is self-contained and its protocol snapshot matches the bridge", () => {
  execFileSync(process.execPath, ["scripts/sync-raycast-protocol.mjs", "--check"]);
  for (const file of readdirSync("extensions/raycast/src")) {
    if (!/\.tsx?$/.test(file)) continue;
    assert.ok(!readFileSync(`extensions/raycast/src/${file}`, "utf8").includes("../../../"), `${file} must not depend on the enclosing repository`);
  }
});

test("cold-start guide preserves the standalone terminal endpoint handoff", () => {
  const guide = readFileSync("docs/server-setup.md", "utf8");
  assert.ok(guide.includes("Print the exact `url` from `ARGO_SERVER_READY` on its own line"));
  assert.ok(guide.includes("terminal output and the final response"));
  assert.ok(guide.includes("automatic forwarding is enabled"));
});

test("Store export contains only standalone public inputs and never overwrites a destination", () => {
  const parent = mkdtempSync(join(tmpdir(), "argo-store-export-"));
  const target = join(parent, "argo");
  try {
    execFileSync(process.execPath, ["scripts/prepare-raycast-store.mjs", target]);
    const manifest = readFileSync(join(target, "package.json"), "utf8");
    assert.equal(JSON.parse(manifest).private, undefined);
    assert.equal(JSON.parse(manifest).scripts.build, "ray build -e dist");
    assert.deepEqual(readdirSync(target).sort(), [".prettierignore", ".prettierrc.json", "CHANGELOG.md", "README.md", "assets", "eslint.config.mjs", "metadata", "package-lock.json", "package.json", "src", "tsconfig.json"].sort());
    assert.throws(() => execFileSync(process.execPath, ["scripts/prepare-raycast-store.mjs", target], { stdio: "pipe" }), /Command failed/);
    assert.equal(readFileSync(join(target, "package.json"), "utf8"), manifest);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
