import { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu, shell } from 'electron';
import updaterPackage from 'electron-updater';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { emptyState, mergeTracks, sanitizeState, removeLibraryTracks } from '../src/shared/library';
import type { AppState, LiveState, Track } from '../src/shared/types';
import { readState, writeState } from './store';
import { AUDIO_EXTENSIONS, parseM3U, readTrack, scanMusic, repairMp4Metadata } from './library';
import { fileResponse } from './media';
import { createExitFlusher } from './lifecycle';
import { folderContains, trackDirectory } from '../src/shared/folders';
import { createUpdateService, readRelease } from './updates';
import { MacUpdater } from './mac-updates';
import { readWaveform,writeWaveform } from './waveforms';
import { sanitizeTrim } from '../src/shared/trim';
import packageInfo from '../package.json';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.LUMA_DATA_DIR)app.setPath('userData',process.env.LUMA_DATA_DIR);
else {
  const dataDirectory=path.join(app.getPath('appData'),'Luma Music');
  mkdirSync(dataDirectory,{recursive:true});
  app.setPath('userData',dataDirectory);
}
app.setName('MusicBoard');
protocol.registerSchemesAsPrivileged([{scheme:'luma',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
let mainWindow:BrowserWindow|null=null;let miniWindow:BrowserWindow|null=null;let state:AppState=emptyState();let warning:string|undefined;let busy=false;let pendingSave=Promise.resolve();
let live:LiveState={track:null,playing:false,position:0,duration:0,volume:0.7};
let allowMainClose=false;let allowQuit=false;let finishRendererFlush:(()=>void)|null=null;
const flushBeforeExit=createExitFlusher(async()=>{
  if(!mainWindow||mainWindow.isDestroyed())return;
  await new Promise<void>(resolve=>{
    const timer=setTimeout(done,2000);
    function done(){clearTimeout(timer);finishRendererFlush=null;resolve();}
    finishRendererFlush=done;mainWindow!.webContents.send('state:flush');
  });
},()=>pendingSave);
const stateFile=()=>path.join(app.getPath('userData'),'state.json');
const artDir=()=>path.join(app.getPath('userData'),'artwork');
const devURL=process.env.LUMA_DEV_URL;
const releasesUrl=`https://github.com/${packageInfo.build.publish.owner}/${packageInfo.build.publish.repo}/releases`;
const updateCache=path.join(app.getPath('userData'),'mac-updates');
const updateArgument=(name:string)=>process.argv.find(arg=>new RegExp(`^--${name}=[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12}$`).test(arg))?.split('=')[1];
const updateToken=updateArgument('sono-update-token');
const rollbackToken=updateArgument('sono-update-rollback');
const macUpdater=app.isPackaged&&process.platform==='darwin'?new MacUpdater({version:app.getVersion(),releasesUrl,bundlePath:path.dirname(path.dirname(path.dirname(process.execPath))),cacheDir:updateCache,helperPath:path.join(root,'resources','mac-update.sh'),fetch:(url,init)=>net.fetch(url,init),quit:()=>app.quit()}):undefined;
const updates=createUpdateService({
  version:app.getVersion(),releasesUrl,
  updater:macUpdater||(app.isPackaged&&process.platform==='win32'?updaterPackage.autoUpdater:undefined),
  readRelease:async()=>{
    const response=await net.fetch(`https://api.github.com/repos/${packageInfo.build.publish.owner}/${packageInfo.build.publish.repo}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'MusicBoard'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('릴리스를 확인하지 못했습니다.');
    return readRelease(await response.json(),process.platform,releasesUrl);
  },
  flush:async()=>{await flushBeforeExit();await persist();},
  openRelease:url=>shell.openExternal(url)
});
updates.subscribe(value=>mainWindow?.webContents.send('update:state',value));
const urlFor=(mini=false)=>devURL?`${devURL}${mini?'?mini=1':''}`:`luma://app/index.html${mini?'?mini=1':''}`;
function trusted(event:Electron.IpcMainEvent|Electron.IpcMainInvokeEvent){
  const known=event.sender===mainWindow?.webContents||event.sender===miniWindow?.webContents;
  const url=event.senderFrame?.url??'';
  return known && (url.startsWith('luma://app/')||(devURL && new URL(url).origin===new URL(devURL).origin));
}
function handle(channel:string,callback:(event:Electron.IpcMainInvokeEvent,...args:any[])=>any){ipcMain.handle(channel,(event,...args)=>{if(!trusted(event))throw new Error('허용되지 않은 요청');return callback(event,...args);});}
const persist=()=>{pendingSave=writeState(stateFile(),state);return pendingSave;};
function protect(win:BrowserWindow){
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('luma://app/')&&!(devURL&&new URL(url).origin===new URL(devURL).origin))event.preventDefault();});
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
}
function createMain(){
  allowMainClose=false;
  mainWindow=new BrowserWindow({width:1320,height:880,minWidth:960,minHeight:650,show:false,title:'MusicBoard',icon:path.join(root,'resources','icon.png'),backgroundColor:'#171717',frame:process.platform==='darwin',titleBarStyle:process.platform==='darwin'?'hiddenInset':undefined,webPreferences:{preload:path.join(root,'dist-electron','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,autoplayPolicy:'no-user-gesture-required'}});
  protect(mainWindow);mainWindow.once('ready-to-show',()=>{mainWindow?.show();if(updateToken)void writeFile(path.join(updateCache,updateToken,'health'),app.getVersion(),{mode:0o600}).catch(()=>{});});mainWindow.on('closed',()=>{mainWindow=null;miniWindow?.close();});
  mainWindow.on('close',event=>{if(allowMainClose)return;event.preventDefault();void flushBeforeExit().finally(()=>{allowMainClose=true;mainWindow?.close();});});
  mainWindow.loadURL(urlFor());
}
async function importFiles(files:string[],folderRoots:string[]=[]):Promise<{added:number;errors:string[];tracks:Track[]}>{
  const errors:string[]=[];let added=0;const tracks:Track[]=[];
  for(let i=0;i<files.length;i++){
    mainWindow?.webContents.send('import:progress',{current:i+1,total:files.length,name:path.basename(files[i])});
    try{
      const track=await readTrack(files[i],artDir());
      const existing=state.tracks.find(t=>t.id===track.id);
      const root=folderRoots.find(folder=>folderContains(folder,trackDirectory(track.path)));
      if(root)track.folderRoot=existing?.folderRoot&&folderContains(existing.folderRoot,root)?existing.folderRoot:root;
      tracks.push(track);
      if(!existing){state.tracks.push(track);added++;}
      else if(track.folderRoot)existing.folderRoot=track.folderRoot;
    }
    catch{errors.push(`${path.basename(files[i])}: 읽을 수 없는 음악 파일`);}
  }
  await persist();return {added,errors,tracks};
}
async function importMusicPaths(paths:string[]){
  const scanErrors:string[]=[];
  const files=await scanMusic(paths,file=>scanErrors.push(`${path.basename(file)}: 접근할 수 없는 파일 또는 폴더`));
  if(!files.length&&!scanErrors.length)throw new Error('가져올 수 있는 음악 파일이 없습니다. 음악 파일이나 음악이 담긴 폴더를 놓아주세요.');
  const folderRoots=(await Promise.all(paths.map(async input=>{try{const resolved=await realpath(input);return (await stat(resolved)).isDirectory()?resolved:null;}catch{return null;}}))).filter((p):p is string=>!!p).sort((a,b)=>a.length-b.length);
  const imported=await importFiles(files,folderRoots);
  return {state,added:imported.added,errors:[...scanErrors,...imported.errors],folderRoots,trackIds:imported.tracks.map(t=>t.id)};
}
app.whenReady().then(async()=>{
  ({state,warning}=await readState(stateFile()));
  if(await repairMp4Metadata(state.tracks)){
    try{await persist();}catch{warning='음원 정보를 갱신했지만 저장하지 못했습니다.';}
  }
  if(rollbackToken)warning='새 버전 실행에 실패해 이전 MusicBoard 앱으로 복구했습니다. 보관함과 설정은 유지됩니다.';
  protocol.handle('luma',async(request)=>{
    const url=new URL(request.url);
    if(url.hostname==='audio'){
      const track=state.tracks.find(t=>t.id===url.pathname.slice(1));
      if(!track)return new Response('Not found',{status:404});
      const mimes:Record<string,string>={MP3:'audio/mpeg',WAV:'audio/wav',FLAC:'audio/flac',M4A:'audio/mp4',AAC:'audio/aac',OGG:'audio/ogg',OPUS:'audio/ogg',AIFF:'audio/aiff',AIF:'audio/aiff'};
      return fileResponse(track.path,request,mimes[track.format]??'application/octet-stream');
    }
    if(url.hostname==='art'&&/^\/[a-f0-9]{64}$/.test(url.pathname))return fileResponse(path.join(artDir(),url.pathname.slice(1)),request,'application/octet-stream');
    if(url.hostname==='app'){
      const relative=decodeURIComponent(url.pathname).replace(/^\//,'');
      const file=path.resolve(root,'dist',relative||'index.html');const inside=path.relative(path.join(root,'dist'),file);
      if(inside.startsWith('..')||path.isAbsolute(inside))return new Response('Forbidden',{status:403});
      return net.fetch(pathToFileURL(file).toString());
    }
    return new Response('Not found',{status:404});
  });
  handle('state:get',()=>({state,warning}));
  handle('waveform:get',async(_event,id:unknown)=>{
    const track=state.tracks.find(t=>t.id===id);if(!track)throw new Error('음원을 찾을 수 없습니다.');
    return readWaveform(track.path,path.join(app.getPath('userData'),'waveforms'));
  });
  handle('waveform:save',async(_event,id:unknown,key:unknown,peaks:unknown)=>{
    const track=state.tracks.find(t=>t.id===id);if(!track||typeof key!=='string')throw new Error('음원을 찾을 수 없습니다.');
    await writeWaveform(track.path,path.join(app.getPath('userData'),'waveforms'),key,peaks);
  });
  handle('update:get',()=>updates.get());
  handle('update:check',()=>updates.check());
  handle('update:download',()=>updates.download());
  handle('update:install',event=>{if(event.sender!==mainWindow?.webContents)throw new Error('메인 창에서 업데이트해주세요.');return updates.install();});
  handle('state:save',async(event,value:unknown)=>{
    if(event.sender!==mainWindow?.webContents)throw new Error('메인 창에서만 저장할 수 있습니다.');
    const incoming=sanitizeState(value);
    const known=new Map(state.tracks.map(track=>[track.id,track]));
    const ordered=[...new Set([...incoming.tracks.map(track=>track.id),...state.tracks.map(track=>track.id)])];
    state={...incoming,tracks:ordered.flatMap(id=>{const track=known.get(id),edit=incoming.tracks.find(t=>t.id===id);return track?[{...track,trim:edit?sanitizeTrim(edit.trim,track.duration):track.trim,favorite:edit?.favorite??track.favorite,folderId:edit?.folderId??track.folderId,displayName:edit?.displayName??track.displayName}]:[];})};
    state=sanitizeState(state);await persist();
  });
  handle('music:import',async(_event,mode:string)=>{
    if(busy)throw new Error('가져오기가 진행 중입니다.');busy=true;
    try{
      const result=await dialog.showOpenDialog(mainWindow!,{title:'음악 가져오기',properties:mode==='folder'?['openDirectory']:['openFile','multiSelections'],filters:[{name:'음악 파일',extensions:AUDIO_EXTENSIONS}]});
      if(result.canceled)return {state,added:0,errors:[],cancelled:true};
      return await importMusicPaths(result.filePaths);
    }finally{busy=false;}
  });
  handle('music:remove',async(event,ids:unknown)=>{
    if(event.sender!==mainWindow?.webContents||!Array.isArray(ids)||!ids.every(id=>typeof id==='string'))throw new Error('유효하지 않은 곡 선택입니다.');
    if(busy)throw new Error('가져오기가 완료된 후 삭제해주세요.');
    state=removeLibraryTracks(state,ids);await persist();return state;
  });
  handle('music:drop',async(event,paths:unknown)=>{
    if(event.sender!==mainWindow?.webContents)throw new Error('메인 창에 음악을 놓아주세요.');
    if(!Array.isArray(paths)||!paths.length||!paths.every(p=>typeof p==='string'&&path.isAbsolute(p)))throw new Error('유효한 음악 파일이나 폴더를 놓아주세요.');
    if(busy)throw new Error('가져오기가 진행 중입니다.');busy=true;
    try{
      return await importMusicPaths(paths);
    }finally{busy=false;}
  });
  handle('playlist:import',async()=>{
    if(busy)throw new Error('가져오기가 진행 중입니다.');busy=true;
    try{
      const result=await dialog.showOpenDialog(mainWindow!,{title:'재생목록 가져오기',properties:['openFile'],filters:[{name:'M3U 재생목록',extensions:['m3u','m3u8']}]});
      if(result.canceled)return {state,added:0,errors:[],cancelled:true};
      const file=result.filePaths[0];const files=parseM3U(await readFile(file,'utf8'),file);
      const imported=await importFiles(files);
      state.playlists.push({id:randomUUID(),name:path.basename(file,path.extname(file)),trackIds:[...new Set(imported.tracks.map(t=>t.id))]});
      await persist();return {state,added:imported.added,errors:imported.errors};
    }finally{busy=false;}
  });
  handle('playlist:export',async(_event,id:string)=>{
    const playlist=state.playlists.find(p=>p.id===id);if(!playlist)return false;
    const result=await dialog.showSaveDialog(mainWindow!,{defaultPath:`${playlist.name.replace(/[<>:"/\\|?*]/g,'_')}.m3u8`,filters:[{name:'M3U 재생목록',extensions:['m3u8']}]});
    if(result.canceled||!result.filePath)return false;
    const lines=['#EXTM3U',...playlist.trackIds.flatMap(trackId=>{const track=state.tracks.find(t=>t.id===trackId);return track?[`#EXTINF:${Math.round(track.duration)},${track.artist} - ${track.title}`,track.path]:[];})];
    await writeFile(result.filePath,lines.join('\n'),'utf8');return true;
  });
  handle('mini:show',()=>{
    if(miniWindow){miniWindow.focus();return;}
    miniWindow=new BrowserWindow({width:440,height:150,resizable:false,frame:false,alwaysOnTop:true,backgroundColor:'#222222',webPreferences:{preload:path.join(root,'dist-electron','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    protect(miniWindow);miniWindow.on('closed',()=>{miniWindow=null;});miniWindow.webContents.once('did-finish-load',()=>miniWindow?.webContents.send('player:live',live));miniWindow.loadURL(urlFor(true));
  });
  handle('mini:close',()=>miniWindow?.close());
  ipcMain.on('player:live',(event,value:LiveState)=>{if(trusted(event)&&event.sender===mainWindow?.webContents){live=value;miniWindow?.webContents.send('player:live',live);}});
  ipcMain.on('state:flushed',event=>{if(trusted(event)&&event.sender===mainWindow?.webContents)finishRendererFlush?.();});
  ipcMain.on('player:command',(event,command:string)=>{if(trusted(event)&&['toggle','next','previous'].includes(command))mainWindow?.webContents.send('player:command',command);});
  ipcMain.on('window:action',(event,action:string)=>{if(!trusted(event))return;const win=BrowserWindow.fromWebContents(event.sender);if(action==='minimize')win?.minimize();if(action==='close')win?.close();if(action==='maximize'){if(win?.isMaximized())win.unmaximize();else win?.maximize();}});
  Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([{label:'MusicBoard',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'quit'}]},{label:'편집',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]}]):null);
  createMain();app.on('activate',()=>{if(!mainWindow)createMain();});
});
app.on('before-quit',event=>{if(allowQuit)return;event.preventDefault();void flushBeforeExit().finally(()=>{allowQuit=true;allowMainClose=true;app.quit();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')pendingSave.finally(()=>app.quit());});
