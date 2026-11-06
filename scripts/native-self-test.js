// Fixed acceptance scenario, enabled only in an explicitly isolated native QA data directory.
(async()=>{
  const checks=[];let initialSnapshot;
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const wait=async callback=>{const until=Date.now()+45000;let error;while(Date.now()<until){try{const value=await callback();if(value)return value;}catch(e){error=e;}await new Promise(r=>setTimeout(r,30));}throw error||Error('Native UI wait timed out');};
  const button=name=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===name||b.textContent.trim()===name);
  const click=async name=>{const el=await wait(()=>button(name));el.click();};
  const input=async(name,value)=>{const el=document.querySelector(`input[aria-label="${name}"]`);assert(el,'Missing '+name);const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));};
  const dialog=()=>document.querySelector('[role="dialog"]');
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const row=id=>document.querySelector(`[data-track-id="${CSS.escape(id)}"]`);
  const heading=id=>document.querySelector(`[data-folder-id="${CSS.escape(id)}"]`);
  const groupIds=id=>{
    const ids=[];let current=heading(id)?.nextElementSibling;
    while(current&&!current.hasAttribute('data-folder-id')){if(current.dataset.trackId)ids.push(current.dataset.trackId);current=current.nextElementSibling;}return ids;
  };
  const same=(actual,expected)=>JSON.stringify(actual)===JSON.stringify(expected);
  const pointerDrag=async(source,target,edge='before')=>{
    source.scrollIntoView({block:'nearest'});target.scrollIntoView({block:'nearest'});await frame();
    const start=source.getBoundingClientRect(),end=target.getBoundingClientRect(),x=start.left+start.width/2,y=start.top+start.height/2;
    const send=(element,type,clientX,clientY)=>element.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:71,pointerType:'mouse',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX,clientY}));
    send(source,'pointerdown',x,y);send(document,'pointermove',x+9,y);await frame();
    assert(document.querySelector('.is-dragging'),'native pointer drag did not start');
    const tx=end.left+Math.min(110,end.width/2),ty=edge==='after'?end.bottom-4:end.top+4;
    send(document,'pointermove',tx,ty);await frame();send(document,'pointerup',tx,ty);
    await wait(()=>!document.querySelector('.is-dragging'));await new Promise(resolve=>setTimeout(resolve,420));
  };
  // Exercise the Tauri event boundary, File proxies, and the actual App destination handler.
  const nativeDrop=async(paths,target,edge='before')=>{
    target.scrollIntoView({block:'nearest'});await frame();const box=target.getBoundingClientRect(),scale=window.devicePixelRatio||1;
    const position={x:(box.left+Math.min(110,box.width/2))*scale,y:(edge==='after'?box.bottom-4:box.top+4)*scale};
    await window.__TAURI__.event.emit('native:drop',{type:'enter',paths,position});await wait(()=>document.querySelector('.drop-overlay'));
    await window.__TAURI__.event.emit('native:drop',{type:'over',position});await frame();
    await window.__TAURI__.event.emit('native:drop',{type:'drop',paths,position});await wait(()=>!document.querySelector('.drop-overlay')&&!document.querySelector('.import-progress'));await frame();
  };
  const audioBytes=async id=>{const response=await fetch(window.luma.mediaUrl('audio',id));assert(response.ok,'original source cannot be read');return new Uint8Array(await response.arrayBuffer());};
  try{
    await wait(()=>window.luma&&document.querySelectorAll('[data-track-id]').length===3);
    const initial=(await window.luma.getState()).state;assert(initial.tracks.length===3,'native tracks');assert(window.luma.mediaUrl('audio',initial.tracks[0].id).startsWith('http://127.0.0.1:'),'loopback media');assert(document.title==='MusicBoard','window title');
    initialSnapshot={names:initial.tracks.map(t=>t.displayName||t.title),ids:initial.tracks.map(t=>t.id),settings:initial.settings,playlists:initial.playlists,trim:initial.tracks.map(t=>t.trim??null),tracks:initial.tracks.map(({id,title,displayName,favorite,trim})=>({id,title,displayName,favorite,trim}))};
    const sources=new Map(await Promise.all(initial.tracks.map(async track=>[track.id,await audioBytes(track.id)])));
    await click('MusicBoard 정보');await wait(()=>dialog()?.getAttribute('aria-label')==='MusicBoard'||dialog()?.textContent.includes('MusicBoard'));await click('닫기');await wait(()=>!dialog());checks.push('native UI/legacy library and about dialog');
    await click('A 재생');const audio=document.querySelector('audio');await wait(()=>!audio.paused&&audio.currentTime>.15);await click('A 일시정지');await wait(()=>audio.paused);await new Promise(r=>setTimeout(r,100));const position=audio.currentTime;await new Promise(r=>setTimeout(r,200));const pausedDelta=audio.currentTime-position;assert(audio.paused&&Math.abs(pausedDelta)<.025,`paused playback changed: delta=${pausedDelta.toFixed(6)}s, paused=${audio.paused}`);assert(!audio.error,'native audio error');
    await wait(()=>document.querySelector('svg[aria-label="음원 파형"]')||document.querySelector('[role="img"][aria-label="음원 파형"]'));checks.push('actual native WebView PCM playback, pause and waveform');
    await click('구간 반복');await wait(()=>dialog());await input('A 시작 시간','2');await input('B 종료 시간','2.75');await click('적용');await wait(()=>button('구간 반복').getAttribute('aria-pressed')==='true');assert(audio.paused,'loop edit autoplay');await click('A 재생');
    let returns=0,last=audio.currentTime;await wait(()=>{if(last-audio.currentTime>.3)returns++;last=audio.currentTime;return returns>=3;});assert(audio.currentTime>=1.95&&audio.currentTime<=2.8,'loop escaped range');await click('A 일시정지');await wait(()=>audio.paused);await click('구간 반복');await click('구간 반복 해제');await wait(()=>button('구간 반복').getAttribute('aria-pressed')==='false');checks.push('native A–B repeat across multiple endings without queue advance');
    await click('음원 길이 조정');await wait(()=>dialog());await input('시작 시간','2');await input('종료 시간','8');await click('적용');await wait(()=>!dialog());assert(audio.currentTime>=2&&audio.currentTime<=8,'trim start');
    await click('페이드 설정');await wait(()=>dialog());
    for(const [label,value] of [['페이드 인','0.73'],['페이드 아웃','1.37']]){
      button(`${label} 초 직접 입력`).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await wait(()=>document.querySelector(`input[aria-label="${label} 초"]`));
      await input(`${label} 초`,value);document.querySelector(`input[aria-label="${label} 초"]`).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      await wait(()=>button(`${label} 초 직접 입력`)?.textContent===`${Number(value).toFixed(2)}초`);
    }
    button('페이드 인 초 직접 입력').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await wait(()=>document.querySelector('input[aria-label="페이드 인 초"]'));await input('페이드 인 초','4.25');
    document.querySelector('input[aria-label="페이드 인 초"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait(()=>button('페이드 인 초 직접 입력')?.textContent==='0.73초');
    await wait(async()=>{const saved=(await window.luma.getState()).state;return saved.settings.fadeIn===.73&&saved.settings.fadeOut===1.37;});
    await click('닫기');await wait(()=>!dialog());checks.push('native trim and fade seconds double-click editing, Enter save and Escape cancel');

    const a=initial.tracks.find(track=>/[\\/]A\.wav$/i.test(track.path)),b=initial.tracks.find(track=>/[\\/]B\.wav$/i.test(track.path)),c=initial.tracks.find(track=>/[\\/]C\.wav$/i.test(track.path));
    assert(a&&b&&c,'native interaction fixture tracks');const first=a.folderId,second=c.folderId;
    assert(first&&second&&first!==second&&heading(first)&&heading(second),'native interaction fixture needs two groups');
    await pointerDrag(row(a.id).querySelector('.drag-handle'),row(c.id));await wait(()=>same(groupIds(second),[a.id,c.id]));assert(same(groupIds(first),[b.id]),'cross-group drag changed remaining songs');
    await wait(async()=>(await window.luma.getState()).state.tracks.find(track=>track.id===a.id)?.folderId===second);
    await nativeDrop([b.path],row(c.id),'after');await wait(()=>same(groupIds(second),[a.id,c.id,b.id]));assert(groupIds(first).length===0,'external drop ignored target group');
    assert(document.querySelectorAll('[data-track-id]').length===3,'duplicate external drop created another track');
    await pointerDrag(row(b.id).querySelector('.drag-handle'),row(a.id));await wait(()=>same(groupIds(second),[b.id,a.id,c.id]));
    checks.push('native pointer drag across groups and within-group reorder; native drop event inserts duplicate source at chosen row edge');

    row(b.id).querySelector('[aria-label$=" 더 보기"]').click();await click('이름 변경');await wait(()=>dialog());await input('새 이름','Native renamed B');await click('변경');await wait(()=>!dialog()&&row(b.id)?.querySelector('.track-title')?.textContent==='Native renamed B');
    heading(second).querySelector('[aria-label$=" 폴더 이름 변경"]').click();await wait(()=>dialog());await input('새 이름','Native kept folder');await click('변경');await wait(()=>!dialog()&&heading(second)?.querySelector('strong')?.textContent==='Native kept folder');
    await wait(async()=>{const state=(await window.luma.getState()).state,renamed=state.tracks.find(track=>track.id===b.id);return renamed?.displayName==='Native renamed B'&&renamed.path===b.path&&renamed.title===b.title&&state.folders.some(folder=>folder.id===second&&folder.name==='Native kept folder');});
    heading(first).querySelector('[aria-label$=" 빈 폴더 삭제"]').click();await wait(()=>!heading(first));assert(same(groupIds(second),[b.id,a.id,c.id]),'removing empty folder removed songs');
    await wait(async()=>!(await window.luma.getState()).state.folders.some(folder=>folder.id===first));
    row(b.id).querySelector('.track-title').dispatchEvent(new MouseEvent('click',{bubbles:true}));await frame();
    row(c.id).querySelector('.track-title').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true,metaKey:window.luma.platform==='darwin'}));await frame();
    assert(document.querySelectorAll('[data-track-id][aria-selected="true"]').length===2,'Ctrl/Command multi-selection failed');
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));await wait(()=>document.querySelectorAll('[data-track-id]').length===1&&row(a.id));
    await wait(async()=>(await window.luma.getState()).state.tracks.length===1);
    assert(!heading(second).querySelector('[aria-label$=" 빈 폴더 삭제"]'),'nonempty folder must not offer removal');
    await nativeDrop([b.path,c.path],row(a.id));await wait(()=>same(groupIds(second),[b.id,c.id,a.id]));
    const restored=await wait(async()=>{const state=(await window.luma.getState()).state;return state.tracks.length===3&&state.tracks.every(track=>track.folderId===second)?state:null;});
    for(const original of initial.tracks){const current=restored.tracks.find(track=>track.id===original.id);assert(current?.path===original.path,'UI operation changed original source path');
      const before=sources.get(original.id),after=await audioBytes(original.id);assert(before.length===after.length&&before.every((byte,index)=>byte===after[index]),'UI operation changed original audio bytes');}
    checks.push('native UI track/folder rename, empty folder removal, Ctrl/Command selection and Delete; reimport proves all original paths and bytes preserved');
    await window.luma.showMini();await new Promise(r=>setTimeout(r,400));await window.luma.closeMini();await new Promise(r=>setTimeout(r,900));
    const state=(await window.luma.getState()).state;state.settings.volume=.43;state.settings.fadeOut=1.2;state.playlists=[{id:'native-list',name:'보존할 목록',trackIds:[state.tracks[0].id]}];state.tracks[0].favorite=true;state.tracks[0].displayName='네이티브 표시 이름';await window.luma.saveState(state);const saved=(await window.luma.getState()).state;assert(saved.settings.volume===.43&&saved.tracks[0].favorite,'native store edits');assert(saved.playlists[0].name==='보존할 목록','native playlist');checks.push('native persistence and mini window lifecycle');
    await window.__TAURI__.core.invoke('native',{method:'qa:report',args:{passed:true,checks,initial:initialSnapshot}});
  }catch(error){await window.__TAURI__.core.invoke('native',{method:'qa:report',args:{passed:false,checks,initial:initialSnapshot,error:String(error?.stack||error),audio:document.querySelector('audio')?.error?.message||null}}).catch(()=>{});}
})();
