import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { LAST_CONVERSATION_KEY, parseSessionTarget } from "./session-target.js";

const source = readFileSync(new URL("./screenshot.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;

test("screenshot command freezes the recent session before hiding Raycast and only opens the recent conversation after capture", async () => {
  for (const outcome of ["success", "cancel", "permission", "launch-failure"] as const) {
    const data = new Map([
      [
        LAST_CONVERSATION_KEY,
        JSON.stringify({ profileId: "frozen", bindingId: "target", connectionKey: "a".repeat(24) }),
      ],
    ]);
    const events: string[] = [];
    const contexts: any[] = [];
    let captures = 0;
    let retry = false;
    const api = {
      LocalStorage: {
        async getItem(key: string) {
          return data.get(key);
        },
        async setItem(key: string, value: string) {
          data.set(key, value);
        },
        async removeItem(key: string) {
          data.delete(key);
        },
      },
      PopToRootType: { Suspended: "suspended" },
      LaunchType: { UserInitiated: "user" },
      async closeMainWindow(options: unknown) {
        assert.equal(JSON.stringify(options), '{"popToRootType":"suspended"}');
        events.push("hide");
        data.delete(LAST_CONVERSATION_KEY);
      },
      async launchCommand(options: any) {
        events.push("open");
        contexts.push(options.context);
        assert.equal(options.name, "recent");
        if (outcome === "launch-failure" && !retry) throw new Error("launch failed");
      },
      async showHUD(message: string) {
        events.push(message);
      },
    };
    const exports: any = {};
    runInNewContext(code, {
      exports,
      require(name: string) {
        if (name === "@raycast/api") return api;
        if (name === "node:util") return { promisify: (fn: any) => fn };
        if (name === "node:child_process")
          return {
            async execFile(executable: string, args: string[]) {
              events.push("capture");
              assert.equal(executable, "/usr/sbin/screencapture");
              assert.deepEqual(Array.from(args), ["-i", "-s", "-x", "-t", "png", "/private/generated.png"]);
              if (outcome === "permission") throw new Error("permission denied");
            },
          };
        if (name === "./images.js")
          return {
            async captureImage(run: (path: string) => Promise<void>, target: any) {
              captures++;
              assert.equal(target.profileId, "frozen");
              await run("/private/generated.png");
              return outcome === "cancel" ? undefined : { id: "11111111-1111-4111-a111-111111111111" };
            },
            async getCapture(id: string) {
              assert.equal(id, "11111111-1111-4111-a111-111111111111");
              return {};
            },
          };
        if (name === "./session-target.js") return { LAST_CONVERSATION_KEY, parseSessionTarget };
        throw new Error(`Unexpected dependency ${name}`);
      },
    });
    await exports.default();
    assert.deepEqual(events.slice(0, 2), ["hide", "capture"]);
    assert.equal(contexts.length, ["success", "launch-failure"].includes(outcome) ? 1 : 0);
    if (outcome === "launch-failure") {
      assert.match(events.at(-1)!, /Screenshot saved/);
      retry = true;
      await exports.default();
      assert.equal(captures, 1, "retry restores the saved capture without overwriting it");
      assert.equal(contexts.length, 2);
      assert.ok(!data.has("screenshot-recovery-v1"));
    }
    if (outcome === "cancel") assert.equal(events.length, 2, "cancel sends and opens nothing");
    if (outcome === "permission") assert.match(events.at(-1)!, /Screen Recording/);
  }
});
