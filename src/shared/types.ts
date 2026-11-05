export interface Track {
  id: string; path: string; title: string; artist: string; album: string;
  duration: number; format: string; addedAt: number; favorite: boolean;
  artwork?: string; trackNumber?: number; sampleRate?: number; bitrate?: number;
  folderRoot?: string;
  folderId?: string; displayName?: string;
  trim?: { start:number; end:number };
}
export interface LibraryFolder { id: string; name: string }
export interface Playlist { id: string; name: string; trackIds: string[] }
export type Repeat = 'off' | 'all' | 'one' | 'stop';
export type LibrarySort = 'manual' | 'added' | 'title' | 'artist';
export interface Settings { volume: number; eqEnabled: boolean; eq: number[]; preamp: number; eqPreset: string; librarySort?: LibrarySort; fadeIn?: number; fadeOut?: number }
export interface PlaybackState { currentId: string | null; anchorId: string | null; position: number; queue: string[]; order: string[]; repeat: Repeat; shuffle: boolean }
export interface AppState { version: 1; tracks: Track[]; folders?: LibraryFolder[]; playlists: Playlist[]; settings: Settings; playback: PlaybackState }
export interface Progress { current: number; total: number; name: string }
export interface ImportResult { state: AppState; added: number; errors: string[]; cancelled?: boolean; folderRoots?: string[]; trackIds?:string[] }
export interface WaveformInfo {key:string;size:number;peaks:number[]|null}
export interface LiveState { track: Track | null; playing: boolean; position: number; duration: number; volume: number }
export type PlayerCommand = 'toggle' | 'next' | 'previous';
export interface UpdateState {
  version:string;status:'idle'|'checking'|'available'|'current'|'downloading'|'downloaded'|'installing'|'error';
  mode:'automatic'|'manual';releasesUrl:string;message:string;latestVersion?:string;percent?:number;
}
export interface Bridge {
  mediaUrl?(kind:'audio'|'art',id:string):string;
  getWaveform(id:string):Promise<WaveformInfo>;
  saveWaveform(id:string,key:string,peaks:number[]):Promise<void>;
  getUpdateState():Promise<UpdateState>;
  checkForUpdates():Promise<UpdateState>;
  downloadUpdate():Promise<UpdateState>;
  installUpdate():Promise<UpdateState>;
  onUpdate(callback:(state:UpdateState)=>void):()=>void;
  getState(): Promise<{ state: AppState; warning?: string }>;
  importMusic(mode: 'files' | 'folder'): Promise<ImportResult>;
  importDroppedFiles(files: File[]): Promise<ImportResult>;
  saveState(state: AppState): Promise<void>;
  removeMusic(ids: string[]): Promise<AppState>;
  importPlaylist(): Promise<ImportResult>;
  exportPlaylist(id: string): Promise<boolean>;
  showMini(): Promise<void>;
  closeMini(): Promise<void>;
  publishLive(state: LiveState): void;
  playerCommand(command: PlayerCommand): void;
  onLive(callback: (state: LiveState) => void): () => void;
  onCommand(callback: (command: PlayerCommand) => void): () => void;
  onProgress(callback: (progress: Progress) => void): () => void;
  onFlush(callback: () => void): () => void;
  flushDone(): void;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
  platform: string;
}
declare global { interface Window { luma: Bridge } }
