// Production packages contain the native Tauri executable, never Electron.
// electron-builder is retained only as the existing Windows NSIS installer.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const output = path.join(root, 'release'), native = path.join(root, 'src-tauri', 'target');
const require = createRequire(import.meta.url), args = new Set(process.argv.slice(2));
const exists = file => access(file).then(() => true, () => false);
for (const arg of args) assert.ok(['--pack-only', '--dir', '--dev', '--start', '--help'].includes(arg), `Unknown native build option: ${arg}`);

function run(command, commandArgs = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${path.basename(command)} failed (${code ?? signal})`)));
  });
}
function pnpm(commandArgs) {
  if (process.env.npm_execpath && /pnpm\.(?:c?js|mjs)$/.test(process.env.npm_execpath)) return run(process.execPath, [process.env.npm_execpath, ...commandArgs]);
  // Only fixed build arguments reach this shell fallback for Windows .cmd shims.
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', commandArgs, { shell: process.platform === 'win32' });
}
async function capture(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(Error(`${path.basename(command)} failed (${code}): ${stderr.slice(-2000)}`)));
  });
}
function insideOutput(file) {
  const resolved = path.resolve(file), relative = path.relative(output, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Packaging target must stay inside release/');
  return resolved;
}
async function resetDirectory(directory) {
  const resolved = insideOutput(directory);
  if (await exists(resolved)) {
    // Verify the filesystem target as well as the lexical path before deletion.
    insideOutput(await realpath(resolved));
    assert.equal((await lstat(resolved)).isSymbolicLink(), false, 'Refuse a linked packaging directory');
  }
  await rm(resolved, { recursive: true, force: true }); await mkdir(resolved, { recursive: true });
}
async function hash(file, algorithm, encoding) {
  const digest = createHash(algorithm); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest(encoding);
}
async function noElectron(directory) {
  assert.equal(await exists(path.join(directory, 'resources', 'app.asar')), false, 'Native package must not include app.asar');
  assert.equal(await exists(path.join(directory, 'Contents', 'Resources', 'app.asar')), false, 'Native bundle must not include app.asar');
  const frameworks = await readdir(path.join(directory, 'Contents', 'Frameworks')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.ok(!frameworks.some(name => /^Electron\s*Framework(?:\.framework)?$/i.test(name)), 'Native bundle must not contain Electron Framework');
}
async function nativeStart() {
  const candidates = process.platform === 'darwin'
    ? [path.join(output, 'mac-universal', 'PulseDeck.app', 'Contents', 'MacOS', 'SONO'), path.join(native, 'universal-apple-darwin', 'release', 'bundle', 'macos', 'PulseDeck.app', 'Contents', 'MacOS', 'SONO'), path.join(native, 'release', 'bundle', 'macos', 'PulseDeck.app', 'Contents', 'MacOS', 'SONO')]
    : [path.join(output, 'native-unpacked', 'SONO.exe'), path.join(native, 'release', 'SONO.exe')];
  const executable = (await Promise.all(candidates.map(async file => await exists(file) ? file : null))).find(Boolean);
  assert.ok(executable, 'Build the native desktop first with pnpm build:native'); await run(executable);
}
function nsisEscape(value) { assert.ok(!/[\r\n]/.test(value)); return value.replaceAll('$', '$$').replaceAll('"', '$\\"'); }

async function webviewPrerequisite(work) {
  // Microsoft recommends registry detection and its Evergreen bootstrapper.
  // https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
  const bootstrapper = path.join(work, 'MicrosoftEdgeWebview2Setup.exe');
  const response = await fetch('https://go.microsoft.com/fwlink/p/?LinkId=2124703', { signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200, 'Cannot download the Microsoft WebView2 bootstrapper');
  const final = new URL(response.url);
  assert.ok(final.protocol === 'https:' && (final.hostname === 'microsoft.com' || final.hostname.endsWith('.microsoft.com')), 'Unexpected WebView2 download origin');
  assert.ok(response.body); let size = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(bytes, _encoding, callback) {
    size += bytes.length; if (size > 20 * 1024 ** 2) return callback(Error('WebView2 bootstrapper is unexpectedly large')); callback(null, bytes);
  } }), createWriteStream(bootstrapper, { flags: 'wx' }));
  assert.ok(size > 0);
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $signature=Get-AuthenticodeSignature -LiteralPath $env:MUSICBOARD_WEBVIEW2_VERIFY_FILE; if($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "(^|,[ ]*)O=Microsoft Corporation(,|$)"){throw "WebView2 bootstrapper Microsoft signature verification failed"}'],
  { env: { ...process.env, MUSICBOARD_WEBVIEW2_VERIFY_FILE: bootstrapper } });
  const include = path.join(work, 'webview2.nsh');
  await writeFile(include, [
    '; Generated native prerequisite; the existing NSIS identity/install mode remains unchanged.',
    '!include "LogicLib.nsh"', '!ifndef BUILD_UNINSTALLER',
    'Function MusicBoardCheckWebView2',
    '  StrCpy $R8 ""', '  SetRegView 32',
    '  ReadRegStr $R8 HKLM "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"',
    '  ${If} $R8 == ""', '  ${OrIf} $R8 == "0.0.0.0"',
    '    ReadRegStr $R8 HKCU "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"', '  ${EndIf}',
    '  SetRegView 64', '  ${If} $R8 == ""', '  ${OrIf} $R8 == "0.0.0.0"',
    '    ReadRegStr $R8 HKCU "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"', '  ${EndIf}',
    '  ${If} $R8 == "0.0.0.0"', '    StrCpy $R8 ""', '  ${EndIf}', 'FunctionEnd',
    '!macro customInit', '  Push $R8', '  Push $R9', '  Call MusicBoardCheckWebView2', '  ${If} $R8 == ""',
    '    InitPluginsDir', '    SetOutPath "$PLUGINSDIR"',
    `    File /oname=MicrosoftEdgeWebview2Setup.exe "${nsisEscape(bootstrapper)}"`,
    '    DetailPrint "Installing Microsoft Edge WebView2 Runtime..."',
    '    ExecWait \'"$PLUGINSDIR\\MicrosoftEdgeWebview2Setup.exe" /silent /install\' $R9',
    '    Call MusicBoardCheckWebView2', '    ${If} $R8 == ""',
    '      IfSilent +2', '      MessageBox MB_ICONSTOP|MB_OK "Microsoft Edge WebView2 Runtime could not be installed. Check your internet connection and run setup again."',
    '      SetErrorLevel 1', '      Quit', '    ${EndIf}', '    SetOutPath "$INSTDIR"',
    '  ${EndIf}', '  Pop $R9', '  Pop $R8', '!macroend', '!endif', ''
  ].join('\n'));
  return include;
}

async function packageWindows(pkg) {
  assert.equal(process.arch, 'x64', 'Windows production packages require an x64 build host');
  const source = path.join(native, 'release'), executable = path.join(source, 'SONO.exe');
  const header = await readFile(executable), pe = header.readUInt32LE(0x3c);
  assert.equal(header.toString('ascii', 0, 2), 'MZ'); assert.equal(header.readUInt32LE(pe), 0x4550); assert.equal(header.readUInt16LE(pe + 4), 0x8664, 'Native executable must be Windows x64');
  const stage = path.join(output, 'native-unpacked'); await resetDirectory(stage);
  await copyFile(executable, path.join(stage, 'SONO.exe'));
  for (const file of await readdir(source)) if (/\.dll$/i.test(file)) await copyFile(path.join(source, file), path.join(stage, file));
  await mkdir(path.join(stage, 'resources'));
  for (const file of ['mac-update.sh', 'THIRD_PARTY_NOTICES.md', 'licenses']) await cp(path.join(root, 'resources', file), path.join(stage, 'resources', file), { recursive: true });
  await noElectron(stage);
  if (args.has('--dir')) { console.log('Native Windows application: release/native-unpacked/SONO.exe (requires installed WebView2 Runtime)'); return; }
  const work = path.join(output, 'native-packaging'); await resetDirectory(work);
  const include = await webviewPrerequisite(work);
  const config = { ...pkg.build, afterPack: null, npmRebuild: false, nodeGypRebuild: false,
    nsis: { ...pkg.build.nsis, include } };
  // appId + package name + productName + executableName and NSIS install options
  // are deliberately unchanged, retaining the previous install path and GUID.
  const configFile = path.join(work, 'electron-builder.json'); await writeFile(configFile, JSON.stringify(config, null, 2));
  const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'out', 'cli', 'cli.js');
  await run(process.execPath, [cli, '--win', 'nsis', '--x64', '--prepackaged', stage, '--config', configFile, '--publish', 'never']);
  await copyFile(path.join(output, `MusicBoard-${pkg.version}-windows-x64-setup.exe`), path.join(output, `SONO-${pkg.version}-windows-x64-setup.exe`));
  await noElectron(stage);
  console.log('Native Windows NSIS installers and latest.yml are ready in release/; nothing was uploaded.');
}

async function packageMac(pkg) {
  const source = path.join(native, 'universal-apple-darwin', 'release', 'bundle', 'macos', 'PulseDeck.app');
  const executable = path.join(source, 'Contents', 'MacOS', 'SONO');
  const architectures = (await capture('/usr/bin/lipo', ['-archs', executable])).split(/\s+/).sort();
  assert.deepEqual(architectures, ['arm64', 'x86_64'], 'Production Mac bundle must be universal');
  const plist = path.join(source, 'Contents', 'Info.plist');
  for (const [key, value] of [['CFBundleIdentifier', 'local.luma.music'], ['CFBundleExecutable', 'SONO'], ['CFBundleShortVersionString', pkg.version]]) {
    assert.equal(await capture('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]), value);
  }
  await noElectron(source); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
  const stage = path.join(output, 'mac-universal'); await resetDirectory(stage);
  const bundle = path.join(stage, 'PulseDeck.app'); await run('/usr/bin/ditto', [source, bundle]);
  if (args.has('--dir')) { console.log('Native universal Mac application: release/mac-universal/PulseDeck.app'); return; }
  const work = path.join(output, 'native-packaging'); await resetDirectory(work);
  for (const name of ['MusicBoard', 'SONO']) {
    const compatible = path.join(work, `${name}.app`); await run('/usr/bin/ditto', [bundle, compatible]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', compatible]);
    const archive = path.join(output, `${name}-${pkg.version}-mac-universal.zip`);
    await rm(insideOutput(archive), { force: true });
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', compatible, archive]);
  }
  const dmgRoot = path.join(work, 'dmg'); await mkdir(dmgRoot);
  await run('/usr/bin/ditto', [bundle, path.join(dmgRoot, 'PulseDeck.app')]); await symlink('/Applications', path.join(dmgRoot, 'Applications'));
  const dmg = path.join(output, `MusicBoard-${pkg.version}-mac-universal.dmg`);
  await run('/usr/bin/hdiutil', ['create', '-volname', 'PulseDeck', '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmg]);
  await copyFile(dmg, path.join(output, `SONO-${pkg.version}-mac-universal.dmg`));
  const name = `MusicBoard-${pkg.version}-mac-universal.zip`, archive = path.join(output, name);
  const digest = await hash(archive, 'sha512', 'base64'), size = (await stat(archive)).size;
  await writeFile(path.join(output, 'latest-mac.yml'), `version: ${pkg.version}\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${size}\npath: ${name}\nsha512: ${digest}\nreleaseDate: '${new Date().toISOString()}'\n`);
  console.log('Native universal Mac ZIP/DMG compatibility assets and latest-mac.yml are ready in release/; nothing was uploaded.');
}

async function main() {
  if (args.has('--help')) { console.log('pnpm build:native  # build native app and compatibility installers\nnode scripts/build-native.mjs --pack-only  # package existing production native outputs\nnode scripts/build-native.mjs --dir  # build native app, skip installer/archive creation\npnpm dev  # Vite + native desktop\npnpm start  # start previously built native desktop'); return; }
  assert.ok(['darwin', 'win32'].includes(process.platform), 'Native packages support macOS and Windows');
  if (args.has('--start')) { await nativeStart(); return; }
  if (args.has('--dev')) {
    const { createServer } = await import('vite'); const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
    await server.listen(); try { await pnpm(['dlx', '@tauri-apps/cli@2', 'dev']); } finally { await server.close(); } return;
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const tauri = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(pkg.version, tauri.version); assert.equal(pkg.name, 'sono'); assert.equal(pkg.productName, 'MusicBoard');
  assert.equal(pkg.build.appId, 'local.luma.music'); assert.equal(pkg.build.productName, 'MusicBoard'); assert.equal(pkg.build.win.executableName, 'SONO');
  await mkdir(output, { recursive: true }); assert.equal(path.relative(output, await realpath(output)), '', 'release/ must not point outside the project');
  if (!args.has('--pack-only')) {
    await run(process.execPath, [path.join(root, 'scripts', 'native-notices.mjs')]);
    await pnpm(['dlx', '@tauri-apps/cli@2', 'build', ...(process.platform === 'darwin' ? ['--target', 'universal-apple-darwin', '--bundles', 'app'] : ['--no-bundle'])]);
  }
  assert.ok(await exists(path.join(root, 'resources', 'licenses', 'native-dependencies', 'INDEX.md')), 'Generate native dependency notices before packaging');
  if (process.platform === 'darwin') await packageMac(pkg); else await packageWindows(pkg);
}
await main();
