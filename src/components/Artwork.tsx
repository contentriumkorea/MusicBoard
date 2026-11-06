import { Disc3 } from 'lucide-react';
import type { Track } from '../shared/types';
export function Artwork({track,className=''}:{track:Track|null;className?:string}){
  return <div className={`artwork ${className}`}>
    {track?.artwork?<img draggable={false} src={track.artwork} alt={`${track.album} 앨범아트`} onError={event=>{event.currentTarget.style.display='none';}}/>:<><span className="art-orbit"/><span className="art-orbit second"/><Disc3 strokeWidth={1}/><span className="art-label">{track?.album==='알 수 없는 앨범'?'MusicBoard':track?.album||'MusicBoard'}</span></>}
  </div>;
}
