// Fixed acceptance scenario, enabled only in an explicitly isolated native QA data directory.
(async()=>{
  const checks=[];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const wait=async callback=>{const until=Date.now()+45000;let error;while(Date.now()<until){try{const value=await callback();if(value)return value;}catch(e){error=e;}await new Promise(r=>setTimeout(r,30));}throw error||Error('Native UI wait timed out');};
  const button=name=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===name||b.textContent.trim()===name);
  const click=async name=>{const el=await wait(()=>button(name));el.click();};
  const input=(name,value)=>{const el=document.querySelector(`input[aria-label="${name}"]`);assert(el,'Missing '+name);const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
  const dialog=()=>document.querySelector('[role="dialog"]');
  try{
    await wait(()=>window.luma&&document.querySelectorAll('[data-track-id]').length===3);
    const initial=(await window.luma.getState()).state;assert(initial.tracks.length===3,'native tracks');assert(window.luma.mediaUrl('audio',initial.tracks[0].id).startsWith('http://127.0.0.1:'),'loopback media');assert(document.title==='PulseDeck','window title');
    await click('PulseDeck 정보');await wait(()=>dialog()?.getAttribute('aria-label')==='PulseDeck'||dialog()?.textContent.includes('PulseDeck'));await click('닫기');await wait(()=>!dialog());checks.push('native UI/legacy library and about dialog');
    await click('A 재생');const audio=document.querySelector('audio');await wait(()=>!audio.paused&&audio.currentTime>.15);await click('A 일시정지');await wait(()=>audio.paused);const position=audio.currentTime;await new Promise(r=>setTimeout(r,150));assert(audio.currentTime===position,'paused playback changed');assert(!audio.error,'native audio error');
    await wait(()=>document.querySelector('svg[aria-label="음원 파형"]')||document.querySelector('[role="img"][aria-label="음원 파형"]'));checks.push('actual native WebView PCM playback, pause and waveform');
    await click('구간 반복');await wait(()=>dialog());input('A 시작 시간','2');input('B 종료 시간','2.75');await click('적용');await wait(()=>button('구간 반복').getAttribute('aria-pressed')==='true');assert(audio.paused,'loop edit autoplay');await click('A 재생');
    let returns=0,last=audio.currentTime;await wait(()=>{if(last-audio.currentTime>.3)returns++;last=audio.currentTime;return returns>=3;});assert(audio.currentTime>=1.95&&audio.currentTime<=2.8,'loop escaped range');await click('A 일시정지');await wait(()=>audio.paused);await click('구간 반복');await click('구간 반복 해제');await wait(()=>button('구간 반복').getAttribute('aria-pressed')==='false');checks.push('native A–B repeat across multiple endings without queue advance');
    await click('음원 길이 조정');await wait(()=>dialog());input('시작 시간','2');input('종료 시간','8');await click('적용');await wait(()=>!dialog());assert(audio.currentTime>=2&&audio.currentTime<=8,'trim start');
    await click('페이드 설정');await wait(()=>dialog());await click('닫기');await wait(()=>!dialog());checks.push('native trim editing and fade dialog');
    await window.luma.showMini();await new Promise(r=>setTimeout(r,400));await window.luma.closeMini();await new Promise(r=>setTimeout(r,900));
    const state=(await window.luma.getState()).state;state.settings.volume=.43;state.settings.fadeOut=1.2;state.playlists=[{id:'native-list',name:'보존할 목록',trackIds:[state.tracks[0].id]}];state.tracks[0].favorite=true;state.tracks[0].displayName='네이티브 표시 이름';await window.luma.saveState(state);const saved=(await window.luma.getState()).state;assert(saved.settings.volume===.43&&saved.tracks[0].favorite,'native store edits');assert(saved.playlists[0].name==='보존할 목록','native playlist');checks.push('native persistence and mini window lifecycle');
    await window.__TAURI__.core.invoke('native',{method:'qa:report',args:{passed:true,checks}});
  }catch(error){await window.__TAURI__.core.invoke('native',{method:'qa:report',args:{passed:false,checks,error:String(error?.stack||error),audio:document.querySelector('audio')?.error?.message||null}}).catch(()=>{});}
})();
