import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
function cache(root: string) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } })
      .outputText,
    {
      exports,
      Buffer,
      process,
      Date,
      require(name: string) {
        if (name === "@raycast/api") return { environment: { supportPath: root } };
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
