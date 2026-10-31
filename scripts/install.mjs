#!/usr/bin/env node
// Standalone public installer: no project imports, credentials, settings edits, or Agent startup.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const RELEASE = 'https://github.com/MatrixA/argo/releases/download/v0.1.2/';
const ARCHIVE = 'argo-connector.tar.gz';
const MAX_ARCHIVE = 16 * 1024 * 1024, MAX_TAR = 32 * 1024 * 1024;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function releaseUrl(value) {
  const url = new URL(value);
  const assetHost = ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !(assetHost || (url.origin === 'https://github.com' && url.pathname.startsWith(new URL(RELEASE).pathname)))) throw new Error('Refusing a non-GitHub release download URL');
  return url;
}

// Injection is import-only for isolated tests, never a CLI/environment URL override.
export async function download(url, limit, fetchImpl = fetch) {
  let target = releaseUrl(url);
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(target.href, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Release redirect has no location');
      target = releaseUrl(new URL(location, target).href);
      continue;
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`Public release download failed (${response.status}); no credentials are needed`); }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body.cancel(); throw new Error('Release download exceeds size limit'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) { throw new Error('Release download exceeds size limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many release redirects');
}

const allowedFile = path => ['package.json', 'package-lock.json', 'LICENSE', 'bin/argo.mjs', 'skills/argo-bind/SKILL.md'].includes(path) || /^dist\/packages\/(bridge|connector|shared)\/src\/[a-z][a-z0-9-]*\.js$/.test(path);
const requiredFiles = ['package.json', 'package-lock.json', 'LICENSE', 'bin/argo.mjs', 'skills/argo-bind/SKILL.md', 'dist/packages/connector/src/cli.js'];

// Accept only the tiny USTAR subset our release builder emits. Validate before invoking tar.
export function validateArchive(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_TAR });
  const files = new Set();
  const octal = field => {
    const value = field.toString('ascii').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('Invalid tar numeric field');
    return Number.parseInt(value, 8);
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length < offset + 1024 || tar.subarray(offset).some(byte => byte !== 0)) throw new Error('Invalid tar trailer');
      for (const path of requiredFiles) if (!files.has(path)) throw new Error(`Incomplete connector release: ${path}`);
      return tar;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum || header.subarray(257, 263).toString() !== 'ustar\0') throw new Error('Invalid USTAR header');
    const field = (start, end) => {
      const bytes = header.subarray(start, end);
      const nul = bytes.indexOf(0), content = nul < 0 ? bytes : bytes.subarray(0, nul);
      if (content.some(byte => byte < 32 || byte > 126) || (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0))) throw new Error('Invalid tar path encoding');
      return content.toString('ascii');
    };
    const name = field(0, 100), prefix = field(345, 500), path = prefix ? prefix + '/' + name : name;
    const type = header[156], size = octal(header.subarray(124, 136));
    if ((type !== 0 && type !== 48) || !allowedFile(path) || files.has(path) || size > MAX_TAR || (octal(header.subarray(100, 108)) & 0o7000)) throw new Error('Unsafe or unexpected archive entry');
    if (header.subarray(157, 257).some(byte => byte !== 0)) throw new Error('Archive links are forbidden');
    files.add(path);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > tar.length) throw new Error('Truncated connector archive');
  }
  throw new Error('Missing tar trailer');
}

export function connectionUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the forwarded loopback HTTP URL, e.g. http://127.0.0.1:49123');
  return url.origin;
}

export async function install({ url, name = 'backend', agent = 'claude' }, { home = homedir(), fetchImpl = fetch } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js 22.13 or later is required; no system packages were changed');
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Agent must be claude or codex');
  url = connectionUrl(url);
  if (!name.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Name must contain 1–100 printable characters');
  execFileSync('tar', ['--version'], { stdio: 'ignore' });
  execFileSync('npm', ['--version'], { stdio: 'ignore' });
  const sums = (await download(RELEASE + 'SHA256SUMS', 16_384, fetchImpl)).toString('utf8');
  const matches = sums.split(/\r?\n/).map(line => /^([a-f0-9]{64})  argo-connector\.tar\.gz$/.exec(line)).filter(Boolean);
  if (matches.length !== 1) throw new Error('SHA256SUMS must contain exactly one connector archive checksum');
  const archive = await download(RELEASE + ARCHIVE, MAX_ARCHIVE, fetchImpl);
  if (createHash('sha256').update(archive).digest('hex') !== matches[0][1]) throw new Error('Connector SHA-256 mismatch; nothing installed');
  const tar = validateArchive(archive);
  const releases = join(resolve(home), '.local/share/argo/releases');
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(releases, '.install-')); chmodSync(stage, 0o700);
  const id = randomUUID(), release = join(releases, id), skill = 'argo-remote-' + id;
  const skillDir = join(resolve(home), '.claude/skills', skill), credential = join(release, 'credential.json');
  let moved = false, skillCreated = false;
  try {
    const unpack = join(stage, 'package'); mkdirSync(unpack, { mode: 0o700 });
    const tarFile = join(stage, 'connector.tar'); writeFileSync(tarFile, tar, { flag: 'wx', mode: 0o600 });
    execFileSync('tar', ['-xf', tarFile, '-C', unpack], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'ignore' });
    const manifest = JSON.parse(readFileSync(join(unpack, 'package.json'), 'utf8'));
    if (manifest.version !== '0.1.2' || manifest.workspaces || manifest.scripts || manifest.devDependencies) throw new Error('Expected a sanitized v0.1.2 connector package');
    // npm rejects loading one path as both user and global config; keep both empty and private.
    for (const file of ['user.npmrc', 'global.npmrc']) writeFileSync(join(stage, file), '', { flag: 'wx', mode: 0o600 });
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--workspaces=false', '--no-audit', '--no-fund', '--userconfig=' + join(stage, 'user.npmrc'), '--globalconfig=' + join(stage, 'global.npmrc')], { cwd: unpack, stdio: ['ignore', 'inherit', 'inherit'], timeout: 180_000 });
    renameSync(unpack, release); moved = true; chmodSync(release, 0o700);
    const command = quote(process.execPath) + ' ' + quote(join(release, 'bin/argo.mjs'));
    const claim = `${command} claim --url ${quote(url)} --stdin --out ${quote(credential)}`;
    if (agent === 'codex') return { version: '0.1.2', adapter: agent, release, launcher: join(release, 'bin/argo.mjs'), credential, claim };
    const template = readFileSync(join(release, 'skills/argo-bind/SKILL.md'), 'utf8');
    if (!template.includes('name: argo-bind') || !template.includes('argo attach --name backend')) throw new Error('Unexpected polling skill template');
    let rendered = template.replace('name: argo-bind', 'name: ' + skill);
    rendered = rendered.replace(/\bargo (?=attach|next|ack|reply|leave)/g, command + ' ');
    rendered = rendered.replace(/ attach --name backend/g, ' attach --credential ' + quote(credential) + ' --name ' + quote(name));
    rendered = rendered.replace('Use the installed `argo` command, or the absolute `node /path/to/argo/bin/argo.mjs` launcher supplied with this skill. Run:', 'Use only the absolute launcher and scoped credential below. Never run local attach without --credential, serve, pair, or init on this remote machine. Run:');
    rendered = rendered.replace('Local attach uses private bridge configuration automatically to authorize one binding. For a remote machine, use `--credential /private/path/to/paired.json` with the pre-paired connector credential. Never copy the bridge\'s admin credential to the remote machine. A forwarded port is still loopback.', 'This remote skill uses only the claimed scoped credential. Never read it into context or copy the bridge admin credential. A forwarded port is still loopback.');
    rendered = rendered.replace('## Attach', `## Claim first (once)\n\nBefore attaching, claim the short-lived one-time pairing code explicitly supplied by the user from their Mac. Pass this one-use code through stdin, never command arguments or diagnostic output. It is not the durable connector credential; never read credential files or request the bridge admin token. If the user has not supplied a code, ask them to supply it privately or claim in their own terminal.\n\nClaim command (stdin must be privately supplied; never run with empty stdin):\n\n\`\`\`sh\n${claim}\n\`\`\`\n\nIf ${quote(credential)} does not exist, execute claim directly in this session using a single-quoted heredoc containing the user-provided one-time code, or redirect a user-supplied private code file without reading it. If no code is supplied, let the user complete claim privately. If claim fails or expires, request a fresh code. Do not attach or start polling until claim succeeds. Never overwrite an existing credential or fall back to local admin setup.\n\n## Attach`);
    mkdirSync(dirname(skillDir), { recursive: true, mode: 0o700 });
    mkdirSync(skillDir, { mode: 0o700 }); skillCreated = true;
    writeFileSync(join(skillDir, 'SKILL.md'), rendered, { flag: 'wx', mode: 0o600 });
    return { version: '0.1.2', adapter: agent, release, launcher: join(release, 'bin/argo.mjs'), skill, skillFile: join(skillDir, 'SKILL.md'), credential, claim };
  } catch (error) {
    if (skillCreated) rmSync(skillDir, { recursive: true, force: true });
    if (moved) rmSync(release, { recursive: true, force: true });
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({ options: { url: { type: 'string' }, name: { type: 'string' }, agent: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node install.mjs --url http://127.0.0.1:49123 [--name backend] [--agent claude|codex]\nAgent defaults to claude; codex installs runtime only, no Claude skill.\nDownloads pinned public v0.1.2 code; does not claim, attach, poll, or start an Agent.');
    else {
      if (!values.url) throw new Error('Missing --url (forwarded loopback bridge address)');
      const result = await install({ url: values.url, name: values.name, agent: values.agent });
      console.log('ARGO_INSTALL_READY ' + JSON.stringify(result));
      console.log(`Installed only. Privately supply the one-time ${result.adapter} pairing code on stdin to:\n${result.claim}`);
      if (result.adapter === 'codex') console.log('No Claude skill, Codex/model, or daemon was started. After claim, use this launcher with connect --credential FILE --thread EXACT_CURRENT_CODEX_THREAD_ID to join an already-loaded thread; keep the connector process alive. Installation alone is not a connection.');
      else console.log(`Then use /${result.skill} in THIS existing Claude session. No Agent was started; pull works only while it keeps waiting.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
