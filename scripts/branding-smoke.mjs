import {_electron as electron} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),root=process.cwd(),dir=await mkdtemp(path.join(tmpdir(),'musicboard-brand-'));
const state={version:1,tracks:[],playlists:[{id:'saved-list',name:'기존 SONO 목록',trackIds:[]}],settings:{volume:.43,eqEnabled:false,eq:Array(20).fill(0),preamp:0,eqPreset:'플랫',fadeIn:.8,fadeOut:1.2,librarySort:'manual'},playback:{currentId:null,anchorId:null,position:0,queue:[],order:[],repeat:'stop',shuffle:false}};
await writeFile(path.join(dir,'state.json'),JSON.stringify(state));
const env={...process.env,LUMA_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;delete env.LUMA_DEV_URL;
const executable=process.env.SONO_SMOKE_EXECUTABLE,options={executablePath:executable||require('electron'),args:executable?[]:[root],env};
let app;
try{
  app=await electron.launch(options);const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'내 음악.'}).waitFor();
  assert.equal(await app.evaluate(({app})=>app.getName()),'MusicBoard');assert.equal(await page.title(),'MusicBoard');
  await page.getByRole('button',{name:'MusicBoard 정보',exact:true}).waitFor();assert.match(await page.locator('.window-caption').textContent(),/^MusicBoard/);
  await page.setViewportSize({width:960,height:650});
  const fits=await page.locator('.brand').evaluate(el=>{const text=el.lastElementChild.getBoundingClientRect(),mark=el.firstElementChild.getBoundingClientRect(),box=el.getBoundingClientRect();return text.left>=mark.right&&text.right<=box.right&&el.scrollWidth<=el.clientWidth;});assert.equal(fits,true);
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/MusicBoard-brand.png'});
  console.log('PASS MusicBoard native/window names, visible brand and compact layout');
  await page.getByRole('button',{name:'MusicBoard 정보'}).click();await page.getByRole('dialog',{name:'MusicBoard',exact:true}).waitFor();await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.getByRole('button',{name:'업데이트',exact:true}).click();await page.getByRole('dialog',{name:'MusicBoard 업데이트'}).waitFor();await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.getByRole('button',{name:'미니 플레이어',exact:true}).click();let mini;for(let i=0;i<50;i++){mini=app.windows().find(w=>w!==page);if(mini)break;await page.waitForTimeout(100);}assert.ok(mini);await mini.locator('.mini-heading').waitFor();assert.match(await mini.locator('.mini-heading').textContent(),/MusicBoard/);await mini.getByRole('button',{name:'미니 플레이어 닫기'}).click();
  console.log('PASS MusicBoard about/update dialogs and mini player');
  const live=(await page.evaluate(()=>window.luma.getState())).state;assert.deepEqual(live.playlists,state.playlists);assert.equal(live.settings.volume,.43);assert.equal(live.settings.fadeOut,1.2);assert.equal(live.playback.repeat,'stop');
  await app.close();app=undefined;const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));assert.deepEqual(saved.playlists,state.playlists);assert.equal(saved.settings.volume,.43);assert.deepEqual(errors,[]);
  console.log('PASS existing SONO library/settings loaded and saved without renderer errors');
}finally{if(app)await app.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('musicboard-brand-'));await rm(resolved,{recursive:true,force:true});}
