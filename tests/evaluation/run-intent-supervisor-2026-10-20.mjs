import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runSerial} from './intent-evaluation-transport.mjs';
// User must explicitly start a new uniquely labelled run after confirming quota.
const runLabel=process.argv.find(arg=>arg.startsWith('--run-label='))?.slice('--run-label='.length);
if(!runLabel||!/^[a-z0-9][a-z0-9-]{0,59}$/.test(runLabel))throw Error('A new --run-label is required; do not overwrite historical evidence.');
const root=resolve('docs/quality/intent-codex-comparison-2026-10-20');
const evidence=resolve(root,`${runLabel}-revision`);
await mkdir(evidence); // Unique run; never replace previous evidence.
const dist=resolve('apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js');
const final=await readFile(dist),baseline=await readFile(resolve(root,'baseline-semantic-router.js'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=resolve('apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts');
const frozenSource=hash(await readFile(source));
await writeFile(resolve(evidence,'final-semantic-router.js'),final);
await writeFile(resolve(evidence,'builds.json'),JSON.stringify({baseline:hash(baseline),final:hash(final),frozenSource,startedAt:new Date().toISOString()},null,2));
async function run(label,offset,limit){
 return new Promise((done,reject)=>{
  const child=spawn(process.execPath,['tests/evaluation/run-intent-codex-current.mjs',`--label=${label}`,`--offset=${offset}`,`--limit=${limit}`,'--supervisor','--budget-ready'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>process.stdout.write(`[${label}] ${x}`));child.stderr.on('data',x=>process.stderr.write(`[${label}] ${x}`));
  child.on('error',reject);child.on('close',code=>code===0?done():reject(Error(`${label} exited ${code}`)));
 });
}
try{
 for(const [name,build]of [['before',baseline],['after',final]]){
  if(hash(await readFile(source))!==frozenSource)throw Error('PRODUCT_PROMPT_CHANGED_DURING_EVALUATION');
  await writeFile(dist,build);
  if(hash(await readFile(dist))!==hash(build))throw Error('BUILD_SWAP_HASH_MISMATCH');
  console.log(JSON.stringify({build:name,hash:hash(build)}));
  await runSerial([[0,9],[9,9],[18,9],[27,6]],([offset,limit],i)=>run(`${runLabel}-${name}-${i+1}`,offset,limit));
 }
}finally{
 await writeFile(dist,final);
 const restored=hash(await readFile(dist))===hash(final);
 await writeFile(resolve(evidence,'restoration.json'),JSON.stringify({restored,actualHash:hash(await readFile(dist)),expectedHash:hash(final),sourceUnchanged:hash(await readFile(source))===frozenSource,finishedAt:new Date().toISOString()},null,2));
 if(!restored)throw Error('FINAL_BUILD_RESTORE_FAILED');
}
