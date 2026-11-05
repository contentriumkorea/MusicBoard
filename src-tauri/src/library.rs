//! Persistent, version-one library data. This module has no desktop-runtime dependency.
use lofty::{file::{AudioFile, TaggedFileExt}, prelude::Accessor, probe::Probe};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

pub fn empty_state() -> Value {
    json!({"version":1,"tracks":[],"playlists":[],"settings":{"volume":0.7,"eqEnabled":false,"eq":vec![0;20],"preamp":0,"eqPreset":"Flat"},"playback":{"currentId":null,"anchorId":null,"position":0,"queue":[],"order":[],"repeat":"off","shuffle":false}})
}

fn array(value: &Value) -> &[Value] { value.as_array().map(Vec::as_slice).unwrap_or(&[]) }
fn number(value: &Value, low: f64, high: f64, default: f64) -> Value {
    json!(value.as_f64().filter(|n| n.is_finite()).unwrap_or(default).clamp(low, high))
}
fn clean_trim(track: &mut Value) {
    let duration = track["duration"].as_f64().unwrap_or(0.0);
    let range = track.get("trim").and_then(|t| Some((t["start"].as_f64()?, t["end"].as_f64()?)))
        .map(|(a,b)| (a.clamp(0.0,duration), b.clamp(0.0,duration)));
    if let Some((start,end)) = range.filter(|(a,b)| b-a >= 0.05 && !(*a == 0.0 && *b == duration)) {
        track["trim"] = json!({"start":start,"end":end});
    } else if let Some(object) = track.as_object_mut() { object.remove("trim"); }
}
fn directory(track: &Value) -> String {
    let path = track["path"].as_str().unwrap_or("").replace('\\', "/");
    path.rsplit_once('/').map(|(parent,_)| parent.trim_end_matches('/')).filter(|s| !s.is_empty()).unwrap_or("/").to_owned()
}
fn track_folder(track: &Value) -> String { track["folderId"].as_str().map(str::to_owned).unwrap_or_else(||directory(track)) }
fn folder_name(id: &str) -> String { id.replace('\\',"/").trim_end_matches('/').rsplit('/').next().filter(|v| !v.is_empty()).unwrap_or("/").to_owned() }

/// Keep extension fields so upgrading or rolling back does not discard user data.
pub fn sanitize_state(input: &Value) -> Value {
    if !input.is_object() { return empty_state(); }
    let mut result = input.clone();
    result["version"] = json!(1);
    let mut seen = HashSet::new();
    let tracks: Vec<Value> = array(&input["tracks"]).iter().filter_map(|raw| {
        let id = raw["id"].as_str()?;
        raw["path"].as_str()?; raw["title"].as_str()?;
        if !seen.insert(id.to_owned()) { return None; }
        let mut track = raw.clone();
        for (key,default) in [("artist","알 수 없는 아티스트"),("album","알 수 없는 앨범")] {
            if !track[key].is_string() { track[key] = json!(default); }
        }
        // Durations are not capped: long recordings must retain their true timeline.
        track["duration"] = number(&track["duration"],0.0,f64::MAX,0.0);
        track["favorite"] = json!(track["favorite"].as_bool().unwrap_or(false));
        for key in ["folderRoot","folderId","displayName"] {
            if let Some(text) = track[key].as_str() {
                let clean = if key == "displayName" { text.trim().chars().take(200).collect::<String>() } else { text.to_owned() };
                if key != "displayName" || !clean.is_empty() { track[key]=json!(clean); }
                else { track.as_object_mut().unwrap().remove(key); }
            } else { track.as_object_mut().unwrap().remove(key); }
        }
        clean_trim(&mut track);
        Some(track)
    }).collect();
    let ids: HashSet<String> = tracks.iter().filter_map(|t|t["id"].as_str().map(str::to_owned)).collect();
    let clean_ids = |values: &Value, unique: bool| -> Value {
        let mut seen = HashSet::new();
        json!(array(values).iter().filter_map(|v|v.as_str()).filter(|s|ids.contains(*s) && (!unique || seen.insert((*s).to_owned()))).collect::<Vec<_>>())
    };
    let mut folder_ids = HashSet::new();
    let mut folders: Vec<Value> = array(&input["folders"]).iter().filter_map(|raw| {
        let id = raw["id"].as_str()?;
        let name = raw["name"].as_str()?;
        if !folder_ids.insert(id.to_owned()) { return None; }
        let mut value = raw.clone();
        let name: String = name.trim().chars().take(200).collect();
        value["name"] = json!(if name.is_empty() {folder_name(id)} else {name});
        Some(value)
    }).collect();
    for track in &tracks {
        let id=track_folder(track);
        if folder_ids.insert(id.clone()) { folders.push(json!({"id":id,"name":folder_name(&id)})); }
    }
    result["folders"] = json!(folders);
    result["playlists"] = json!(array(&input["playlists"]).iter().filter_map(|raw| {
        raw["id"].as_str()?; raw["name"].as_str()?;
        let mut p=raw.clone(); p["trackIds"]=clean_ids(&raw["trackIds"],true); Some(p)
    }).collect::<Vec<_>>());
    let mut settings = input.get("settings").filter(|s|s.is_object()).cloned().unwrap_or_else(||empty_state()["settings"].clone());
    settings["volume"]=number(&settings["volume"],0.0,1.0,0.7);
    settings["eqEnabled"]=json!(settings["eqEnabled"].as_bool().unwrap_or(false));
    settings["eq"]=json!((0..20).map(|i|number(&settings["eq"][i],-12.0,12.0,0.0)).collect::<Vec<_>>());
    settings["preamp"]=number(&settings["preamp"],-12.0,6.0,0.0);
    if !settings["eqPreset"].is_string() {settings["eqPreset"]=json!("사용자 설정");}
    if !matches!(settings["librarySort"].as_str(),Some("manual"|"added"|"title"|"artist")) {settings["librarySort"]=json!("added");}
    for key in ["fadeIn","fadeOut"] {settings[key]=number(&settings[key],0.0,5.0,0.35);}
    result["settings"]=settings;
    let mut playback=input.get("playback").filter(|p|p.is_object()).cloned().unwrap_or_else(||empty_state()["playback"].clone());
    for key in ["currentId","anchorId"] {
        let id=playback[key].as_str().filter(|id|ids.contains(*id)).map(str::to_owned);
        playback[key]=json!(id);
    }
    if playback["anchorId"].is_null() {playback["anchorId"]=playback["currentId"].clone();}
    playback["position"]=number(&playback["position"],0.0,f64::MAX,0.0);
    playback["queue"]=clean_ids(&playback["queue"],false); playback["order"]=clean_ids(&playback["order"],false);
    if !matches!(playback["repeat"].as_str(),Some("off"|"all"|"one"|"stop")) {playback["repeat"]=json!("off");}
    playback["shuffle"]=json!(playback["shuffle"].as_bool().unwrap_or(false));
    result["playback"]=playback; result["tracks"]=json!(tracks); result
}

/// A renderer snapshot can reorder and edit tracks but cannot replace file identities,
/// metadata, or erase a track imported while that snapshot was being edited.
pub fn merge_state(existing: &Value, incoming: &Value) -> Value {
    let base=sanitize_state(existing);
    if !incoming.is_object() { return base; }
    let mut result=base.clone();
    for (key,value) in incoming.as_object().unwrap() { if key!="tracks" && key!="version" {result[key]=value.clone();} }
    let originals: HashMap<&str,&Value> = array(&base["tracks"]).iter().filter_map(|t|Some((t["id"].as_str()?,t))).collect();
    let mut seen=HashSet::new(); let mut tracks=Vec::new();
    for edit in array(&incoming["tracks"]) {
        let Some(id)=edit["id"].as_str() else {continue};
        let Some(original)=originals.get(id) else {continue};
        if !seen.insert(id.to_owned()) {continue;}
        let mut track=(**original).clone();
        for key in ["favorite","displayName","folderId","trim"] {
            if let Some(value)=edit.get(key) {track[key]=value.clone();}
            else if key!="favorite" {track.as_object_mut().unwrap().remove(key);}
        }
        tracks.push(track);
    }
    for track in array(&base["tracks"]) { if seen.insert(track["id"].as_str().unwrap().to_owned()) { tracks.push(track.clone()); } }
    result["tracks"]=json!(tracks); sanitize_state(&result)
}

pub fn read_state(dir: &Path) -> (Value,Option<String>) {
    let file=dir.join("state.json");
    let parse=|file: &Path| -> Result<Value,String> {serde_json::from_slice(&fs::read(file).map_err(|e|e.to_string())?).map_err(|e|e.to_string())};
    let (mut state,warning)=match parse(&file) {
        Ok(state)=>(sanitize_state(&state),None),
        Err(_) => match parse(&dir.join("state.json.bak")) {
            Ok(state)=>(sanitize_state(&state),Some("저장 파일을 읽을 수 없어 이전 상태를 복구했습니다.".to_owned())),
            Err(_) if !file.exists() => (empty_state(),None),
            Err(_) => (empty_state(),Some("저장 파일을 읽을 수 없습니다. 기존 파일은 보존했습니다.".to_owned())),
        }
    };
    // Repair the old extension-based MP4 import bug without touching any UI edits.
    if let Some(tracks)=state["tracks"].as_array_mut() {
        for track in tracks {
            if track["format"]=="M4A" {continue;}
            let Some(path)=track["path"].as_str().map(PathBuf::from) else {continue};
            if !has_mp4_header(&path) {continue;}
            if let Ok(metadata)=read_track(&path,None) {
                if metadata["duration"].as_f64().unwrap_or(0.0)>0.0 {
                    for key in ["duration","format","sampleRate","bitrate"] {track[key]=metadata[key].clone();}
                    clean_trim(track);
                }
            }
        }
    }
    (state,warning)
}

/// Write and sync a sibling temporary file before replacement. Never replace the
/// last valid backup with a corrupt primary file.
pub fn write_state(dir: &Path, state: &Value) -> Result<(),String> {
    fs::create_dir_all(dir).map_err(|e|e.to_string())?;
    let file=dir.join("state.json");
    match fs::read(&file) {
        Ok(old) => {
            let target=if serde_json::from_slice::<Value>(&old).is_ok() {dir.join("state.json.bak")}
                else if !dir.join("state.json.corrupt").exists() {dir.join("state.json.corrupt")}
                else {dir.join(format!("state.json.{}.corrupt",uuid::Uuid::new_v4()))};
            atomic_bytes(&target,&old)?;
        }
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    atomic_bytes(&file,&serde_json::to_vec(&sanitize_state(state)).map_err(|e|e.to_string())?)
}

pub(crate) fn atomic_bytes(target: &Path, bytes: &[u8]) -> Result<(),String> {
    let temp=target.with_file_name(format!("{}.{}.tmp",target.file_name().unwrap_or_default().to_string_lossy(),uuid::Uuid::new_v4()));
    let result=(|| {
        let mut file=OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e|e.to_string())?;
        file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;
        drop(file);
        fs::rename(&temp,target).map_err(|e|e.to_string())
    })();
    if result.is_err() {let _=fs::remove_file(temp);} result
}

pub fn remove_tracks(state: &mut Value, ids: &[String]) {
    let removed:HashSet<&str>=ids.iter().map(String::as_str).collect();
    let mut clean=sanitize_state(state);
    let current_removed=clean["playback"]["currentId"].as_str().is_some_and(|id|removed.contains(id));
    clean["tracks"].as_array_mut().unwrap().retain(|t|!removed.contains(t["id"].as_str().unwrap_or("")));
    let used:HashSet<String>=array(&clean["tracks"]).iter().map(track_folder).collect();
    clean["folders"].as_array_mut().unwrap().retain(|f|f["id"].as_str().is_some_and(|id|used.contains(id)));
    if current_removed {clean["playback"]["position"]=json!(0);}
    *state=sanitize_state(&clean);
}

fn audio_path(file: &Path) -> bool {
    matches!(file.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),"mp3"|"wav"|"flac"|"m4a"|"aac"|"ogg"|"opus"|"aiff"|"aif")
}
pub(crate) fn real_path(file: &Path) -> Result<PathBuf,String> {
    let path=fs::canonicalize(file).map_err(|e|e.to_string())?;
    #[cfg(windows)] {
        let text=path.to_string_lossy();
        if let Some(rest)=text.strip_prefix(r"\\?\UNC\") {return Ok(PathBuf::from(format!(r"\\{}",rest)));}
        if let Some(rest)=text.strip_prefix(r"\\?\") {return Ok(PathBuf::from(rest));}
    }
    Ok(path)
}
fn path_key(path: &Path) -> String {
    let text=path.to_string_lossy().into_owned();
    if cfg!(windows) {text.to_lowercase()} else {text}
}
fn scan(input: &Path, root: Option<&str>, seen: &mut HashSet<String>, files: &mut Vec<(PathBuf,Option<String>)>, errors: &mut Vec<String>) {
    let result=(|| -> Result<(),String> {
        let info=fs::symlink_metadata(input).map_err(|e|e.to_string())?;
        if info.file_type().is_symlink() {return Ok(());}
        let resolved=real_path(input)?;
        if !seen.insert(path_key(&resolved)) {return Ok(());}
        if info.is_dir() {
            let mut entries=fs::read_dir(&resolved).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            entries.sort_by_key(|entry|entry.file_name());
            for entry in entries {
                if entry.file_name().to_string_lossy().starts_with('.') {continue;}
                #[cfg(windows)] {
                    use std::os::windows::fs::MetadataExt;
                    if entry.metadata().map(|m|m.file_attributes() & 0x2 != 0).unwrap_or(false) {continue;}
                }
                scan(&entry.path(),root,seen,files,errors);
            }
        } else if info.is_file() && audio_path(&resolved) {files.push((resolved,root.map(str::to_owned)));}
        Ok(())
    })();
    if let Err(error)=result {errors.push(format!("{}: {}",input.display(),error));}
}
fn has_mp4_header(file: &Path) -> bool {
    let mut header=[0_u8;12];
    File::open(file).and_then(|mut f|f.read_exact(&mut header)).is_ok() && &header[4..8]==b"ftyp"
}

fn read_track(input: &Path, art: Option<&Path>) -> Result<Value,String> {
    let file=real_path(input)?;
    // A fresh Probe over a reader has no extension hint. Content wins, including
    // an MP4 container whose source was named .mp3.
    let tagged=Probe::new(std::io::BufReader::new(File::open(&file).map_err(|e|e.to_string())?))
        .guess_file_type().map_err(|e|e.to_string())?.read().map_err(|e|e.to_string())?;
    let props=tagged.properties();
    let tag=tagged.primary_tag().or_else(||tagged.first_tag());
    let fallback=file.file_stem().unwrap_or_default().to_string_lossy();
    let title=tag.and_then(|t|t.title()).map(|s|s.into_owned()).filter(|s|!s.is_empty()).unwrap_or_else(||fallback.into_owned());
    let artist=tag.and_then(|t|t.artist()).map(|s|s.into_owned()).filter(|s|!s.is_empty()).unwrap_or_else(||"알 수 없는 아티스트".into());
    let album=tag.and_then(|t|t.album()).map(|s|s.into_owned()).filter(|s|!s.is_empty()).unwrap_or_else(||"알 수 없는 앨범".into());
    let format=if has_mp4_header(&file) {"M4A".into()} else {
        match format!("{:?}",tagged.file_type()).as_str() {
            "Mpeg"=>"MP3".into(),"Wav"=>"WAV".into(),"Aiff"=>"AIFF".into(),"Flac"=>"FLAC".into(),"Aac"=>"AAC".into(),"Opus"=>"OPUS".into(),"Vorbis"=>"OGG".into(),
            _=>file.extension().unwrap_or_default().to_string_lossy().to_uppercase(),
        }
    };
    let mut track=json!({"id":hex::encode(Sha256::digest(path_key(&file).as_bytes())),"path":file.to_string_lossy(),"title":title,"artist":artist,"album":album,"duration":props.duration().as_secs_f64(),"format":format,"addedAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,"favorite":false});
    if let Some(rate)=props.sample_rate() {track["sampleRate"]=json!(rate);}
    if let Some(rate)=props.audio_bitrate().or_else(||props.overall_bitrate()) {track["bitrate"]=json!(u64::from(rate)*1000);}
    if let Some(number)=tag.and_then(|t|t.track()) {track["trackNumber"]=json!(number);}
    if let Some(picture)=tag.and_then(|t|t.pictures().first()) {
        let data=picture.data();
        let safe=data.starts_with(b"\x89PNG\r\n\x1a\n") || data.starts_with(&[0xff,0xd8,0xff]) || (data.starts_with(b"RIFF") && data.get(8..12)==Some(b"WEBP"));
        if data.len()<5_000_000 && safe {
            if let Some(dir)=art {
                let id=hex::encode(Sha256::digest(data));
                if fs::create_dir_all(dir).is_ok() && (dir.join(&id).is_file() || atomic_bytes(&dir.join(&id),data).is_ok()) {track["artwork"]=json!(format!("luma://art/{id}"));}
            }
        }
    }
    Ok(track)
}

pub fn import_paths(dir: &Path, state: &mut Value, paths: &[String], progress: &mut dyn FnMut(usize,usize,&str)) -> Result<Value,String> {
    let mut files=Vec::new(); let mut seen=HashSet::new(); let mut errors=Vec::new(); let mut roots=Vec::new();
    for path in paths {
        let input=Path::new(path);
        let root=if input.is_dir() {real_path(input).ok().map(|p|p.to_string_lossy().into_owned())} else {None};
        if let Some(root)=&root {if !roots.contains(root) {roots.push(root.clone());}}
        scan(input,root.as_deref(),&mut seen,&mut files,&mut errors);
    }
    files.sort_by(|a,b|a.0.cmp(&b.0));
    let mut next=sanitize_state(state); let tracks=next["tracks"].as_array_mut().unwrap();
    let mut indexes:HashMap<String,usize>=tracks.iter().enumerate().map(|(i,t)|(t["id"].as_str().unwrap().to_owned(),i)).collect();
    let mut added=0; let mut track_ids=Vec::new();
    for (index,(file,root)) in files.iter().enumerate() {
        progress(index+1,files.len(),&file.file_name().unwrap_or_default().to_string_lossy());
        let id=hex::encode(Sha256::digest(path_key(file).as_bytes()));
        if let Some(index)=indexes.get(&id).copied() {
            if let Some(root)=root {tracks[index]["folderRoot"]=json!(root);}
            track_ids.push(id); continue;
        }
        match read_track(file,Some(&dir.join("artwork"))) {
            Ok(mut track)=> {
                if let Some(root)=root {track["folderRoot"]=json!(root);}
                track_ids.push(id.clone()); indexes.insert(id,tracks.len()); tracks.push(track); added+=1;
            }
            Err(error)=>errors.push(format!("{}: {}",file.file_name().unwrap_or_default().to_string_lossy(),error)),
        }
    }
    next=sanitize_state(&next);
    // Commit the in-memory snapshot only after a successful disk write.
    write_state(dir,&next)?; *state=next;
    Ok(json!({"state":state,"added":added,"errors":errors,"folderRoots":roots,"trackIds":track_ids}))
}

pub fn parse_m3u(content: &str, file: &Path) -> Vec<String> {
    content.trim_start_matches('\u{feff}').lines().filter_map(|line| {
        let line=line.trim();
        if line.is_empty() || line.starts_with('#') || line.to_ascii_lowercase().starts_with("http:") || line.to_ascii_lowercase().starts_with("https:") {return None;}
        let path=if line.to_ascii_lowercase().starts_with("file:") {url::Url::parse(line).ok()?.to_file_path().ok()?}
            else {let path=Path::new(line); if path.is_absolute() {path.to_owned()} else {file.parent().unwrap_or(Path::new(".")).join(path)}};
        // Resolve '..' lexically; sources may be offline and must not be dropped.
        let mut normalized=PathBuf::new();
        for part in path.components() {match part {std::path::Component::CurDir=>(),std::path::Component::ParentDir=>{normalized.pop();},other=>normalized.push(other.as_os_str())}}
        Some(normalized.to_string_lossy().into_owned())
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: &str) -> Value {json!({"id":id,"path":format!("/audio/{id}.wav"),"title":id,"duration":10,"artist":"artist","favorite":false,"custom":{"keep":true}})}
    #[test]
    fn stale_renderer_cannot_replace_identity_or_remove_new_imports() {
        let mut state=empty_state(); state["tracks"]=json!([track("old"),track("new")]);
        let mut edit=track("old"); edit["path"]=json!("/stolen"); edit["duration"]=json!(999); edit["favorite"]=json!(true); edit["trim"]=json!({"start":2,"end":8});
        let merged=merge_state(&state,&json!({"tracks":[edit]}));
        assert_eq!(merged["tracks"][0]["path"],"/audio/old.wav"); assert_eq!(merged["tracks"][0]["duration"],10.0);
        assert_eq!(merged["tracks"][0]["favorite"],true); assert_eq!(merged["tracks"][0]["custom"]["keep"],true); assert_eq!(merged["tracks"][1]["id"],"new");
    }
    #[test]
    fn store_recovers_and_preserves_corruption_and_unknown_settings() {
        let temp=tempfile::tempdir().unwrap(); let mut state=empty_state(); state["settings"]["future"]=json!({"x":7});
        write_state(temp.path(),&state).unwrap(); state["settings"]["volume"]=json!(0.2); write_state(temp.path(),&state).unwrap();
        fs::write(temp.path().join("state.json"),b"{broken").unwrap();
        let (recovered,warning)=read_state(temp.path()); assert!(warning.is_some()); assert_eq!(recovered["settings"]["future"]["x"],7);
        write_state(temp.path(),&recovered).unwrap(); assert_eq!(fs::read(temp.path().join("state.json.corrupt")).unwrap(),b"{broken");
        assert!(serde_json::from_slice::<Value>(&fs::read(temp.path().join("state.json.bak")).unwrap()).is_ok());
    }
    #[test]
    fn removal_cleans_playlists_and_playback_without_deleting_sources() {
        let mut state=empty_state(); state["tracks"]=json!([track("a"),track("b")]); state["playlists"]=json!([{"id":"p","name":"p","trackIds":["a","b"]}]); state["playback"]["currentId"]=json!("a"); state["playback"]["position"]=json!(8); state["playback"]["queue"]=json!(["a","b"]);
        remove_tracks(&mut state,&["a".into()]); assert!(state["playback"]["currentId"].is_null()); assert_eq!(state["playback"]["position"],0.0); assert_eq!(state["playlists"][0]["trackIds"],json!(["b"]));
    }
    #[test]
    fn m3u_bom_comments_urls_and_relative_paths() {
        let dir=tempfile::tempdir().unwrap(); let uri=url::Url::from_file_path(dir.path().join("a b.wav")).unwrap();
        let result=parse_m3u(&format!("\u{feff}#EXTM3U\r\n#comment\nhttps://example.test/a.mp3\nsub/../relative.wav\n{uri}"),&dir.path().join("list.m3u"));
        assert_eq!(result.len(),2); assert_eq!(Path::new(&result[0]),dir.path().join("relative.wav")); assert_eq!(Path::new(&result[1]),dir.path().join("a b.wav"));
    }
    #[test]
    fn folder_import_is_sorted_skips_hidden_and_deduplicates() {
        let source=tempfile::tempdir().unwrap(); let storage=tempfile::tempdir().unwrap();
        for name in ["z.wav","a.wav",".hidden.wav"] {crate::waveform::tests::write_wav(&source.path().join(name),&[[0,0];960]);}
        fs::write(source.path().join("bad.mp3"),b"invalid audio").unwrap();
        let mut state=empty_state(); let mut calls=Vec::new();
        let result=import_paths(storage.path(),&mut state,&[source.path().to_string_lossy().into_owned()],&mut |n,total,_|calls.push((n,total))).unwrap();
        assert_eq!(result["added"],2); assert_eq!(result["errors"].as_array().unwrap().len(),1); assert_eq!(state["tracks"][0]["title"],"a"); assert_eq!(calls.len(),3);
        let result=import_paths(storage.path(),&mut state,&[source.path().to_string_lossy().into_owned()],&mut |_,_,_|{}).unwrap(); assert_eq!(result["added"],0); assert_eq!(state["tracks"].as_array().unwrap().len(),2);
    }
}
