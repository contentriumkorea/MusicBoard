//! Streaming audio analysis. Memory usage depends on a decoder packet, never song length.
use serde_json::{json, Value};
use sha2::{Digest,Sha256};
use std::{fs::{self,File}, io::{ErrorKind,Read,Seek}, path::Path, time::UNIX_EPOCH};
use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};

pub const WAVEFORM_POINTS: usize = 960;

fn valid(peaks: &Value) -> bool {
    peaks.as_array().is_some_and(|values|values.len()==WAVEFORM_POINTS && values.iter().all(|v|v.as_f64().is_some_and(|n|n.is_finite() && (0.0..=1.0).contains(&n))))
}

fn fingerprint(file: &Path) -> Result<(String,u64),String> {
    let path=crate::library::real_path(file)?;
    let info=fs::metadata(&path).map_err(|e|e.to_string())?;
    if !info.is_file() {return Err("음원을 읽을 수 없습니다.".into());}
    let modified=info.modified().map_err(|e|e.to_string())?.duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let created=info.created().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_nanos());
    let text=format!("wave-rust-v1:{}:{}:{modified}:{created:?}",path.to_string_lossy(),info.len());
    Ok((hex::encode(Sha256::digest(text.as_bytes())),info.len()))
}

pub fn get_waveform(file: &Path, cache: &Path) -> Result<Value,String> {
    let (key,size)=fingerprint(file)?;
    let cached=fs::read(cache.join(format!("{key}.json"))).ok().and_then(|data|serde_json::from_slice::<Value>(&data).ok()).filter(valid);
    let peaks=if let Some(peaks)=cached {peaks} else {
        // Unsupported codecs or malformed media use the existing WebAudio fallback.
        match analyse(file) {
            Ok(peaks)=> {
                let peaks=json!(peaks);
                if fingerprint(file)?.0!=key {return Err("음원 파일이 변경되었습니다.".into());}
                // A read-only/full cache directory must not hide successful analysis.
                let _=save_waveform(file,cache,&key,&peaks);
                peaks
            }
            Err(_)=>Value::Null,
        }
    };
    if fingerprint(file)?.0!=key {return Err("음원 파일이 변경되었습니다.".into());}
    Ok(json!({"key":key,"size":size,"peaks":peaks}))
}

pub fn save_waveform(file: &Path, cache: &Path, key: &str, peaks: &Value) -> Result<(),String> {
    if key.len()!=64 || !key.bytes().all(|b|b.is_ascii_hexdigit()) || !valid(peaks) || fingerprint(file)?.0!=key {
        return Err("음원 파형이 변경되었거나 올바르지 않습니다.".into());
    }
    fs::create_dir_all(cache).map_err(|e|e.to_string())?;
    crate::library::atomic_bytes(&cache.join(format!("{key}.json")),&serde_json::to_vec(peaks).map_err(|e|e.to_string())?)
}

type SampleSink<'a> = dyn FnMut(f64,u32,usize,&[f32]) + 'a;

/// Decode from content with no extension hint. The first pass measures the exact
/// decoded timeline; the second fills fixed-size bins using packet timestamps.
/// This also handles VBR files with missing or inaccurate duration metadata.
fn decode(file: &Path, mut sink: Option<&mut SampleSink<'_>>) -> Result<f64,String> {
    let mut input=File::open(file).map_err(|e|e.to_string())?;
    let size=input.metadata().map_err(|e|e.to_string())?.len();
    let mut header=[0_u8;12]; input.read_exact(&mut header).map_err(|e|e.to_string())?;
    // Symphonia represents both normal EOF and truncated PCM as UnexpectedEof.
    // Check the container's declared extent so truncation cannot become a valid
    // but shortened waveform with misleading timeline positions.
    let declared=if &header[..4]==b"RIFF" && &header[8..]==b"WAVE" {Some(u32::from_le_bytes(header[4..8].try_into().unwrap()))}
        else if &header[..4]==b"FORM" {Some(u32::from_be_bytes(header[4..8].try_into().unwrap()))} else {None};
    if declared.is_some_and(|length|u64::from(length)+8>size) {return Err("오디오 데이터가 잘렸습니다.".into());}
    input.rewind().map_err(|e|e.to_string())?;
    let source=MediaSourceStream::new(Box::new(input),Default::default());
    let options=FormatOptions {enable_gapless:true,..Default::default()};
    let mut format=symphonia::default::get_probe().format(&Hint::new(),source,&options,&MetadataOptions::default()).map_err(|e|e.to_string())?.format;
    let (track_id,params,mut decoder)=format.tracks().iter().find_map(|track| {
        symphonia::default::get_codecs().make(&track.codec_params,&DecoderOptions {verify:true,..Default::default()}).ok().map(|decoder|(track.id,track.codec_params.clone(),decoder))
    }).ok_or_else(||"지원하지 않는 오디오 코덱입니다.".to_owned())?;
    let seconds=|ts:u64|params.time_base.map(|tb|{let t=tb.calc_time(ts); t.seconds as f64+t.frac});
    let origin=seconds(params.start_ts).unwrap_or(0.0);
    let mut end=0.0_f64;
    let mut decoded_any=false;
    loop {
        let packet=match format.next_packet() {
            Ok(packet)=>packet,
            Err(Error::IoError(e)) if e.kind()==ErrorKind::UnexpectedEof=>break,
            Err(error)=>return Err(error.to_string()),
        };
        if packet.track_id()!=track_id {continue;}
        let decoded=decoder.decode(&packet).map_err(|e|e.to_string())?;
        let spec=*decoded.spec(); let channels=spec.channels.count(); let frames=decoded.frames();
        if spec.rate==0 || channels==0 {return Err("올바르지 않은 오디오 형식입니다.".into());}
        if frames==0 {continue;}
        // Most decoders already trim gapless packets. Some codecs return the full
        // packet; only trim those when the timestamp duration proves it is needed.
        let expected=seconds(packet.dur()).map(|duration|(duration*spec.rate as f64).round().max(0.0) as usize);
        let requested_trim=packet.trim_start() as usize+packet.trim_end() as usize;
        let apply_trim=requested_trim>0 && expected.is_some_and(|n|frames.saturating_sub(n).abs_diff(requested_trim)<=1);
        let first=if apply_trim {(packet.trim_start() as usize).min(frames)} else {0};
        let last=if apply_trim {frames.saturating_sub(packet.trim_end() as usize).max(first)} else {frames};
        let count=last-first;
        let start=seconds(packet.ts()).map(|time|(time-origin).max(0.0)).unwrap_or(end);
        let packet_end=start+count as f64/spec.rate as f64;
        if let Some(callback)=sink.as_deref_mut() {
            let mut samples=SampleBuffer::<f32>::new(decoded.capacity() as u64,spec);
            samples.copy_interleaved_ref(decoded);
            callback(start,spec.rate,channels,&samples.samples()[first*channels..last*channels]);
        }
        end=end.max(packet_end); decoded_any=true;
    }
    if !decoded_any || !end.is_finite() || end<=0.0 {return Err("오디오 데이터를 읽을 수 없습니다.".into());}
    if decoder.finalize().verify_ok==Some(false) {return Err("오디오 데이터가 손상되었습니다.".into());}
    Ok(end)
}

fn analyse(file: &Path) -> Result<Vec<f64>,String> {
    let duration=decode(file,None)?;
    let mut peaks=vec![0.0_f64;WAVEFORM_POINTS];
    let mut collect=|start:f64, rate:u32, channels:usize, samples:&[f32]| {
        for (frame,values) in samples.chunks_exact(channels).enumerate() {
            let time=start+frame as f64/rate as f64;
            // Keep an exact sample on a bucket boundary from rounding into the
            // previous bucket after timestamp-to-seconds conversion.
            let bucket=((time/duration*WAVEFORM_POINTS as f64+1e-7).floor() as usize).min(WAVEFORM_POINTS-1);
            for sample in values { if sample.is_finite() {peaks[bucket]=peaks[bucket].max(f64::from(sample.abs()).min(1.0));} }
        }
    };
    let second_duration=decode(file,Some(&mut collect))?;
    if (duration-second_duration).abs()>0.001 {return Err("음원 파일이 변경되었습니다.".into());}
    Ok(peaks)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    /// Small synthetic fixtures only; never inspect the user's audio library.
    pub(crate) fn write_wav(file: &Path, frames: &[[i16;2]]) {
        let length=(frames.len()*4) as u32; let mut bytes=Vec::new();
        bytes.extend_from_slice(b"RIFF"); bytes.extend_from_slice(&(36+length).to_le_bytes()); bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes()); bytes.extend_from_slice(&1_u16.to_le_bytes()); bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&9600_u32.to_le_bytes()); bytes.extend_from_slice(&38400_u32.to_le_bytes()); bytes.extend_from_slice(&4_u16.to_le_bytes()); bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data"); bytes.extend_from_slice(&length.to_le_bytes());
        for frame in frames {for sample in frame {bytes.extend_from_slice(&sample.to_le_bytes());}}
        fs::write(file,bytes).unwrap();
    }
    fn write_aiff(file: &Path, frames: &[[i16;2]]) {
        let length=(frames.len()*4) as u32; let mut bytes=Vec::new();
        bytes.extend_from_slice(b"FORM"); bytes.extend_from_slice(&(46+length).to_be_bytes()); bytes.extend_from_slice(b"AIFFCOMM");
        bytes.extend_from_slice(&18_u32.to_be_bytes()); bytes.extend_from_slice(&2_u16.to_be_bytes()); bytes.extend_from_slice(&(frames.len() as u32).to_be_bytes()); bytes.extend_from_slice(&16_u16.to_be_bytes());
        // 9600 Hz as an IEEE 80-bit extended number.
        bytes.extend_from_slice(&[0x40,0x0c,0x96,0,0,0,0,0,0,0]);
        bytes.extend_from_slice(b"SSND"); bytes.extend_from_slice(&(8+length).to_be_bytes()); bytes.extend_from_slice(&[0;8]);
        for frame in frames {for sample in frame {bytes.extend_from_slice(&sample.to_be_bytes());}}
        fs::write(file,bytes).unwrap();
    }
    #[test]
    fn silence_loud_and_opposite_channels_preserve_amplitude() {
        let dir=tempfile::tempdir().unwrap(); let file=dir.path().join("audio.mp3"); // Deliberately incorrect extension.
        write_wav(&file,&[[0,0];9600]);
        let silence=analyse(&file).unwrap(); assert_eq!(silence,vec![0.0;WAVEFORM_POINTS]);
        write_wav(&file,&[[i16::MAX,i16::MIN];9600]);
        let loud=analyse(&file).unwrap(); assert!(loud.iter().all(|peak|*peak>0.99));
        let mut frames=vec![[0,0];9600]; frames[4800]=[0,i16::MIN]; write_wav(&file,&frames);
        let peak=analyse(&file).unwrap(); assert_eq!(peak.iter().filter(|p|**p>0.99).count(),1); assert!(peak[480]>0.99);
    }
    #[test]
    fn aiff_uses_content_and_places_the_last_channel_on_the_timeline() {
        let dir=tempfile::tempdir().unwrap(); let file=dir.path().join("aiff-disguised.mp3");
        let mut frames=vec![[0,0];9600]; frames[2400]=[0,i16::MIN]; write_aiff(&file,&frames);
        let peak=analyse(&file).unwrap(); assert!(peak[240]>0.99); assert_eq!(peak.iter().filter(|p|**p>0.99).count(),1);
    }
    #[test]
    fn invalid_audio_and_invalid_cache_use_null_fallback() {
        let dir=tempfile::tempdir().unwrap(); let file=dir.path().join("bad.wav"); fs::write(&file,b"not an audio stream").unwrap();
        let result=get_waveform(&file,&dir.path().join("cache")).unwrap(); assert!(result["peaks"].is_null());
        assert!(get_waveform(&dir.path().join("absent"),dir.path()).is_err());
        write_wav(&file,&[[i16::MAX,0];9600]);
        let input=std::fs::OpenOptions::new().write(true).open(&file).unwrap(); input.set_len(44+4800*4).unwrap(); drop(input);
        assert!(get_waveform(&file,&dir.path().join("cache")).unwrap()["peaks"].is_null());
    }
    #[test]
    fn cache_validation_and_file_change_reject_stale_keys() {
        let dir=tempfile::tempdir().unwrap(); let file=dir.path().join("audio.wav"); let cache=dir.path().join("cache"); write_wav(&file,&[[0,0];960]);
        let first=get_waveform(&file,&cache).unwrap(); let key=first["key"].as_str().unwrap();
        assert!(save_waveform(&file,&cache,key,&json!([0,1])).is_err());
        let mut invalid=vec![0.0;WAVEFORM_POINTS]; invalid[1]=2.0; assert!(save_waveform(&file,&cache,key,&json!(invalid)).is_err());
        fs::write(cache.join(format!("{key}.json")),b"[broken").unwrap(); assert!(get_waveform(&file,&cache).unwrap()["peaks"].is_array());
        write_wav(&file,&[[1,1];1920]); assert!(save_waveform(&file,&cache,key,&json!(vec![0.0;WAVEFORM_POINTS])).is_err());
        assert_ne!(get_waveform(&file,&cache).unwrap()["key"],first["key"]);
    }
    #[test]
    fn successful_analysis_survives_unwritable_cache() {
        let dir=tempfile::tempdir().unwrap(); let file=dir.path().join("audio.wav"); let cache=dir.path().join("cache-file");
        write_wav(&file,&[[i16::MAX,0];960]); fs::write(&cache,b"a file cannot contain cache entries").unwrap();
        let result=get_waveform(&file,&cache).unwrap(); assert!(result["peaks"].as_array().unwrap().iter().all(|p|p.as_f64().unwrap()>0.99));
    }
}
