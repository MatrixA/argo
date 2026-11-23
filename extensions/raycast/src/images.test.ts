import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as protocol from "./protocol.js";
import * as targets from "./session-target.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5eQAAAAASUVORK5CYII=",
  "base64",
);
const require = createRequire(import.meta.url);
const source = await readFile(new URL("./images.ts", import.meta.url), "utf8");
function cache(
  root: string,
  {
    storage = new Map<string, string>(),
    now = () => Date.now(),
    allItems = async () => Object.fromEntries(storage),
    beforeUnlink,
  }: {
    storage?: Map<string, string>;
    now?: () => number;
    allItems?: () => Promise<Record<string, string>>;
    beforeUnlink?: (path: string) => Promise<void>;
  } = {},
) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } })
      .outputText,
    {
      exports,
      Buffer,
      process,
      Date: class extends Date {
        static now() {
          return now();
        }
      },
      require(name: string) {
        if (name === "@raycast/api") return { environment: { supportPath: root }, LocalStorage: { allItems } };
        if (name === "node:fs/promises" && beforeUnlink) {
          const fs = require(name) as typeof import("node:fs/promises");
          return {
            ...fs,
            unlink: async (path: import("node:fs").PathLike) => {
              await beforeUnlink(String(path));
              return fs.unlink(path);
            },
          };
        }
        if (name === "./protocol.js") return protocol;
        if (name === "./session-target.js") return targets;
        return require(name);
      },
    },
  );
  return exports as typeof import("./images.js");
}

test("image drafts keep immutable private bytes, exact metadata and the frozen recent target", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    const original = join(root, "User Screenshot.png");
    await writeFile(original, png);
    const images = cache(root);
    const target = { bindingId: "binding", profileId: "profile", connectionKey: "a".repeat(24) };
    const image = await images.importImage(original, target);
    await writeFile(original, "changed after choosing");
    const upload = await images.readImage(image.id);
    assert.deepEqual(Buffer.from(upload.data, "base64"), png);
    assert.equal(upload.mimeType, "image/png");
    assert.equal(upload.size, png.length);
    assert.deepEqual(JSON.parse(JSON.stringify((await images.getCapture(image.id)).target)), target);
    assert.equal((await images.getImage(image.id)).path, image.path);
    await images.releaseImage(image.id);
    assert.equal(await readFile(original, "utf8"), "changed after choosing", "cleanup never touches the user's file");
    assert.deepEqual(
      Buffer.from((await images.readImage(image.id)).data, "base64"),
      png,
      "another open view has a recovery window",
    );
    await writeFile(image.path, png.subarray(0, 40));
    await assert.rejects(images.readImage(image.id), /changed/);
    await assert.rejects(images.getImage("../arbitrary-file"), /Invalid image/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image picker rejects non-images, truncated images, oversized files and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    const images = cache(root);
    const original = join(root, "image.png");
    for (const invalid of [
      Buffer.from("not an image"),
      png.subarray(0, 32),
      Buffer.alloc(protocol.MAX_IMAGE_BYTES + 1),
    ]) {
      await writeFile(original, invalid);
      await assert.rejects(images.importImage(original));
    }
    await writeFile(original, png);
    await symlink(original, join(root, "link.png"));
    await assert.rejects(images.importImage(join(root, "link.png")));
    await assert.rejects(images.importImage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("region capture handles no-file cancellation, success and process failure without leaving temporary captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    const images = cache(root);
    assert.equal(await images.captureImage(async () => {}), undefined, "Esc may exit zero without creating an image");
    const image = await images.captureImage(async (path) => {
      await writeFile(path, png);
    });
    assert.ok(image);
    assert.equal((await images.readImage(image.id)).size, png.length);
    await assert.rejects(
      images.captureImage(async () => {
        throw new Error("screen recording permission denied");
      }),
      /permission denied/,
    );
    assert.ok(!(await readdir(join(root, "images-v1"))).some((file) => file.endsWith(".capture.png")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup never deletes an expired release referenced by a draft, uncertain attempt or screenshot recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    let now = Date.now();
    const storage = new Map<string, string>();
    const images = cache(root, { storage, now: () => now });
    const original = join(root, "source.png");
    await writeFile(original, png);
    const protectedImages: string[] = [];
    for (const key of [
      "draft:bridge:binding:image",
      "draft:bridge:binding:pending",
      "hc-drafts-v1:target",
      "hc-attempt-v1:target",
      "screenshot-recovery-v1",
    ]) {
      const image = await images.importImage(original);
      await images.releaseImage(image.id);
      storage.set(
        key,
        key.endsWith(":image") || key === "screenshot-recovery-v1" ? image.id : JSON.stringify({ imageId: image.id }),
      );
      protectedImages.push(image.id);
    }
    now += 8 * 86400_000;
    await images.importImage(original);
    for (const id of protectedImages) assert.equal((await images.readImage(id)).size, png.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unattached captures and legacy unreferenced imports expire while recent images and user originals remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    let now = Date.now();
    const images = cache(root, { now: () => now });
    const original = join(root, "source.png");
    await writeFile(original, png);
    const abandoned = await images.captureImage(async (path) => {
      await writeFile(path, png);
    });
    const legacy = await images.importImage(original);
    const record = join(root, "images-v1", `${legacy.id}.json`);
    const saved = JSON.parse(await readFile(record, "utf8"));
    delete saved.createdAt;
    delete saved.retainedAt;
    await writeFile(record, JSON.stringify(saved));
    await utimes(record, now / 1000, now / 1000);
    now += 6 * 86400_000;
    const recent = await images.importImage(original);
    now += 2 * 86400_000;
    await images.importImage(original);
    await assert.rejects(images.getImage(abandoned!.id), /ENOENT/);
    await assert.rejects(images.getImage(legacy.id), /ENOENT/);
    assert.equal((await images.readImage(recent.id)).size, png.length);
    assert.deepEqual(await readFile(original), png);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reattaching clears release state before a competing import and renews the persistence recovery window", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    let now = Date.now();
    const images = cache(root, { now: () => now });
    const original = join(root, "source.png");
    await writeFile(original, png);
    const image = await images.importImage(original);
    await images.releaseImage(image.id);
    now += 8 * 86400_000;
    await Promise.all([images.retainImage(image.id), images.importImage(original)]);
    const saved = JSON.parse(await readFile(join(root, "images-v1", `${image.id}.json`), "utf8"));
    assert.equal(saved.releasedAt, undefined);
    assert.equal(saved.retainedAt, now);
    now += 2 * 86400_000;
    await images.importImage(original);
    assert.equal((await images.readImage(image.id)).size, png.length);
    await images.releaseImage(image.id);
    now += 8 * 86400_000;
    await images.importImage(original);
    await assert.rejects(images.getImage(image.id), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed reference scans preserve expired images and a failed cleanup does not poison later imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  try {
    let now = Date.now(),
      fail = false;
    const images = cache(root, {
      now: () => now,
      allItems: async () => {
        if (fail) throw new Error("reference storage unavailable");
        return {};
      },
    });
    const original = join(root, "source.png");
    await writeFile(original, png);
    const image = await images.importImage(original);
    await images.releaseImage(image.id);
    now += 8 * 86400_000;
    fail = true;
    await assert.rejects(images.importImage(original), /reference storage unavailable/);
    assert.equal((await images.readImage(image.id)).size, png.length);
    fail = false;
    await images.importImage(original);
    await assert.rejects(images.getImage(image.id), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separate command instances cannot retain while cleanup has claimed an expired image", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  let resume!: () => void;
  let collecting: Promise<unknown> | undefined;
  try {
    let now = Date.now(),
      oldPath = "";
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = cache(root, {
      now: () => now,
      beforeUnlink: async (path) => {
        if (path === oldPath) {
          reached();
          await released;
        }
      },
    });
    const second = cache(root, { now: () => now });
    const original = join(root, "source.png");
    await writeFile(original, png);
    const old = await first.importImage(original);
    oldPath = old.path;
    await first.releaseImage(old.id);
    now += 8 * 86400_000;
    collecting = first.importImage(original);
    await paused;
    await assert.rejects(second.retainImage(old.id), /cache is busy/);
    resume();
    await collecting;
    const next = await second.importImage(original);
    await second.retainImage(next.id);
    assert.equal((await second.readImage(next.id)).size, png.length);
  } finally {
    resume?.();
    await collecting?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("cache transaction locks reject another process and are released automatically after process death", async () => {
  const root = await mkdtemp(join(tmpdir(), "argo-images-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const images = cache(root);
    const original = join(root, "source.png");
    await writeFile(original, png);
    await images.importImage(original);
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setInterval(() => {}, 1000);
    `,
        join(root, "images-v1", ".cache-lock.sqlite"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await once(child.stdout!, "data");
    await assert.rejects(images.importImage(original), /cache is busy/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    child = undefined;
    const next = await images.importImage(original);
    assert.equal((await images.readImage(next.id)).size, png.length);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
