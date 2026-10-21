import {readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const label=process.argv.find(a=>a.startsWith('--run-label='))?.slice(12);
if(!label||!/^[a-z0-9][a-z0-9-]{0,59}$/.test(label))throw Error('Valid --run-label required');
const root=resolve('docs/quality/intent-codex-comparison-2026-10-20'),out=resolve(root,`${label}-revision`);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const builds=await json(resolve(out,'builds.json')),restore=await json(resolve(out,'restoration.json'));
if(!restore.restored||!restore.sourceUnchanged)throw Error('RESTORE_FAILED');
if(hash(await readFile('apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js'))!==builds.final)throw Error('DIST_CHANGED');
if(hash(await readFile('apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts'))!==builds.frozenSource)throw Error('SOURCE_CHANGED');
const config=await json(resolve(out,'configuration-freeze.json'));
if(config.envExists&&hash(await readFile('.env'))!==config.envHash)throw Error('ENV_CHANGED');
const previous=await json(resolve(root,'review-before-1','cases.json'));
const expectedHash=hash(JSON.stringify(previous));
const sets={},manifests=[],connections=[],providerErrors=[];
for(const side of ['before','after']){
 const rows=[];
 for(let n=1;n<=4;n++){
  const dir=resolve(root,`${label}-${side}-${n}`),m=await json(resolve(dir,'manifest.json'));
  const cases=await json(resolve(dir,'cases.json'));
  if(m.casesHash!==expectedHash||hash(JSON.stringify(cases))!==expectedHash)throw Error('QUESTIONS_CHANGED');
  if(m.buildHash!==builds[side==='before'?'baseline':'final'])throw Error('WRONG_BUILD');
  manifests.push(m);rows.push(...await json(resolve(dir,'results.json')));
  for(const file of await readdir(dir))if(/^provider-\d+\.jsonl$/.test(file)){
   const log=await readFile(resolve(dir,file),'utf8');
   if(/429 Too Many Requests|request timed out/.test(log))connections.push({side,file:`${label}-${side}-${n}/${file}`,http429:log.includes('429 Too Many Requests'),timeout:log.includes('request timed out')});
  }
  for(const file of await readdir(dir))if(/^provider-\d+\.json$/.test(file)){
   const call=await json(resolve(dir,file));
   if(call.error)providerErrors.push({side,file:`${label}-${side}-${n}/${file}`,error:call.error});
  }
 }
 if(rows.length!==33||new Set(rows.map(r=>r.id)).size!==33)throw Error('INCOMPLETE_ROUND');
 for(const r of rows){
  if(!r.fixture||r.fixture.snapshot.activeWorkItem.status!==r.fixture.productionWorkItemStatus)throw Error('FIXTURE_STATE_MISMATCH');
  if(!r.transport)throw Error('MISSING_TRANSPORT_AUDIT');
  const attempts=r.transport.attempts;
  for(const attempt of attempts.slice(0,-1))if(attempt.result.providerCalls!==0||attempt.result.modelOutputSeen||!attempt.result.actual?.reasonCodes?.includes('INTENT_PROVIDER_CIRCUIT_OPEN'))throw Error('REPEATED_MODEL_SAMPLE');
 }
 const b=rows.find(r=>r.id==='B01');
 if(b.fixture.snapshot.correctionCandidates.length!==8||b.fixture.snapshot.recentRelevantMessages.length!==8||b.fixture.snapshot.validDecisions.length<16)throw Error('LARGE_FIXTURE_INVALID');
 sets[side]=rows.sort((a,b)=>a.id.localeCompare(b.id));
}
const {before,after}=sets;
const keys=[...new Set([...before,...after].flatMap(r=>r.checks.map(c=>c.field)))];
const status=(r,k)=>r.checks.some(c=>c.field===k)?(r.checks.find(c=>c.field===k).pass?'通过':'失败'):'未检查';
const matrix=before.flatMap((b,i)=>keys.map(k=>({id:b.id,check:k,before:status(b,k),after:status(after[i],k)})));
const summary=rows=>({total:rows.length,passed:rows.filter(r=>r.passed).length,valid:rows.filter(r=>r.actual?.understanding).length,
 providerCalls:rows.reduce((s,r)=>s+r.providerCalls,0),cooldownRetries:rows.reduce((s,r)=>s+r.transport.retryCount,0),waitMs:rows.reduce((s,r)=>s+r.transport.waitTotalMs,0),
 noProvider:rows.filter(r=>!r.providerCalls).map(r=>r.id),outcomes:rows.reduce((s,r)=>{const k=r.actual?.plan?.outcome??'no_plan';s[k]=(s[k]??0)+1;return s;},{})});
const groups={};for(const [name,prefix]of [['diagnostic','L'],['holdout','H'],['budget','B']])groups[name]={before:summary(before.filter(r=>r.id.startsWith(prefix))),after:summary(after.filter(r=>r.id.startsWith(prefix)))};
const regressed=matrix.filter(r=>r.before==='通过'&&r.after!=='通过');
const comparison={label,groups,regressed,connections,providerErrors,builds,restore,casesHash:expectedHash,configurationUnchanged:true};
await writeFile(resolve(out,'comparison.json'),JSON.stringify(comparison,null,2));
await writeFile(resolve(out,'check-matrix.json'),JSON.stringify(matrix,null,2));
await writeFile(resolve(out,'scored-results.json'),JSON.stringify(sets,null,2));
const clean=x=>String(x??'—').replaceAll('|','/').replaceAll('\n',' ');
const actual=r=>r.actual?.understanding?.segments.map(s=>`${s.scopeRelation} → ${s.suggestedAction}`).join('；')??r.actual?.reasonCodes?.join('、')??r.error;
const tok=r=>(r.tokenEstimates??[]).map(t=>t.estimatedInputTokens);
const blocked=[...before,...after].some(r=>!r.actual?.understanding);
let md='# 意图识别与路由真实模型评测：串行确认轮次\n\n';
md+=`生成时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（UTC+8）；run-label：\`${label}\`。\n\n`;
md+='**范围：被测的是默认关闭的 intent-understanding-v1 新链路，对默认配置下的线上消息路由不生效。** 新会话需同时满足 INTENT_UNDERSTANDING_ENABLED=true 和 enforce 路由准入。本轮未修改默认配置、产品代码、提示词、题目或期望，未扩展工作流。\n\n';
md+=blocked?'**结论边界：本轮仍有题目缺少有效语义输出，不能作为完整模型准确率的最终结论。** 下表保留全部题目与连接/结构失败，不用旧轮次或单题补测填补。\n\n':'本轮两个构建均获得全部 33 题的有效语义输出。以下是冻结题集上的单次服务评测，不能外推为生产准确率或稳定率。\n\n';
md+='## 结果概览\n\n| 集合 | 前通过 | 后通过 | 前有效语义输出 | 后有效语义输出 | 差异 |\n|---|---:|---:|---:|---:|---|\n';
for(const [k,title]of [['diagnostic','原 20 题诊断集'],['holdout','12 题留出集'],['budget','B01 大会话']]){
 const g=groups[k],valid=g.before.valid===g.before.total&&g.after.valid===g.after.total;
 md+=`| ${title} | ${g.before.passed}/${g.before.total} | ${g.after.passed}/${g.after.total} | ${g.before.valid}/${g.before.total} | ${g.after.valid}/${g.after.total} | ${valid?`${g.after.passed-g.before.passed} 题`:'无效（存在连接或结构失败）'} |\n`;
}
md+='\n诊断集参与过两轮提示词调优，留出集未用于调参，但之前评测已看过部分输出，不能称本轮重新盲测。本轮没有第三轮提示词优化。旧 13→17→20 受 WorkItem 夹具错误影响，不能作为优化幅度；旧监督轮次受连接影响也不并入本轮。\n\n';
md+='“通过”指冻结检查项全部通过，并非所有题都要求计划可应用：正向恢复单独要求 applicable，其余题可能在识别和安全检查通过后仍因授权或禁止项无法执行。尤其 B01 通过不代表预算安全，也不代表计划可提交。编译结果分布和失败原因分别列出。\n\n';
md+='## 运行与冻结验证\n\n';
md+=`- 基线实际构建：\`${builds.baseline}\`；最终构建：\`${builds.final}\`。结束后 finally 恢复且再次实读核验通过。\n- 产品源码冻结哈希：\`${builds.frozenSource}\`；题集哈希：\`${expectedHash}\`，与上一轮冻结题集一致。\n`;
md+='- 前后都复用生产 WorkItem 状态映射，逐题断言：EXECUTING→EXECUTING，PAUSED/WAIT_*→WAITING_USER，FAILED→FAILED。B01 历史路由从开始就设为已完成，避免阻挡当前请求。\n- 批次与题目串行、并发 1。仅零提供方调用且无模型输出的熔断题按 retryAfterMs 冷却后在同一轮重建隔离夹具重试；最多 3 次，完整保留每次准入结果。已调用提供方或有模型输出（含错误/结构错误）的题不作此重跑。产品内部原有修复预算保留。\n- 本地 Codex 真实 CLI 经隔离 HTTP 桥，调用真实 SemanticIntentRouter / IntentUnderstandingRoutingService / GenericLlmRuntime / 纯 RoutePlanCompiler；只读沙箱、空工具目录，无业务派发。330 秒逻辑预算，160 秒应用调用，150 秒 CLI 观察上限。模型沿用本地配置 gpt-6-astra/high。\n- .env 哈希未变；评测直接调用服务，绕过默认 shadow/false 开关，非 UI/HTTP 产品入口端到端验收。\n\n';
md+='## 传输与冷却记录\n\n| 构建 | 提供方调用 | 零调用熔断重试 | 总等待 ms | 最终仍未到提供方 |\n|---|---:|---:|---:|---|\n';
for(const side of ['before','after']){const s=summary(sets[side]);md+=`| ${side} | ${s.providerCalls} | ${s.cooldownRetries} | ${s.waitMs} | ${s.noProvider.join('、')||'无'} |\n`;}
md+=`\n${connections.filter(x=>x.http429).length} 个 CLI 日志包含 429，${connections.filter(x=>x.timeout).length} 个包含超时，可能重叠且不等于失败题数。逐调用路径见 comparison.json；各题 transport-*.json 及 scored-results.json 保存尝试数、请求等待与实等时间。\n\n`;
md+=`桥接层另记录 ${providerErrors.length} 次调用错误（CLI 事件中未必出现）：${providerErrors.map(e=>`${e.file}: ${e.error}`).join('；')||'无'}。基线 L13 首次达到 150 秒 CLI 观察上限，由系统原有调用重试后成功；它不是评测脚本重跑题目。总计 67 次提供方调用对应 66 道构建样本，所有调用证据均保留。\n\n`;
for(const [prefix,title]of [['L','诊断集'],['H','留出集']]){
 md+=`## ${title}题目与逐题结果\n\n| 题号 | Session / WorkItem | 题目 | 期望动作 | 前识别 | 后识别 | 整题前→后 |\n|---|---|---|---|---|---|---|\n`;
 before.forEach((b,i)=>{if(!b.id.startsWith(prefix))return;const a=after[i];md+=`| ${b.id} | ${b.fixture.sessionStatus} / ${b.fixture.productionWorkItemStatus} | ${clean(b.message)} | ${clean(b.expected.actions?.join('/')??'拆分两个目标')} | ${clean(actual(b))} | ${clean(actual(a))} | ${b.passed?'通过':'失败'}→${a.passed?'通过':'失败'} |\n`;});
 md+='\n| 检查项 | 前通过/失败/未检查 | 后通过/失败/未检查 | 题内退步 |\n|---|---|---|---|\n';
 for(const k of keys){const cells=matrix.filter(r=>r.id.startsWith(prefix)&&r.check===k);const counts=s=>['通过','失败','未检查'].map(v=>cells.filter(r=>r[s]===v).length).join('/');md+=`| ${k} | ${counts('before')} | ${counts('after')} | ${cells.filter(r=>r.before==='通过'&&r.after!=='通过').map(r=>r.id).join('、')||'无'} |\n`;}
 md+='\n“未检查”包括条件不适用及无语义输出导致无法检查，不能当作通过。逐题逐检查项完整矩阵见 check-matrix.json。\n\n';
}
md+='## 失败及题内退步\n\n| 题号 | 构建 | 失败检查 | 编译结果 | 原因 |\n|---|---|---|---|---|\n';
for(const side of ['before','after'])for(const r of sets[side].filter(r=>!r.passed))md+=`| ${r.id} | ${side} | ${clean(r.checks.filter(c=>!c.pass).map(c=>c.field).join('、')||r.error)} | ${clean(r.actual?.plan?.outcome)} | ${clean(r.actual?.plan?.validation?.errorCodes?.join('、')||r.actual?.reasonCodes?.join('、'))} |\n`;
md+='\n| 题号 | 退步检查项 | 前→后 |\n|---|---|---|\n';
for(const r of regressed)md+=`| ${r.id} | ${r.check} | ${r.before}→${r.after} |\n`;
if(!regressed.length)md+='| — | 本轮未发现 | — |\n';
md+='\n整题前后都失败仍可能有检查项退步；历史 L20 曾由仅 action 错误变成 correctionBinding、routeReferencesAndRelation 同时错误，旧整题 regressed=[] 漏记，历史 routeReferencesAndRelation 18→17、applicable 6→5 均不能描述为全面改善。本轮上述表重新按每项比较。\n\n';
for(const k of ['diagnostic','holdout'])md+=`${k} 编译结果：前 ${JSON.stringify(groups[k].before.outcomes)}；后 ${JSON.stringify(groups[k].after.outcomes)}。\n\n`;
md+='## PAUSED 恢复正例\n\n| 题号 | 前动作/编译 | 后动作/编译 | 前/后 positiveResumeApplicable |\n|---|---|---|---|\n';
for(const id of ['H01','H11']){const b=before.find(r=>r.id===id),a=after.find(r=>r.id===id);md+=`| ${id} | ${clean(actual(b))} / ${clean(b.actual?.plan?.outcome)} | ${clean(actual(a))} / ${clean(a.actual?.plan?.outcome)} | ${status(b,'positiveResumeApplicable')}/${status(a,'positiveResumeApplicable')} |\n`;}
md+='\n该检查要求 resume 且纯编译为 applicable，澄清不能算通过。但纯编译通过不证明可提交执行：即使授权完整，自然语言 resume 仍在新链路提交层因缺少执行器被阻断。夹具未提供历史执行资源授权，模型额外请求未解析 modify_source 也会导致 EFFECT_TARGET_UNRESOLVED。两者是不同层次的问题，不能全部归为识别错误或过度澄清。\n\n';
md+='本轮优化后仍失败的 H01/H11 均识别为 resume，但请求的 modify_source 没有可解析资源，编译为 needs_clarification；H03 将“照常推进”和“补齐报错”拆成两段，而冻结期望是一个补充目标。H02/H07/H09 从失败变为通过。没有对这些结果继续调参或补测替换。\n\n';
md+='## 输入 token 预算\n\n从实发 messages 计算 ceil(JSON.stringify({messages}).length/4)，与生产字符估算函数同口径（UTF-16 字符数）。不是 CLI 实际用量，后者包含自身系统上下文。每次调用均列出，增量与余量取首次；未发出请求不伪造估算。\n\n| 题号 | 前估算 | 后估算 | 首次增量 | 后距6000余量 |\n|---|---:|---:|---:|---:|\n';
before.forEach((b,i)=>{const bt=tok(b),at=tok(after[i]);md+=`| ${b.id} | ${bt.join('/')||'未到提供方'} | ${at.join('/')||'未到提供方'} | ${bt.length&&at.length?at[0]-bt[0]:'—'} | ${at.length?6000-at[0]:'—'} |\n`;});
for(const side of ['before','after']){const b=sets[side].find(r=>r.id==='B01'),s=b.fixture.snapshot;md+=`\nB01 ${side}：${s.correctionCandidates.length} 个纠错候选、${s.validDecisions.length} 条 Decision、${s.recentRelevantMessages.length} 条近期消息（上限 8、单条截断 400 字符）；调用 ${b.providerCalls} 次，状态 ${b.actual?.status}，原因 ${clean(b.actual?.reasonCodes?.join('、'))}。\n`;}
md+='\n6000 预算声明未在空工具分类路径执行：assertWithinInputBudget 仅位于 runWithToolLoop，本次路径走 runOpenAiCompatible/requestCompletion。超预算仍发出的数据说明拦截未生效，不能把未拒绝称为预算安全。本轮只记录，不加预算、不修改运行时。\n\n';
md+='## 已知缺口与结论边界\n\n- **识别正确 ≠ 新链路可执行**：intent-plan-commit.service.ts 对非 localActions、非 answer_in_chat、非隔离测试步骤的 applicable 计划置为 blocked / INTENT_ACTION_EXECUTOR_UNAVAILABLE。自然语言 resume、replan、retry_failed_step、非测试 enqueue_follow_up 缺少执行器，即使充分授权也会被拦截。精确命令“继续”“重试”等绕过新链路，不受该拦截。本轮不接执行器。\n- **检查点缺口**：提交层 compileIntentRoutePlan 没传 recoverableCheckpointId，retry_failed_step 还会因缺少检查点被拒绝。仅记录，不修复。\n- **默认关闭与预算缺口**：本轮不改变默认线上路由；空工具分类输入预算未执行。\n- **未验收执行**：效果授权、禁止项、资源定位、纠错事务、实际派发没有通过本轮服务级评测验收。L20/H07 仅评语义绑定与纯编译。\n- **样本与稳定性**：诊断集参与过调优，留出集同一评测方编写，没有独立双人标注。每构建一次完整服务评测，未追加稳定性轮次；不证明生产准确率、首轮识别和长会话泛化。\n\n';
md+=`## 证据\n\n- ${label}-revision/builds.json、restoration.json、configuration-freeze.json：构建、源码和配置校验。\n- ${label}-before-* / ${label}-after-*：33 题各自完整原始结果、模型输入输出、冷却记录。\n- ${label}-revision/comparison.json、check-matrix.json、scored-results.json：本轮统计，未混入旧成绩。\n- ${label}-revision/report-before-r3.md：本轮启动前报告快照；旧 report-pre-supervisor.md 和所有旧运行证据继续保留。\n`;
await writeFile(resolve(out,'report.md'),md);
await writeFile(resolve(root,'report.md'),md);
console.log(JSON.stringify({label,groups,regressionChecks:regressed.length,blocked},null,2));
