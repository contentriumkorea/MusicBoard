import {spawn} from 'node:child_process';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {coreClient,fixture,cleanFixture} from './rust-core-smoke.mjs';
const executable=process.env.MUSICBOARD_NATIVE_EXECUTABLE||path.resolve(`src-tauri/target/release/SONO${process.platform==='win32'?'.exe':''}`),f=await fixture();
let core,child,logs='';
try{
  core=coreClient(executable,f.data);await core.call('music:paths',{paths:[f.folder]});await core.close();core=undefined;
  child=spawn(executable,[],{env:f.env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{logs+=d.toString();});child.stderr.on('data',d=>{logs+=d.toString();});
  const deadline=Date.now()+150000,resultFile=path.join(f.data,'native-result.json');let result;
  while(Date.now()<deadline){try{await access(resultFile);result=JSON.parse(await readFile(resultFile,'utf8'));break;}catch{}if(child.exitCode!=null)throw Error(`Native app exited ${child.exitCode}: ${logs.slice(-5000)}`);await new Promise(r=>setTimeout(r,100));}
  assert.ok(result,`No native UI result: ${logs.slice(-5000)}`);assert.equal(result.passed,true,JSON.stringify(result));for(const check of result.checks)console.log('PASS '+check);
  child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000);});child=undefined;
  core=coreClient(executable,f.data);const saved=(await core.call('state:get')).state;assert.equal(saved.settings.fadeOut,1.2);assert.equal(saved.tracks[0].displayName,'네이티브 표시 이름');assert.equal(saved.playlists[0].name,'보존할 목록');assert.deepEqual(await readFile(f.files[0]),f.bytes);console.log('PASS native desktop restart retains settings/names/playlists and original audio bytes');
}finally{if(child){child.kill();await new Promise(r=>setTimeout(r,300));}if(core)await core.close().catch(()=>{});await cleanFixture(f.dir);}
