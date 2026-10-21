import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const label=process.argv.find(a=>a.startsWith('--run-label='))?.slice(12);
if(!label||!/^[a-z0-9][a-z0-9-]{0,45}$/.test(label))throw Error('Valid --run-label required');
const root=resolve('docs/quality/intent-codex-comparison-2026-10-20'),out=resolve(root,`${label}-revision`);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const config=await json(resolve(out,'configuration-freeze.json'));
const run=await json(resolve(out,'builds.json')),progress=await json(resolve(out,'progress.json'));
const restoration=await json(resolve(out,'restoration.json'));
assert.equal(progress.state,'complete');assert.equal(progress.completed.length,25);
assert(restoration.restored&&restoration.sourceUnchanged&&restoration.frozenFilesUnchanged);
for(const [path,sha]of Object.entries(config.files))assert.equal(hash(await readFile(path)),sha,`Changed frozen file ${path}`);
assert.equal(hash(await readFile('apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js')),run.expected.current);
const names=run.rounds.map(r=>r.name),sets={},providers=[],warnings=[],manifests=[];
let cases,casesHash;
for(const round of run.rounds){
 const rows=[];
 for(let n=1;n<=5;n++){
  const batch=`${label}-${round.name}-${n}`,dir=resolve(root,batch);
  const manifest=await json(resolve(dir,'manifest.json')),batchCases=await json(resolve(dir,'cases.json'));
  cases??=batchCases;casesHash??=manifest.casesHash;
  assert.equal(manifest.casesHash,casesHash);assert.equal(hash(JSON.stringify(batchCases)),casesHash);
  assert.equal(manifest.buildHash,run.expected[round.build]);manifests.push({...manifest,batch});
  const batchRows=await json(resolve(dir,'results.json'));assert.equal(batchRows.length,9);
  assert.deepEqual(batchRows.map(r=>r.id),batchCases.slice((n-1)*9,n*9).map(c=>c.id));
  const callRecords=[];
  for(const file of await readdir(dir)){
   if(/^provider-\d+\.json$/.test(file)){
    const call=await json(resolve(dir,file));callRecords.push(call);
    providers.push({round:round.name,batch,file,...call});
   }else if(/^provider-\d+\.jsonl$/.test(file)){
    const log=await readFile(resolve(dir,file),'utf8');
    const matches=log.split(/\r?\n/).filter(line=>/429 Too Many Requests|request timed out|Reconnecting|WebSocket|stream disconnected/i.test(line));
    if(matches.length)warnings.push({round:round.name,batch,file,lines:matches});
   }
  }
  const declaredCalls=batchRows.reduce((sum,r)=>sum+r.transport.attempts.reduce((s,a)=>s+a.result.providerCalls,0),0);
  assert.equal(declaredCalls,callRecords.length,`Call accounting mismatch ${batch}`);
  for(const row of batchRows){
   assert.deepEqual(row.expected,batchCases.find(c=>c.id===row.id).expected);
   for(const attempt of row.transport.attempts.slice(0,-1)){
    const r=attempt.result;
    assert.equal(r.providerCalls,0);assert(!r.modelOutputSeen&&!r.actual?.understanding);
    assert(r.actual?.reasonCodes?.includes('INTENT_PROVIDER_CIRCUIT_OPEN'));
    assert(attempt.requestedWaitMs>0&&attempt.actualWaitMs>=attempt.requestedWaitMs);
   }
  }
  rows.push(...batchRows);
 }
 assert.equal(rows.length,45);assert.equal(new Set(rows.map(r=>r.id)).size,45);sets[round.name]=rows;
 const budget=rows.find(r=>r.id==='B01'),snap=budget.fixture?.snapshot;
 assert(snap);assert.equal(snap.correctionCandidates.length,8);assert.equal(snap.recentRelevantMessages.length,8);assert.equal(snap.validDecisions.length,17);
}
assert.equal(cases.length,45);
const groups={L:cases.filter(c=>c.id.startsWith('L')),H:cases.filter(c=>c.id.startsWith('H')),V:cases.filter(c=>c.id.startsWith('V')),B:cases.filter(c=>c.id==='B01')};
assert.deepEqual(Object.values(groups).map(g=>g.length),[20,12,12,1]);
const byId=Object.fromEntries(names.map(n=>[n,Object.fromEntries(sets[n].map(r=>[r.id,r]))]));
const fields=[...new Set(Object.values(sets).flatMap(rows=>rows.flatMap(r=>r.checks.map(c=>c.field))))].sort();
const checkValue=(r,f)=>r.checks.find(c=>c.field===f)?.pass??null;
const connectionBlocked=r=>!r.modelOutputSeen&&!r.actual?.understanding&&(r.providerCalls===0||r.invocations.some(i=>i.error));
const checkMatrix=cases.flatMap(c=>fields.map(field=>({id:c.id,field,values:Object.fromEntries(names.map(n=>[n,checkValue(byId[n][c.id],field)]))}))).filter(r=>Object.values(r.values).some(v=>v!==null));
const regressions=[];
const comparisons=[['baseline','previous'],...['baseline','previous'].flatMap(from=>['current-1','current-2','current-3'].map(to=>[from,to]))];
for(const [from,to]of comparisons)for(const entry of checkMatrix){
 if(entry.values[from]===true&&entry.values[to]!==true)regressions.push({id:entry.id,field:entry.field,from,to,toValue:entry.values[to],connectionBlocked:connectionBlocked(byId[to][entry.id])});
}

// Compare route structure, preserving array order and all effect/prohibition details.
// Arbitrary local keys, wording, confidence and evidence IDs are not route decisions.
function signature(row){
 const u=row.actual?.understanding;if(!u)return {missing:true,status:row.actual?.status,reasons:row.actual?.reasonCodes};
 const snap=row.fixture.snapshot,replacements=new Map();
 const register=(id,kind)=>{if(id&&!replacements.has(id))replacements.set(id,kind);};
 register(row.fixture.activeWorkItemId,'ACTIVE_WORK_ITEM');register(row.fixture.decisionId,'CURRENT_DECISION');
 register(row.fixture.oldDecision?.id,'OLD_DECISION');
 for(const [i,d]of (snap.validDecisions??[]).entries())register(d.id,`DECISION_${i}`);
 const normalize=x=>Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().filter(k=>!['evidenceRefs'].includes(k)).map(k=>[k,normalize(x[k])])):replacements.get(x)??x;
 return {segments:u.segments.map(s=>({dialogueAct:s.dialogueAct,scopeRelation:s.scopeRelation,suggestedAction:s.suggestedAction,
  contextPolicy:s.contextPolicy,target:normalize(s.target),requestedEffects:normalize(s.requestedEffects),prohibitions:normalize(s.prohibitions),
  correction:normalize(s.correction),dependencies:s.dependencies.map(dep=>({segmentIndex:u.segments.findIndex(t=>t.localKey===dep.segmentKey),condition:dep.condition}))})),
  outcome:row.actual.plan?.outcome,stateValid:row.actual.plan?.validation.stateValid,errorCodes:row.actual.plan?.validation.errorCodes};
}
const stableJson=x=>JSON.stringify(x);
const stability=cases.map(c=>{
 const rows=['current-1','current-2','current-3'].map(n=>byId[n][c.id]);
 const structures=rows.map(signature),checks=rows.map(r=>r.checks.map(x=>[x.field,x.pass]).sort((a,b)=>a[0].localeCompare(b[0])));
 const comparedFields=['dialogueAct','scopeRelation','suggestedAction','contextPolicy','target','requestedEffects','prohibitions','correction','dependencies'];
 const varyingFields=comparedFields.filter(field=>new Set(structures.map(s=>stableJson(s.segments?.map(t=>t[field])))).size>1);
 for(const field of ['outcome','stateValid','errorCodes'])if(new Set(structures.map(s=>stableJson(s[field]))).size>1)varyingFields.push(field);
 return {id:c.id,passCount:rows.filter(r=>r.passed).length,passConsistent:new Set(rows.map(r=>r.passed)).size===1,
  checksConsistent:new Set(checks.map(stableJson)).size===1,routeStructureConsistent:new Set(structures.map(stableJson)).size===1,
  goalWordingConsistent:new Set(rows.map(r=>stableJson(r.actual?.understanding?.segments.map(s=>s.goal)))).size===1,
  varyingFields,structures,checks};
});
const summary=Object.fromEntries(Object.entries(groups).map(([g,cs])=>[g,Object.fromEntries(names.map(n=>{
 const rows=cs.map(c=>byId[n][c.id]);return [n,{passed:rows.filter(r=>r.passed).length,total:rows.length,connectionBlocked:rows.filter(connectionBlocked).length,
  applicable:rows.filter(r=>r.actual?.plan?.outcome==='applicable').length}];
}))]));
const transport=Object.fromEntries(names.map(n=>[n,{samples:sets[n].length,calls:providers.filter(p=>p.round===n).length,
 outputs:providers.filter(p=>p.round===n&&typeof p.output==='string').length,errors:providers.filter(p=>p.round===n&&p.error).map(p=>({batch:p.batch,file:p.file,error:p.error})),
 cooldownRetries:sets[n].reduce((s,r)=>s+r.transport.retryCount,0),waitMs:sets[n].reduce((s,r)=>s+r.transport.waitTotalMs,0),
 missingUsageCalls:providers.filter(p=>p.round===n&&!p.usage).length,
 inputTokens:providers.filter(p=>p.round===n).reduce((s,p)=>s+(p.usage?.input_tokens??0),0),
 cachedInputTokens:providers.filter(p=>p.round===n).reduce((s,p)=>s+(p.usage?.cached_input_tokens??0),0),
 outputTokens:providers.filter(p=>p.round===n).reduce((s,p)=>s+(p.usage?.output_tokens??0),0)}]));
await writeFile(resolve(out,'scored-results.json'),JSON.stringify(sets,null,2));
await writeFile(resolve(out,'check-matrix.json'),JSON.stringify(checkMatrix,null,2));
await writeFile(resolve(out,'stability.json'),JSON.stringify(stability,null,2));
await writeFile(resolve(out,'comparison.json'),JSON.stringify({label,summary,regressions,transport,casesHash,warnings,manifests,restoration},null,2));
const clean=x=>String(x??'—').replaceAll('|','/').replaceAll('\n',' ');
const mark=x=>x===null?'—':x?'✓':'✗';
const failed=r=>r.checks.filter(c=>!c.pass).map(c=>c.field).join(', ')||r.error||'—';
const actions=r=>r.actual?.understanding?.segments.map(s=>s.suggestedAction).join('+')??'无输出';
let md=`# 意图识别与路由 R5 正式评测\n\n运行标签：\`${label}\`。开始 ${progress.startedAt}，结束 ${progress.finishedAt}。本轮共 225 个样本，三个冻结构建使用同一判分和同一 45 题；基线、上轮优化各 1 次，C 各题 3 次。全程串行；不混入任何探索成绩。\n\n`;
md+='## 结果概览\n\nL（20）与 H（12）均已参与开发诊断；**只有 V（12）是 C 冻结后由监督方新写的留出集**。B01 是预算边界样本，单独报告。通过指本题全部冻结检查项通过，不代表业务动作已执行。\n\n| 集合 | 原始基线 | 上轮优化 | C 第1次 | C 第2次 | C 第3次 | C−上轮差异（通过题数） |\n|---|---:|---:|---:|---:|---:|---|\n';
for(const [g,stats]of Object.entries(summary)){
 const invalid=Object.values(stats).some(s=>s.connectionBlocked);
 const difference=invalid?'无效（连接受阻）':['current-1','current-2','current-3'].map(n=>`${stats[n].passed-stats.previous.passed>=0?'+':''}${stats[n].passed-stats.previous.passed}`).join(' / ');
 md+=`| ${g} | ${names.map(n=>`${stats[n].passed}/${stats[n].total}`).join(' | ')} | ${difference} |\n`;
}
md+=`\nC 的 45 题中，3/3 通过 ${stability.filter(s=>s.passCount===3).length} 题，2/3 通过 ${stability.filter(s=>s.passCount===2).length} 题，1/3 通过 ${stability.filter(s=>s.passCount===1).length} 题，0/3 通过 ${stability.filter(s=>s.passCount===0).length} 题。检查项三次一致 ${stability.filter(s=>s.checksConsistent).length}/45；路由结构三次一致 ${stability.filter(s=>s.routeStructureConsistent).length}/45。不能据此估计生产准确率。\n\n`;
md+='## 方法、冻结与范围\n\n直接调用默认关闭的 intent-understanding-v1：真实 SemanticIntentRouter → 持久化 IntentUnderstandingRouting → GenericLlmRuntime → 本地 Codex HTTP 桥 → 真实纯编译器。只允许 user_message_routing、空工具目录、writeMode=none；没有提交或业务派发。不是默认线上链路、HTTP/UI 端到端或执行器验收。模型使用本地配置 gpt-6-astra/high；未改配置。\n\n仅替换已冻结 dist 路由文件，未 checkout 基线源码；所以三个构建 manifest 的 source hash 都是 C，实际 buildHash 分别如下。其余服务源码、dist、共享包、题目、判分、传输及 .env（若存在，仅存哈希）均逐批核对。\n\n| 输入 | SHA-256 |\n|---|---|\n';
for(const key of ['baseline','previous','current','source','scorer','v3'])md+=`| ${key} | \`${run.expected[key]}\` |\n`;
md+=`| 完整题集 JSON | \`${casesHash}\` |\n`;
for(const p of ['tests/evaluation/run-intent-r5-formal.mjs','tests/evaluation/report-intent-r5-formal.mjs'])md+=`| ${p} | \`${hash(await readFile(p))}\` |\n`;
md+=`\n最终 dist 已恢复 C：\`${restoration.actualHash}\`；所有冻结文件复核通过。V3 导入为 12 题 V01–V12 + 可加载的 budgetCase；正式 B01 仅取旧 H 导出一次。未修改提示词、题目、期望、夹具或判分。历史报告保存为 ${label}-revision/report-before-r5.md。\n\n`;
md+='## 逐题通过与稳定性\n\n检查一致比较字段名与布尔值；路由结构一致比较段落顺序、行为、关系、动作、上下文策略、目标、效果、禁止项、纠错、依赖和纯编译结果。动态夹具 ID 映射为角色；忽略局部命名、goal 表述、证据 ID、置信度。结构一致不等于完整语义等价，goal 原文及模型输出保留在原始证据。\n\n| 题号 | 基线 | 上轮 | C1 | C2 | C3 | C通过次数 | 检查一致 | 路由结构一致 |\n|---|---|---|---|---|---|---:|---|---|\n';
for(const s of stability)md+=`| ${s.id} | ${names.map(n=>mark(byId[n][s.id].passed)).join(' | ')} | ${s.passCount}/3 | ${mark(s.checksConsistent)} | ${mark(s.routeStructureConsistent)} |\n`;
md+='\n路由结构不一致的具体字段（按前述归一化口径，未作语义等价推断）：\n\n| 题号 | 三次间变化的字段 |\n|---|---|\n';
for(const s of stability.filter(s=>!s.routeStructureConsistent))md+=`| ${s.id} | ${s.varyingFields.join(', ')} |\n`;
md+='\n## 识别通过与纯编译结果\n\n除明确的恢复正例外，检查项不要求所有计划 applicable；效果资源缺失、禁止项不可约束或主动澄清均可能阻止纯编译。以下数量包含通过与失败题，不是业务执行成绩。\n\n| 运行 | applicable | needs_clarification | blocked | 其它/无计划 |\n|---|---:|---:|---:|---:|\n';
for(const n of names){const counts=['applicable','needs_clarification','blocked'].map(x=>sets[n].filter(r=>r.actual?.plan?.outcome===x).length);md+=`| ${n} | ${counts.join(' | ')} | ${45-counts.reduce((s,v)=>s+v,0)} |\n`;}
md+='\nH02“保持暂停、只问理由”的逐次结果：\n\n| 运行 | 语义检查 | 动作 | 禁止项 | 纯编译结果 | 编译原因 |\n|---|---|---|---|---|---|\n';
for(const n of names){const r=byId[n].H02;md+=`| ${n} | ${mark(r.passed)} | ${actions(r)} | ${clean(r.actual?.understanding?.segments.flatMap(s=>s.prohibitions.map(p=>p.effectKind)).join(', ')||'无')} | ${clean(r.actual?.plan?.outcome)} | ${clean(r.actual?.plan?.validation.errorCodes.join(', '))} |\n`;}
md+='\n## 所有失败样本\n\n| 运行 | 题号 | 动作 | 实际关系/策略 | 失败检查/错误 | 编译结果 | 原因 |\n|---|---|---|---|---|---|---|\n';
for(const n of names)for(const r of sets[n].filter(r=>!r.passed))md+=`| ${n} | ${r.id} | ${actions(r)} | ${clean(r.actual?.understanding?.segments.map(s=>`${s.scopeRelation}/${s.contextPolicy}`).join(' + '))} | ${clean(failed(r))} | ${clean(r.actual?.plan?.outcome)} | ${clean([...(r.actual?.reasonCodes??[]),...(r.actual?.plan?.validation.errorCodes??[])].join(', '))} |\n`;
md+='\nC 中未达到3/3通过的题目：\n\n';
for(const s of stability.filter(s=>s.passCount<3)){
 const c=cases.find(c=>c.id===s.id);
 md+=`- **${s.id}**（${s.passCount}/3）：${clean(c.message)} 冻结关系期望为 ${clean(c.expected.relation)}，动作期望为 ${clean(c.expected.actions?.join('/'))}；失败运行：${['current-1','current-2','current-3'].filter(n=>!byId[n][s.id].passed).join('、')}。具体错误见上表；本轮不改期望或提示词。\n`;
}
md+='\n失败样本不重跑、不覆盖，模型输出、检查项和夹具原样保存。schema 失败可能让后续检查未执行；“—”不计为通过，亦不伪装成语义错误。\n\n## 逐检查项对比与退步\n\n下表分母为实际执行该检查的样本数；条件检查未执行时不加入分母。每一条由通过变为失败或未执行的检查均在后表列出，包括整题前后均失败的情况。\n\n| 检查项 | 基线 | 上轮 | C1 | C2 | C3 |\n|---|---:|---:|---:|---:|---:|\n';
for(const f of fields)md+=`| ${f} | ${names.map(n=>{const vals=sets[n].map(r=>checkValue(r,f)).filter(v=>v!==null);return `${vals.filter(Boolean).length}/${vals.length}`;}).join(' | ')} |\n`;
md+='\n| 题号 | 检查项 | 起点 | 对比运行 | 变化 |\n|---|---|---|---|---|\n';
for(const r of regressions)md+=`| ${r.id} | ${r.field} | ${r.from} | ${r.to} | ${r.connectionBlocked?'无效（连接受阻）':r.toValue===null?'✓→未执行':'✓→✗'} |\n`;
if(!regressions.length)md+='| — | — | — | — | 无逐项退步 |\n';
md+='\n## 传输、重试和 token\n\n脚本只有在熔断、0 提供方调用、没有模型输出时按 retryAfterMs 冷却重试（最多3次）。发生过任何提供方调用的样本均保留，不额外补跑；产品内部重试若发生会计入该样本调用数。CLI 网络回退警告与最终样本失败分别记录。\n\n| 运行 | 样本 | 模型调用 | 有输出调用 | 提供方错误 | 脚本冷却重试 | 等待ms | CLI输入token | CLI缓存输入token | CLI输出token |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const n of names){const t=transport[n];md+=`| ${n} | ${t.samples} | ${t.calls} | ${t.outputs} | ${t.errors.length} | ${t.cooldownRetries} | ${t.waitMs} | ${t.inputTokens} | ${t.cachedInputTokens} | ${t.outputTokens} |\n`;}
md+=`\n有连接/回退警告的调用日志 ${warnings.length} 份（完整行见 comparison.json/warnings）；提供方错误见同文件 transport.errors。CLI usage 包含 CLI 自身上下文，与以下应用输入字符估算不同。上述用量仅汇总已报告的 usage，${Object.values(transport).reduce((s,t)=>s+t.missingUsageCalls,0)} 次调用缺 usage（包括超时调用）；缺失不代表实际消耗为0，也未估算费用。\n\n`;
md+='每次应用实发输入估算为 ceil(JSON.stringify({messages}).length/4)，配置上限6000；同一格若有多次调用则以“/”分隔。完整估算、预算、模型真实 usage 在原始结果和 provider 文件中。\n\n| 题号 | 基线估算 | 上轮估算 | C1估算 | C2估算 | C3估算 |\n|---|---:|---:|---:|---:|---:|\n';
for(const c of cases)md+=`| ${c.id} | ${names.map(n=>byId[n][c.id].tokenEstimates.map(t=>t.estimatedInputTokens).join('/')||'未发出').join(' | ')} |\n`;
md+='\nB01 的完整历史夹具每次均确认 8 个纠错候选、8 条近期消息、17 条有效 Decision。\n\n| 运行 | B01检查 | 编译结果 | 估算输入 | 超6000调用数 | 原因 |\n|---|---|---|---|---:|---|\n';
for(const n of names){const r=byId[n].B01;md+=`| ${n} | ${mark(r.passed)} | ${clean(r.actual?.plan?.outcome)} | ${r.tokenEstimates.map(t=>t.estimatedInputTokens).join('/')} | ${r.tokenEstimates.filter(t=>t.estimatedInputTokens>6000).length} | ${clean(r.actual?.plan?.validation.errorCodes.join(', '))} |\n`;}
md+='\n空工具分类路径没有执行6000输入预算拦截：预算检查仅在工具循环路径。超预算仍发出的请求暴露此缺口；B01语义检查通过不能称为预算验收通过。本轮不修运行时、不提高预算。\n\n';
md+='## 已知缺口与结论边界\n\n- 新链路默认关闭，本轮直接调用服务绕过开关。没有改变默认配置或 .env，也没有证明生产默认路由行为。\n- **识别正确、纯编译 applicable 均不代表业务可执行。** 提交层缺少 resume、replan、retry_failed_step、非测试 enqueue_follow_up 执行器；即使充分授权仍会 INTENT_ACTION_EXECUTOR_UNAVAILABLE。精确命令走另一条路径。\n- 纯 resume 的 requestedEffects 必须为空，由服务端绑定原已批准计划并重新校验授权/版本；空效果不是授权。本轮未实现该执行器。自然语言 EXECUTING 延续使用空效果 enqueue_follow_up；未来执行器仍需验证不重复派发。\n- 提交层没有向纯编译传入 recoverableCheckpointId，retry_failed_step 还存在检查点缺口。夹具无 artifact、资源授权、待确认记录或失败检查点；未验收实际纠错事务、效果授权、资源定位与派发。\n- H02 维持暂停可能被推断成 modify_source 等禁止项；夹具不可约束这些禁止项会产生 PROHIBITION_NOT_ENFORCEABLE，纯识别检查通过仍可能 blocked。不得把所有 blocked 归为识别错误。\n- 新 V 集不覆盖“resume + 新要求”两个 same_requirement 段；冻结 multi 检查只能表达 same_requirement + independent_new_requirement，本轮不改判分补覆盖。\n- L/H 是开发集；V 仅12道由监督方编写的小样本，无独立双人标注。C 仅3次采样；上轮/基线各1次且按时间先后运行。不能排除采样和服务时间漂移，不能作生产准确率或全面稳定性承诺。\n- 本轮未扩展工作流，未修改编译器、execution-scope-resolver、提交层、默认配置或产品提示词。定向单测33/33、server typecheck/build 在 C 冻结时已通过，本轮未重新 build，以免改变冻结构建。新运行/报告脚本做语法检查，结果汇总附完整性断言。\n\n';
md+='## 冻结题目索引\n\n本表从各批一致的 cases.json 生成，不重新解释或修改期望。readOnly、inherit、correction、resume、clarify 等附加期望和检查代码详见原始 cases.json 及冻结判分脚本。\n\n| 题号 | 状态 | 功能点 | 题目 | 关系期望 | 动作期望 | 段数期望 |\n|---|---|---|---|---|---|---:|\n';
for(const c of cases)md+=`| ${c.id} | ${clean(c.status)} | ${clean(c.feature??c.name)} | ${clean(c.message)} | ${clean(c.expected.multi?'same_requirement + independent_new_requirement':c.expected.relation)} | ${clean(c.expected.actions?.join('/'))} | ${c.expected.multi?2:1} |\n`;
md+=`## 证据索引\n\n- ${label}-revision/builds.json、configuration-freeze.json、progress.json、restoration.json：冻结、执行覆盖和恢复核验。\n- ${label}-{baseline,previous,current-1,current-2,current-3}-{1..5}：共25批原始模型输入/输出、manifest、逐题结果、transport日志。\n- ${label}-revision/scored-results.json、comparison.json、check-matrix.json、stability.json：225样本汇总、每项退步与三次路由结构。\n- ${label}-revision/report-before-r5.md：本轮前报告快照；所有探索和旧正式结果原样保留。\n`;
await writeFile(resolve(out,'report.md'),md);await writeFile(resolve(root,'report.md'),md);
console.log(JSON.stringify({label,summary,regressions:regressions.length,transport,stability:stability.map(({structures,checks,...rest})=>rest)},null,2));
