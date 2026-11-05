import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {coreClient,fixture,cleanFixture} from './rust-core-smoke.mjs';

// Reuse the repository's synthetic encoded audio from mislabeled-audio-smoke,
// long-waveform-smoke and waveform-fade-smoke. No user media or encoder is used.
const encoded=JSON.parse(await readFile(new URL('../tests/fixtures/waveform-audio.json',import.meta.url),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
function regions(info,name){
  assert.match(info.key,/^[a-f0-9]{64}$/u,`${name}: cache key`);
  assert.ok(Array.isArray(info.peaks),`${name}: Rust must return native peaks, not the WebAudio fallback`);
  assert.equal(info.peaks.length,960,`${name}: point count`);
  assert.ok(info.peaks.every(p=>Number.isFinite(p)&&p>=0&&p<=1),`${name}: finite amplitudes`);
  const max=(from,to)=>Math.max(...info.peaks.slice(Math.floor(from*960),Math.floor(to*960)));
  const quiet=max(.29,.44),loud=max(.56,.70);
  assert.ok(quiet>.0001,`${name}: quiet section is audible`);
  assert.ok(loud>quiet*2.5,`${name}: loud section exceeds quiet section`);
  assert.ok(max(.03,.20)<loud*.01+.00001,`${name}: leading silence`);
  assert.ok(max(.80,.96)<loud*.01+.00001,`${name}: trailing silence`);
  assert.ok(info.peaks.filter(p=>p>loud*.05).length>400,`${name}: peaks span the full middle half, not one collapsed bin`);
}

const f=await fixture();
const executable=process.env.MUSICBOARD_CORE_EXECUTABLE||path.resolve(process.platform==='win32'?'release/native-unpacked/SONO.exe':'release/mac-universal/PulseDeck.app/Contents/MacOS/SONO');
const aac=path.join(f.folder,'AAC 내용의 MP3.mp3'),flac=path.join(f.folder,'stereo FLAC.flac'),long=path.join(f.folder,'긴 MP3.mp3');
let core;
const diagnostics=[];
function launch(){const client=coreClient(executable,f.data);client.child.stderr.on('data',bytes=>diagnostics.push(bytes.toString()));return client;}
try{
  const aacBytes=Buffer.from(encoded.m4a,'base64'),flacBytes=Buffer.from(encoded.flac,'base64');
  // Exactly the existing long-waveform fixture: independent CBR frames without
  // Xing/ID3/bit-reservoir dependencies, four sections totalling 5011.2 seconds.
  const mp3Bytes=Buffer.concat(['silence','quiet','loud','silence'].flatMap(name=>Array(300).fill(Buffer.from(encoded[name],'base64'))));
  assert.equal(aacBytes.toString('ascii',4,8),'ftyp');
  assert.equal(flacBytes.toString('ascii',0,4),'fLaC');
  const streamInfo=flacBytes.readBigUInt64BE(18);
  assert.equal(Number(streamInfo>>44n),16000);assert.equal(Number((streamInfo>>41n)&7n)+1,2);
  assert.equal(Number(streamInfo&0xfffffffffn),192000);
  const originals=new Map([[aac,sha(aacBytes)],[flac,sha(flacBytes)],[long,sha(mp3Bytes)]]);
  await writeFile(aac,aacBytes);await writeFile(flac,flacBytes);await writeFile(long,mp3Bytes);
  const cache=path.join(f.data,'waveforms');await mkdir(cache);
  const oldStat=await stat(aac),oldKey=sha(`wave-v1:${aac}:${oldStat.size}:${oldStat.mtimeMs}:${oldStat.ctimeMs}`);
  const collapsed=Array(960).fill(0);collapsed[959]=1;await writeFile(path.join(cache,`${oldKey}.json`),JSON.stringify(collapsed));

  core=launch();
  const imported=await core.call('music:paths',{paths:[aac,flac,long]});
  assert.equal(imported.added,3);assert.equal(imported.trackIds.length,3);assert.deepEqual(imported.errors,[]);
  const find=file=>{const track=imported.state.tracks.find(t=>t.path===file);assert.ok(track,`imported ${path.basename(file)}`);assert.ok(imported.trackIds.includes(track.id));return track;};
  const aacTrack=find(aac),flacTrack=find(flac),longTrack=find(long);
  assert.equal(aacTrack.format,'M4A');assert.ok(Math.abs(aacTrack.duration-12.064)<.001);
  assert.equal(flacTrack.format,'FLAC');assert.ok(Math.abs(flacTrack.duration-12)<.001);
  assert.equal(longTrack.format,'MP3');assert.ok(longTrack.duration>5000&&longTrack.duration<5020,`long MP3 metadata: ${longTrack.duration}`);
  console.log('PASS Rust imports real AAC/MP4 disguised as MP3, stereo FLAC and 5011-second MP3 with correct content metadata');

  const waves=new Map();
  for(const track of [aacTrack,flacTrack]){const wave=await core.call('waveform:get',{id:track.id});regions(wave,track.format);waves.set(track.id,wave);}
  assert.notEqual(waves.get(aacTrack.id).key,oldKey);
  console.log('PASS native AAC/MP4 and stereo FLAC return 960 distributed peaks with leading silence, quiet/loud tones and silent tails');

  const started=performance.now(),longWave=await core.call('waveform:get',{id:longTrack.id});regions(longWave,'long MP3');waves.set(longTrack.id,longWave);
  console.log(`PASS native ${longTrack.duration.toFixed(1)}-second MP3 preserves all four timeline sections in ${((performance.now()-started)/1000).toFixed(1)} seconds`);

  for(const wave of waves.values())assert.deepEqual(JSON.parse(await readFile(path.join(cache,`${wave.key}.json`),'utf8')),wave.peaks);
  // Exercise startup repair on the same real disguised MP4, as the existing
  // mislabeled-audio smoke does for a library created by the old application.
  const saved=(await core.call('state:get')).state;
  const damaged=saved.tracks.find(t=>t.id===aacTrack.id);
  damaged.duration=.042666666666666665;damaged.format='MP3';damaged.favorite=true;damaged.displayName='보존할 이름';damaged.folderId='saved-folder';
  saved.folders.push({id:'saved-folder',name:'보존할 폴더'});
  saved.settings.fadeOut=1.23;saved.playlists=[{id:'saved-playlist',name:'보존할 목록',trackIds:[aacTrack.id]}];
  await core.close();core=undefined;await writeFile(path.join(f.data,'state.json'),JSON.stringify(saved));
  core=launch();
  const restarted=(await core.call('state:get')).state,repaired=restarted.tracks.find(t=>t.id===aacTrack.id);
  assert.equal(repaired.path,aac);assert.equal(repaired.format,'M4A');assert.ok(Math.abs(repaired.duration-12.064)<.001);
  assert.equal(repaired.favorite,true);assert.equal(repaired.displayName,'보존할 이름');assert.equal(repaired.folderId,'saved-folder');
  assert.deepEqual(restarted.playlists,saved.playlists);assert.deepEqual(restarted.settings,saved.settings);
  const persisted=JSON.parse(await readFile(path.join(f.data,'state.json'),'utf8'));assert.equal(persisted.tracks.find(t=>t.id===aacTrack.id).format,'M4A');
  for(const [id,wave] of waves){
    const cached=await core.call('waveform:get',{id});
    assert.equal(cached.key,wave.key);assert.equal(cached.size,wave.size);assert.equal(cached.peaks.length,wave.peaks.length);
    // serde_json may round a decimal cache value by one final binary64 bit when
    // reading it back; retain every-bin comparison below audio precision.
    assert.ok(cached.peaks.every((peak,index)=>Math.abs(peak-wave.peaks[index])<=1e-12),'cached native amplitudes preserved');
  }
  for(const [file,hash] of originals)assert.equal(await fileHash(file),hash,`${path.basename(file)} source SHA-256 unchanged`);
  await core.close();core=undefined;assert.equal(diagnostics.join('').trim(),'','native core stderr');
  console.log('PASS real MP4 startup repair preserves edits/playlists/settings; codec caches survive restart and every original audio SHA-256 stays unchanged');
}finally{
  if(core)await core.close().catch(error=>{core.child.kill();console.error(error.message);});
  await cleanFixture(f.dir);
}
