// Real NSIS 0.1.11 -> native 0.2.0 upgrade in a disposable GitHub Windows runner.
// Refuse a workstation or an existing registration rather than redirecting an
// installed user's app through the compatibility GUID during this test.
import assert from 'node:assert/strict';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { coreClient, fixture, cleanFixture } from './rust-core-smoke.mjs';

assert.equal(process.platform, 'win32', 'Run this verification only in Windows CI');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This installer test requires an isolated GitHub Actions runner');
assert.ok(process.env.MUSICBOARD_NATIVE_EXECUTABLE, 'Set MUSICBOARD_NATIVE_EXECUTABLE to the newly built native SONO.exe');
const nativeExecutable = await realpath(process.env.MUSICBOARD_NATIVE_EXECUTABLE);
const newInstaller = await realpath(path.resolve('release/MusicBoard-0.2.0-windows-x64-setup.exe'));
const releases = 'https://github.com/contentriumkorea/MusicBoard/releases';
const oldVersion = '0.1.11', version = '0.2.0', maxArchive = 2 * 1024 ** 3;
const f = await fixture(), installDir = path.join(f.dir, 'Applications', 'MusicBoard');
const executable = path.join(installDir, 'SONO.exe'), resultFile = path.join(f.data, 'native-result.json');
const env = { ...f.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.LUMA_DEV_URL;
delete env.PSModulePath;
const exists = file => access(file).then(() => true, () => false);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let core, baselineRegistration, nativeUi, installationAttempted = false, uiLogs = '';

// electron-builder NSIS uses UUID.v5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3).
const guidBytes = createHash('sha1').update(Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')).update('local.luma.music').digest().subarray(0, 16);
guidBytes[6] = (guidBytes[6] & 15) | 0x50; guidBytes[8] = (guidBytes[8] & 63) | 0x80;
const guidHex = guidBytes.toString('hex'), guid = `${guidHex.slice(0, 8)}-${guidHex.slice(8, 12)}-${guidHex.slice(12, 16)}-${guidHex.slice(16, 20)}-${guidHex.slice(20)}`;

async function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(Error(`${path.basename(command)} exited ${code}: ${stderr.slice(-3000)}`)));
  });
}
async function powershell(source, extraEnv = {}) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ' + source], extraEnv);
}
async function registrations() {
  const source = '$items=@(); foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view); try{$key=$base.OpenSubKey("Software\\"+$env:MUSICBOARD_QA_GUID); $uninstall=$base.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+$env:MUSICBOARD_QA_GUID); if($null -ne $key -or $null -ne $uninstall){$location=$null; $version=$null; if($null -ne $key){$location=$key.GetValue("InstallLocation");$key.Dispose()}; if($null -ne $uninstall){$version=$uninstall.GetValue("DisplayVersion");$uninstall.Dispose()};$items+=@{hive=$hive.ToString();view=$view.ToString();location=$location;version=$version}}}finally{$base.Dispose()}}}; ConvertTo-Json -Compress -InputObject @($items)';
  return JSON.parse(await powershell(source, { MUSICBOARD_QA_GUID: guid }));
}
async function ownedProcesses() {
  const source = '$items=@(Get-CimInstance Win32_Process | Where-Object {[String]::Equals($_.ExecutablePath,$env:MUSICBOARD_QA_PROCESS,[StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {@{pid=$_.ProcessId;path=$_.ExecutablePath}});ConvertTo-Json -Compress -InputObject $items';
  return JSON.parse(await powershell(source, { MUSICBOARD_QA_PROCESS: executable }));
}
async function eventually(callback, timeout = 180000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { return await callback(); } catch (error) { last = error; } await pause(250); }
  throw last || Error('Windows upgrade verification timed out');
}
async function stopOwnedProcesses() {
  for (const item of await ownedProcesses()) {
    // Re-read the exact executable path immediately before each signal.
    if ((await ownedProcesses()).some(process => process.pid === item.pid && path.resolve(process.path).toLowerCase() === executable.toLowerCase())) {
      try { process.kill(item.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  await eventually(async () => assert.equal((await ownedProcesses()).length, 0, 'Fixture native process did not stop'), 15000);
}
async function hash(file) {
  const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex');
}
function assertFixtureRegistrations(items, expectedVersion) {
  assert.ok(items.length > 0, 'Installer must register the existing compatibility GUID');
  for (const item of items) {
    assert.equal(item.hive, 'CurrentUser', 'This test must install only for the disposable CI user');
    assert.equal(path.resolve(item.location || '').toLowerCase(), installDir.toLowerCase(), 'Installer registration must point only at the fixture');
    assert.equal(item.version, expectedVersion);
  }
}
async function publishedInstaller() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'MusicBoard-Rust-NSIS-QA' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/contentriumkorea/MusicBoard/releases/tags/v${oldVersion}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Published release metadata HTTP ${response.status}`);
  const release = await response.json(); assert.equal(release.tag_name, `v${oldVersion}`);
  assert.equal(release.draft, false); assert.equal(release.prerelease, false); assert.equal(release.html_url, `${releases}/tag/v${oldVersion}`);
  const name = `MusicBoard-${oldVersion}-windows-x64-setup.exe`, assets = release.assets.filter(asset => asset.name === name); assert.equal(assets.length, 1);
  const asset = assets[0]; assert.equal(asset.browser_download_url, `${releases}/download/v${oldVersion}/${name}`);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxArchive); assert.match(asset.digest, /^sha256:[a-f\d]{64}$/i);
  const downloaded = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(600000) }); assert.equal(downloaded.status, 200); assert.ok(downloaded.body);
  const file = path.join(f.dir, 'published-0.1.11-setup.exe'), digest = createHash('sha256'); let received = 0;
  await pipeline(Readable.fromWeb(downloaded.body), new Transform({ transform(bytes, _encoding, callback) {
    received += bytes.length; if (received > asset.size || received > maxArchive) return callback(Error('Published installer exceeds declared size'));
    digest.update(bytes); callback(null, bytes);
  } }), createWriteStream(file, { flags: 'wx' }));
  assert.equal(received, asset.size); assert.equal(digest.digest('hex'), asset.digest.slice(7).toLowerCase()); return file;
}

try {
  assert.deepEqual(await registrations(), [], 'Refuse to replace an existing app registration; use a clean disposable runner');
  core = coreClient(nativeExecutable, f.data);
  const imported = await core.call('music:paths', { paths: [f.folder] }); assert.equal(imported.added, 3);
  const state = imported.state, [a, b, c] = f.files.map(file => state.tracks.find(track => track.path === file)); assert.ok(a && b && c);
  b.favorite = true; b.displayName = '기존 표시 이름'; c.trim = { start: 1, end: 10 };
  state.folders = [{ id: 'native-group-one', name: '그룹 하나' }, { id: 'native-group-two', name: '그룹 둘' }];
  a.folderId = 'native-group-one'; b.folderId = 'native-group-one'; c.folderId = 'native-group-two';
  state.settings.volume = .43; state.settings.fadeOut = 1.2; state.settings.librarySort = 'manual';
  state.playlists = [{ id: 'legacy-list', name: '이전 재생목록', trackIds: [b.id] }];
  await core.call('state:save', { state }); const before = (await core.call('state:get')).state;
  await core.close(); core = undefined;
  const audioHashes = await Promise.all(f.files.map(hash)), oldInstaller = await publishedInstaller();
  installationAttempted = true;
  await run(oldInstaller, ['/S', '--currentuser', `/D=${installDir}`]);
  baselineRegistration = await registrations(); assertFixtureRegistrations(baselineRegistration, oldVersion);
  assert.equal(await exists(executable), true); assert.equal(await exists(path.join(installDir, 'resources', 'app.asar')), true, 'Published baseline must be Electron');
  // No destination override: same-GUID upgrade must rediscover the old location.
  // Disable only the QA scenario during installer-controlled restart: Explorer
  // may discard inherited environment, so data/UI QA runs explicitly afterward.
  await run(newInstaller, ['/S', '--currentuser', '--updated', '--force-run'], { LUMA_NATIVE_QA: '0' });
  const upgradedRegistration = await registrations(); assertFixtureRegistrations(upgradedRegistration, version);
  assert.deepEqual(upgradedRegistration.map(({ hive, view }) => ({ hive, view })), baselineRegistration.map(({ hive, view }) => ({ hive, view })), 'Upgrade must retain the same registry identity and scope');
  assert.equal(await exists(path.join(installDir, 'resources', 'app.asar')), false, 'Upgraded app must not contain Electron app.asar');
  assert.equal(await exists(path.join(installDir, 'chrome_100_percent.pak')), false, 'Old Electron runtime files must be removed');
  const restarted = await eventually(async () => { const items = await ownedProcesses(); assert.ok(items.length > 0, 'Installer --force-run must restart the exact fixture native executable'); return items; }, 30000);
  assert.ok(restarted.every(item => Number.isSafeInteger(item.pid) && item.pid > 1));
  console.log('PASS Windows NSIS --force-run automatically restarted the exact isolated native executable');
  await stopOwnedProcesses();
  nativeUi = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  nativeUi.stdout.on('data', bytes => { uiLogs = (uiLogs + bytes).slice(-8000); }); nativeUi.stderr.on('data', bytes => { uiLogs = (uiLogs + bytes).slice(-8000); });
  await new Promise((resolve, reject) => { nativeUi.once('spawn', resolve); nativeUi.once('error', reject); });
  const result = await eventually(async () => JSON.parse(await readFile(resultFile, 'utf8')));
  assert.equal(result.passed, true, JSON.stringify(result)); assert.ok(Array.isArray(result.checks) && result.checks.length >= 5);
  const initial = result.initial; assert.ok(initial && Array.isArray(initial.tracks));
  assert.deepEqual(initial.ids, before.tracks.map(track => track.id)); assert.deepEqual(initial.names, before.tracks.map(track => track.displayName || track.title));
  assert.deepEqual(initial.settings, before.settings); assert.deepEqual(initial.playlists, before.playlists); assert.deepEqual(initial.trim, before.tracks.map(track => track.trim ?? null));
  assert.equal(initial.tracks.find(track => track.id === b.id).displayName, '기존 표시 이름'); assert.equal(initial.tracks.find(track => track.id === b.id).favorite, true);
  assert.deepEqual(initial.tracks.find(track => track.id === c.id).trim, { start: 1, end: 10 });
  assert.ok((await ownedProcesses()).some(item => item.pid === nativeUi.pid), `Controlled native UI must run from the installed fixture: ${uiLogs}`);
  for (const check of result.checks) console.log('PASS Windows upgraded ' + check);
  assert.deepEqual(await Promise.all(f.files.map(hash)), audioHashes, 'Source audio bytes must survive the actual installer upgrade');
  await stopOwnedProcesses();
  core = coreClient(executable, f.data); const update = await core.call('update:get');
  assert.equal(update.version, version); assert.equal(update.mode, 'automatic'); assert.equal(update.releasesUrl, releases);
  await core.close(); core = undefined;
  console.log('PASS real published Windows NSIS 0.1.11 -> native 0.2.0: same GUID/install location, controlled native UI, pre-edit data preservation, source bytes and automatic update channel');
} finally {
  if (core) await core.close().catch(() => {});
  await stopOwnedProcesses();
  const registered = installationAttempted ? await registrations() : [];
  if (registered.length) {
    for (const item of registered) assert.equal(path.resolve(item.location || '').toLowerCase(), installDir.toLowerCase(), 'Refuse to uninstall anything outside the fixture');
    const uninstaller = (await readdir(installDir)).find(name => /^Uninstall (?:SONO|MusicBoard)\.exe$/i.test(name));
    assert.ok(uninstaller, 'Fixture uninstaller must exist');
    await run(path.join(installDir, uninstaller), ['/S', `_?=${installDir}`]);
    await eventually(async () => assert.deepEqual(await registrations(), [], 'Fixture uninstaller must remove its registration'), 60000);
  }
  await cleanFixture(f.dir);
}
