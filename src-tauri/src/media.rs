use serde_json::Value;
use std::{fs::File,io::{Read,Seek,SeekFrom},path::PathBuf,sync::{Arc,Mutex}};
use tiny_http::{Header,Method,Response,Server,StatusCode};

pub fn byte_range(value:Option<&str>,size:u64)->Result<(u64,u64,bool),()> {
    if size==0{return if value.is_none(){Ok((0,0,false))}else{Err(())};}
    let Some(value)=value else{return Ok((0,size-1,false));};
    let range=value.strip_prefix("bytes=").ok_or(())?;
    if range.contains(','){return Err(());}
    let (a,b)=range.split_once('-').ok_or(())?;
    let (start,end)=if a.is_empty(){let n=b.parse::<u64>().map_err(|_|())?;if n==0{return Err(());} (size.saturating_sub(n),size-1)}
      else{let start=a.parse::<u64>().map_err(|_|())?;let end=if b.is_empty(){size-1}else{b.parse::<u64>().map_err(|_|())?.min(size-1)};(start,end)};
    if start>=size||start>end{return Err(());}Ok((start,end,true))
}

pub fn start(state:Arc<Mutex<Value>>,artwork:PathBuf)->Result<String,String>{
    let server=Server::http("127.0.0.1:0").map_err(|_|"미디어 서버를 시작하지 못했습니다.")?;
    let address=server.server_addr().to_ip().ok_or("미디어 서버 주소 오류")?;
    let token=uuid::Uuid::new_v4().simple().to_string();
    let base=format!("http://127.0.0.1:{}/{token}",address.port());
    std::thread::spawn(move||{
        for request in server.incoming_requests(){
            let state=state.clone();let artwork=artwork.clone();let token=token.clone();
            std::thread::spawn(move||serve(request,&state,&artwork,&token));
        }
    });
    Ok(base)
}

fn serve(request:tiny_http::Request,state:&Arc<Mutex<Value>>,artwork:&PathBuf,token:&str){
            let path=request.url().split('?').next().unwrap_or("");
            let prefix=format!("/{token}/");
            let file=path.strip_prefix(&prefix).and_then(|tail|{
                let (kind,id)=tail.split_once('/')?;
                if id.len()!=64||!id.bytes().all(|b|b.is_ascii_hexdigit()){return None;}
                match kind{
                    "audio"=>state.lock().ok()?.get("tracks")?.as_array()?.iter().find(|t|t["id"]==id)?.get("path")?.as_str().map(PathBuf::from),
                    "art"=>Some(artwork.join(id)),_=>None,
                }
            });
            let Some(file)=file else{let _=request.respond(Response::empty(StatusCode(404)));return;};
            if request.method()==&Method::Options{
                let mut response=Response::empty(StatusCode(204));
                for (key,value) in [("Access-Control-Allow-Origin","*"),("Access-Control-Allow-Headers","Range"),("Access-Control-Allow-Methods","GET, HEAD, OPTIONS")]{response.add_header(header(key,value));}
                let _=request.respond(response);return;
            }
            if request.method()!=&Method::Get&&request.method()!=&Method::Head{let _=request.respond(Response::empty(StatusCode(405)));return;}
            let Ok(mut input)=File::open(&file) else{let _=request.respond(Response::empty(StatusCode(404)));return;};
            let Ok(info)=input.metadata() else{let _=request.respond(Response::empty(StatusCode(404)));return;};
            if !info.is_file(){let _=request.respond(Response::empty(StatusCode(404)));return;}
            let size=info.len();let range=request.headers().iter().find(|h|h.field.equiv("Range")).map(|h|h.value.as_str());
            let Ok((start,end,partial))=byte_range(range,size) else{
                let mut response=Response::empty(StatusCode(416));response.add_header(header("Content-Range",&format!("bytes */{size}")));response.add_header(header("Access-Control-Allow-Origin","*"));let _=request.respond(response);return;
            };
            let mut signature=[0u8;12];let _=input.read(&mut signature);
            let mime=if &signature[4..8]==b"ftyp"{"audio/mp4"}else if signature.starts_with(b"RIFF")&&&signature[8..12]==b"WAVE"{"audio/wav"}else if signature.starts_with(b"FORM"){"audio/aiff"}else if signature.starts_with(b"fLaC"){"audio/flac"}else if signature.starts_with(b"OggS"){"audio/ogg"}else{match file.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(){"mp3"=>"audio/mpeg","wav"=>"audio/wav","flac"=>"audio/flac","m4a"=>"audio/mp4","aac"=>"audio/aac","ogg"|"opus"=>"audio/ogg","aif"|"aiff"=>"audio/aiff",_=>if signature.starts_with(b"\x89PNG"){"image/png"}else if signature.starts_with(b"\xff\xd8"){"image/jpeg"}else if &signature[8..12]==b"WEBP"{"image/webp"}else{"application/octet-stream"}}};
            if input.seek(SeekFrom::Start(start)).is_err(){let _=request.respond(Response::empty(StatusCode(500)));return;}
            let length=if size==0{0}else{end-start+1};
            let mut headers=vec![header("Content-Type",mime),header("Accept-Ranges","bytes"),header("Access-Control-Allow-Origin","*"),header("Access-Control-Expose-Headers","Content-Range, Content-Length, Accept-Ranges"),header("Cache-Control","private, no-store")];
            if partial{headers.push(header("Content-Range",&format!("bytes {start}-{end}/{size}")));}
            let status=StatusCode(if partial{206}else{200});
            if request.method()==&Method::Head{
                let response=Response::new(status,headers,std::io::empty(),Some(length as usize),None).with_chunked_threshold(usize::MAX);let _=request.respond(response);
            }else{
                let response=Response::new(status,headers,input.take(length),Some(length as usize),None).with_chunked_threshold(usize::MAX);let _=request.respond(response);
            }
}


fn header(name:&str,value:&str)->Header{Header::from_bytes(name.as_bytes(),value.as_bytes()).unwrap()}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn ranges(){assert_eq!(byte_range(Some("bytes=3-9"),8),Ok((3,7,true)));assert_eq!(byte_range(Some("bytes=-3"),8),Ok((5,7,true)));assert_eq!(byte_range(Some("bytes=7-"),8),Ok((7,7,true)));assert!(byte_range(Some("bytes=9-"),8).is_err());assert!(byte_range(Some("bytes=3-1"),8).is_err());assert!(byte_range(Some("bytes=1-2,4-5"),8).is_err());}
    #[test]fn streams_only_known_media_and_rejects_token_and_range_errors(){
        let dir=tempfile::tempdir().unwrap();let file=dir.path().join("a.mp3");std::fs::write(&file,b"RIFF0123WAVEabcdef").unwrap();let id="a".repeat(64);
        let state=Arc::new(Mutex::new(serde_json::json!({"tracks":[{"id":id,"path":file}]})));
        let base=start(state,dir.path().join("artwork")).unwrap();let client=reqwest::blocking::Client::new();
        let head=client.head(format!("{base}/audio/{id}")).send().unwrap();assert_eq!(head.headers()["content-length"],"18");assert_eq!(head.headers()["content-type"],"audio/wav");assert!(head.bytes().unwrap().is_empty());
        let response=client.get(format!("{base}/audio/{id}")).header("Range","bytes=12-14").send().unwrap();assert_eq!(response.status().as_u16(),206);assert_eq!(response.bytes().unwrap().as_ref(),b"abc");
        assert_eq!(client.get(format!("{base}/audio/{id}")).header("Range","bytes=999-").send().unwrap().status().as_u16(),416);
        assert_eq!(client.get(format!("{base}/audio/../a.wav")).send().unwrap().status().as_u16(),404);
        let bad=base.replace(base.rsplit('/').next().unwrap(),"wrong");assert_eq!(client.get(format!("{bad}/audio/{id}")).send().unwrap().status().as_u16(),404);
    }
}
