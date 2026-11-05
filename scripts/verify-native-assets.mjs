import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const {version}=JSON.parse(await readFile('package.json','utf8'));
assert.match(version,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
if(process.env.GITHUB_REF_TYPE==='tag')assert.equal(process.env.GITHUB_REF_NAME,`v${version}`);
const dir=path.resolve(process.argv[2]||'release');
const win=`MusicBoard-${version}-windows-x64-setup.exe`,zip=`MusicBoard-${version}-mac-universal.zip`,dmg=`MusicBoard-${version}-mac-universal.dmg`;
const expected=[win,win+'.blockmap',win.replace('MusicBoard','SONO'),zip,zip.replace('MusicBoard','SONO'),dmg,dmg.replace('MusicBoard','SONO'),'latest.yml','latest-mac.yml'].sort();
assert.deepEqual((await readdir(dir)).sort(),expected,'Only the checked installers and update metadata may be published');
async function digest(file,algorithm='sha512',encoding='base64'){
  const hash=createHash(algorithm);for await(const chunk of createReadStream(path.join(dir,file)))hash.update(chunk);return hash.digest(encoding);
}
for(const [manifest,file] of [['latest.yml',win],['latest-mac.yml',zip]]){
  const text=await readFile(path.join(dir,manifest),'utf8');
  assert.equal(/^version:\s*(\S+)\s*$/m.exec(text)?.[1],version);
  assert.equal(/^path:\s*(\S+)\s*$/m.exec(text)?.[1],file);
  assert.equal(/^\s*-\s*url:\s*(\S+)\s*$/m.exec(text)?.[1],file);
  const hashes=[...text.matchAll(/^\s*sha512:\s*([a-zA-Z0-9+/=]+)\s*$/gm)].map(match=>match[1]);
  assert.ok(hashes.length>=2);const hash=await digest(file);assert.ok(hashes.every(value=>value===hash),`${manifest} SHA-512 differs`);
  const sizes=[...text.matchAll(/^\s*size:\s*(\d+)\s*$/gm)].map(match=>Number(match[1])),size=(await stat(path.join(dir,file))).size;assert.ok(sizes.length>=1);assert.ok(sizes.every(value=>value===size),`${manifest} byte size differs`);
}
for(const file of [win,dmg])assert.equal(await digest(file),await digest(file.replace('MusicBoard','SONO')),'Compatibility asset must match primary installer');
for(const file of expected)assert.ok((await stat(path.join(dir,file))).size>0);
console.log(`PASS ${version}: nine native release assets, matching aliases and verified update SHA-512/size metadata`);
