pub mod library;
pub mod media;
pub mod updates;
pub mod waveform;

use serde_json::{json, Value};
use std::{io::{self, BufRead, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}};

pub struct Core {
    pub directory: PathBuf,
    pub state: Arc<Mutex<Value>>,
    pub media_base: String,
    warning: Mutex<Option<String>>,
    updater: Mutex<updates::Updater>,
}

pub fn data_directory() -> PathBuf {
    std::env::var_os("LUMA_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("Luma Music")
    })
}

impl Core {
    pub fn new(directory: PathBuf, helper: PathBuf) -> Result<Arc<Self>, String> {
        let (state, warning) = library::read_state(&directory);
        let state = Arc::new(Mutex::new(state));
        let media_base = media::start(state.clone(), directory.join("artwork"))?;
        let updater = updates::Updater::new(directory.clone(), env!("CARGO_PKG_VERSION"), helper);
        Ok(Arc::new(Self { directory, state, media_base, warning: Mutex::new(warning), updater: Mutex::new(updater) }))
    }

    pub fn invoke(&self, method: &str, args: &Value, emit: &mut dyn FnMut(&str, Value)) -> Result<Value, String> {
        match method {
            "shell:info" => Ok(json!({"platform": std::env::consts::OS, "mediaBase": self.media_base, "version": env!("CARGO_PKG_VERSION"), "runtime":"rust"})),
            "state:get" => Ok(json!({"state":*self.state.lock().map_err(|_|"보관함 잠금 오류")?, "warning":*self.warning.lock().map_err(|_|"보관함 잠금 오류")?})),
            "state:save" => {
                let mut state = self.state.lock().map_err(|_|"보관함 잠금 오류")?;
                let next = library::merge_state(&state, &args["state"]);
                library::write_state(&self.directory, &next)?;
                *state = next;
                Ok(Value::Null)
            },
            "music:remove" => {
                let ids = strings(&args["ids"])?;
                let mut state = self.state.lock().map_err(|_|"보관함 잠금 오류")?;
                let mut next = state.clone();
                library::remove_tracks(&mut next, &ids);
                library::write_state(&self.directory, &next)?;
                *state = next;
                Ok(state.clone())
            },
            "music:paths" => {
                let paths = strings(&args["paths"])?;
                if paths.is_empty() || paths.iter().any(|p| !Path::new(p).is_absolute()) { return Err("유효한 음악 파일이나 폴더를 놓아주세요.".into()); }
                let mut state = self.state.lock().map_err(|_|"보관함 잠금 오류")?;
                library::import_paths(&self.directory, &mut state, &paths, &mut |current,total,name|emit("import:progress", json!({"current":current,"total":total,"name":name})))
            },
            "waveform:get" | "waveform:save" => {
                let file = self.track_path(args["id"].as_str().ok_or("음원 ID가 필요합니다.")?)?;
                let cache = self.directory.join("waveforms");
                if method == "waveform:get" { waveform::get_waveform(&file, &cache) }
                else { waveform::save_waveform(&file, &cache, args["key"].as_str().unwrap_or(""), &args["peaks"])?; Ok(Value::Null) }
            },
            "playlist:paths" => {
                let file = PathBuf::from(args["path"].as_str().ok_or("재생목록 파일이 필요합니다.")?);
                let text = std::fs::read_to_string(&file).map_err(|_|"재생목록을 읽을 수 없습니다.")?;
                let paths = library::parse_m3u(&text, &file);
                let mut state = self.state.lock().map_err(|_|"보관함 잠금 오류")?;
                let mut result = library::import_paths(&self.directory, &mut state, &paths, &mut |current,total,name|emit("import:progress",json!({"current":current,"total":total,"name":name})))?;
                let playlist = json!({"id":uuid::Uuid::new_v4().to_string(),"name":file.file_stem().and_then(|n|n.to_str()).unwrap_or("재생목록"),"trackIds":result["trackIds"]});
                state["playlists"].as_array_mut().ok_or("재생목록 정보가 올바르지 않습니다.")?.push(playlist);
                library::write_state(&self.directory, &state)?;
                result["state"] = state.clone(); Ok(result)
            },
            "playlist:export" => {
                let state = self.state.lock().map_err(|_|"보관함 잠금 오류")?;
                let id = args["id"].as_str().ok_or("재생목록 ID가 필요합니다.")?;
                let playlist = state["playlists"].as_array().and_then(|a|a.iter().find(|p|p["id"]==id)).ok_or("재생목록이 없습니다.")?;
                let mut lines = vec!["#EXTM3U".to_string()];
                for id in playlist["trackIds"].as_array().into_iter().flatten() {
                    if let Some(track) = state["tracks"].as_array().and_then(|a|a.iter().find(|t|&t["id"]==id)) {
                        lines.push(format!("#EXTINF:{},{}",track["duration"].as_f64().unwrap_or(0.).round(),track["displayName"].as_str().or_else(||track["title"].as_str()).unwrap_or("")));
                        lines.push(track["path"].as_str().unwrap_or("").to_string());
                    }
                }
                std::fs::write(args["path"].as_str().ok_or("저장 위치가 필요합니다.")?, lines.join("\n")).map_err(|_|"재생목록을 저장하지 못했습니다.")?;
                Ok(json!(true))
            },
            "update:get" => Ok(self.updater.lock().map_err(|_|"업데이트 잠금 오류")?.get()),
            "update:check" => self.updater.lock().map_err(|_|"업데이트 잠금 오류")?.check(),
            "update:download" => self.updater.lock().map_err(|_|"업데이트 잠금 오류")?.download(&mut |v| emit("update:state",v)),
            "update:install" => { self.updater.lock().map_err(|_|"업데이트 잠금 오류")?.prepare_install()?; Ok(json!(true)) },
            _ => Err("지원하지 않는 요청입니다.".into()),
        }
    }

    pub fn track_path(&self, id: &str) -> Result<PathBuf,String> {
        let state = self.state.lock().map_err(|_|"보관함 잠금 오류")?;
        state["tracks"].as_array().and_then(|a|a.iter().find(|t|t["id"]==id)).and_then(|t|t["path"].as_str()).map(PathBuf::from).ok_or_else(||"음원을 찾을 수 없습니다.".into())
    }
}

fn strings(value:&Value) -> Result<Vec<String>,String> {
    value.as_array().ok_or_else(||"잘못된 목록입니다.".to_string())?.iter().map(|v|v.as_str().map(str::to_string).ok_or_else(||"잘못된 목록입니다.".to_string())).collect()
}

pub fn stdio_main() -> Result<(),String> {
    let helper = std::env::current_exe().map_err(|e|e.to_string())?.parent().unwrap().join("resources/mac-update.sh");
    let core = Core::new(data_directory(),helper)?;
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|e|e.to_string())?;
        let request:Value = match serde_json::from_str(&line) { Ok(v)=>v,Err(_)=>continue };
        let result = core.invoke(request["method"].as_str().unwrap_or(""), &request["args"], &mut |event,payload| { println!("{}",json!({"event":event,"payload":payload})); });
        println!("{}",match result {Ok(value)=>json!({"id":request["id"],"result":value}),Err(error)=>json!({"id":request["id"],"error":error})});
        io::stdout().flush().map_err(|e|e.to_string())?;
    }
    Ok(())
}
