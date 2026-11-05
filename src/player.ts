import { EQ_FREQUENCIES } from './shared/library';
import { audioUrl } from './shared/media';
import type { Settings,Track } from './shared/types';
import { trimBounds } from './shared/trim';
import { MIN_LOOP_SECONDS,sanitizeLoop } from './shared/loop';
import type { LoopRange } from './shared/loop';
export class AudioPlayer {
  readonly audio=document.createElement('audio');
  private context:AudioContext|null=null;
  private filters:BiquadFilterNode[]=[];
  private gain:GainNode|null=null;
  private fadeGain:GainNode|null=null;
  private transitionTimer:ReturnType<typeof setTimeout>|null=null;
  private transitionId=0;
  private pausing=false;
  private endFading=false;
  private pendingLoad:{id:string;position:number;autoplay:boolean;trim?:Track['trim']}|null=null;
  private trim:Track['trim'];
  private loop:LoopRange|undefined;
  private endTimer:ReturnType<typeof setTimeout>|null=null;
  private rangeEnded=false;
  private settings:Settings|null=null;
  private metadataCallback:(()=>void)|null=null;
  onEnded:()=>void=()=>{};
  onChange:()=>void=()=>{};
  onError:(message:string)=>void=()=>{};
  constructor(){
    this.audio.crossOrigin='anonymous';this.audio.preload='metadata';this.audio.hidden=true;document.body.append(this.audio);
    for(const event of ['timeupdate','play','pause','loadedmetadata','durationchange'])this.audio.addEventListener(event,()=>this.onChange());
    this.audio.addEventListener('timeupdate',()=>this.fadeAtEnd());
    this.audio.addEventListener('play',()=>this.armEndTimer());
    this.audio.addEventListener('pause',()=>this.stopEndTimer());
    this.audio.addEventListener('ended',()=>this.complete());
    this.audio.addEventListener('error',()=>{this.onError('이 곡을 재생할 수 없습니다. 파일 위치 또는 음악 형식을 확인해주세요.');this.onChange();});
  }
  private ensureGraph(){
    if(this.context)return;
    this.context=new AudioContext();const source=this.context.createMediaElementSource(this.audio);
    this.filters=EQ_FREQUENCIES.map(freq=>{const filter=this.context!.createBiquadFilter();filter.type='peaking';filter.frequency.value=Math.min(freq,this.context!.sampleRate/2-1);filter.Q.value=1.4;return filter;});
    this.gain=this.context.createGain();let previous:AudioNode=source;
    for(const filter of this.filters){previous.connect(filter);previous=filter;}
    this.fadeGain=this.context.createGain();
    previous.connect(this.gain);this.gain.connect(this.fadeGain);this.fadeGain.connect(this.context.destination);
    if(this.settings)this.setEQ(this.settings);
  }
  load(id:string,position=0,autoplay=false,trim?:Track['trim']){
    this.stopEndTimer();this.loop=undefined;
    const token=this.cancelTransition();this.pendingLoad=null;this.pausing=false;this.endFading=false;
    const replace=()=>{if(token===this.transitionId){const pending=this.pendingLoad;this.replaceSource(pending?.id??id,pending?.position??position,pending?.autoplay??autoplay,pending?pending.trim:trim);}};
    if(!this.audio.paused&&this.fadeGain&&(this.settings?.fadeOut??0.35)>0){
      this.pendingLoad={id,position,autoplay,trim};
      const seconds=this.settings?.fadeOut??0.35;this.ramp(0,seconds);
      this.transitionTimer=setTimeout(replace,seconds*1000);
    }else replace();
  }
  private replaceSource(id:string,position:number,autoplay:boolean,trim?:Track['trim']){
    this.trim=trim;this.rangeEnded=false;this.stopEndTimer();
    this.transitionTimer=null;this.pendingLoad=null;
    if(this.metadataCallback)this.audio.removeEventListener('loadedmetadata',this.metadataCallback);
    this.audio.pause();this.audio.src=audioUrl(id);
    this.metadataCallback=()=>{this.metadataCallback=null;this.seek(position);if(autoplay)void this.play();};
    this.audio.addEventListener('loadedmetadata',this.metadataCallback,{once:true});
    this.audio.load();
  }
  async play(){
    if(this.pendingLoad){const pending=this.pendingLoad;this.cancelTransition();this.pausing=false;this.replaceSource(pending.id,pending.position,true,pending.trim);return;}
    if(this.rangeEnded||(Number.isFinite(this.audio.duration)&&this.audio.currentTime>=this.bounds().end-.005))this.seek(this.bounds().start);
    const token=this.cancelTransition();const starting=this.audio.paused;
    this.pausing=false;this.endFading=false;
    try{
      this.ensureGraph();await this.context!.resume();if(token!==this.transitionId)return;
      if(starting)this.ramp(0,0);
      await this.audio.play();if(token!==this.transitionId)return;
      this.ramp(1,this.settings?.fadeIn??0.35);this.armEndTimer();this.onChange();
    }
    catch(error){if((error as Error).name!=='AbortError')this.onError('재생을 시작하지 못했습니다. 다른 곡을 선택해주세요.');}
  }
  get playing(){return !this.audio.paused&&!this.pausing;}
  pause(){
    this.stopEndTimer();
    const pending=this.pendingLoad;const token=this.cancelTransition();this.pausing=true;this.onChange();
    const finish=()=>{if(token!==this.transitionId)return;this.transitionTimer=null;if(pending)this.replaceSource(pending.id,pending.position,false,pending.trim);else this.audio.pause();this.pausing=false;this.onChange();};
    const fade=this.settings?.fadeOut??0.35,seconds=this.loop?Math.min(fade,Math.max(0,this.loop.end-this.audio.currentTime)):fade;
    if(this.audio.paused||!this.fadeGain||!seconds){finish();return;}
    this.ramp(0,seconds);
    this.transitionTimer=setTimeout(finish,seconds*1000);
  }
  private cancelTransition(){
    if(this.transitionTimer)clearTimeout(this.transitionTimer);this.transitionTimer=null;
    return ++this.transitionId;
  }
  private ramp(value:number,seconds:number){
    if(!this.fadeGain||!this.context)return;
    const parameter=this.fadeGain.gain;const now=this.context.currentTime;
    parameter.cancelAndHoldAtTime(now);
    if(seconds>0)parameter.linearRampToValueAtTime(value,now+seconds);else parameter.setValueAtTime(value,now);
  }
  private fadeAtEnd(){
    const remaining=this.bounds().end-this.audio.currentTime;const seconds=this.settings?.fadeOut??0.35;
    if(this.loop){if(this.playing&&remaining<=.005)this.complete();return;}
    if(this.trim&&this.playing&&remaining<=.005){this.complete();return;}
    if(this.playing&&!this.endFading&&seconds>0&&remaining>0&&remaining<=seconds){this.endFading=true;this.ramp(0,remaining);}
  }
  seek(seconds:number){
    if(this.pendingLoad){this.pendingLoad.position=Math.max(0,seconds);return;}
    if(Number.isFinite(this.audio.duration)){const range=this.bounds();this.audio.currentTime=Math.max(range.start,Math.min(seconds,range.end));if(this.audio.currentTime<range.end-.005)this.rangeEnded=false;}
    if(this.endFading){this.endFading=false;if(this.playing)this.ramp(1,0.03);}
    this.fadeAtEnd();this.armEndTimer();
  }
  private bounds(){return this.loop?{...this.loop,duration:this.loop.end-this.loop.start}:trimBounds({duration:this.audio.duration,trim:this.trim});}
  get canLoop(){return !this.pendingLoad&&Number.isFinite(this.audio.duration)&&this.bounds().duration+1e-9>=MIN_LOOP_SECONDS;}
  setLoop(value?:LoopRange){
    this.loop=value&&this.canLoop?sanitizeLoop(value,trimBounds({duration:this.audio.duration,trim:this.trim})):undefined;
    this.rangeEnded=false;this.endFading=false;
    if(this.loop&&(this.audio.currentTime<this.loop.start||this.audio.currentTime>=this.loop.end))this.seek(this.loop.start);
    if(this.playing)this.ramp(1,.03);this.armEndTimer();this.onChange();
    return this.loop?{...this.loop}:undefined;
  }
  setTrim(trim?:Track['trim']){this.loop=undefined;this.trim=trim;this.rangeEnded=false;const range=this.bounds();if(this.audio.currentTime<range.start||this.audio.currentTime>=range.end)this.seek(range.start);else{this.endFading=false;if(this.playing)this.ramp(1,.03);this.armEndTimer();}this.onChange();}
  private stopEndTimer(){if(this.endTimer)clearTimeout(this.endTimer);this.endTimer=null;}
  private armEndTimer(){
    this.stopEndTimer();if((!this.trim&&!this.loop)||!this.playing||this.pendingLoad||!Number.isFinite(this.audio.duration)||(!this.loop&&this.bounds().end>=this.audio.duration))return;
    const remaining=this.bounds().end-this.audio.currentTime;if(remaining<=.005){this.complete();return;}
    this.endTimer=setTimeout(()=>{this.fadeAtEnd();this.armEndTimer();},Math.min(100,remaining*1000/(this.audio.playbackRate||1)));
  }
  private complete(){
    this.stopEndTimer();this.endFading=false;
    if(this.pendingLoad){const pending=this.pendingLoad;const autoplay=pending.autoplay&&!this.pausing;this.cancelTransition();this.pausing=false;this.replaceSource(pending.id,pending.position,autoplay,pending.trim);return;}
    if(this.pausing||this.rangeEnded)return;this.rangeEnded=true;
    if(this.loop){
      this.rangeEnded=false;this.audio.currentTime=this.loop.start;this.ramp(1,0);
      if(this.audio.paused)void this.audio.play().then(()=>{this.armEndTimer();this.onChange();}).catch(error=>{if((error as Error).name!=='AbortError')this.onError('구간 반복 재생을 시작하지 못했습니다.');});
      else this.armEndTimer();this.onChange();return;
    }
    if(this.trim){this.audio.pause();this.audio.currentTime=this.bounds().end;}this.onChange();this.onEnded();
  }
  setVolume(volume:number){this.audio.volume=volume;}
  setEQ(settings:Settings){
    this.settings=settings;
    this.filters.forEach((filter,i)=>filter.gain.setTargetAtTime(settings.eqEnabled?settings.eq[i]:0,this.context!.currentTime,0.015));
    if(this.gain)this.gain.gain.setTargetAtTime(settings.eqEnabled?Math.pow(10,settings.preamp/20):1,this.context!.currentTime,0.015);
  }
  clear(){this.stopEndTimer();this.trim=undefined;this.loop=undefined;this.rangeEnded=false;this.cancelTransition();this.pendingLoad=null;this.pausing=false;this.endFading=false;if(this.metadataCallback)this.audio.removeEventListener('loadedmetadata',this.metadataCallback);this.metadataCallback=null;this.audio.pause();this.audio.removeAttribute('src');this.audio.load();this.onChange();}
  dispose(){this.clear();this.audio.remove();void this.context?.close();}
}
