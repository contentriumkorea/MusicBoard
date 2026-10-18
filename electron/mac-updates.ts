import { EventEmitter } from 'node:events';
import { access, chmod, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { isNewerVersion, readRelease } from './updates';
import type { NativeUpdater } from './updates';

const exec=promisify(execFile);
export interface MacRelease {version:string;url:string;size:number;sha256:string}
export interface MacInstall {bundlePath:string;stagedBundle:string;workspace:string;token:string;version:string;helperPath:string;pid:number}
interface Options {
  version:string;releasesUrl:string;bundlePath:string;cacheDir:string;helperPath?:string;
  fetch:(url:string,init?:RequestInit)=>Promise<Response>;quit?:()=>void;
  extract?:(zip:string,destination:string,version:string)=>Promise<string>;
  install?:(request:MacInstall)=>Promise<void>;
}
export function readMacRelease(value:unknown,releasesUrl:string):MacRelease {
  const {version}=readRelease(value,'darwin',releasesUrl);
  const release=value as {assets:{name:string;browser_download_url?:string;size?:number;digest?:string}[]};
  const preferred=`MusicBoard-${version}-mac-universal.zip`;
  const name=release.assets.some(a=>a.name===preferred)?preferred:`SONO-${version}-mac-universal.zip`;
  const asset=release.assets.find(a=>a.name===name);
  const url=`${releasesUrl}/download/v${version}/${name}`;
  if(!asset||asset.browser_download_url!==url||!Number.isSafeInteger(asset.size)||asset.size!<=0||asset.size!>2*1024**3||!/^sha256:[a-f\d]{64}$/i.test(asset.digest??''))
    throw new Error('검증 가능한 Mac 업데이트 파일이 없습니다.');
  return {version,url,size:asset.size!,sha256:asset.digest!.slice(7).toLowerCase()};
}
export async function extractMacBundle(zip:string,destination:string,version:string):Promise<string>{
  const listing=await exec('/usr/bin/unzip',['-Z1',zip],{maxBuffer:8*1024**2});
  const roots=new Set<string>();
  for(const entry of listing.stdout.split('\n').filter(Boolean)){
    if(!/^((MusicBoard|SONO)\.app\/|__MACOSX\/)/.test(entry)||entry.includes('\\')||entry.split('/').includes('..'))throw new Error('잘못된 앱 압축 파일입니다.');
    if(!entry.startsWith('__MACOSX/'))roots.add(entry.split('/')[0]);
  }
  if(roots.size!==1)throw new Error('잘못된 앱 압축 파일입니다.');
  await mkdir(destination,{recursive:true});await exec('/usr/bin/ditto',['-x','-k',zip,destination]);
  const bundle=path.join(destination,[...roots][0]),plist=path.join(bundle,'Contents','Info.plist');
  const field=async(key:string)=>(await exec('/usr/bin/plutil',['-extract',key,'raw','-o','-',plist])).stdout.trim();
  if(await field('CFBundleIdentifier')!=='local.luma.music'||await field('CFBundleShortVersionString')!==version||await field('CFBundleExecutable')!=='SONO')throw new Error('PulseDeck 업데이트 앱을 확인하지 못했습니다.');
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);return bundle;
}
export async function prepareMacInstall(request:MacInstall):Promise<void>{
  const {workspace,token,version,helperPath,pid,stagedBundle}=request;
  const target=await realpath(request.bundlePath);
  if(!target.endsWith('.app')||target.includes('/AppTranslocation/')||target.startsWith('/Volumes/'))throw new Error('PulseDeck을 응용프로그램 폴더로 옮긴 뒤 업데이트해주세요.');
  try{await access(path.dirname(target),constants.W_OK);await access(target,constants.W_OK);}
  catch{throw new Error('앱 폴더에 쓰기 권한이 없습니다. 사용자 응용프로그램 폴더로 PulseDeck을 옮겨주세요.');}
  const candidate=`${target}.sono-update-${token}.app`,helper=path.join(workspace,'install.sh'),health=path.join(workspace,'health');
  let created=false,started=false;
  try{
    await mkdir(candidate);created=true;await exec('/usr/bin/ditto',[stagedBundle,candidate]);
    await exec('/usr/bin/codesign',['--verify','--deep','--strict',candidate]);
    await writeFile(helper,await readFile(helperPath),{mode:0o600});await chmod(helper,0o600);
    const log=await open(path.join(workspace,'install.log'),'a',0o600);
    try{
      const child=spawn('/bin/sh',[helper,String(pid),target,candidate,workspace,token,version,health,'300'],{detached:true,stdio:['ignore',log.fd,log.fd]});
      await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>resolve());});started=true;child.unref();
    }finally{await log.close();}
  }finally{if(created&&!started)await rm(candidate,{recursive:true,force:true});}
}
export class MacUpdater extends EventEmitter implements NativeUpdater {
  autoDownload=false;autoInstallOnAppQuit=false;allowPrerelease=false;allowDowngrade=false;
  private release:MacRelease|null=null;private staged:MacInstall|null=null;
  constructor(private options:Options){super();}
  async checkForUpdates(){
    this.release=null;const api=this.options.releasesUrl.replace('https://github.com/','https://api.github.com/repos/');
    const response=await this.options.fetch(`${api}/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'MusicBoard'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('새 버전을 확인하지 못했습니다.');
    const release=readMacRelease(await response.json(),this.options.releasesUrl);
    if(isNewerVersion(release.version,this.options.version)){this.release=release;this.emit('update-available',{version:release.version});}else this.emit('update-not-available');
  }
  async downloadUpdate(){
    if(!this.release)throw new Error('먼저 새 버전을 확인해주세요.');
    const release=this.release,token=randomUUID(),workspace=path.join(this.options.cacheDir,token);
    await mkdir(this.options.cacheDir,{recursive:true});await mkdir(workspace,{mode:0o700});const zip=path.join(workspace,'update.zip');
    try{
      const response=await this.options.fetch(release.url,{signal:AbortSignal.timeout(10*60*1000)});
      if(!response.ok||!response.body)throw new Error('업데이트를 내려받지 못했습니다.');
      const file=await open(zip,'wx',0o600),reader=response.body.getReader(),hash=createHash('sha256');let received=0;
      try{
        for(;;){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;if(received>release.size)throw new Error('업데이트 파일 크기가 다릅니다.');hash.update(value);await file.writeFile(value);this.emit('download-progress',{percent:received/release.size*100});}
        if(received!==release.size||hash.digest('hex')!==release.sha256)throw new Error('업데이트 파일 검증에 실패했습니다.');
      }finally{await reader.cancel().catch(()=>{});await file.close();}
      const stagedBundle=await (this.options.extract??extractMacBundle)(zip,path.join(workspace,'unpacked'),release.version);
      this.staged={bundlePath:this.options.bundlePath,stagedBundle,workspace,token,version:release.version,helperPath:this.options.helperPath??'',pid:process.pid};this.emit('update-downloaded',{version:release.version});
    }catch(error){await rm(workspace,{recursive:true,force:true});throw error;}
  }
  async quitAndInstall(_silent:boolean,_relaunch:boolean){
    if(!this.staged)throw new Error('다운로드한 업데이트가 없습니다.');await (this.options.install??prepareMacInstall)(this.staged);this.options.quit?.();
  }
}
