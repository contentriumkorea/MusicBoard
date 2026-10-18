import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),root=process.cwd();
const dir=await mkdtemp(path.join(tmpdir(),'sono-update-smoke-'));
const env={...process.env,LUMA_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;delete env.LUMA_DEV_URL;
const packaged=process.argv.includes('--packaged');
let application;
try{
  application=await electron.launch({executablePath:packaged?(process.env.SONO_SMOKE_EXECUTABLE||path.join(root,'release','win-unpacked','SONO.exe')):require('electron'),args:packaged?[]:[root],env});
  const page=await application.firstWindow();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'내 음악.'}).waitFor();
  assert.equal((await page.evaluate(()=>window.luma.getUpdateState())).releasesUrl,'https://github.com/contentriumkorea/MusicBoard/releases');
  if(packaged){
    const config=await application.evaluate(()=>process.getBuiltinModule('fs').readFileSync(process.resourcesPath+'/app-update.yml','utf8'));
    assert.match(config,/repo: MusicBoard\b/);
  }
  if(packaged){
    await application.evaluate(async({app})=>{
      const {createRequire}=process.getBuiltinModule('node:module');const require=createRequire(app.getAppPath()+'/package.json');
      const {autoUpdater}=require('electron-updater');
      autoUpdater.checkForUpdates=async()=>{await new Promise(r=>setTimeout(r,200));autoUpdater.emit('update-available',{version:'0.2.0'});return null;};
      autoUpdater.quitAndInstall=()=>{globalThis.sonoInstalled=true;};
      autoUpdater.downloadUpdate=async()=>{autoUpdater.emit('download-progress',{percent:37});await new Promise(r=>setTimeout(r,400));autoUpdater.emit('update-downloaded',{version:'0.2.0'});return [];};
    });
  }else{
    await application.evaluate(({net,shell})=>{
      net.fetch=async url=>{if(url!=='https://api.github.com/repos/contentriumkorea/MusicBoard/releases/latest')throw Error('Unexpected update source');await new Promise(r=>setTimeout(r,200));return new Response(JSON.stringify({tag_name:'v0.2.0',draft:false,prerelease:false,html_url:'https://github.com/contentriumkorea/MusicBoard/releases/tag/v0.2.0',assets:[{name:'MusicBoard-0.2.0-windows-x64-setup.exe'},{name:'MusicBoard-0.2.0-mac-universal.dmg'}]}),{status:200});};
      shell.openExternal=async url=>{globalThis.sonoOpenedRelease=url;};
    });
  }
  await page.getByRole('button',{name:'업데이트',exact:true}).click();
  await page.getByRole('heading',{name:'PulseDeck 업데이트'}).waitFor();
  const version=await application.evaluate(({app})=>app.getVersion());
  assert.ok((await page.locator('.update-version').first().textContent()).includes(`v${version}`));
  await page.getByRole('button',{name:'업데이트 확인 중'}).waitFor();
  await page.getByRole('button',{name:packaged?'지금 업데이트':'설치 파일 받기',exact:true}).waitFor();
  assert.match(await page.locator('.update-version').last().textContent(),/v0\.2\.0/);
  await page.getByRole('button',{name:packaged?'지금 업데이트':'설치 파일 받기',exact:true}).click();
  if(packaged){
    await page.getByRole('progressbar',{name:'업데이트 다운로드 진행률'}).waitFor();
    await page.waitForFunction(async()=> (await window.luma.getUpdateState()).status==='installing');
    for(let i=0;i<50&&!await application.evaluate(()=>globalThis.sonoInstalled);i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(await application.evaluate(()=>globalThis.sonoInstalled),true);
  }else{
    assert.equal(await application.evaluate(()=>globalThis.sonoOpenedRelease),'https://github.com/contentriumkorea/MusicBoard/releases');
  }
  await mkdir('test-results',{recursive:true});await page.screenshot({path:`test-results/update-${packaged?'packaged':'dev'}.png`});
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.getByRole('heading',{name:'내 음악.'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS update dialog: actual IPC, current version, checking, new version, '+(packaged?'download progress and automatic install after one click':'manual release page link')+' (release responses/download simulated)');
}catch(error){throw error;}
finally{if(application)await application.close();await rm(dir,{recursive:true,force:true});}
