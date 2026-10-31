#!/usr/bin/env node
// Public code only. Never package a working tree, credential, or remote-setup manifest wholesale.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const manifestKeys = ['name', 'version', 'private', 'type', 'engines', 'bin', 'dependencies', 'overrides'];
const lockKeys = ['version', 'resolved', 'integrity', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc', 'optional', 'devOptional', 'hasInstallScript', 'license', 'bin'];
const pick = (object, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
function regular(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Release input must be a regular file: ${path}`);
  return readFileSync(path);
}

export function buildRelease({ root = resolve(fileURLToPath(new URL('..', import.meta.url))), out }) {
  root = resolve(root); out = resolve(out);
  const packageJson = JSON.parse(regular(join(root, 'package.json')));
  if (packageJson.version !== '0.1.0') throw new Error('Update the pinned installer before releasing another version');
  const manifest = pick(packageJson, manifestKeys);
  const sourceLock = JSON.parse(regular(join(root, 'package-lock.json')));
  if (sourceLock.lockfileVersion !== 3) throw new Error('Expected npm lockfile version 3');
  const packages = { '': pick(manifest, ['name', 'version', 'dependencies', 'engines', 'bin']) };
  for (const [path, entry] of Object.entries(sourceLock.packages)) {
    if (!path.startsWith('node_modules/') || entry.dev || entry.link) continue;
    if (entry.resolved) {
      const url = new URL(entry.resolved);
      if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash || !entry.integrity) throw new Error(`Non-public dependency: ${path}`);
    }
    packages[path] = pick(entry, lockKeys);
  }
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(tmpdir(), 'argo-public-release-'));
  const archive = join(out, 'argo-connector.tar.gz');
  const sums = join(out, 'SHA256SUMS'), installer = join(out, 'install.mjs');
  // Reserve outputs without ever replacing an existing release artifact.
  const created = [];
  try {
    for (const path of [archive, sums, installer]) { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); created.push(path); }
    const files = ['package.json', 'package-lock.json', 'LICENSE', 'bin/argo.mjs', 'skills/argo-bind/SKILL.md'];
    for (const area of ['bridge', 'connector', 'shared']) {
      const directory = join(root, 'dist/packages', area, 'src');
      if (!lstatSync(directory).isDirectory()) throw new Error('Build the project before packaging');
      for (const name of readdirSync(directory).sort()) {
        if (/^[a-z][a-z0-9-]*\.js$/.test(name)) files.push(`dist/packages/${area}/src/${name}`);
      }
    }
    if (!files.includes('dist/packages/connector/src/cli.js')) throw new Error('Run npm run build first');
    for (const path of files) {
      mkdirSync(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
      const content = path === 'package.json' ? JSON.stringify(manifest, null, 2) + '\n' : path === 'package-lock.json' ? JSON.stringify(lock, null, 2) + '\n' : regular(join(root, path));
      writeFileSync(join(stage, path), content, { flag: 'wx', mode: 0o600 });
    }
    const bsd = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('bsdtar');
    const owner = bsd ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'] : ['--owner=0', '--group=0', '--numeric-owner'];
    execFileSync('tar', ['--format=ustar', ...owner, '-czf', archive, '-C', stage, ...files.sort()], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    writeFileSync(installer, regular(join(root, 'scripts/install.mjs')));
    const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    writeFileSync(sums, `${sha(archive)}  argo-connector.tar.gz\n${sha(installer)}  install.mjs\n`);
    return { archive, sums, installer };
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } } });
    if (!values.out) throw new Error('Usage: node scripts/package-release.mjs --out /private/fresh-release [--root /absolute/argo]');
    console.log(JSON.stringify(buildRelease({ root: values.root, out: values.out }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
