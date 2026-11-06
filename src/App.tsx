import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, GripVertical, Library, Disc3, Heart, Plus, Search, Folder, FolderPlus, Music2, ListMusic, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, SlidersHorizontal, PanelTop, ListEnd, ArrowUpRight, ChevronDown, Clock3, X, Minus, Square, MoreHorizontal, Download, Upload, Check, ArrowUp, ArrowDown, Trash2, Pencil, Timer, Headphones } from 'lucide-react';
import { Artwork } from './components/Artwork';
import { Modal } from './components/Modal';
import { Equalizer } from './components/Equalizer';
import { UpdatePanel } from './components/UpdatePanel';
import { WaveformSeek } from './components/WaveformSeek';
import { TrimDialog } from './components/TrimDialog';
import { FadeControl } from './components/FadeControl';
import { LoopDialog } from './components/LoopDialog';
import type { LoopRange } from './shared/loop';
import { sanitizeTrim,trimBounds,trimTime } from './shared/trim';
import { Scissors } from 'lucide-react';
import { placeImportedSongs } from './shared/placement';
import type { ImportDestination } from './shared/placement';
import { libraryFolders, songFolder, songName, moveLibrarySongs, moveSongsToFolder, reorderLibraryFolder, renameLibraryItem, removeEmptyLibraryFolders } from './shared/organization';
import { AudioPlayer } from './player';
import { emptyState, formatTime, mergeTracks, advancePlayback, searchTracks, reorderTrackIds, removeLibraryTracks } from './shared/library';
import type { AppState, ImportResult, LibrarySort, LibraryFolder, Playlist, Progress, Track, UpdateState } from './shared/types';

type View='library'|'albums'|'favorites'|string;
type Dialog='eq'|'timer'|'about'|'fade'|'playback'|'update'|'loop'|null;
type NameDialog={id?:string;name:string}|null;
const IconButton=({label,children,onClick,active=false,disabled=false}:{label:string;children:React.ReactNode;onClick:()=>void;active?:boolean;disabled?:boolean})=><button aria-label={label} title={label} disabled={disabled} onClick={event=>{event.stopPropagation();onClick();}} className={`icon-button ${active?'active':''}`}>{children}</button>;

export function App(){
  const [state,setState]=useState<AppState>(emptyState);
  const [loaded,setLoaded]=useState(false);
  const [updateState,setUpdateState]=useState<UpdateState|null>(null);
  useEffect(()=>{
    let active=true;const stop=window.luma.onUpdate(value=>{if(active)setUpdateState(value);});
    void window.luma.getUpdateState().then(value=>{if(active)setUpdateState(value);}).catch(()=>notify('업데이트 정보를 불러오지 못했습니다.'));
    return()=>{active=false;stop();};
  },[]);
  const [view,setView]=useState<View>('library');
  const [query,setQuery]=useState('');
  const [sort,setSort]=useState('added');
  const [playing,setPlaying]=useState(false);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(0);
  const [progress,setProgress]=useState<Progress|null>(null);
  const [importing,setImporting]=useState(false);
  const [dragging,setDragging]=useState(false);
  const [draggedTrack,setDraggedTrack]=useState<string|null>(null);
  const [dropTarget,setDropTarget]=useState<string|null>(null);
  const [dropAfter,setDropAfter]=useState(false);
  const dragIds=useRef<string[]>([]);
  const dragFolder=useRef<string|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const selectionAnchor=useRef<string|null>(null);
  const [deleting,setDeleting]=useState(false);
  const importBusy=useRef(false);
  const [toast,setToast]=useState('');
  const [dialog,setDialog]=useState<Dialog>(null);
  useEffect(()=>{if(dialog==='update')void window.luma.checkForUpdates().then(setUpdateState).catch(()=>notify('업데이트를 확인하지 못했습니다.'));},[dialog]);
  const [nameDialog,setNameDialog]=useState<NameDialog>(null);
  const [renameDialog,setRenameDialog]=useState<{kind:'track'|'folder';id:string;name:string}|null>(null);
  const [trimId,setTrimId]=useState<string|null>(null);
  const [abLoop,setABLoop]=useState<(LoopRange&{id:string})|null>(null);
  const [assignTrack,setAssignTrack]=useState<Track|null>(null);
  const [queueOpen,setQueueOpen]=useState(false);
  const [menu,setMenu]=useState<string|null>(null);
  const [albumFilter,setAlbumFilter]=useState<string|null>(null);
  const [sleepAt,setSleepAt]=useState<number|null>(null);
  const [timerRemaining,setTimerRemaining]=useState(0);
  const [confirmDelete,setConfirmDelete]=useState<Playlist|null>(null);
  const stateRef=useRef(state);stateRef.current=state;
  const player=useRef<AudioPlayer|null>(null);
  const visibleRef=useRef<Track[]>([]);
  const controls=useRef<{toggle:()=>void;next:(ended?:boolean)=>void;previous:()=>void;selectAll:()=>void;remove:()=>void}>({toggle:()=>{},next:()=>{},previous:()=>{},selectAll:()=>{},remove:()=>{}});
  const notify=(message:string)=>setToast(message);
  const current=state.tracks.find(t=>t.id===state.playback.currentId)??null;
  const currentRange=current?trimBounds(current,duration||current.duration):{start:0,end:0,duration:0};
  const trimTrack=state.tracks.find(t=>t.id===trimId);
  const activeLoop=abLoop&&abLoop.id===current?.id?abLoop:undefined;
  useEffect(()=>{setABLoop(null);setDialog(value=>value==='loop'?null:value);},[current?.id]);
  const playlist=state.playlists.find(p=>p.id===view);
  const viewTitle=view==='favorites'?'좋아하는 음악':view==='albums'?'앨범':playlist?.name||'내 음악';
  const grouped=view==='library'||view==='favorites';
  const playbackMode=state.playback.repeat==='one'?'one':state.playback.repeat==='stop'?'stop':'auto';
  const playbackLabel=playbackMode==='one'?'한 곡 반복':playbackMode==='stop'?'현재 곡만 재생 후 정지':'다음 곡 자동 재생';

  const visible=useMemo(()=>{
    let tracks=state.tracks;
    if(view==='favorites')tracks=tracks.filter(t=>t.favorite);
    if(playlist)tracks=playlist.trackIds.map(id=>tracks.find(t=>t.id===id)).filter((t):t is Track=>!!t);
    if(albumFilter)tracks=tracks.filter(t=>`${t.album}\0${t.artist}`===albumFilter);
    tracks=searchTracks(tracks,query);
    const compare=(a:Track,b:Track)=>sort==='title'?songName(a).localeCompare(songName(b)):sort==='artist'?a.artist.localeCompare(b.artist):sort==='manual'?0:b.addedAt-a.addedAt;
    if(grouped){
      const folders=libraryFolders(state.tracks,state.folders);if(sort!=='manual')folders.sort((a,b)=>a.name.localeCompare(b.name));
      return [...tracks].sort((a,b)=>folders.findIndex(f=>f.id===songFolder(a))-folders.findIndex(f=>f.id===songFolder(b))||compare(a,b));
    }
    if(sort==='title'||sort==='artist')return [...tracks].sort(compare);
    if(playlist||sort==='manual')return tracks;
    return [...tracks].sort((a,b)=>b.addedAt-a.addedAt);
  },[state.tracks,state.folders,state.playlists,view,playlist,query,sort,albumFilter,grouped]);
  visibleRef.current=visible;
  const importContext=useRef<ImportDestination>({});
  importContext.current={playlistId:playlist?.id,displayIds:visible.map(t=>t.id),folderOrder:libraryFolders(state.tracks,state.folders).sort((a,b)=>sort==='manual'?0:a.name.localeCompare(b.name)).map(f=>f.id)};
  const folders=libraryFolders(state.tracks,state.folders);if(sort!=='manual')folders.sort((a,b)=>a.name.localeCompare(b.name));
  const emptyFolderCount=folders.filter(f=>!state.tracks.some(t=>songFolder(t)===f.id)).length;
  const listItems:({kind:'folder';folder:LibraryFolder}|{kind:'track';track:Track})[]=grouped?folders.flatMap(folder=>{
    const songs=visible.filter(t=>songFolder(t)===folder.id);
    return !songs.length&&(view!=='library'||!!query)?[]:[{kind:'folder' as const,folder},...songs.map(track=>({kind:'track' as const,track}))];
  }):visible.map(track=>({kind:'track',track}));
  const albums=useMemo(()=>{
    const map=new Map<string,Track[]>();
    for(const t of searchTracks(state.tracks,query)){const key=`${t.album}\0${t.artist}`;const list=map.get(key)||[];list.push(t);map.set(key,list);}
    return [...map.entries()];
  },[state.tracks,query]);
  const updatePlayback=(patch:Partial<AppState['playback']>)=>setState(s=>({...s,playback:{...s.playback,...patch}}));
  function playTrack(track:Track,order?:string[],fromQueue=false){
    const p=player.current;if(!p)return;
    setABLoop(null);
    updatePlayback({currentId:track.id,position:0,...(!fromQueue?{anchorId:track.id}:{}),...(order?{order}: {})});
    p.load(track.id,0,true,track.trim);setPosition(trimBounds(track).start);setDuration(track.duration);
  }
  function toggle(){
    if(!player.current)return;
    if(!stateRef.current.playback.currentId){const track=visibleRef.current[0]||stateRef.current.tracks[0];if(track)playTrack(track,visibleRef.current.map(t=>t.id));else notify('먼저 음악을 가져와주세요.');return;}
    if(!player.current.playing)void player.current.play();else player.current.pause();
  }
  function toggleTrack(track:Track){
    if(stateRef.current.playback.currentId===track.id)toggle();
    else playTrack(track,visibleRef.current.map(t=>t.id));
  }
  function next(ended=false){
    const s=stateRef.current;
    const result=advancePlayback(s.playback,s.tracks.map(t=>t.id),ended);
    updatePlayback(result);
    const track=s.tracks.find(t=>t.id===result.currentId);
    if(track)playTrack(track,undefined,true);else{player.current?.pause();player.current?.seek(0);setPosition(0);updatePlayback({currentId:s.playback.currentId,position:0});}
  }
  function previous(){
    const s=stateRef.current;if(!player.current)return;
    const track=s.tracks.find(t=>t.id===s.playback.currentId);if(player.current.audio.currentTime>(track?trimBounds(track).start:0)+3){player.current.seek(0);return;}
    const order=s.playback.order.length?s.playback.order:s.tracks.map(t=>t.id);
    const i=order.indexOf(s.playback.currentId||'');const id=order[(i-1+order.length)%order.length];
    const previousTrack=s.tracks.find(t=>t.id===id);if(previousTrack)playTrack(previousTrack);
  }
  controls.current={toggle,next,previous,selectAll:()=>setSelected(new Set(visibleRef.current.map(t=>t.id))),remove:()=>void deleteSelected()};

  useEffect(()=>{
    const engine=new AudioPlayer();player.current=engine;
    engine.onChange=()=>{setPlaying(engine.playing);setPosition(engine.audio.currentTime||0);setDuration(Number.isFinite(engine.audio.duration)?engine.audio.duration:0);};
    engine.onEnded=()=>controls.current.next(true);
    engine.onError=notify;
    window.luma.getState().then(result=>{
      setState(result.state);setSort(result.state.settings.librarySort||'added');setLoaded(true);if(result.warning)notify(result.warning);
      const s=result.state;engine.setVolume(s.settings.volume);engine.setEQ(s.settings);
      if(s.playback.currentId){engine.load(s.playback.currentId,s.playback.position,false,s.tracks.find(t=>t.id===s.playback.currentId)?.trim);setPosition(s.playback.position);}
    }).catch(()=>notify('보관함을 불러오지 못했습니다. 앱을 다시 실행해주세요.'));
    const stopProgress=window.luma.onProgress(setProgress);
    const stopCommand=window.luma.onCommand(command=>{if(command==='toggle')controls.current.toggle();if(command==='next')controls.current.next();if(command==='previous')controls.current.previous();});
    const stopFlush=window.luma.onFlush(()=>{
      void window.luma.saveState({...stateRef.current,playback:{...stateRef.current.playback,position:engine.audio.currentTime||0}}).catch(()=>notify('설정을 저장하지 못했습니다.')).finally(()=>window.luma.flushDone());
    });
    const key=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement;
      if(document.querySelector('[role="dialog"][aria-modal="true"]')||target.closest('input:not([type="checkbox"]),textarea,select'))return;
      if(target.closest('input[type="checkbox"]')&&event.code==='Space')return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();controls.current.selectAll();return;}
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();controls.current.remove();return;}
      if(event.code==='Space'){event.preventDefault();controls.current.toggle();}
      if(event.ctrlKey||event.metaKey){if(event.key==='ArrowRight'){event.preventDefault();controls.current.next();}if(event.key==='ArrowLeft'){event.preventDefault();controls.current.previous();}}
    };document.addEventListener('keydown',key);
    const interval=setInterval(()=>{const s=stateRef.current;if(s.tracks.length)void window.luma.saveState({...s,playback:{...s.playback,position:engine.audio.currentTime||0}}).catch(()=>notify('설정을 저장하지 못했습니다.'));},5000);
    if('mediaSession' in navigator){navigator.mediaSession.setActionHandler('play',()=>void engine.play());navigator.mediaSession.setActionHandler('pause',()=>engine.pause());navigator.mediaSession.setActionHandler('nexttrack',()=>controls.current.next());navigator.mediaSession.setActionHandler('previoustrack',()=>controls.current.previous());navigator.mediaSession.setActionHandler('seekto',details=>engine.seek(details.seekTime??0));}
    return()=>{stopProgress();stopCommand();stopFlush();document.removeEventListener('keydown',key);clearInterval(interval);engine.dispose();};
  },[]);
  useEffect(()=>{
    if(!loaded)return;
    player.current?.setVolume(state.settings.volume);player.current?.setEQ(state.settings);
    void window.luma.saveState({...state,playback:{...state.playback,position:player.current?.audio.currentTime||state.playback.position}}).catch(()=>notify('설정을 저장하지 못했습니다.'));
  },[state,loaded]);
  useEffect(()=>{
    window.luma.publishLive({track:current,playing,position:Math.max(0,position-currentRange.start),duration:currentRange.duration,volume:state.settings.volume});
    if('mediaSession' in navigator){navigator.mediaSession.playbackState=playing?'playing':'paused';if(current)navigator.mediaSession.metadata=new MediaMetadata({title:songName(current),...(current.artwork?{artwork:[{src:current.artwork}]}:{})});}
  },[current,playing,position,duration,state.settings.volume]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),6000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{
    if(!sleepAt){setTimerRemaining(0);return;}
    const tick=()=>{const remaining=Math.max(0,sleepAt-Date.now());setTimerRemaining(Math.ceil(remaining/1000));if(!remaining){player.current?.pause();setSleepAt(null);notify('취침 타이머로 재생을 멈췄습니다.');}};
    tick();const interval=setInterval(tick,1000);return()=>clearInterval(interval);
  },[sleepAt]);
  useEffect(()=>{const close=()=>setMenu(null);window.addEventListener('click',close);return()=>window.removeEventListener('click',close);},[]);
  useEffect(()=>{
    let depth=0;
    const hasFiles=(event:DragEvent)=>event.dataTransfer?.types.includes('Files');
    const reset=()=>{depth=0;setDragging(false);dragIds.current=[];dragFolder.current=null;setDraggedTrack(null);setDropTarget(null);};
    const enter=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();depth++;if(loaded&&!importBusy.current)setDragging(true);};
    const destination=(event:DragEvent):ImportDestination=>{
      const element=event.target instanceof Element?event.target:null;
      const row=element?.closest<HTMLElement>('[data-track-id]'),folder=element?.closest<HTMLElement>('[data-folder-id]');
      const rect=row?.getBoundingClientRect();
      return {...importContext.current,...(row?{trackId:row.dataset.trackId,edge:event.clientY>(rect!.top+rect!.height/2)?'after':'before'} as const:folder?{folderId:folder.dataset.folderId}:{})};
    };
    const over=(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=loaded&&!importBusy.current?'copy':'none';
      const target=destination(event);setDropTarget(target.trackId||target.folderId||null);setDropAfter(target.edge==='after');};
    const leave=()=>{depth=Math.max(0,depth-1);if(!depth){setDragging(false);setDropTarget(null);}};
    const drop=(event:DragEvent)=>{
      const target=destination(event);event.preventDefault();reset();
      const files=Array.from(event.dataTransfer?.files??[]);
      if(!files.length)return;
      if(!loaded){notify('보관함을 불러오는 중입니다. 잠시 후 다시 놓아주세요.');return;}
      void importMusic('drop',files,target);
    };
    document.addEventListener('dragenter',enter);document.addEventListener('dragover',over);
    document.addEventListener('dragleave',leave);document.addEventListener('drop',drop);
    window.addEventListener('dragend',reset);window.addEventListener('blur',reset);
    return()=>{document.removeEventListener('dragenter',enter);document.removeEventListener('dragover',over);document.removeEventListener('dragleave',leave);document.removeEventListener('drop',drop);window.removeEventListener('dragend',reset);window.removeEventListener('blur',reset);};
  },[loaded]);

  async function importMusic(mode:'files'|'folder'|'playlist'|'drop',files:File[]=[],destination:ImportDestination=importContext.current){
    if(importBusy.current){notify('음악을 가져오는 중입니다. 완료 후 다시 놓아주세요.');return;}
    importBusy.current=true;
    setImporting(true);setMenu(null);
    try{
      const result:ImportResult=mode==='drop'?await window.luma.importDroppedFiles(files):mode==='playlist'?await window.luma.importPlaylist():await window.luma.importMusic(mode);
      if(!result.cancelled){
        const placed=mode!=='playlist'&&!!(destination.trackId||destination.folderId||destination.playlistId);
        setState(s=>{const merged={...s,tracks:mergeTracks(s.tracks,result.state.tracks),playlists:mode==='playlist'?result.state.playlists:s.playlists};
          return placed?placeImportedSongs(merged,result.trackIds||[],destination):merged;});
        if(placed)setSort('manual');
        if(result.folderRoots?.length&&!placed)navigate('library');
        notify(`${result.added}곡을 가져왔습니다.${result.errors.length?` ${result.errors.length}개 파일을 읽지 못했습니다. ${result.errors[0]}`:''}`);
      }
    }catch(error){notify((error as Error).message.replace(/^.*Error: /,''));}
    finally{importBusy.current=false;setImporting(false);setProgress(null);}
  }
  function favorite(id:string){setState(s=>({...s,tracks:s.tracks.map(t=>t.id===id?{...t,favorite:!t.favorite}:t)}));}
  function addQueue(track:Track){updatePlayback({queue:[...stateRef.current.playback.queue,track.id]});notify('재생 대기열에 추가했습니다.');setMenu(null);}
  function savePlaylist(){
    if(!nameDialog?.name.trim())return;
    const id=nameDialog.id||crypto.randomUUID();const name=nameDialog.name.trim().slice(0,80);
    setState(s=>({...s,playlists:nameDialog.id?s.playlists.map(p=>p.id===id?{...p,name}:p):[...s.playlists,{id,name,trackIds:[]}]}));
    setNameDialog(null);navigate(id);
  }
  function assign(playlistId:string){
    if(!assignTrack)return;
    setState(s=>({...s,playlists:s.playlists.map(p=>p.id===playlistId?{...p,trackIds:[...new Set([...p.trackIds,assignTrack.id])]}:p)}));setAssignTrack(null);notify('재생목록에 추가했습니다.');
  }
  function reorder(id:string,direction:number){
    if(!playlist)return;
    const ids=[...playlist.trackIds];const from=ids.indexOf(id);const to=from+direction;if(to<0||to>=ids.length)return;
    [ids[from],ids[to]]=[ids[to],ids[from]];
    setState(s=>({...s,playlists:s.playlists.map(p=>p.id===playlist.id?{...p,trackIds:ids}:p)}));
  }
  function selectTrack(id:string,event:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean}){
    const ids=visibleRef.current.map(track=>track.id);
    setSelected(previous=>{
      const next=new Set(event.ctrlKey||event.metaKey||event.shiftKey?previous:[]);
      if(event.shiftKey&&selectionAnchor.current){const a=ids.indexOf(selectionAnchor.current);const b=ids.indexOf(id);if(a>=0&&b>=0)for(const value of ids.slice(Math.min(a,b),Math.max(a,b)+1))next.add(value);}
      else if((event.ctrlKey||event.metaKey)&&next.has(id))next.delete(id);else next.add(id);
      return next;
    });if(!event.shiftKey)selectionAnchor.current=id;
  }
  async function deleteSelected(){
    await deleteSongs([...selected]);
  }
  async function deleteSongs(ids:string[]){
    if(!ids.length||deleting||importing)return;
    const removing=new Set(ids);setDeleting(true);setMenu(null);
    try{
      if(playlist){setState(s=>({...s,playlists:s.playlists.map(p=>p.id===playlist.id?{...p,trackIds:p.trackIds.filter(id=>!removing.has(id))}:p)}));}
      else {
        await window.luma.removeMusic(ids);
        if(stateRef.current.playback.currentId&&removing.has(stateRef.current.playback.currentId)){player.current?.clear();setPosition(0);setDuration(0);}
        setState(s=>removeLibraryTracks(s,ids));
      }
      setSelected(previous=>new Set([...previous].filter(id=>!removing.has(id))));notify(`${ids.length}곡을 ${playlist?'재생목록':'보관함'}에서 삭제했습니다.`);
    }catch(error){notify((error as Error).message.replace(/^.*Error: /,''));}
    finally{setDeleting(false);}
  }
  function startTrackDrag(event:React.DragEvent,ids:string[],folderId:string|null=null){
    event.stopPropagation();dragIds.current=ids;dragFolder.current=folderId;
    event.dataTransfer.setData('application/x-sono-track',JSON.stringify(ids));
    event.dataTransfer.effectAllowed='move';setDraggedTrack(folderId?`folder:${folderId}`:ids[0]);
  }
  function dropTrack(targetId:string,event:React.DragEvent,position?:'before'|'after',folderId?:string){
    event.preventDefault();event.stopPropagation();
    const moving=dragIds.current,sourceFolder=dragFolder.current;
    const rect=event.currentTarget.getBoundingClientRect(),edge=position||(event.clientY>rect.top+rect.height/2?'after':'before');
    setDraggedTrack(null);setDropTarget(null);dragIds.current=[];dragFolder.current=null;
    if(!sourceFolder&&!moving.length)return;
    const displayIds=visibleRef.current.map(track=>track.id);setSort('manual');
    setState(s=>{
      const oldOrder=playlist?(s.playlists.find(p=>p.id===playlist.id)?.trackIds||[]):s.tracks.map(track=>track.id);
      let index=0;const base=oldOrder.map(id=>displayIds.includes(id)?displayIds[index++]:id);
      if(!playlist){
        const byId=new Map(s.tracks.map(t=>[t.id,t]));
        const arranged={...s,tracks:base.map(id=>byId.get(id)!),folders};
        const targetFolder=folderId||songFolder(s.tracks.find(t=>t.id===targetId)!);
        if(sourceFolder)return reorderLibraryFolder(arranged,sourceFolder,targetFolder,edge);
        if(folderId)return moveSongsToFolder(arranged,moving,folderId,visible.find(t=>songFolder(t)===folderId&&!moving.includes(t.id))?.id,'before');
        return moveLibrarySongs(arranged,moving,targetId,edge);
      }
      const ids=reorderTrackIds(base,moving,targetId,edge);
      const sameScope=oldOrder.length===s.playback.order.length&&oldOrder.every(id=>s.playback.order.includes(id));
      return {...s,playback:sameScope?{...s.playback,order:ids}:s.playback,settings:{...s.settings,librarySort:'manual'},playlists:s.playlists.map(p=>p.id===playlist.id?{...p,trackIds:ids}:p)};
    });
  }
  function folderHeading(folder:LibraryFolder){
    const ids=visible.filter(t=>songFolder(t)===folder.id).map(t=>t.id);
    return <div key={`folder:${folder.id}`} className={`folder-group-heading ${dropTarget===folder.id?'folder-drop-target':''}`} data-folder-id={folder.id}
      onDragOver={e=>{if(!e.dataTransfer.types.includes('application/x-sono-track'))return;e.preventDefault();e.stopPropagation();setDropTarget(folder.id);}}
      onDrop={e=>{if(!e.dataTransfer.types.includes('application/x-sono-track'))return;dropTrack('',e,'before',folder.id);}}>
      <button className="folder-drag-handle" draggable aria-label={`${folder.name} 폴더 순서 이동`} title="폴더 묶음 순서 이동" onDragStart={e=>startTrackDrag(e,ids,folder.id)}><GripVertical size={15}/></button>
      <Folder size={16}/><strong>{folder.name}</strong><small>{ids.length}곡</small>
      <IconButton label={`${folder.name} 폴더 이름 변경`} onClick={()=>setRenameDialog({kind:'folder',id:folder.id,name:folder.name})}><Pencil size={14}/></IconButton>
      {!state.tracks.some(t=>songFolder(t)===folder.id)&&<IconButton label={`${folder.name} 빈 폴더 삭제`} disabled={importing||deleting} onClick={()=>clearEmptyFolders([folder.id])}><Trash2 size={14}/></IconButton>}
    </div>;
  }
  function clearEmptyFolders(ids?:string[]){
    const current=stateRef.current,result=removeEmptyLibraryFolders(current,ids);
    const count=libraryFolders(current.tracks,current.folders).length-(result.folders?.length||0);
    setState(s=>removeEmptyLibraryFolders(s,ids));
    if(count)notify(`빈 폴더 ${count}개를 목록에서 삭제했습니다.`);
  }
  function navigate(nextView:View){setView(nextView);setAlbumFilter(null);setQuery('');setMenu(null);setSelected(new Set());selectionAnchor.current=null;}
  const playVisible=()=>{if(visible[0])playTrack(visible[0],visible.map(t=>t.id));};

  return <div className="app-shell">
    {dragging&&<div className="drop-overlay" role="status"><div className="drop-card"><FolderPlus size={36}/><strong>원하는 위치에 놓아주세요</strong><span>폴더 안 · 곡 위나 아래에 추가</span><small>MP3 · FLAC · WAV · M4A · OGG</small></div></div>}
    <aside className="sidebar">
      <button className="brand" onClick={()=>setDialog('about')} aria-label="MusicBoard 정보"><span className="brand-mark"><AudioLines size={23}/></span><span>MusicBoard</span></button>
      <div className="sidebar-section-title">나만의 음악 공간</div>
      <nav className="main-nav">
        <button className={view==='library'?'selected':''} onClick={()=>navigate('library')}><Library size={19}/>내 음악<span>{state.tracks.length||''}</span></button>
        <button className={view==='albums'?'selected':''} onClick={()=>navigate('albums')}><Disc3 size={19}/>앨범</button>
        <button className={view==='favorites'?'selected':''} onClick={()=>navigate('favorites')}><Heart size={19}/>좋아요<span>{state.tracks.filter(t=>t.favorite).length||''}</span></button>
      </nav>
      <div className="playlist-heading"><span>재생목록</span><IconButton label="재생목록 만들기" onClick={()=>setNameDialog({name:''})}><Plus size={17}/></IconButton></div>
      <nav className="playlist-nav">{state.playlists.map(p=><button key={p.id} className={view===p.id?'selected':''} onClick={()=>navigate(p.id)}><ListMusic size={17}/><span>{p.name}</span><small>{p.trackIds.length}</small></button>)}{!state.playlists.length&&<button className="create-playlist" onClick={()=>setNameDialog({name:''})}><Plus size={16}/>첫 재생목록 만들기</button>}</nav>
      <div className="sidebar-bottom"><div className="local-label"><span className="status-dot"/>LOCAL & PERSONAL</div><button className="import-card" onClick={()=>importMusic('folder')} disabled={importing}><FolderPlus size={20}/><span><strong>음악 폴더 가져오기</strong><small>좋아하는 음악을 한곳에</small></span><ArrowUpRight size={16}/></button><button className="sidebar-update" onClick={()=>setDialog('update')}><Download size={16}/><span>업데이트</span>{updateState?.status==='available'&&<span className="update-badge">NEW</span>}</button><button className="sidebar-footer" onClick={()=>setDialog('about')}><span>MusicBoard</span><span>{updateState?`v${updateState.version}`:''}</span></button></div>
    </aside>
    <div className="workspace">
      <div className="titlebar drag"><span className="window-caption">MusicBoard / YOUR SOUND, YOUR SPACE</span>{window.luma.platform!=='darwin'&&<div className="window-controls no-drag"><IconButton label="창 최소화" onClick={()=>window.luma.windowAction('minimize')}><Minus size={15}/></IconButton><IconButton label="창 최대화" onClick={()=>window.luma.windowAction('maximize')}><Square size={12}/></IconButton><IconButton label="앱 닫기" onClick={()=>window.luma.windowAction('close')}><X size={16}/></IconButton></div>}</div>
      <header className="topbar"><div className="breadcrumb">내 공간 <span>/</span> <strong>{viewTitle}</strong></div><label className="search-field"><Search size={17}/><input aria-label="음악 검색" placeholder="파일 이름 검색" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="검색 지우기" onClick={()=>setQuery('')}><X size={14}/></button>}<kbd>검색</kbd></label><IconButton label="미니 플레이어" onClick={()=>window.luma.showMini()}><PanelTop size={20}/></IconButton></header>
      <main className="content" onClick={()=>setMenu(null)}>
        <section className="collection-heading"><div><span className="eyebrow">{view==='favorites'?'ON REPEAT':view==='albums'?'THE COLLECTION':playlist?'MADE BY YOU':'YOUR PERSONAL COLLECTION'}</span><h1>{albumFilter?albumFilter.split('\0')[0]:viewTitle}<span className="heading-dot">.</span></h1><p>{state.tracks.length?`${visible.length}곡 · ${Math.floor(visible.reduce((n,t)=>n+trimBounds(t).duration,0)/60)}분의 음악`:'취향을 담은, 오직 당신만의 플레이어'}</p></div><div className="collection-actions">{view==='library'&&emptyFolderCount>0&&<button className="button secondary" disabled={importing||deleting} onClick={()=>clearEmptyFolders()}><Trash2 size={15}/>빈 폴더 정리 ({emptyFolderCount})</button>}{playlist&&<><IconButton label="재생목록 이름 변경" onClick={()=>setNameDialog({id:playlist.id,name:playlist.name})}><Pencil size={17}/></IconButton><IconButton label="재생목록 내보내기" onClick={()=>window.luma.exportPlaylist(playlist.id).then(ok=>{if(ok)notify('재생목록을 내보냈습니다.');}).catch(()=>notify('내보내기에 실패했습니다.'))}><Download size={17}/></IconButton><IconButton label="재생목록 삭제" onClick={()=>setConfirmDelete(playlist)}><Trash2 size={17}/></IconButton></>}{visible.length>0&&<button className="button primary" onClick={playVisible}><Play size={15} fill="currentColor"/>전체 재생</button>}<div className="menu-wrapper"><button disabled={importing} className="button secondary" onClick={event=>{event.stopPropagation();setMenu(menu==='import'?null:'import');}}><Plus size={17}/>음악 추가<ChevronDown size={14}/></button>{menu==='import'&&<div className="dropdown import-dropdown"><button onClick={()=>importMusic('files')}><Music2 size={16}/>파일 가져오기</button><button onClick={()=>importMusic('folder')}><FolderPlus size={16}/>폴더 가져오기</button><button onClick={()=>importMusic('playlist')}><Upload size={16}/>M3U 목록 가져오기</button></div>}</div></div></section>
        {!state.tracks.length?<section className="empty-hero"><div className="hero-copy"><span className="empty-kicker"><span/>A LITTLE SPACE FOR YOUR MUSIC</span><h2>좋아하는 음악이<br/><em>머무는 곳.</em></h2><p>오래 아껴온 앨범부터 오늘 발견한 한 곡까지.<br/>당신의 음악을 가져와, 편안하게 들어보세요.</p><button className="button primary large" disabled={importing} onClick={()=>importMusic('files')}><Plus size={18}/>첫 음악 가져오기<ArrowUpRight size={17}/></button><div className="format-label">MP3 · FLAC · WAV · M4A · OGG</div></div><div className="record-scene" aria-hidden="true"><div className="scene-glow"/><div className="record-sleeve"><div className="sleeve-text">THE SOUND<br/>OF YOUR DAYS<span>VOLUME 01 — PERSONAL COLLECTION</span></div><div className="sleeve-orbit"/><div className="sleeve-caption">MusicBoard / EST. 2026</div></div><div className="vinyl"><div className="vinyl-label"><AudioLines size={30}/><span>MusicBoard</span><i/></div></div><div className="record-footnote">GOOD MUSIC. YOUR OWN RHYTHM.</div></div></section>:view==='albums'&&!albumFilter?<section className="album-grid">{albums.map(([key,tracks])=><button className="album-card" key={key} onClick={()=>setAlbumFilter(key)}><div className="album-cover"><Artwork track={tracks[0]}/><span className="album-play"><Play size={20} fill="currentColor"/></span></div><strong>{tracks[0].album}</strong><span>{tracks.length}곡</span></button>)}</section>:<>
          <section className="collection-tracks">
          {selected.size>0&&<div className="selection-toolbar"><span>{selected.size}곡 선택됨</span><button className="text-button" onClick={()=>setSelected(new Set())}>선택 해제</button><button className="button secondary" disabled={deleting||importing} onClick={()=>void deleteSelected()}><Trash2 size={14}/>선택 삭제 ({selected.size})</button></div>}
          <div className="list-toolbar"><span>{albumFilter?<button className="text-button" onClick={()=>setAlbumFilter(null)}>← 모든 앨범</button>:playlist?'나만의 재생목록':view==='favorites'?'마음을 누른 음악':'폴더별 음악'}<small>{visible.length}</small></span><select aria-label="음악 정렬" value={sort} onChange={e=>{const value=e.target.value as LibrarySort;setSort(value);setState(s=>({...s,settings:{...s.settings,librarySort:value}}));}}><option value="manual">{playlist?'목록 순서':'직접 정한 순서'}</option><option value="added">{playlist?'목록 순서':'최근 추가순'}</option><option value="title">곡 제목순</option></select></div>
          {visible.length?<div className="track-table" role="table" aria-label="음악 목록"><div className="track-header track-row" role="row"><span/><span>재생</span><span>파일 이름</span><span/><span><Clock3 size={14}/></span><span/></div>{listItems.map(item=>{if(item.kind==='folder')return folderHeading(item.folder);const track=item.track;return             <div className={`track-row ${grouped?'grouped-track':''} ${selected.has(track.id)?'is-selected':''} ${track.id===current?.id?'is-current':''} ${draggedTrack===track.id?'is-dragging':''} ${dropTarget===track.id?`drop-target ${dropAfter?'drop-after':''}`:''}`} role="row" data-track-id={track.id} aria-selected={selected.has(track.id)} draggable onDragStart={e=>startTrackDrag(e,selected.has(track.id)?visible.filter(t=>selected.has(t.id)).map(t=>t.id):[track.id])} onDragOver={e=>{if(!dragIds.current.length&&!e.dataTransfer.types.includes('application/x-sono-track'))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';setDropTarget(track.id);const rect=e.currentTarget.getBoundingClientRect();setDropAfter(e.clientY>rect.top+rect.height/2);}} onDrop={e=>{if(!dragIds.current.length&&!e.dataTransfer.types.includes('application/x-sono-track'))return;dropTrack(track.id,e);}} onDragEnd={()=>{dragIds.current=[];dragFolder.current=null;setDraggedTrack(null);setDropTarget(null);}} onClick={e=>{if((e.target as HTMLElement).closest('button,input'))return;selectTrack(track.id,e);}} onDoubleClick={()=>playTrack(track,visible.map(t=>t.id))}>
            <button className="drag-handle" draggable aria-label={`${songName(track)} 순서 이동`} title="끌어서 곡 이동" onDragStart={e=>startTrackDrag(e,selected.has(track.id)?visible.filter(t=>selected.has(t.id)).map(t=>t.id):[track.id])} onClick={e=>e.stopPropagation()}><GripVertical size={15}/></button>
            <button className={`track-number ${track.id===current?.id&&playing?'playing':''}`} aria-label={`${songName(track)} ${track.id===current?.id&&playing?'일시정지':'재생'}`} title={track.id===current?.id&&playing?'일시정지':'재생'} onDoubleClick={e=>e.stopPropagation()} onClick={()=>toggleTrack(track)}>{track.id===current?.id&&playing?<Pause size={15} fill="currentColor"/>:<Play size={15} fill="currentColor"/>}</button>
            <div className="track-identity"><Artwork track={track}/><div><button className="track-title" onClick={e=>selectTrack(track.id,e)}>{songName(track)}</button></div></div><IconButton label={`${songName(track)} ${track.favorite?'좋아요 취소':'좋아요'}`} active={track.favorite} onClick={()=>favorite(track.id)}><Heart size={16} fill={track.favorite?'currentColor':'none'}/></IconButton><span className="track-duration" title={track.trim?`재생 구간 ${trimTime(track.trim.start)} – ${trimTime(track.trim.end)} · 원래 ${trimTime(track.duration)}`:undefined}>{track.trim&&<Scissors className="trim-mark" size={12}/>} {formatTime(trimBounds(track).duration)}</span><div className="menu-wrapper"><IconButton label={`${songName(track)} 더 보기`} onClick={()=>setMenu(menu===track.id?null:track.id)}><MoreHorizontal size={19}/></IconButton>{menu===track.id&&<div className="dropdown track-dropdown" onClick={e=>e.stopPropagation()}><button onClick={()=>{setRenameDialog({kind:'track',id:track.id,name:songName(track)});setMenu(null);}}><Pencil size={16}/>이름 변경</button><button onClick={()=>{setTrimId(track.id);setMenu(null);}}><Scissors size={16}/>음원 길이 조정</button><button onClick={()=>addQueue(track)}><ListEnd size={16}/>대기열에 추가</button><button onClick={()=>{setAssignTrack(track);setMenu(null);}}><Plus size={16}/>재생목록에 추가</button>{playlist&&<><button disabled={!['added','manual'].includes(sort)||!!query} onClick={()=>{reorder(track.id,-1);setMenu(null);}}><ArrowUp size={16}/>위로 이동</button><button disabled={!['added','manual'].includes(sort)||!!query} onClick={()=>{reorder(track.id,1);setMenu(null);}}><ArrowDown size={16}/>아래로 이동</button></>}<button disabled={deleting||importing} onClick={()=>void deleteSongs([track.id])}><Minus size={16}/>{playlist?'목록에서 제거':'보관함에서 제거'}</button></div>}</div>
          </div>;})}</div>:<div className="list-empty"><Music2 size={30}/><h3>{query?'찾는 음악이 없어요':playlist?'음악으로 채워보세요':'아직 좋아하는 음악이 없어요'}</h3><p>{query?'다른 검색어로 찾아보세요.':playlist?'내 음악에서 곡의 더 보기 메뉴로 추가할 수 있어요.':'곡 옆의 하트를 눌러 좋아하는 음악을 모아보세요.'}</p></div>}
          </section>
        </>}
        {!state.tracks.length&&<div className="empty-features"><div><Headphones size={18}/><span>오직 음악에 집중</span><small>광고 없이, 나의 파일 그대로</small></div><div><SlidersHorizontal size={18}/><span>취향에 맞는 소리</span><small>20밴드 EQ로 섬세하게</small></div><div><PanelTop size={18}/><span>일상 곁의 플레이어</span><small>작은 창에서도 편안하게</small></div></div>}
      </main>
      <div className="content-footer"><span><span className="status-dot"/>{state.tracks.length?`${state.tracks.length}곡이 보관함에 있어요`:'당신의 첫 번째 음악을 기다리고 있어요'}</span><span>{sleepAt&&<button onClick={()=>setDialog('timer')}><Timer size={13}/>{formatTime(timerRemaining)}</button>}OFFLINE FIRST</span></div>
    </div>
    {queueOpen&&<aside className="queue-panel"><header><div><span className="eyebrow">UP NEXT</span><h2>재생 대기열</h2></div><IconButton label="대기열 닫기" onClick={()=>setQueueOpen(false)}><X size={19}/></IconButton></header><span className="queue-label">지금 재생 중</span>{current?<div className="queue-current"><Artwork track={current}/><div><strong>{songName(current)}</strong></div></div>:<p className="hint">선택한 음악이 없어요.</p>}<div className="queue-label"><span>다음 재생 · {state.playback.queue.length}</span>{state.playback.queue.length>0&&<button onClick={()=>updatePlayback({queue:[]})}>비우기</button>}</div>{state.playback.queue.map((id,i)=>{const t=state.tracks.find(t=>t.id===id);return t&&<div className="queue-track" key={`${id}-${i}`}><span>{i+1}</span><div><strong>{songName(t)}</strong></div><IconButton label={`${songName(t)} 대기열에서 제거`} onClick={()=>updatePlayback({queue:state.playback.queue.filter((_,index)=>index!==i)})}><X size={14}/></IconButton></div>;})}{!state.playback.queue.length&&<div className="queue-empty"><ListEnd size={26}/><p>다음에 듣고 싶은 곡을<br/>대기열에 추가해보세요.</p></div>}</aside>}
    <footer className="player-bar"><div className="now-playing"><Artwork track={current}/><div><strong>{current?songName(current):'어떤 음악을 들어볼까요?'}</strong><span>{current?'':'음악을 선택해 재생해주세요'}</span></div>{current&&<IconButton label="현재 곡 좋아요" active={current.favorite} onClick={()=>favorite(current.id)}><Heart size={17} fill={current.favorite?'currentColor':'none'}/></IconButton>}</div><div className="transport"><div className="transport-buttons"><IconButton label="셔플" active={state.playback.shuffle} onClick={()=>updatePlayback({shuffle:!state.playback.shuffle})}><Shuffle size={17}/></IconButton><IconButton label="이전 곡" disabled={!current} onClick={previous}><SkipBack size={21} fill="currentColor"/></IconButton><button className="play-button" aria-label={playing?'일시정지':'재생'} onClick={toggle}>{playing?<Pause size={21} fill="currentColor"/>:<Play size={21} fill="currentColor"/>}</button><IconButton label="다음 곡" disabled={!current} onClick={()=>next()}><SkipForward size={21} fill="currentColor"/></IconButton><IconButton label={`재생 방식: ${playbackLabel}`} active={state.playback.repeat!=='off'} onClick={()=>setDialog('playback')}>{playbackMode==='one'?<Repeat1 size={18}/>:playbackMode==='stop'?<Square size={16}/>:<Repeat size={18}/>}</IconButton></div><div className="seek-row"><span>{formatTime(Math.max(0,position-currentRange.start))}</span><WaveformSeek track={current} position={position} duration={duration} loop={activeLoop} onSeek={time=>{player.current?.seek(time);setPosition(player.current?.audio.currentTime??time);}}/><span>{formatTime(currentRange.duration)}</span></div></div><div className="player-extras"><IconButton label={state.settings.volume?'음소거':'음소거 해제'} onClick={()=>setState(s=>({...s,settings:{...s.settings,volume:s.settings.volume?0:0.7}}))}>{state.settings.volume?<Volume2 size={18}/>:<VolumeX size={18}/>}</IconButton><input aria-label="음량" className="volume-slider" type="range" min="0" max="1" step="0.01" value={state.settings.volume} onChange={e=>setState(s=>({...s,settings:{...s.settings,volume:Number(e.target.value)}}))}/><span className="player-divider"/><button className={`icon-button ab-repeat-button ${activeLoop?'active':''}`} aria-label="구간 반복" aria-pressed={!!activeLoop} aria-haspopup="dialog" disabled={!current||!player.current?.canLoop} title={activeLoop?`구간 반복 켜짐 · A ${trimTime(activeLoop.start-currentRange.start)} – B ${trimTime(activeLoop.end-currentRange.start)}`:'구간 반복 (A–B)'} onClick={()=>setDialog('loop')}>A–B</button><IconButton label="음원 길이 조정" disabled={!current} onClick={()=>current&&setTrimId(current.id)}><Scissors size={17}/></IconButton><IconButton label="페이드 설정" onClick={()=>setDialog('fade')}><AudioLines size={18}/></IconButton><IconButton label="이퀄라이저" active={state.settings.eqEnabled} onClick={()=>setDialog('eq')}><SlidersHorizontal size={18}/></IconButton><IconButton label="취침 타이머" active={!!sleepAt} onClick={()=>setDialog('timer')}><Timer size={18}/></IconButton><IconButton label="재생 대기열" active={queueOpen} onClick={()=>setQueueOpen(!queueOpen)}><ListMusic size={20}/></IconButton></div></footer>
    {importing&&<div className="import-progress" role="status"><span className="spinner"/><div><strong>{progress?`음악 가져오는 중 · ${progress.current}/${progress.total}`:'음악 가져오기 준비 중'}</strong><small>{progress?.name||'파일 또는 폴더를 확인하고 있습니다.'}</small></div></div>}
    {toast&&<div className="toast" role="status"><Check size={17}/><span>{toast}</span><button aria-label="알림 닫기" onClick={()=>setToast('')}><X size={15}/></button></div>}
    {dialog==='update'&&<Modal title="MusicBoard 업데이트" onClose={()=>setDialog(null)}><UpdatePanel state={updateState} onChange={setUpdateState}/></Modal>}
    {dialog==='eq'&&<Modal title="나에게 맞는 소리" wide onClose={()=>setDialog(null)}><p className="modal-subtitle">20-band equalizer · 작은 차이로 완성하는 나의 취향</p><Equalizer settings={state.settings} onChange={settings=>setState(s=>({...s,settings}))}/></Modal>}
    {dialog==='playback'&&<Modal title="재생 방식" onClose={()=>setDialog(null)}><p className="modal-subtitle">곡이 끝난 뒤의 동작을 선택하세요.</p><div className="playback-modes" role="radiogroup" aria-label="곡 종료 후 동작">{([
      {value:'auto',label:'다음 곡 자동 재생',description:'목록 순서대로 다음 곡을 이어 듣습니다.'},
      {value:'one',label:'한 곡 반복',description:'지금 재생하는 곡을 계속 반복합니다.'},
      {value:'stop',label:'현재 곡만 재생 후 정지',description:'이 곡이 끝나면 다음 곡을 재생하지 않습니다.'}
    ] as const).map(mode=><label key={mode.value} className={`playback-mode ${playbackMode===mode.value?'selected':''}`}><input type="radio" aria-label={mode.label} aria-describedby={`playback-description-${mode.value}`} name="playback-mode" value={mode.value} checked={playbackMode===mode.value} onChange={()=>updatePlayback({repeat:mode.value==='auto'?(state.playback.repeat==='all'?'all':'off'):mode.value})}/><span><strong>{mode.label}</strong><small id={`playback-description-${mode.value}`}>{mode.description}</small></span></label>)}</div>{playbackMode==='auto'&&<label className="repeat-list-option"><input type="checkbox" checked={state.playback.repeat==='all'} onChange={e=>updatePlayback({repeat:e.target.checked?'all':'off'})}/>목록 마지막 곡 뒤에는 처음부터 다시 재생</label>}<p className="hint">이전·다음 버튼으로 직접 곡을 바꿀 수 있습니다. 선택한 방식은 자동 저장됩니다.</p></Modal>}
    {dialog==='loop'&&current&&<LoopDialog key={current.id} name={songName(current)} bounds={currentRange} loop={activeLoop} getPosition={()=>player.current?.audio.currentTime??position} onClose={()=>setDialog(null)} onSave={value=>{const loop=player.current?.setLoop(value);setABLoop(loop?{...loop,id:current.id}:null);setDialog(null);notify(loop?'구간 반복을 켰습니다.':'반복 구간을 확인해주세요.');}} onClear={()=>{player.current?.setLoop();setABLoop(null);setDialog(null);notify('구간 반복을 해제했습니다.');}}/>}
    {dialog==='fade'&&<Modal title="부드러운 재생" onClose={()=>setDialog(null)}><p className="modal-subtitle">재생 시작과 이어듣기에는 페이드 인, 정지와 곡 전환에는 페이드 아웃을 적용합니다. 0초로 설정하면 끌 수 있습니다.</p><div className="fade-settings">{(['fadeIn','fadeOut'] as const).map(key=><FadeControl key={key} label={key==='fadeIn'?'페이드 인':'페이드 아웃'} value={state.settings[key]??0.35} onChange={value=>setState(s=>({...s,settings:{...s.settings,[key]:value}}))}/>)}</div></Modal>}
    {dialog==='timer'&&<Modal title="음악과 함께, 편안한 밤" onClose={()=>setDialog(null)}><p className="modal-subtitle">선택한 시간이 지나면 음악을 멈춰요.</p><div className="timer-options">{[15,30,45,60,90].map(minutes=><button key={minutes} aria-label={`${minutes}분`} onClick={()=>{setSleepAt(Date.now()+minutes*60*1000);setDialog(null);notify(`${minutes}분 후 재생을 멈춥니다.`);}}>{minutes}<small>분</small></button>)}</div>{sleepAt&&<button className="button secondary full" onClick={()=>{setSleepAt(null);setDialog(null);}}>타이머 취소 · {formatTime(timerRemaining)} 남음</button>}</Modal>}
    {dialog==='about'&&<Modal title="MusicBoard" onClose={()=>setDialog(null)}><div className="about-mark"><AudioLines size={40}/></div><h3 className="about-title">Your sound, your space.</h3><p className="about-copy">나만의 음악을 위한 편안한 공간.<br/>당신의 파일로, 당신의 취향대로.</p><div className="about-details"><span>버전 <strong>{updateState?.version||'확인 중'}</strong></span><span>재생 엔진 <strong>Web Audio</strong></span><span>음악 보관 <strong>로컬 파일</strong></span></div><p className="hint">단축키: Space 재생/정지 · Ctrl/⌘ + 방향키 이전/다음</p></Modal>}
    {trimTrack&&<TrimDialog key={trimTrack.id} track={trimTrack} position={current?.id===trimTrack.id?position:null} onClose={()=>setTrimId(null)} onSave={range=>{const trim=sanitizeTrim(range,trimTrack.duration);if(current?.id===trimTrack.id){player.current?.setTrim(trim);setABLoop(null);}setState(s=>({...s,tracks:s.tracks.map(t=>t.id===trimTrack.id?{...t,trim}:t)}));setTrimId(null);notify(trim?'재생 구간을 저장했습니다.':'원래 길이로 되돌렸습니다.');}}/>}
    {renameDialog&&<Modal title={renameDialog.kind==='folder'?'폴더 이름 변경':'파일 이름 변경'} onClose={()=>setRenameDialog(null)}><p className="modal-subtitle">MusicBoard 목록에 표시할 이름을 변경합니다.</p><form onSubmit={e=>{e.preventDefault();if(!renameDialog.name.trim())return;setState(s=>renameLibraryItem(s,renameDialog.kind,renameDialog.id,renameDialog.name));setRenameDialog(null);}}><input className="name-input" aria-label="새 이름" autoFocus maxLength={200} value={renameDialog.name} onChange={e=>setRenameDialog({...renameDialog,name:e.target.value})}/><div className="dialog-actions"><button type="button" className="button secondary" onClick={()=>setRenameDialog(null)}>취소</button><button type="submit" disabled={!renameDialog.name.trim()} className="button primary">변경</button></div></form></Modal>}
    {nameDialog&&<Modal title={nameDialog.id?'재생목록 이름 변경':'새로운 재생목록'} onClose={()=>setNameDialog(null)}><label className="field-label">이름<input autoFocus maxLength={80} placeholder="예: 밤 산책, 집중할 때" value={nameDialog.name} onChange={e=>setNameDialog({...nameDialog,name:e.target.value})} onKeyDown={e=>{if(e.key==='Enter')savePlaylist();}}/></label><button className="button primary full" disabled={!nameDialog.name.trim()} onClick={savePlaylist}>{nameDialog.id?'저장':'만들기'}</button></Modal>}
    {assignTrack&&<Modal title="재생목록에 추가" onClose={()=>setAssignTrack(null)}><p className="modal-subtitle">{songName(assignTrack)}</p><div className="assign-list">{state.playlists.map(p=><button key={p.id} onClick={()=>assign(p.id)}><ListMusic size={18}/><span>{p.name}</span><Plus size={16}/></button>)}</div>{!state.playlists.length&&<><p className="hint">먼저 재생목록을 만들어주세요.</p><button className="button primary full" onClick={()=>{setAssignTrack(null);setNameDialog({name:''});}}>재생목록 만들기</button></>}</Modal>}
    {confirmDelete&&<Modal title="재생목록을 삭제할까요?" onClose={()=>setConfirmDelete(null)}><p className="modal-subtitle">‘{confirmDelete.name}’ 목록을 삭제합니다. 음악 파일과 보관함의 곡은 그대로 유지됩니다.</p><div className="dialog-actions"><button className="button secondary" onClick={()=>setConfirmDelete(null)}>취소</button><button className="button primary" onClick={()=>{setState(s=>({...s,playlists:s.playlists.filter(p=>p.id!==confirmDelete.id)}));setConfirmDelete(null);navigate('library');}}>목록 삭제</button></div></Modal>}
  </div>;
}
