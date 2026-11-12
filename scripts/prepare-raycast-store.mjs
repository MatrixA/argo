// Export only reviewed public extension files. Does not publish or open a PR.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "extensions/raycast");
if (process.argv.length !== 3) throw new Error("Usage: node scripts/prepare-raycast-store.mjs /ABSOLUTE/FRESH/argo");
execFileSync(process.execPath, [join(root, "scripts/sync-raycast-protocol.mjs"), "--check"]);
const files = ["package.json", "package-lock.json", "README.md", "CHANGELOG.md", "tsconfig.json", "eslint.config.mjs", ".prettierrc.json", ".prettierignore"];
function collect(directory) {
  for (const name of readdirSync(join(source, directory))) {
    const path = join(directory, name), stat = lstatSync(join(source, path));
    if (stat.isSymbolicLink()) throw new Error(`No symlinks allowed: ${path}`);
    if (stat.isDirectory()) collect(path);
    else if (stat.isFile() && !name.endsWith(".test.ts")) files.push(path);
    else if (stat.isFile()) continue;
    else throw new Error(`Unexpected input: ${path}`);
  }
}
for (const directory of ["src", "assets", "metadata"]) collect(directory);
for (const file of files) {
  if (!lstatSync(join(source, file)).isFile()) throw new Error(`Not a regular file: ${file}`);
}
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
if (manifest.private || manifest.workspaces) throw new Error("Expected standalone public extension manifest");
const target = resolve(process.argv[2]);
mkdirSync(target); // Exclusive: never overwrite a previous preparation or checkout.
for (const file of files) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  copyFileSync(join(source, file), join(target, file));
}
// Keep development tests in Argo, but omit their command and runner from the Store.
delete manifest.scripts.test;
delete manifest.devDependencies.tsx;
writeFileSync(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
// Reconcile the copied lock without upgrading packages or running install scripts.
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--workspaces=false", "--offline", "--no-audit", "--no-fund"], { cwd: target, stdio: "pipe" });
console.log(`Prepared standalone Store source: ${target}`);
console.log("Not submitted. Run repository tests separately, then npm ci, npm run lint and npm run build in the export before review.");
