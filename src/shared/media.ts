/** Electron keeps its registered protocol; Rust supplies a per-launch loopback URL. */
export function audioUrl(id:string):string {
  return typeof window!=='undefined'&&window.luma?.mediaUrl
    ?window.luma.mediaUrl('audio',id):`luma://audio/${id}`;
}
