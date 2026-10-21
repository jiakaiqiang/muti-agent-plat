import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';

const label=process.argv.find(a=>a.startsWith('--run-label='))?.slice(12);
if(!label||!/^[a-z0-9][a-z0-9-]{0,45}$/.test(label))throw Error('A new --run-label is required');
const root=resolve('docs/quality/intent-codex-comparison-2026-10-20');
const out=resolve(root,`${label}-revision`);
const dist=resolve('apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js');
const source='apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts';
const scorer='tests/evaluation/run-intent-codex-current.mjs';
const v3='tests/evaluation/intent-holdout-v3-2026-10-20.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const expected={
 baseline:'88d1b375d3f1679e603e141581e032442511c8091a62072b3a152e4c7e6f13ca',
 previous:'5d3586dc10f1957c7ed2f3b876acc26e8d61aebd4e26ff8a27bfc21d959bcab2',
 current:'ae37404ea2212dfd525a61975f130b8d1aff45be1c74bbf2575ecb0cd691e4ab',
 source:'9025a2428fa8d486f735683454f7c466a8ae22eddd5bc18e2e36685fb43e2828',
 scorer:'ca37950a03d3d2aa8d190e69318e07b51ec2ae7525618bcd396d2aecf2afe1d5',
 v3:'801ec752ff30a9ce67012004d569017b529382cb9c2aa3574e3e1022b925c1cd'
};
const builds={
 baseline:await readFile(resolve(root,'baseline-semantic-router.js')),
 previous:await readFile(resolve(root,'r5-freeze/before-semantic-router.js')),
 current:await readFile(resolve(root,'r5-freeze/final-semantic-router.js'))
};
for(const [name,bytes]of Object.entries(builds))if(hash(bytes)!==expected[name])throw Error(`BUILD_HASH_MISMATCH:${name}`);
for(const [path,key]of [[source,'source'],[scorer,'scorer'],[v3,'v3'],[dist,'current']])if(hash(await readFile(path))!==expected[key])throw Error(`FROZEN_HASH_MISMATCH:${path}`);
const {holdoutCases,budgetCase}=await import('./intent-holdout-v3-2026-10-20.mjs');
if(holdoutCases.length!==12||budgetCase.id!=='B01')throw Error('V3_IMPORT_FAILED');

// Freeze all product source/dist and evaluation inputs without exposing configuration values.
const files=[scorer,v3,'tests/evaluation/intent-evaluation-cases-2026-10-19.mjs',
 'tests/evaluation/intent-supervisor-holdout-2026-10-20.mjs',
 'tests/evaluation/intent-evaluation-transport.mjs','tests/evaluation/local-codex-provider.mjs'];
async function collect(dir){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const p=resolve(dir,entry.name);
  if(entry.isDirectory())await collect(p);
  else if(p!==dist)files.push(relative(process.cwd(),p).replaceAll('\\','/'));
 }
}
for(const dir of ['apps/server/src','apps/server/dist','packages/shared/src','packages/shared/dist'])await collect(dir);
try{await readFile('.env');files.push('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const frozen={};for(const path of files)frozen[path]=hash(await readFile(path));
async function assertFrozen(){for(const [path,sha]of Object.entries(frozen))if(hash(await readFile(path))!==sha)throw Error(`FROZEN_FILE_CHANGED:${path}`);}
await mkdir(out);
await writeFile(resolve(out,'configuration-freeze.json'),JSON.stringify({files:frozen,envContentsRecorded:false},null,2));
for(const [name,bytes]of Object.entries(builds))await writeFile(resolve(out,`${name}-semantic-router.js`),bytes);
await copyFile(resolve(root,'report.md'),resolve(out,'report-before-r5.md'));
const rounds=[{name:'baseline',build:'baseline'},{name:'previous',build:'previous'},
 {name:'current-1',build:'current'},{name:'current-2',build:'current'},{name:'current-3',build:'current'}];
const batches=[[0,9],[9,9],[18,9],[27,9],[36,9]];
const progress={label,startedAt:new Date().toISOString(),expected,rounds,batches,completed:[],state:'running'};
await writeFile(resolve(out,'builds.json'),JSON.stringify(progress,null,2));
const persist=()=>writeFile(resolve(out,'progress.json'),JSON.stringify(progress,null,2));
async function run(childLabel,offset,limit){
 let stdout='',stderr='';
 try{
  await new Promise((done,reject)=>{
   const child=spawn(process.execPath,[scorer,`--label=${childLabel}`,`--offset=${offset}`,`--limit=${limit}`,'--supervisor','--budget-ready'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',chunk=>{stdout+=chunk;process.stdout.write(`[${childLabel}] ${chunk}`);});
   child.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(`[${childLabel}] ${chunk}`);});
   child.on('error',reject);child.on('close',code=>code===0?done():reject(Error(`${childLabel} exited ${code}; no automatic rerun`)));
  });
 }finally{
  await writeFile(resolve(out,`${childLabel}.stdout.log`),stdout);
  await writeFile(resolve(out,`${childLabel}.stderr.log`),stderr);
 }
}
let failure;
try{
 for(const round of rounds){
  await assertFrozen();await writeFile(dist,builds[round.build]);
  for(const [index,[offset,limit]]of batches.entries()){
   await assertFrozen();
   if(hash(await readFile(dist))!==expected[round.build])throw Error('DIST_BUILD_CHANGED');
   const childLabel=`${label}-${round.name}-${index+1}`;
   progress.active={round:round.name,childLabel,offset,limit};await persist();
   console.log(JSON.stringify({event:'batch_start',...progress.active,buildHash:expected[round.build]}));
   await run(childLabel,offset,limit);
   const rows=JSON.parse(await readFile(resolve(root,childLabel,'results.json'),'utf8'));
   if(rows.length!==limit||new Set(rows.map(r=>r.id)).size!==limit)throw Error('BATCH_INCOMPLETE');
   progress.completed.push({...progress.active,passed:rows.filter(r=>r.passed).length});await persist();
  }
 }
 progress.state='complete';
}catch(error){failure=error;progress.state='failed';progress.error=String(error.stack??error);}
finally{
 await writeFile(dist,builds.current);
 let freezeError;try{await assertFrozen();}catch(e){freezeError=String(e);}
 const restoration={restored:hash(await readFile(dist))===expected.current,actualHash:hash(await readFile(dist)),
  expectedHash:expected.current,sourceUnchanged:hash(await readFile(source))===expected.source,
  frozenFilesUnchanged:!freezeError,freezeError,finishedAt:new Date().toISOString()};
 await writeFile(resolve(out,'restoration.json'),JSON.stringify(restoration,null,2));
 progress.finishedAt=restoration.finishedAt;await persist();
 if(!restoration.restored||freezeError)throw Error(`RESTORE_OR_FREEZE_FAILED:${freezeError??''}`);
}
if(failure)throw failure;
console.log(JSON.stringify({event:'formal_complete',label,samples:225,restored:true}));
