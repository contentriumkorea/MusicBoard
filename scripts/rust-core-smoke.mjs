import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export function pcmWave(){
  const rate=16000,channels=2,samples=rate*12,size=samples*channels*2,b=Buffer.alloc(44+size);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);
  for(let i=0;i<samples;i++){const amplitude=i<rate*3||i>=rate*9?0:i<rate*6?.2:.8,value=Math.round(Math.sin(i/rate*440*Math.PI*2)*amplitude*32767);b.writeInt16LE(value,44+i*4);b.writeInt16LE(-value,46+i*4);}return b;
}
export function coreClient(executable,dir){
  const child=spawn(executable,path.basename(executable).toLowerCase().startsWith('sono')?['--core-stdio']:[],{env:{...process.env,LUMA_DATA_DIR:dir},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let id=0,errors='';child.stderr.on('data',v=>{errors+=v.toString();});
  createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}if(value.id!=null){const entry=pending.get(value.id);if(entry){pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(Error(value.error)):entry.resolve(value.result);}}});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error(`Native core exited (${code}): ${errors}`));}pending.clear();code===0?resolve():reject(Error(`Native core exit ${code}: ${errors}`));});});
  return {child,call:(method,args={})=>new Promise((resolve,reject)=>{const request=++id,timer=setTimeout(()=>{pending.delete(request);reject(Error(`Native core request timed out: ${method}`));},60000);pending.set(request,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:request,method,args})+'\n');}),close:async()=>{child.stdin.end();await closed;}};
}
export async function fixture(){
  const dir=await realpath(await mkdtemp(path.join(tmpdir(),'musicboard-native-'))),data=path.join(dir,'data'),folder=path.join(dir,'음원');await mkdir(data);await mkdir(folder);
  const files=['A','B','C'].map(name=>path.join(folder,name+'.wav'));const bytes=pcmWave();for(const file of files)await writeFile(file,bytes);
  return {dir,data,folder,files,bytes,env:{...process.env,LUMA_DATA_DIR:data,LUMA_NATIVE_QA:'1'}};
}
export async function cleanFixture(dir){const actual=path.resolve(dir),base=path.resolve(await realpath(tmpdir()));assert.ok(actual.startsWith(base+path.sep)&&path.basename(actual).startsWith('musicboard-native-'));await rm(actual,{recursive:true,force:true});}

async function main(){
  const f=await fixture(),exe=process.env.MUSICBOARD_CORE_EXECUTABLE||path.resolve(process.platform==='win32'?'release/native-unpacked/SONO.exe':'release/mac-universal/PulseDeck.app/Contents/MacOS/SONO');let core=coreClient(exe,f.data);
  try{
    const imported=await core.call('music:paths',{paths:[f.folder]});assert.equal(imported.added,3);assert.equal(imported.state.tracks.length,3);assert.deepEqual(imported.folderRoots,[f.folder]);assert.equal((await core.call('music:paths',{paths:f.files})).added,0);
    const a=imported.state.tracks.find(t=>t.path===f.files[0]);assert.ok(a);assert.ok(Math.abs(a.duration-12)<.01);assert.equal(a.id,createHash('sha256').update(process.platform==='win32'?f.files[0].toLowerCase():f.files[0]).digest('hex'));
    console.log('PASS Rust native real folder import, content metadata, stable legacy IDs and duplicate protection');
    const state=imported.state;state.tracks[0].displayName='기존 표시 이름';state.tracks[0].favorite=true;state.tracks[0].trim={start:2,end:8};state.settings.volume=.43;state.settings.fadeOut=1.2;state.playback.repeat='stop';state.playlists=[{id:'keep',name:'보존할 목록',trackIds:[a.id]}];
    const originalPath=state.tracks[0].path;state.tracks[0].path='C:/not-allowed';state.tracks.push({...state.tracks[0],id:'forged'});await core.call('state:save',{state});const saved=(await core.call('state:get')).state;
    assert.equal(saved.tracks.length,3);assert.equal(saved.tracks[0].path,originalPath);assert.equal(saved.tracks[0].displayName,'기존 표시 이름');assert.deepEqual(saved.tracks[0].trim,{start:2,end:8});assert.equal(saved.settings.volume,.43);assert.deepEqual(saved.playlists,state.playlists);
    console.log('PASS Rust authoritative state protects source paths/IDs and preserves names, favorites, playlists, fade and trim settings');
    const wave=await core.call('waveform:get',{id:a.id});assert.equal(wave.peaks.length,960);assert.ok(Math.max(...wave.peaks.slice(10,230))<.001);assert.ok(Math.max(...wave.peaks.slice(260,450))>.18);assert.ok(Math.max(...wave.peaks.slice(500,700))>.75);assert.ok(Math.max(...wave.peaks.slice(750,940))<.001);
    const shell=await core.call('shell:info'),url=`${shell.mediaBase}/audio/${a.id}`;let response=await fetch(url,{headers:{Range:'bytes=44-75'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes.subarray(44,76));assert.equal((await fetch(url,{headers:{Range:'bytes=99999999-'}})).status,416);assert.equal((await fetch(`${shell.mediaBase}/audio/${'b'.repeat(64)}`)).status,404);response=await fetch(url,{method:'HEAD'});assert.equal(Number(response.headers.get('content-length')),f.bytes.length);
    console.log('PASS Rust PCM opposite-channel waveform, silent/quiet/loud regions and actual streaming Range/HEAD protection');
    const update=await core.call('update:get');assert.equal(update.version,'0.2.0');assert.equal(update.mode,'automatic');assert.equal(update.releasesUrl,'https://github.com/contentriumkorea/MusicBoard/releases');
    await core.close();core=coreClient(exe,f.data);const restarted=(await core.call('state:get')).state;assert.deepEqual(restarted.playlists,state.playlists);assert.equal(restarted.settings.fadeOut,1.2);assert.deepEqual((await core.call('waveform:get',{id:a.id})).peaks,wave.peaks);assert.deepEqual(await readFile(f.files[0]),f.bytes);
    await core.call('music:remove',{ids:[a.id]});const removed=(await core.call('state:get')).state;assert.equal(removed.tracks.length,2);assert.equal(removed.playlists[0].trackIds.length,0);assert.deepEqual(await readFile(f.files[0]),f.bytes);
    console.log('PASS Rust update channel, restart/cache persistence and selected deletion without changing source audio');
    const m3u=path.join(f.dir,'reversed.m3u8');await writeFile(m3u,`#EXTM3U\n${f.files[1]}\n${f.files[0]}\n${f.files[1]}\n`);
    const playlistImport=await core.call('playlist:paths',{path:m3u}),playlist=playlistImport.state.playlists.at(-1);
    const names=playlist.trackIds.map(id=>playlistImport.state.tracks.find(track=>track.id===id).title);assert.deepEqual(names,['B','A']);
    const exported=path.join(f.dir,'exported.m3u8');await core.call('playlist:export',{id:playlist.id,path:exported});
    assert.deepEqual((await readFile(exported,'utf8')).split('\n').filter(line=>line&&!line.startsWith('#')),[f.files[1],f.files[0]]);
    console.log('PASS M3U import/export retains explicit song order and deduplicates repeated entries');
  }finally{await core.close().catch(()=>{});await cleanFixture(f.dir);}
}
if(import.meta.url===new URL(process.argv[1], 'file:').href||process.argv[1]?.endsWith('rust-core-smoke.mjs'))await main();
