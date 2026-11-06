import { useEffect, useState } from 'react';
import { Pause,Play,SkipBack,SkipForward,X,AudioLines } from 'lucide-react';
import { Artwork } from './components/Artwork';
import { songName } from './shared/organization';
import type { LiveState } from './shared/types';
export function Mini(){
  const [live,setLive]=useState<LiveState>({track:null,playing:false,position:0,duration:0,volume:0.7});
  useEffect(()=>window.luma.onLive(setLive),[]);
  return <div className="mini-player"><div className="mini-heading drag"><span><AudioLines size={13}/> MusicBoard</span><button className="icon-button no-drag" aria-label="미니 플레이어 닫기" onClick={()=>window.luma.closeMini()}><X size={14}/></button></div><div className="mini-content"><Artwork track={live.track}/><div className="mini-info"><strong>{live.track?songName(live.track):'음악을 선택해주세요'}</strong><small>{live.track?'':'나만의 음악 공간'}</small><div className="mini-controls"><button className="icon-button" aria-label="이전 곡" onClick={()=>window.luma.playerCommand('previous')}><SkipBack size={17}/></button><button className="mini-play" aria-label={live.playing?'일시정지':'재생'} onClick={()=>window.luma.playerCommand('toggle')}>{live.playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}</button><button className="icon-button" aria-label="다음 곡" onClick={()=>window.luma.playerCommand('next')}><SkipForward size={17}/></button></div></div></div><div className="mini-progress"><span style={{width:`${live.duration?live.position/live.duration*100:0}%`}}/></div></div>;
}
