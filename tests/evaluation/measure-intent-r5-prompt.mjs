// Offline, same-request comparison. No provider call and no semantic score.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='docs/quality/intent-codex-comparison-2026-10-20';
const freeze=`${root}/r5-freeze`;
const sourcePath='apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts';
const distPath='apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js';
const before=await readFile(`${freeze}/before-semantic-router.ts`,'utf8');
const after=await readFile(sourcePath,'utf8');
const dist=await readFile(distPath,'utf8');
function rules(source){
 const block=source.match(/envelope\.L0\.systemRules\.push\(([\s\S]*?)\n\s*\);/)[1];
 return [...block.matchAll(/^\s*'([^'\r\n]*)'[,]?$/gm)].map(match=>match[1]);
}
const oldRules=rules(before),newRules=rules(after);
assert.equal(oldRules.length,5);assert.equal(newRules.length,5);
let expectedSource=before;
let expectedDist=await readFile(`${freeze}/before-semantic-router.js`,'utf8');
for(let i=0;i<oldRules.length;i++){
 expectedSource=expectedSource.replace(oldRules[i],newRules[i]);
 expectedDist=expectedDist.replace(oldRules[i],newRules[i]);
}
assert.equal(after,expectedSource,'Router source may change only these prompt rules');
assert.equal(dist,expectedDist,'Router dist may change only these prompt rules');
const historical=`${root}/serial-confirmed-20261020-r3-after-4`;
const row=JSON.parse(await readFile(`${historical}/results.json`,'utf8')).find(row=>row.id==='B01');
const call=JSON.parse(await readFile(`${historical}/provider-${row.tokenEstimates[0].providerCall}.json`,'utf8'));
const l0Before=row.invocations[0].envelope.L0.systemRules;
const l0After=[...l0Before];
const messages=structuredClone(call.request.messages);
const replacements=[];
for(let i=0;i<oldRules.length;i++){
 assert.ok(dist.includes(newRules[i]),'Built artifact must contain current rule');
 if(oldRules[i]===newRules[i])continue;
 assert.equal(l0Before.filter(rule=>rule===oldRules[i]).length,1);
 l0After[l0Before.indexOf(oldRules[i])]=newRules[i];
 let occurrences=0;
 for(const message of messages){
  assert.equal(typeof message.content,'string');
  occurrences+=message.content.split(oldRules[i]).length-1;
  message.content=message.content.replaceAll(oldRules[i],newRules[i]);
 }
 assert.ok(occurrences>0,'Changed rule must occur in actual historical request');
 replacements.push({before:oldRules[i],after:newRules[i],occurrences});
}
const chars=rules=>rules.reduce((sum,rule)=>sum+rule.length,0);
const tokenEstimate=messages=>Math.ceil(JSON.stringify({messages}).length/4);
const measurement={
 method:'Offline reconstruction of the same historical B01 provider request; replace only changed L0 rules. No inference, no score. UTF-16 chars; ceil(JSON.stringify({messages}).length/4).',
 sourceHash:createHash('sha256').update(after).digest('hex'),
 distHash:createHash('sha256').update(dist).digest('hex'),
 l0:{before:chars(l0Before),after:chars(l0After),delta:chars(l0After)-chars(l0Before),ruleCount:l0After.length},
 b01:{before:tokenEstimate(call.request.messages),after:tokenEstimate(messages),configuredMaxInputTokens:6000},
 replacements
};
assert.ok(measurement.l0.delta<=0);
assert.equal(measurement.b01.before,row.tokenEstimates[0].estimatedInputTokens);
await writeFile(`${freeze}/prompt-measurement.json`,JSON.stringify(measurement,null,2));
console.log(JSON.stringify({...measurement,replacements:undefined},null,2));
