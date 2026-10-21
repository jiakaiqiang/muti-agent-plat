// Run after development exploration and verification. Never launches inference.
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='docs/quality/intent-codex-comparison-2026-10-20';
const out=`${root}/r5-freeze`;
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const source='apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts';
const dist='apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js';
const scorer='tests/evaluation/run-intent-codex-current.mjs';
assert.equal(await hash(scorer),'beec4dae26002278cee6572df09d15585432e466a6ae962ff6dfd60b16fc714a');
assert.equal(await hash(`${out}/scorer-before-prompt.mjs`),await hash(scorer));
assert.equal(await hash(`${out}/before-semantic-router.ts`),'8abc792ae92b062ca8bdf1f738c819184a4007de8823b2376caf5c0c15f5a821');
assert.equal(await hash(`${out}/before-semantic-router.js`),'5d3586dc10f1957c7ed2f3b876acc26e8d61aebd4e26ff8a27bfc21d959bcab2');
const measurement=JSON.parse(await readFile(`${out}/prompt-measurement.json`,'utf8'));
assert.equal(measurement.sourceHash,await hash(source));
assert.equal(measurement.distHash,await hash(dist));
assert.ok(measurement.l0.delta<=0,'Prompt must not grow beyond the pre-R5 baseline');
const batches=[
 ['explore-r5-a-20261020-h01-h03',['H01','H02','H03'],false],
 ['explore-r5-b-20261020-h01-h03',['H01','H02','H03'],false],
 ['explore-r5-b-20261020-h10-h12',['H10','H11','H12'],false],
 ['explore-r5-b-20261020-l11',['L11'],false],
 ['explore-r5-b-20261020-l16',['L16'],false],
 ['explore-r5-b-20261020-l06-l07',['L06','L07'],false],
 ['explore-r5-b-20261020-l20',['L20'],false],
 ['explore-r5-c-20261020-l06-l07',['L06','L07'],true],
 ['explore-r5-c-20261020-l16',['L16'],true],
 ['explore-r5-c-20261020-l20',['L20'],true],
 ['explore-r5-c-20261020-h01-h03',['H01','H02','H03'],true],
 ['explore-r5-c-20261020-h10-h12',['H10','H11','H12'],true],
 ['explore-r5-c-20261020-l11',['L11'],true]
];
const historical=JSON.parse(await readFile(`${root}/serial-confirmed-20261020-r3-after-4/manifest.json`,'utf8'));
const exploration=[];
for(const [label,ids,finalCandidate] of batches){
 const manifest=JSON.parse(await readFile(`${root}/${label}/manifest.json`,'utf8'));
 const rows=JSON.parse(await readFile(`${root}/${label}/results.json`,'utf8'));
 assert.deepEqual(rows.map(row=>row.id),ids);
 assert.equal(manifest.casesHash,historical.casesHash,'Question set must remain unchanged');
 const candidate=label.match(/^explore-r5-([abc])-/)[1];
 const candidateSource=candidate==='c'?source:`${out}/explore-${candidate}-semantic-router.ts`;
 const candidateDist=candidate==='c'?dist:`${out}/explore-${candidate}-semantic-router.js`;
 assert.equal(manifest.hashes[source],await hash(candidateSource));
 assert.equal(manifest.buildHash,await hash(candidateDist));
 for(const row of rows){
  const attempts=row.transport?.attempts;
  assert.ok(attempts?.length,'Transport audit must be present');
  assert.equal(row.transport.retryCount,attempts.length-1);
  for(const attempt of attempts.slice(0,-1)){
   assert.equal(attempt.result.providerCalls,0,'A provider-called sample cannot be rerun');
   assert.equal(attempt.result.modelOutputSeen,false,'A sample with model output cannot be rerun');
   assert.ok(!attempt.result.actual?.understanding);
   assert.ok(attempt.result.actual?.reasonCodes?.includes('INTENT_PROVIDER_CIRCUIT_OPEN'));
   assert.ok(attempt.requestedWaitMs>0);
  }
 }
 if(finalCandidate){
  assert.equal(manifest.hashes[source],await hash(source));
  assert.equal(manifest.buildHash,await hash(dist));
  for(const row of rows){
   const rules=row.invocations[0]?.envelope?.L0?.systemRules;
   assert.ok(rules,'Actual runtime envelope must be captured');
   assert.equal(rules.reduce((sum,rule)=>sum+rule.length,0),measurement.l0.after);
  }
 }
 exploration.push({label,finalCandidate,officialScore:false,sourceHash:manifest.hashes[source],distHash:manifest.buildHash,
  results:rows.map(row=>({id:row.id,passed:row.passed,failedChecks:row.checks.filter(check=>!check.pass),
   providerCalls:row.providerCalls,modelOutputSeen:row.modelOutputSeen,
   transport:{retryCount:row.transport?.retryCount,waitTotalMs:row.transport?.waitTotalMs,stopReason:row.transport?.stopReason,
    attempts:row.transport?.attempts.map(attempt=>({attempt:attempt.attempt,providerCalls:attempt.result?.providerCalls,
     modelOutputSeen:attempt.result?.modelOutputSeen,requestedWaitMs:attempt.requestedWaitMs,actualWaitMs:attempt.actualWaitMs}))},
   segments:row.actual?.understanding?.segments.map(segment=>({action:segment.suggestedAction,effects:segment.requestedEffects})),
   planOutcome:row.actual?.plan?.outcome,planErrors:row.actual?.plan?.validation?.errorCodes}))});
}
const protectedHashes={};
const previouslyRecordedProtected=JSON.parse(await readFile(`${out}/freeze-b-supplement.json`,'utf8')).protectedHashes;
for(const path of ['apps/server/src/modules/message-routing/route-plan-compiler.service.ts',
 'apps/server/src/modules/runtime-routing/execution-scope-resolver.service.ts',
 'apps/server/src/modules/message-routing/intent-plan-commit.service.ts']){
 protectedHashes[path]=await hash(path);
 assert.equal(protectedHashes[path],previouslyRecordedProtected[path],'Protected product code must match the previously recorded freeze');
 if(historical.hashes[path])assert.equal(protectedHashes[path],historical.hashes[path]);
}
const priorDevelopmentResults=[];
const selectedIds=new Set(batches.filter(batch=>batch[2]).flatMap(batch=>batch[1]));
for(let batch=1;batch<=4;batch++){
 const rows=JSON.parse(await readFile(`${root}/serial-confirmed-20261020-r3-after-${batch}/results.json`,'utf8'));
 priorDevelopmentResults.push(...rows.filter(row=>selectedIds.has(row.id)).map(row=>({
  id:row.id,passedUnderPreviousOracle:row.passed,failedChecks:row.checks.filter(check=>!check.pass),
  note:'Historical result, not rescored. Previous oracle did not include resumeDeclaresNoEffects.'
 })));
}
const files=[source,dist,scorer,
 'apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts',
 'docs/design/intent-recognition-correction-system-development-design-v1.md',
 'docs/quality/intent-codex-r5-freeze-2026-10-20.md',
 'tests/evaluation/measure-intent-r5-prompt.mjs',
 'tests/evaluation/capture-intent-r5-freeze.mjs',
 `${out}/targeted-tests-c.log`,`${out}/typecheck-c.log`,`${out}/build-c.log`,`${out}/transport-tests.log`];
const hashes={};for(const path of files)hashes[path]=await hash(path);
await copyFile(source,`${out}/final-semantic-router.ts`);
await copyFile(dist,`${out}/final-semantic-router.js`);
await writeFile(`${out}/freeze.json`,JSON.stringify({
 frozenAt:new Date().toISOString(),scope:'R5 recognition-only; development exploration, no official evaluation',
 scorerFrozenBeforePrompt:true,hashes,protectedHashes,measurement,priorDevelopmentResults,exploration
},null,2));
console.log(JSON.stringify({source:await hash(source),dist:await hash(dist),scorer:await hash(scorer),
 exploration:exploration.map(run=>({label:run.label,results:run.results.map(row=>({id:row.id,passed:row.passed,failed:row.failedChecks}))}))},null,2));
