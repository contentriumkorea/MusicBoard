// @vitest-environment happy-dom
import { afterEach,beforeAll,expect,it,vi } from 'vitest';
import { createNativeBridge,createNativeDropDispatcher,initializeNativeBridge,installPointerDragAdapter } from '../src/native';
import type { NativeApi,ShellInfo } from '../src/native';
import { audioUrl } from '../src/shared/media';
import { emptyState } from '../src/shared/library';
import type { Track,UpdateState } from '../src/shared/types';

const info:ShellInfo={platform:'windows',mediaBase:'http://127.0.0.1:32100/token',version:'0.2.0',runtime:'rust'};
const track:Track={id:'song',path:'C:\\Music\\song.mp3',title:'Song',artist:'Artist',album:'Album',duration:10,format:'MP3',addedAt:1,favorite:false,artwork:'luma://art/hash'};
const makeState=()=>({...emptyState(),tracks:[{...track}]});
// happy-dom exposes a placeholder DragEvent without MouseEvent coordinates or dataTransfer.
beforeAll(()=>{globalThis.DragEvent=class extends MouseEvent {
  readonly dataTransfer:DataTransfer|null;
  constructor(type:string,init:DragEventInit={}){super(type,init);this.dataTransfer=init.dataTransfer??null;}
} as typeof DragEvent;});
const update:UpdateState={version:'0.2.0',status:'available',mode:'automatic',releasesUrl:'https://example.com/releases',message:'Ready'};
const cleanup:(()=>void)[]=[];
function fakeApi(){
  const callbacks=new Map<string,(event:{payload:any})=>void>();
  const removed:string[]=[];
  const invoke=vi.fn(async(_command:string,args?:Record<string,unknown>):Promise<any>=>{
    if(args?.method==='state:get')return {state:makeState()};
    if(args?.method==='music:paths'||args?.method==='music:import'||args?.method==='playlist:import')return {state:makeState(),added:1,errors:[]};
    if(args?.method==='music:remove')return makeState();
    if(String(args?.method).startsWith('update:'))return update;
  });
  const api:NativeApi={core:{invoke},event:{listen:async(name,callback)=>{callbacks.set(name,callback);return()=>{removed.push(name);callbacks.delete(name);};}}};
  return {api,invoke,callbacks,removed};
}
async function setup(platform:ShellInfo['platform']='windows'){
  const fake=fakeApi(),result=await createNativeBridge(fake.api,{...info,platform});cleanup.push(result.dispose);return {...fake,...result};
}
afterEach(()=>{cleanup.splice(0).forEach(stop=>stop());document.body.replaceChildren();vi.restoreAllMocks();delete window.__TAURI__;});

it('preserves the Electron bridge when Tauri is absent',async()=>{
  const original=window.luma;await initializeNativeBridge();expect(window.luma).toBe(original);
  window.luma={} as typeof window.luma;expect(audioUrl('song')).toBe('luma://audio/song');window.luma=original;
});
it('maps native platforms and media addresses',async()=>{
  const {bridge}=await setup();expect(bridge.platform).toBe('win32');
  expect(bridge.mediaUrl?.('audio','song name')).toBe(`${info.mediaBase}/audio/song%20name`);
  expect((await setup('macos')).bridge.platform).toBe('darwin');expect((await setup('linux')).bridge.platform).toBe('linux');
  window.luma=bridge;expect(audioUrl('song')).toBe(`${info.mediaBase}/audio/song`);
});
it('hydrates artwork but sends canonical artwork and exact argument envelopes to Rust',async()=>{
  const {bridge,invoke}=await setup();
  const result=await bridge.getState();expect(result.state.tracks[0].artwork).toBe(`${info.mediaBase}/art/hash`);
  await bridge.saveState(result.state);
  expect(invoke).toHaveBeenLastCalledWith('native',{method:'state:save',args:{state:makeState()}});
  await bridge.saveWaveform('song','key',[0,0.5]);expect(invoke).toHaveBeenLastCalledWith('native',{method:'waveform:save',args:{id:'song',key:'key',peaks:[0,0.5]}});
  expect((await bridge.importMusic('folder')).state.tracks[0].artwork).toBe(`${info.mediaBase}/art/hash`);
  expect(invoke).toHaveBeenLastCalledWith('native',{method:'music:import',args:{mode:'folder'}});
  await bridge.exportPlaylist('list');expect(invoke).toHaveBeenLastCalledWith('native',{method:'playlist:export',args:{id:'list'}});
});
it('subscribes before live-state requests and unsubscribes synchronously',async()=>{
  const {bridge,callbacks,invoke,dispose,removed}=await setup();const callback=vi.fn();const stop=bridge.onLive(callback);
  expect(invoke).toHaveBeenLastCalledWith('native',{method:'player:request',args:{}});
  callbacks.get('player:live')!({payload:{track,playing:true,position:1,duration:10,volume:1}});
  expect(callback.mock.calls[0][0].track.artwork).toBe(`${info.mediaBase}/art/hash`);
  stop();callbacks.get('player:live')!({payload:{track:null}});expect(callback).toHaveBeenCalledTimes(1);
  dispose();expect(removed).toContain('native:drop');
});
it('waits for frontend state flush acknowledgment before update installation',async()=>{
  const {bridge,invoke}=await setup();let saveComplete=false;
  bridge.onFlush(()=>{void bridge.saveState(makeState()).then(()=>{saveComplete=true;bridge.flushDone();});});
  await bridge.installUpdate();expect(saveComplete).toBe(true);
  const methods=invoke.mock.calls.map(call=>call[1]?.method);
  expect(methods.indexOf('state:save')).toBeLessThan(methods.indexOf('lifecycle:flushed'));
  expect(methods.indexOf('lifecycle:flushed')).toBeLessThan(methods.indexOf('update:install'));
});
it('returns a retryable update error after reading native updater state',async()=>{
  const {bridge,invoke}=await setup();invoke.mockImplementation(async(_command,args)=>{if(args?.method==='update:download')throw new Error('Network unavailable');return update;});
  expect(await bridge.downloadUpdate()).toMatchObject({status:'error',message:'Network unavailable'});
  expect(invoke).toHaveBeenLastCalledWith('native',{method:'update:get',args:{}});
});
it('routes OS paths through zero-byte File proxies and CSS drop coordinates',async()=>{
  const {bridge,invoke}=await setup();const row=document.createElement('div');row.dataset.trackId='song';document.body.append(row);
  vi.spyOn(document,'elementFromPoint').mockReturnValue(row);vi.spyOn(window,'devicePixelRatio','get').mockReturnValue(2);
  let imported:Promise<unknown>|undefined;row.addEventListener('drop',event=>{
    expect(event.clientX).toBe(30);expect(event.clientY).toBe(20);expect(event.dataTransfer!.files[0].size).toBe(0);
    imported=bridge.importDroppedFiles(Array.from(event.dataTransfer!.files));
  });
  createNativeDropDispatcher()({type:'drop',paths:['C:\\Music\\song.mp3'],position:{x:60,y:40}});
  await imported;expect(invoke).toHaveBeenLastCalledWith('native',{method:'music:paths',args:{paths:['C:\\Music\\song.mp3']}});
  await expect(bridge.importDroppedFiles([new File([],'unknown.mp3')])).rejects.toThrow('컴퓨터에 저장된');
});
it('adapts pointer movement to existing row drag handlers and suppresses the final click',()=>{
  const row=document.createElement('div'),target=document.createElement('div');row.dataset.trackId='song';target.dataset.trackId='next';document.body.append(row,target);
  const events:string[]=[];row.addEventListener('dragstart',event=>{events.push('start');event.dataTransfer!.setData('application/x-sono-track','["song"]');});
  target.addEventListener('dragover',event=>{events.push('over');expect(event.dataTransfer!.getData('application/x-sono-track')).toBe('["song"]');event.preventDefault();});
  target.addEventListener('drop',()=>events.push('drop'));row.addEventListener('dragend',()=>events.push('end'));
  vi.spyOn(document,'elementFromPoint').mockReturnValue(target);cleanup.push(installPointerDragAdapter(async()=>{}));
  const pointer=(type:string,x:number)=>new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:x,clientY:10});
  row.dispatchEvent(pointer('pointerdown',10));document.dispatchEvent(pointer('pointermove',13));expect(events).toEqual([]);
  document.dispatchEvent(pointer('pointermove',30));document.dispatchEvent(pointer('pointerup',30));expect(events).toEqual(['start','over','drop','end']);
  const click=new MouseEvent('click',{bubbles:true,cancelable:true});target.dispatchEvent(click);expect(click.defaultPrevented).toBe(true);
});
