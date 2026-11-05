// Collect exact resolved Rust dependency notices before bundling the native app.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const exec=promisify(execFile);
const {stdout}=await exec('cargo',['metadata','--locked','--format-version','1','--manifest-path','src-tauri/Cargo.toml'],{maxBuffer:32*1024*1024});
const metadata=JSON.parse(stdout),destination=path.resolve('resources/licenses/native-dependencies');
await mkdir(destination,{recursive:true});
const index=['# Application dependency notices','', 'Generated from the checked-in Cargo.lock and installed frontend dependencies. Each dependency keeps its own license. These notices do not license the application itself.',''];
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
const require=createRequire(import.meta.url);
const frontend=['react','react-dom','lucide-react','mediabunny'].map(name=>path.resolve('node_modules',name,'package.json'));
frontend.push(createRequire(require.resolve('react-dom/package.json')).resolve('scheduler/package.json'));
for(const manifest of frontend){
  const pkg=JSON.parse(await readFile(manifest,'utf8')),source=path.dirname(manifest),key=`frontend-${pkg.name}-${pkg.version}`;
  index.push(`## ${pkg.name} ${pkg.version}`,`License: ${pkg.license}`,`Source: https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,'');
  const files=(await readdir(source)).filter(name=>/^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));
  if(!files.length)throw Error(`Frontend dependency license is absent: ${pkg.name}`);
  await mkdir(path.join(destination,key),{recursive:true});
  for(const file of files){await writeFile(path.join(destination,key,file),await readFile(path.join(source,file)));index.push(`- ${key}/${file}`);copied++;}
  index.push('');
}
await writeFile(path.join(destination,'INDEX.md'),index.join('\n'));
console.log(`Native dependency notices: ${metadata.packages.filter(p=>p.source).length} packages, ${copied} original license/notice files`);
