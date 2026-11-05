import type { AppState, Bridge, ImportResult, LiveState, PlayerCommand, Progress, Track, UpdateState } from './shared/types';

/** Public APIs exposed by Tauri's withGlobalTauri option; no renderer package required. */
export interface NativeApi {
  core:{invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>};
  event:{listen<T>(name:string,callback:(event:{payload:T})=>void):Promise<()=>void>};
}
export interface ShellInfo {platform:'windows'|'macos'|'linux';mediaBase:string;version:string;runtime:'rust'}
export interface NativeDrop {type:'enter'|'over'|'drop'|'leave';paths?:string[];position?:{x:number;y:number}}
declare global {interface Window {__TAURI__?:NativeApi}}

type Subscriber<T>=(value:T)=>void;
function subscriptions<T>() {
  const callbacks=new Set<Subscriber<T>>();
  return {emit:(value:T)=>{for(const callback of [...callbacks])callback(value);},
    add:(callback:Subscriber<T>)=>{callbacks.add(callback);return()=>{callbacks.delete(callback);};},
    get size(){return callbacks.size;}};
}
const droppedPaths=new WeakMap<File,string>();
let pointerDragging=false;
function dragEvent(target:EventTarget,type:string,dataTransfer:DataTransfer,x:number,y:number) {
  const event=new DragEvent(type,{bubbles:true,cancelable:true,composed:true,dataTransfer,clientX:x,clientY:y});
  target.dispatchEvent(event);return event;
}

/** Feed OS file paths through the existing React/document drop handlers. */
export function createNativeDropDispatcher() {
  let transfer:DataTransfer|undefined,lastTarget:Element|undefined,lastPosition={x:0,y:0};
  return (drop:NativeDrop)=>{
    if(pointerDragging)return;
    if(drop.position)lastPosition=drop.position;
    const scale=window.devicePixelRatio||1,x=lastPosition.x/scale,y=lastPosition.y/scale;
    const target=document.elementFromPoint(x,y)||lastTarget||document.body;
    if(drop.type==='enter'||!transfer)transfer=new DataTransfer();
    if(drop.paths?.length){
      transfer.items.clear();
      for(const path of drop.paths){
        const file=new File([],path.split(/[\\/]/).pop()||path);
        droppedPaths.set(file,path);transfer.items.add(file);
      }
    }
    const type=drop.type==='enter'?'dragenter':drop.type==='over'?'dragover':drop.type==='leave'?'dragleave':'drop';
    dragEvent(target,type,transfer,x,y);lastTarget=target;
    if(drop.type==='drop'||drop.type==='leave'){transfer=undefined;lastTarget=undefined;}
  };
}

/** WebView2 native file drops suppress HTML5 internal dragging on Windows. */
export function installPointerDragAdapter(invoke:(method:string,args?:Record<string,unknown>)=>Promise<unknown>) {
  let candidate:{source:HTMLElement;id:number;x:number;y:number}|undefined;
  let active:{source:HTMLElement;transfer:DataTransfer;target:Element|null}|undefined;
  let suppressClickUntil=0,oldUserSelect='';
  const finish=(event?:PointerEvent,drop=false)=>{
    if(active){
      const {source,transfer}=active,x=event?.clientX??candidate?.x??0,y=event?.clientY??candidate?.y??0;
      const target=event?document.elementFromPoint(x,y):null;
      if(drop&&target)dragEvent(target,'drop',transfer,x,y);
      dragEvent(source,'dragend',transfer,x,y);
      document.body.style.userSelect=oldUserSelect;suppressClickUntil=Date.now()+400;
    }
    active=undefined;candidate=undefined;pointerDragging=false;
  };
  const down=(event:PointerEvent)=>{
    if(event.button!==0||!(event.target instanceof Element))return;
    const target=event.target;
    if(target.closest('.drag')&&!target.closest('.no-drag,button,input,select,textarea,a')){
      event.preventDefault();void invoke('window:drag').catch(()=>{});return;
    }
    const handle=target.closest<HTMLElement>('.folder-drag-handle,.drag-handle');
    if(!handle&&target.closest('button,input,select,textarea,a,[contenteditable="true"]'))return;
    const source=handle?.classList.contains('folder-drag-handle')?handle:target.closest<HTMLElement>('[data-track-id]');
    if(source)candidate={source,id:event.pointerId,x:event.clientX,y:event.clientY};
  };
  const move=(event:PointerEvent)=>{
    if(!candidate||event.pointerId!==candidate.id)return;
    if(!active){
      if(Math.hypot(event.clientX-candidate.x,event.clientY-candidate.y)<=5)return;
      const transfer=new DataTransfer();
      if(dragEvent(candidate.source,'dragstart',transfer,candidate.x,candidate.y).defaultPrevented){candidate=undefined;return;}
      active={source:candidate.source,transfer,target:null};pointerDragging=true;oldUserSelect=document.body.style.userSelect;document.body.style.userSelect='none';
    }
    event.preventDefault();
    const target=document.elementFromPoint(event.clientX,event.clientY);
    if(target!==active.target){
      if(active.target)dragEvent(active.target,'dragleave',active.transfer,event.clientX,event.clientY);
      if(target)dragEvent(target,'dragenter',active.transfer,event.clientX,event.clientY);
      active.target=target;
    }
    if(target)dragEvent(target,'dragover',active.transfer,event.clientX,event.clientY);
  };
  const up=(event:PointerEvent)=>{if(candidate&&event.pointerId===candidate.id)finish(event,true);};
  const cancel=()=>finish();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')finish();};
  const click=(event:MouseEvent)=>{if(Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}};
  const nativeStart=(event:DragEvent)=>{if(event.isTrusted&&candidate){event.preventDefault();event.stopImmediatePropagation();}};
  document.addEventListener('pointerdown',down,true);document.addEventListener('pointermove',move,{capture:true,passive:false});
  document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true);
  document.addEventListener('keydown',escape,true);document.addEventListener('click',click,true);document.addEventListener('dragstart',nativeStart,true);
  window.addEventListener('blur',cancel);
  return()=>{finish();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',move,true);
    document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true);
    document.removeEventListener('keydown',escape,true);document.removeEventListener('click',click,true);document.removeEventListener('dragstart',nativeStart,true);window.removeEventListener('blur',cancel);};
}

export async function createNativeBridge(api:NativeApi,info:ShellInfo):Promise<{bridge:Bridge;dispose:()=>void;ready:()=>Promise<void>}> {
  const invoke=<T,>(method:string,args:Record<string,unknown>={})=>api.core.invoke<T>('native',{method,args});
  const mediaBase=info.mediaBase.replace(/\/$/,'');
  const mediaUrl=(kind:'audio'|'art',id:string)=>`${mediaBase}/${kind}/${encodeURIComponent(id)}`;
  const track=(value:Track,toNative=false):Track=>{
    const artwork=value.artwork;
    if(!artwork)return value;
    if(toNative&&artwork.startsWith(`${mediaBase}/art/`))return {...value,artwork:`luma://art/${artwork.slice(`${mediaBase}/art/`.length)}`};
    if(!toNative&&artwork.startsWith('luma://art/'))return {...value,artwork:mediaUrl('art',artwork.slice('luma://art/'.length))};
    return value;
  };
  const state=(value:AppState,toNative=false):AppState=>({...value,tracks:value.tracks.map(value=>track(value,toNative))});
  const imported=(value:ImportResult):ImportResult=>({...value,state:state(value.state)});
  const live=(value:LiveState,toNative=false):LiveState=>({...value,track:value.track?track(value.track,toNative):null});
  const progress=subscriptions<Progress>(),updates=subscriptions<UpdateState>(),lives=subscriptions<LiveState>(),commands=subscriptions<PlayerCommand>(),flushes=subscriptions<void>();
  let pendingFlush:{resolve:()=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>;error?:Error}|undefined;
  const flush=()=>{
    if(!flushes.size)return Promise.resolve();
    if(pendingFlush)return Promise.reject(new Error('설정을 저장하는 중입니다. 잠시 후 다시 시도해주세요.'));
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingFlush=undefined;reject(new Error('설정을 저장하지 못했습니다. 다시 시도해주세요.'));},10000);
      pendingFlush={resolve,reject,timer};
      try{flushes.emit();}catch(error){clearTimeout(timer);pendingFlush=undefined;reject(error);}
    });
  };
  const update=async(method:string):Promise<UpdateState>=>{try{return await invoke<UpdateState>(method);}catch(error){
    const current=await invoke<UpdateState>('update:get');
    return {...current,status:'error',message:current.status==='error'?current.message:error instanceof Error?error.message:String(error)};
  }};
  const bridge:Bridge={
    platform:info.platform==='windows'?'win32':info.platform==='macos'?'darwin':'linux',mediaUrl,
    getWaveform:id=>invoke('waveform:get',{id}),saveWaveform:(id,key,peaks)=>invoke('waveform:save',{id,key,peaks}),
    getUpdateState:()=>invoke('update:get'),checkForUpdates:()=>update('update:check'),downloadUpdate:()=>update('update:download'),
    installUpdate:async()=>{try{await flush();}catch(error){const current=await invoke<UpdateState>('update:get');return {...current,status:'error',message:error instanceof Error?error.message:String(error)};}return update('update:install');},
    onUpdate:updates.add,
    getState:async()=>{const result=await invoke<{state:AppState;warning?:string}>('state:get');return {...result,state:state(result.state)};},
    saveState:async value=>{try{await invoke('state:save',{state:state(value,true)});}catch(error){if(pendingFlush)pendingFlush.error=error instanceof Error?error:new Error(String(error));throw error;}},removeMusic:async ids=>state(await invoke('music:remove',{ids})),
    importMusic:async mode=>imported(await invoke('music:import',{mode})),
    importDroppedFiles:async files=>{const paths=files.map(file=>droppedPaths.get(file)).filter((path):path is string=>!!path);
      if(!paths.length)throw new Error('컴퓨터에 저장된 음악 파일이나 폴더를 놓아주세요.');return imported(await invoke('music:paths',{paths}));},
    importPlaylist:async()=>imported(await invoke('playlist:import')),exportPlaylist:id=>invoke('playlist:export',{id}),
    showMini:()=>invoke('mini:show'),closeMini:()=>invoke('mini:close'),
    publishLive:value=>{void invoke('player:live',{state:live(value,true)}).catch(()=>{});},
    playerCommand:command=>{void invoke('player:command',{command}).catch(()=>{});},
    onLive:callback=>{const stop=lives.add(callback);void invoke('player:request').catch(()=>{});return stop;},
    onCommand:commands.add,onProgress:progress.add,onFlush:flushes.add,
    flushDone:()=>{
      if(pendingFlush?.error){const pending=pendingFlush;pendingFlush=undefined;clearTimeout(pending.timer);pending.reject(pending.error!);return;}
      void invoke('lifecycle:flushed').then(()=>{if(pendingFlush){clearTimeout(pendingFlush.timer);pendingFlush.resolve();pendingFlush=undefined;}}).catch(error=>{if(pendingFlush){clearTimeout(pendingFlush.timer);pendingFlush.reject(error);pendingFlush=undefined;}});
    },
    windowAction:action=>{void invoke('window:action',{action}).catch(()=>{});}
  };
  const stops:(()=>void)[]=[];
  const listen=async<T,>(name:string,callback:(value:T)=>void)=>{stops.push(await api.event.listen<T>(name,event=>callback(event.payload)));};
  try{
    await listen<Progress>('import:progress',progress.emit);await listen<UpdateState>('update:state',updates.emit);
    await listen<LiveState>('player:live',value=>lives.emit(live(value)));await listen<PlayerCommand>('player:command',commands.emit);
    await listen<void>('state:flush',()=>flushes.emit());await listen<NativeDrop>('native:drop',createNativeDropDispatcher());
    stops.push(installPointerDragAdapter(invoke));
  }catch(error){stops.forEach(stop=>stop());throw error;}
  return {bridge,ready:()=>invoke('frontend:ready'),dispose:()=>{stops.forEach(stop=>stop());if(pendingFlush){clearTimeout(pendingFlush.timer);pendingFlush.reject(new Error('창을 닫았습니다.'));pendingFlush=undefined;}}};
}

let native:Awaited<ReturnType<typeof createNativeBridge>>|undefined;
export async function initializeNativeBridge():Promise<void> {
  if(!window.__TAURI__)return;
  const info=await window.__TAURI__.core.invoke<ShellInfo>('native',{method:'shell:info',args:{}});
  native=await createNativeBridge(window.__TAURI__,info);window.luma=native.bridge;
}
export async function notifyFrontendReady():Promise<void> {await native?.ready();}
