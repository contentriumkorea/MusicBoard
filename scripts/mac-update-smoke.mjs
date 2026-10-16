// A real packaged app replaces itself. Only release HTTP responses are supplied locally.
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

assert.equal(process.platform,'darwin','Run this verification on macOS after release:mac');
const exec=promisify(execFile),require=createRequire(import.meta.url);
const builderRequire=createRequire(require.resolve('electron-builder/package.json'));
const libRequire=createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar=libRequire('@electron/asar');
const {version}=JSON.parse(await readFile('package.json','utf8'));
const dir=await realpath(await mkdtemp(path.join(tmpdir(),"sono packaged update ' ")));
const legacy=process.argv.includes('--legacy');
const target=path.join(dir,'Applications',legacy?'SONO.app':'MusicBoard.app'),data=path.join(dir,'data');
const archive=path.resolve(`release/${legacy?'SONO':'MusicBoard'}-${version}-mac-universal.zip`);
const plist=path.join(target,'Contents','Info.plist');
const stateFile=path.join(data,'state.json');
let application,page,installedPid;
const exists=async file=>access(file).then(()=>true,()=>false);
async function eventually(callback,timeout=90000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{return await callback();}catch(error){last=error;}await new Promise(r=>setTimeout(r,200));}
  throw last||new Error('Timed out');
}
try{
  await mkdir(path.dirname(target),{recursive:true});await mkdir(data);
  if(legacy){
    const headers=process.env.GH_TOKEN?{Authorization:`Bearer ${process.env.GH_TOKEN}`}:{ };
    const response=await fetch('https://api.github.com/repos/contentriumkorea/MusicBoard/releases/tags/v0.1.9',{headers});assert.equal(response.ok,true,`Old release metadata HTTP ${response.status}`);
    const release=await response.json(),asset=release.assets.find(a=>a.name==='SONO-0.1.9-mac-universal.zip');assert.ok(asset);
    assert.equal(asset.browser_download_url,'https://github.com/contentriumkorea/MusicBoard/releases/download/v0.1.9/SONO-0.1.9-mac-universal.zip');assert.match(asset.digest,/^sha256:[a-f\d]{64}$/);
    const downloaded=await fetch(asset.browser_download_url);assert.equal(downloaded.ok,true);const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(bytes.length,asset.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.digest.slice(7));
    const zip=path.join(dir,'old.zip');await writeFile(zip,bytes);const listing=(await exec('/usr/bin/unzip',['-Z1',zip],{maxBuffer:8*1024**2})).stdout;
    assert.ok(listing.split('\n').filter(Boolean).every(e=>/^(SONO\.app\/|__MACOSX\/)/.test(e)&&!e.includes('\\')&&!e.split('/').includes('..')));
    await exec('/usr/bin/ditto',['-x','-k',zip,path.dirname(target)]);
  }else await exec('/usr/bin/ditto',[path.resolve('release/mac-universal/MusicBoard.app'),target]);
  // Change only the fixture's version, retaining the new automatic updater code.
  // Versions <=0.1.2 cannot bootstrap this code through their manual updater.
  const fixtureVersion=legacy?'0.1.9':'0.1.3',source=path.join(dir,'source');
  const asarPath=path.join(target,'Contents','Resources','app.asar');
  if(!legacy){
  asar.extractAll(asarPath,source);
  const fixturePackage=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
  fixturePackage.version=fixtureVersion;await writeFile(path.join(source,'package.json'),JSON.stringify(fixturePackage));
  await asar.createPackage(source,asarPath);
  asar.uncache(asarPath);
  const integrity={'Resources/app.asar':{algorithm:'SHA256',hash:createHash('sha256').update(asar.getRawHeader(asarPath).headerString).digest('hex')}};
  await exec('/usr/bin/plutil',['-replace','ElectronAsarIntegrity','-json',JSON.stringify(integrity),plist]);
  for(const key of ['CFBundleShortVersionString','CFBundleVersion'])await exec('/usr/bin/plutil',['-replace',key,'-string',fixtureVersion,plist]);
  }
  const marker=path.join(target,'Contents','Resources','old-version-marker');await writeFile(marker,'old fixture');
  await exec('/usr/bin/codesign',['--force','--deep','--sign','-',target]);
  const audio=path.join(dir,'음악.wav'),size=44100*2*30,b=Buffer.alloc(44+size);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);
  await writeFile(audio,b);
  const state={version:1,tracks:[{id:'test-track',path:audio,title:'음악',artist:'',album:'',format:'WAV',duration:30,addedAt:1,favorite:true,displayName:'보존할 음악'}],
    playlists:[{id:'test-list',name:'보존할 목록',trackIds:['test-track']}],
    settings:{volume:0.43,eqEnabled:true,eq:Array(20).fill(1),preamp:0,eqPreset:'사용자 설정',fadeIn:0.8,fadeOut:1.2,librarySort:'manual'},
    playback:{currentId:'test-track',anchorId:'test-track',position:4.1,queue:[],order:['test-track'],repeat:'stop',shuffle:false}};
  await writeFile(stateFile,JSON.stringify(state));
  const env={...process.env,LUMA_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.LUMA_DEV_URL;
  application=await electron.launch({executablePath:path.join(target,'Contents','MacOS','SONO'),args:[],env,timeout:60000});
  page=await application.firstWindow();page.setDefaultTimeout(90000);
  await page.getByRole('heading',{name:'내 음악.'}).waitFor();
  await page.getByRole('button',{name:'보존할 음악',exact:true}).waitFor();
  assert.equal(await application.evaluate(({app})=>app.getVersion()),fixtureVersion);
  assert.equal(await page.evaluate(async()=> (await window.luma.getUpdateState()).mode),'automatic');
  const bytes=await readFile(archive),name=path.basename(archive),releases='https://github.com/contentriumkorea/SONO/releases';
  const release={tag_name:`v${version}`,draft:false,prerelease:false,html_url:`${releases}/tag/v${version}`,
    assets:[{name:`${legacy?'SONO':'MusicBoard'}-${version}-mac-universal.dmg`},{name,browser_download_url:`${releases}/download/v${version}/${name}`,size:bytes.length,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`}]};
  await application.evaluate(({net},{release,archive})=>{
    const original=net.fetch.bind(net),fs=process.getBuiltinModule('fs'),{Readable}=process.getBuiltinModule('stream');
    net.fetch=async(url,init)=>{
      if(url==='https://api.github.com/repos/contentriumkorea/SONO/releases/latest')return new Response(JSON.stringify(release));
      if(url===release.assets[1].browser_download_url)return new Response(Readable.toWeb(fs.createReadStream(archive)));
      return original(url,init);
    };
  },{release,archive});
  await page.getByRole('button',{name:'업데이트',exact:true}).click();
  await page.getByRole('button',{name:'지금 업데이트',exact:true}).waitFor();
  const closed=new Promise(resolve=>application.once('close',resolve));
  await page.getByRole('button',{name:'지금 업데이트',exact:true}).click();
  await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Old app did not quit after update')),90000);timer.unref();})]);
  application=undefined;
  const cache=path.join(data,'mac-updates');
  const [token]=await readdir(cache);assert.match(token,/^[a-f\d-]{36}$/);
  const workspace=path.join(cache,token);
  await eventually(async()=>assert.equal((await readFile(path.join(workspace,'status'),'utf8')).trim(),'installed'));
  installedPid=Number(await readFile(path.join(workspace,'app.pid'),'utf8'));assert.ok(installedPid>1);process.kill(installedPid,0);
  assert.equal(await readFile(path.join(workspace,'health'),'utf8'),version);
  assert.equal((await exec('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',plist])).stdout.trim(),version);
  asar.uncache(asarPath);assert.equal(JSON.parse(asar.extractFile(asarPath,'package.json').toString()).version,version);
  assert.equal(await exists(marker),false);assert.equal(await exists(`${target}.sono-backup-${token}`),false);
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',target]);
  const saved=JSON.parse(await readFile(stateFile,'utf8'));
  assert.equal(saved.tracks[0].favorite,true);assert.equal(saved.tracks[0].displayName,'보존할 음악');
  assert.deepEqual(saved.playlists,state.playlists);assert.equal(saved.settings.volume,0.43);assert.equal(saved.settings.fadeOut,1.2);
  assert.equal(saved.playback.repeat,'stop');assert.ok(Math.abs(saved.playback.position-4.1)<0.2);await access(audio);
  assert.equal((await exec('/usr/bin/plutil',['-extract','CFBundleDisplayName','raw','-o','-',plist])).stdout.trim(),'MusicBoard');
  assert.equal(JSON.parse(asar.extractFile(asarPath,'package.json').toString()).productName,'MusicBoard');
  console.log((legacy?'PASS genuine published SONO 0.1.9 to MusicBoard migration: ':'PASS MusicBoard packaged automatic update: ')+'one UI click, streamed ZIP, SHA-256, bundle verification, old app exit, actual app replacement, new app restart/health, backup cleanup and library/settings preservation (release HTTP supplied locally)');
}catch(error){
  if(page&&!page.isClosed()){await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/mac-update-failure.png'}).catch(()=>{});}
  const cache=path.join(data,'mac-updates');
  for(const token of await readdir(cache).catch(()=>[]))for(const name of ['install.log','app.log','status']){
    console.error(name,await readFile(path.join(cache,token,name),'utf8').catch(()=>'<absent>'));
  }
  throw error;
}finally{
  if(application)await application.close().catch(()=>{});
  for(const token of await readdir(path.join(data,'mac-updates')).catch(()=>[])){
    const pid=Number(await readFile(path.join(data,'mac-updates',token,'app.pid'),'utf8').catch(()=>''));
    if(pid>1){const command=await exec('/bin/ps',['-p',String(pid),'-o','command=']).then(r=>r.stdout,()=> '');
      if(command.includes(path.join(target,'Contents','MacOS','SONO'))){process.kill(pid,'SIGTERM');await new Promise(r=>setTimeout(r,1500));}}
  }
  await rm(dir,{recursive:true,force:true});
}
