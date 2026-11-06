#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use musicboard_native::{Core,data_directory};
use serde_json::{json,Value};
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},time::Duration};
use tauri::{Emitter,Manager,WebviewWindow,WebviewWindowBuilder,WebviewUrl,WindowEvent};

struct Desktop {
    core:Arc<Core>,
    live:Mutex<Value>,
    closing:AtomicBool,
    quitting:AtomicBool,
    ready_token:Option<String>,
    qa_mode:bool,
    qa_started:AtomicBool,
    close_generation:AtomicU64,
}

fn request_quit(app:&tauri::AppHandle){
    let desktop=app.state::<Desktop>();
    if desktop.quitting.swap(true,Ordering::SeqCst){return;}
    let _=app.emit_to("main","state:flush",());
    let handle=app.clone();
    std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(3));handle.exit(0);});
}

#[tauri::command]
async fn native(method:String,args:Value,window:WebviewWindow,desktop:tauri::State<'_,Desktop>)->Result<Value,String>{
    let app=window.app_handle().clone();
    let is_main=window.label()=="main";
    match method.as_str(){
        "window:drag"=>{window.start_dragging().map_err(|e|e.to_string())?;return Ok(Value::Null);},
        "window:action"=>{
            match args["action"].as_str().unwrap_or(""){
                "minimize"=>window.minimize(),"maximize"=>if window.is_maximized().unwrap_or(false){window.unmaximize()}else{window.maximize()},"close"=>window.close(),_=>return Err("알 수 없는 창 동작입니다.".into()),
            }.map_err(|e|e.to_string())?;return Ok(Value::Null);
        },
        "frontend:ready"=>{
            window.show().map_err(|e|e.to_string())?;
            if is_main{if let Some(token)=&desktop.ready_token{let file=desktop.core.directory.join("mac-updates").join(token).join("health");let _=std::fs::write(file,env!("CARGO_PKG_VERSION"));}}
            if is_main&&desktop.qa_mode&&!desktop.qa_started.swap(true,Ordering::SeqCst){let _=window.eval(include_str!("../../scripts/native-self-test.js"));}
            return Ok(Value::Null);
        },
        "qa:report"=>{
            if !is_main||!desktop.qa_mode{return Err("지원하지 않는 요청입니다.".into());}
            let bytes=serde_json::to_vec(&args).map_err(|e|e.to_string())?;
            std::fs::write(desktop.core.directory.join("native-result.json"),bytes).map_err(|e|e.to_string())?;
            return Ok(Value::Null);
        },
        "lifecycle:flushed"=>{
            if is_main&&desktop.quitting.load(Ordering::SeqCst){app.exit(0);}
            else if is_main&&desktop.closing.load(Ordering::SeqCst){
                #[cfg(target_os="macos")] { let _=window.destroy();if let Some(mini)=app.get_webview_window("mini"){let _=mini.destroy();} }
                #[cfg(not(target_os="macos"))] {desktop.quitting.store(true,Ordering::SeqCst);app.exit(0);}
            }
            return Ok(Value::Null);
        },
        "mini:close"=>{if let Some(mini)=app.get_webview_window("mini"){let _=mini.close();}return Ok(Value::Null);},
        "player:request"=>{let value=desktop.live.lock().map_err(|_|"재생 상태 잠금 오류")?.clone();let _=window.emit("player:live",value);return Ok(Value::Null);},
        "player:command"=>{
            if !["toggle","previous","next"].contains(&args["command"].as_str().unwrap_or("")){return Err("지원하지 않는 재생 동작입니다.".into());}
            let _=app.emit_to("main","player:command",&args["command"]);return Ok(Value::Null);
        },
        _=>{}
    }
    if !is_main&&method!="shell:info"{return Err("메인 창에서 실행해주세요.".into());}
    if method=="player:live"{
        *desktop.live.lock().map_err(|_|"재생 상태 잠금 오류")?=args["state"].clone();let _=app.emit_to("mini","player:live",&args["state"]);return Ok(Value::Null);
    }
    if method=="mini:show"{
        if let Some(mini)=app.get_webview_window("mini"){let _=mini.show();return Ok(Value::Null);}
        WebviewWindowBuilder::new(&app,"mini",WebviewUrl::App("index.html?mini=1".into())).title("MusicBoard").inner_size(440.,150.).resizable(false).decorations(false).always_on_top(true).visible(false).build().map_err(|e|e.to_string())?;
        return Ok(Value::Null);
    }
    let core=desktop.core.clone();
    let action=method.clone();let progress_app=app.clone();
    let result=tauri::async_runtime::spawn_blocking(move||{
        let mut action=action;let mut payload=args;
        if action=="music:import"{
            let dialog=rfd::FileDialog::new().set_title("음악 가져오기");
            let paths=if payload["mode"]=="folder"{dialog.pick_folder().map(|p|vec![p])}else{dialog.add_filter("음악 파일",&["mp3","wav","flac","m4a","aac","ogg","opus","aif","aiff"]).pick_files()};
            let Some(paths)=paths else{return Ok(json!({"state":core.state.lock().map_err(|_|"보관함 잠금 오류")?.clone(),"added":0,"errors":[],"cancelled":true}));};
            payload=json!({"paths":paths});action="music:paths".into();
        }else if action=="playlist:import"{
            let Some(path)=rfd::FileDialog::new().set_title("재생목록 가져오기").add_filter("M3U 재생목록",&["m3u","m3u8"]).pick_file()else{return Ok(json!({"state":core.state.lock().map_err(|_|"보관함 잠금 오류")?.clone(),"added":0,"errors":[],"cancelled":true}));};
            payload=json!({"path":path});action="playlist:paths".into();
        }else if action=="playlist:export"{
            let Some(path)=rfd::FileDialog::new().set_title("재생목록 내보내기").set_file_name("재생목록.m3u8").add_filter("M3U 재생목록",&["m3u8"]).save_file()else{return Ok(json!(false));};
            payload["path"]=json!(path);
        }
        core.invoke(&action,&payload,&mut |event,value|{let _=progress_app.emit_to("main",event,value);})
    }).await.map_err(|e|e.to_string())?;
    if method.starts_with("update:"){
        if let Ok(state)=desktop.core.invoke("update:get",&Value::Null,&mut |_,_|{}){let _=app.emit_to("main","update:state",state);}
        if method=="update:install"&&result.is_ok(){desktop.quitting.store(true,Ordering::SeqCst);app.exit(0);}
    }
    result
}

fn main(){
    if std::env::args().any(|arg|arg=="--core-stdio"){
        if let Err(error)=musicboard_native::stdio_main(){eprintln!("{error}");std::process::exit(1);}return;
    }
    let token=std::env::args().find_map(|arg|arg.strip_prefix("--sono-update-token=").map(str::to_owned)).filter(|v|uuid::Uuid::parse_str(v).is_ok());
    let app=tauri::Builder::default()
        .setup(move|app|{
            let helper=app.path().resource_dir()?.join("resources/mac-update.sh");
            let directory=data_directory();
            let qa_mode=std::env::var("LUMA_NATIVE_QA").ok().as_deref()==Some("1")&&directory.canonicalize().ok().zip(std::env::temp_dir().canonicalize().ok()).and_then(|(dir,temp)|dir.strip_prefix(temp).ok().and_then(|p|p.components().next().map(|c|c.as_os_str().to_string_lossy().starts_with("musicboard-native-")))).unwrap_or(false);
            let core=Core::new(directory,helper).map_err(std::io::Error::other)?;
            app.manage(Desktop{core,live:Mutex::new(json!({"track":null,"playing":false,"position":0,"duration":0,"volume":0.7})),closing:AtomicBool::new(false),quitting:AtomicBool::new(false),ready_token:token,qa_mode,qa_started:AtomicBool::new(false),close_generation:AtomicU64::new(0)});
            Ok(())
        })
        .on_window_event(|window,event|{
            if window.label()=="main"{if let WindowEvent::CloseRequested{api,..}=event{
                api.prevent_close();let app=window.app_handle();let desktop=app.state::<Desktop>();
                if !desktop.closing.swap(true,Ordering::SeqCst){
                    let _=window.emit("state:flush",());let handle=app.clone();let generation=desktop.close_generation.fetch_add(1,Ordering::SeqCst)+1;
                    std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(3));let desktop=handle.state::<Desktop>();if !desktop.closing.load(Ordering::SeqCst)||desktop.close_generation.load(Ordering::SeqCst)!=generation{return;}
                        #[cfg(target_os="macos")] {if let Some(main)=handle.get_webview_window("main"){let _=main.destroy();}if let Some(mini)=handle.get_webview_window("mini"){let _=mini.destroy();}}
                        #[cfg(not(target_os="macos"))] {handle.state::<Desktop>().quitting.store(true,Ordering::SeqCst);handle.exit(0);}
                    });
                }
            }}
        })
        .on_webview_event(|webview,event|{
            if let tauri::WebviewEvent::DragDrop(event)=event{
                let payload=match event{
                    tauri::DragDropEvent::Enter{paths,position,..}=>json!({"type":"enter","paths":paths,"position":{"x":position.x,"y":position.y}}),
                    tauri::DragDropEvent::Over{position,..}=>json!({"type":"over","position":{"x":position.x,"y":position.y}}),
                    tauri::DragDropEvent::Drop{paths,position,..}=>json!({"type":"drop","paths":paths,"position":{"x":position.x,"y":position.y}}),
                    _=>json!({"type":"leave"}),
                };let _=webview.emit("native:drop",payload);
            }
        })
        .invoke_handler(tauri::generate_handler![native])
        .build(tauri::generate_context!()).expect("MusicBoard를 시작하지 못했습니다.");
    app.run(|app,event|{
        if let tauri::RunEvent::ExitRequested{api,..}=&event{
            if !app.state::<Desktop>().quitting.load(Ordering::SeqCst){api.prevent_exit();request_quit(app);}
        }
        #[cfg(target_os="macos")]
        if let tauri::RunEvent::Reopen{..}=event{
            if app.get_webview_window("main").is_none(){
                app.state::<Desktop>().closing.store(false,Ordering::SeqCst);
                app.state::<Desktop>().close_generation.fetch_add(1,Ordering::SeqCst);
                if let Some(config)=app.config().app.windows.iter().find(|w|w.label=="main"){if let Ok(builder)=WebviewWindowBuilder::from_config(app,config){let _=builder.build();}}
            }
        }
    });
}
