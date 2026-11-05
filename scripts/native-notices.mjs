// Collect exact resolved Rust dependency notices before bundling the native app.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const exec=promisify(execFile);
const {stdout}=await exec('cargo',['metadata','--locked','--format-version','1','--manifest-path','src-tauri/Cargo.toml'],{maxBuffer:32*1024*1024});
const metadata=JSON.parse(stdout),destination=path.resolve('resources/licenses/native-dependencies');
await mkdir(destination,{recursive:true});
const index=['# Native dependency notices','', 'Generated from the checked-in Cargo.lock. Each dependency keeps its own license. These notices do not license the application itself.',''];
let copied=0;
for(const pkg of metadata.packages.filter(p=>p.source).sort((a,b)=>`${a.name}-${a.version}`.localeCompare(`${b.name}-${b.version}`))){
  const source=path.dirname(pkg.manifest_path),key=`${pkg.name}-${pkg.version}`,files=[];
  const collect=async(folder,depth=0)=>{
    for(const entry of await readdir(folder,{withFileTypes:true})){
      if(entry.isFile()&&(depth===1||/^(licen[cs]e|copying|notice|authors)(?:[._-].*)?$/i.test(entry.name)))files.push(path.join(folder,entry.name));
      else if(entry.isDirectory()&&depth===0&&/^licen[cs]es?$/i.test(entry.name))await collect(path.join(folder,entry.name),1);
    }
  };
  await collect(source);
  if(pkg.license_file){const file=path.resolve(source,pkg.license_file);if(!files.includes(file))files.push(file);}
  index.push(`## ${key}`,`License: ${pkg.license||'See included license files'}`,`Source: https://crates.io/crates/${pkg.name}/${pkg.version}`, '');
  for(const file of files){
    const relative=path.relative(source,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('License file escaped crate');
    const out=path.join(destination,key,relative);await mkdir(path.dirname(out),{recursive:true});await writeFile(out,await readFile(file));copied++;
    index.push(`- ${key}/${relative.replaceAll('\\','/')}`);
  }
  index.push('');
}
await writeFile(path.join(destination,'INDEX.md'),index.join('\n'));
console.log(`Native dependency notices: ${metadata.packages.filter(p=>p.source).length} packages, ${copied} original license/notice files`);
