// Genuine published Electron 0.1.10 -> native Rust migration. Only release HTTP
// responses are replaced; the old updater, helper and app are left unchanged.
import { _electron as electron } from '@playwright/test';
import { access, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { coreClient, fixture, cleanFixture } from './rust-core-smoke.mjs';

assert.equal(process.platform, 'darwin', 'Run this verification on macOS with a built native update ZIP');
assert.ok(process.env.MUSICBOARD_NATIVE_EXECUTABLE, 'Set MUSICBOARD_NATIVE_EXECUTABLE to the newly built signed Contents/MacOS/SONO');
const exec = promisify(execFile), releases = 'https://github.com/contentriumkorea/MusicBoard/releases';
const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const oldVersion = '0.1.10', maxArchive = 2 * 1024 ** 3;
const nativeExecutable = await realpath(process.env.MUSICBOARD_NATIVE_EXECUTABLE);
const legacyReleases = 'https://github.com/contentriumkorea/SONO/releases';
const archive = await realpath(path.resolve(`release/MusicBoard-${version}-mac-universal.zip`));
const f = await fixture(), target = path.join(f.dir, 'Applications', 'MusicBoard.app');
const installedExecutable = path.join(target, 'Contents', 'MacOS', 'SONO');
const plist = path.join(target, 'Contents', 'Info.plist'), cache = path.join(f.data, 'mac-updates');
const resultFile = path.join(f.data, 'native-result.json');
let application, page, core, installedPid, updateStarted = false;
const exists = file => access(file).then(() => true, () => false);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(callback, timeout = 120000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {
    try { return await callback(); } catch (error) { last = error; }
    await pause(200);
  }
  throw last || Error('Migration verification timed out');
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function field(key) {
  return (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
}
async function ownedProcesses() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command=']);
  return stdout.split('\n').map(line => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), command: match[2] }))
    .filter(({ pid, command }) => pid > 1 && (command === installedExecutable || command.startsWith(installedExecutable + ' ')));
}
async function stopOwnedProcesses() {
  // Check the complete, fixture-specific executable path immediately before
  // each signal; never find or kill the user's app by product/process name.
  for (const { pid } of await ownedProcesses()) {
    const command = await exec('/bin/ps', ['-p', String(pid), '-o', 'command=']).then(r => r.stdout.trim(), () => '');
    if (command === installedExecutable || command.startsWith(installedExecutable + ' ')) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  await eventually(async () => assert.equal((await ownedProcesses()).length, 0, 'Fixture native app did not stop'), 15000);
}
async function downloadPublishedApp() {
  const metadataUrl = `https://api.github.com/repos/contentriumkorea/MusicBoard/releases/tags/v${oldVersion}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'MusicBoard-Rust-migration-QA' };
  // Readonly CI token is sent to the canonical API only, never printed or
  // forwarded to asset redirects.
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(metadataUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Published release metadata HTTP ${response.status}`);
  const release = await response.json();
  assert.equal(release.tag_name, `v${oldVersion}`); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert.equal(release.html_url, `${releases}/tag/v${oldVersion}`);
  const name = `MusicBoard-${oldVersion}-mac-universal.zip`;
  const matches = release.assets.filter(asset => asset.name === name); assert.equal(matches.length, 1);
  const asset = matches[0], url = `${releases}/download/v${oldVersion}/${name}`;
  assert.equal(asset.browser_download_url, url);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxArchive, 'Invalid published archive size');
  assert.match(asset.digest, /^sha256:[a-f\d]{64}$/i);
  const downloaded = await fetch(url, { signal: AbortSignal.timeout(600000) });
  assert.equal(downloaded.status, 200, `Published archive HTTP ${downloaded.status}`); assert.ok(downloaded.body);
  if (downloaded.headers.has('content-length')) assert.equal(Number(downloaded.headers.get('content-length')), asset.size);
  const hash = createHash('sha256'); let received = 0;
  const zip = path.join(f.dir, 'published-0.1.11.zip');
  await pipeline(Readable.fromWeb(downloaded.body), new Transform({
    transform(bytes, _encoding, callback) {
      received += bytes.length;
      if (received > asset.size || received > maxArchive) return callback(Error('Published archive exceeds declared size'));
      hash.update(bytes); callback(null, bytes);
    }
  }), createWriteStream(zip, { flags: 'wx', mode: 0o600 }));
  assert.equal(received, asset.size); assert.equal(hash.digest('hex'), asset.digest.slice(7).toLowerCase());
  const listing = (await exec('/usr/bin/unzip', ['-Z1', zip], { maxBuffer: 8 * 1024 ** 2 })).stdout;
  const entries = listing.split('\n').filter(Boolean); assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(/^(MusicBoard\.app\/|__MACOSX\/)/.test(entry), 'Unexpected published ZIP root');
    assert.equal(entry.includes('\\'), false);
    assert.ok(entry.replace(/\/$/, '').split('/').every(component => component && component !== '.' && component !== '..'), 'Unsafe published ZIP entry');
  }
  await mkdir(path.dirname(target), { recursive: true });
  await exec('/usr/bin/ditto', ['-x', '-k', zip, path.dirname(target)]);
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  assert.equal(await field('CFBundleShortVersionString'), oldVersion);
  assert.equal(await field('CFBundleIdentifier'), 'local.luma.music');
  assert.equal(await field('CFBundleExecutable'), 'SONO');
  assert.equal(await exists(path.join(target, 'Contents', 'Resources', 'app.asar')), true, 'Published baseline must be Electron');
}

try {
  core = coreClient(nativeExecutable, f.data);
  const imported = await core.call('music:paths', { paths: [f.folder] }); assert.equal(imported.added, 3);
  const seeded = imported.state;
  const [a, b, c] = f.files.map(file => seeded.tracks.find(track => track.path === file));
  assert.ok(a && b && c);
  b.favorite = true; b.displayName = '기존 표시 이름'; c.trim = { start: 1, end: 10 };
  seeded.settings.volume = .43; seeded.settings.fadeOut = 1.2;
  seeded.folders = [{ id: 'native-group-one', name: 'Native group one' }, { id: 'native-group-two', name: 'Native group two' }];
  seeded.tracks.forEach((track, index) => { track.folderId = index === 2 ? 'native-group-two' : 'native-group-one'; });
  seeded.settings.librarySort = 'manual';
  seeded.playlists = [{ id: 'legacy-list', name: '이전 재생목록', trackIds: [b.id] }];
  await core.call('state:save', { state: seeded });
  const before = (await core.call('state:get')).state;
  assert.equal(before.tracks.find(track => track.id === b.id).favorite, true);
  await core.close(); core = undefined;
  const audioHashes = await Promise.all(f.files.map(sha256));
  await downloadPublishedApp();

  const archiveSize = (await stat(archive)).size; assert.ok(archiveSize > 0 && archiveSize <= maxArchive);
  const archiveHash = await sha256(archive), name = path.basename(archive);
  const release = { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${legacyReleases}/tag/v${version}`,
    assets: [{ name: `MusicBoard-${version}-mac-universal.dmg` },
      { name, browser_download_url: `${legacyReleases}/download/v${version}/${name}`, size: archiveSize, digest: `sha256:${archiveHash}` }] };
  const env = { ...f.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.LUMA_DEV_URL;
  application = await electron.launch({ executablePath: installedExecutable, args: [], env, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(90000);
  await page.getByRole('heading', { name: '내 음악.' }).waitFor();
  await page.getByRole('button', { name: '기존 표시 이름', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), oldVersion);
  const oldUpdater = await page.evaluate(async () => window.luma.getUpdateState());
  assert.equal(oldUpdater.mode, 'automatic'); assert.equal(oldUpdater.releasesUrl, legacyReleases);
  const legacyLoaded = await page.evaluate(async () => (await window.luma.getState()).state);
  assert.equal(legacyLoaded.tracks.find(track => track.id === b.id).displayName, '기존 표시 이름');
  assert.deepEqual(legacyLoaded.playlists, before.playlists);
  await application.evaluate(({ net }, { release, archive }) => {
    const original = net.fetch.bind(net), fs = process.getBuiltinModule('fs'), { Readable } = process.getBuiltinModule('stream');
    net.fetch = async (url, init) => {
      if (url === 'https://api.github.com/repos/contentriumkorea/SONO/releases/latest') return new Response(JSON.stringify(release));
      if (url === release.assets[1].browser_download_url) return new Response(Readable.toWeb(fs.createReadStream(archive)));
      return original(url, init);
    };
  }, { release, archive });
  await page.getByRole('button', { name: '업데이트', exact: true }).click();
  await page.getByRole('button', { name: '지금 업데이트', exact: true }).waitFor();
  const closed = new Promise(resolve => application.once('close', resolve));
  updateStarted = true;
  await page.getByRole('button', { name: '지금 업데이트', exact: true }).click();
  let closeTimer;
  try {
    await Promise.race([closed, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(Error('Published Electron app did not quit after update')), 90000); })]);
  } finally { clearTimeout(closeTimer); }
  application = undefined;

  const token = await eventually(async () => {
    const tokens = (await readdir(cache)).filter(name => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(name));
    assert.equal(tokens.length, 1, 'Expected exactly one real updater workspace'); return tokens[0];
  });
  const workspace = path.join(cache, token);
  await eventually(async () => assert.equal((await readFile(path.join(workspace, 'status'), 'utf8')).trim(), 'installed'));
  assert.equal(await readFile(path.join(workspace, 'health'), 'utf8'), version);
  installedPid = Number((await readFile(path.join(workspace, 'app.pid'), 'utf8')).trim());
  assert.ok(Number.isSafeInteger(installedPid) && installedPid > 1); process.kill(installedPid, 0);
  assert.ok((await ownedProcesses()).some(process => process.pid === installedPid), 'Health PID must run the exact temporary installed bundle');
  assert.equal(await field('CFBundleShortVersionString'), version);
  assert.equal(await field('CFBundleIdentifier'), 'local.luma.music'); assert.equal(await field('CFBundleExecutable'), 'SONO');
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  assert.equal(await exists(path.join(target, 'Contents', 'Resources', 'app.asar')), false, 'Installed update must use native Rust');
  const frameworks = await readdir(path.join(target, 'Contents', 'Frameworks')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.ok(!frameworks.some(name => /^Electron\s*Framework(?:\.framework)?$/i.test(name)), 'Electron framework remains in installed native bundle');
  assert.equal(await exists(`${target}.sono-backup-${token}`), false, 'Successful migration should remove the rollback backup');

  const result = await eventually(async () => JSON.parse(await readFile(resultFile, 'utf8')), 180000);
  assert.equal(result.passed, true, JSON.stringify(result)); assert.ok(Array.isArray(result.checks) && result.checks.length >= 5);
  const initial = result.initial; assert.ok(initial && Array.isArray(initial.tracks), 'Native QA must record state before editing it');
  assert.deepEqual(initial.ids, before.tracks.map(track => track.id));
  assert.deepEqual(initial.names, before.tracks.map(track => track.displayName || track.title));
  assert.deepEqual(initial.settings, before.settings); assert.deepEqual(initial.playlists, before.playlists);
  assert.deepEqual(initial.trim, before.tracks.map(track => track.trim ?? null));
  const initialB = initial.tracks.find(track => track.id === b.id), initialC = initial.tracks.find(track => track.id === c.id);
  assert.equal(initialB.displayName, '기존 표시 이름'); assert.equal(initialB.favorite, true);
  assert.deepEqual(initialC.trim, { start: 1, end: 10 });
  assert.equal(initial.settings.volume, .43); assert.equal(initial.settings.fadeOut, 1.2);
  for (const check of result.checks) console.log('PASS migrated ' + check);
  assert.deepEqual(await Promise.all(f.files.map(sha256)), audioHashes, 'Migration and native UI must preserve every original audio byte');
  console.log(`PASS published Electron ${oldVersion} -> Rust ${version}: one update click, replacement, restart and data preservation`);

  await stopOwnedProcesses();
  core = coreClient(installedExecutable, f.data);
  const update = await core.call('update:get');
  assert.equal(update.version, version); assert.equal(update.mode, 'automatic'); assert.equal(update.releasesUrl, releases);
  await core.close(); core = undefined;
  console.log('PASS installed Rust executable keeps the canonical automatic update channel; no Electron runtime or source audio changes');
} catch (error) {
  for (const token of await readdir(cache).catch(() => [])) {
    if (!/^[a-f\d-]{36}$/.test(token)) continue;
    for (const name of ['status', 'install.log', 'app.log']) {
      const text = await readFile(path.join(cache, token, name), 'utf8').catch(() => '<absent>');
      console.error(`Migration fixture ${name}: ${text.slice(-6000)}`);
    }
  }
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  if (core) await core.close().catch(() => {});
  // A failed health check may still be rolling back. Give the fixture helper
  // its bounded rollback window before terminating its exact temporary app.
  if (updateStarted) {
    await eventually(async () => {
      for (const token of await readdir(cache).catch(() => [])) {
        if (!/^[a-f\d-]{36}$/.test(token)) continue;
        const status = await readFile(path.join(cache, token, 'status'), 'utf8').catch(() => '');
        assert.ok(['installed', 'rollback'].includes(status.trim()), 'Fixture helper is still running');
      }
    }, 45000).catch(() => {});
  }
  await stopOwnedProcesses();
  await cleanFixture(f.dir);
}
