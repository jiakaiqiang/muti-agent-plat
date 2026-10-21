import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('docs/quality/intent-codex-comparison-2026-10-20'),out=resolve(root,'supervisor-revision');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const builds=await json(resolve(out,'builds.json')),restoration=await json(resolve(out,'restoration.json'));
if(!restoration.restored||!restoration.sourceUnchanged)throw Error('BUILD_RESTORATION_OR_PROMPT_FREEZE_FAILED');
const before=[],after=[],manifests=[];
for(const [name,rows]of [['before',before],['after',after]]){
 for(let batch=1;batch<=4;batch++){
  const folder=resolve(root,`review-${name}-${batch}`),manifest=await json(resolve(folder,'manifest.json'));
  if(manifest.buildHash!==builds[name==='before'?'baseline':'final'])throw Error('WRONG_BUILD');
  manifests.push(manifest);rows.push(...await json(resolve(folder,'results.json')));
 }
 rows.sort((a,b)=>a.id.localeCompare(b.id));
 if(rows.length!==33||new Set(rows.map(r=>r.id)).size!==33)throw Error('MISSING_COMPLETE_ROUND');
 for(const row of rows){
  if(row.fixture&&row.fixture.snapshot.activeWorkItem.status!==row.fixture.productionWorkItemStatus)throw Error('WRONG_WORKITEM_STATE');
 }
}
if(new Set(manifests.map(m=>m.casesHash)).size!==1)throw Error('CASE_SET_CHANGED');
const initialBudget={before:before.find(r=>r.id==='B01'),after:after.find(r=>r.id==='B01')};
for(const [name,rows]of [['before',before],['after',after]]){
 const folder=resolve(root,`review-budget-${name}-v2`),manifest=await json(resolve(folder,'manifest.json'));
 if(manifest.buildHash!==builds[name==='before'?'baseline':'final']||manifest.casesHash!==manifests[0].casesHash)throw Error('BUDGET_BUILD_OR_CASE_MISMATCH');
 const budget=await json(resolve(folder,'results.json'));
 if(budget.length!==1||budget[0].id!=='B01'||!budget[0].providerCalls)throw Error('BUDGET_PROBE_DID_NOT_REACH_PROVIDER');
 rows[rows.findIndex(r=>r.id==='B01')]=budget[0];
}
const definitions=await json(resolve(root,'review-before-1','cases.json'));
const definition=new Map(definitions.map(c=>[c.id,c]));
const status=(r,k)=>r.checks.find(c=>c.field===k)?.pass===true?'通过':r.checks.some(c=>c.field===k)?'失败':'未检查';
const keys=[...new Set([...before,...after].flatMap(r=>r.checks.map(c=>c.field)))];
const matrix=before.flatMap((b,i)=>keys.map(k=>({id:b.id,check:k,before:status(b,k),after:status(after[i],k)})));
const regressions=matrix.filter(r=>r.before==='通过'&&r.after!=='通过');
const improvements=matrix.filter(r=>r.before!=='通过'&&r.after==='通过');
const outcomes=rows=>rows.reduce((a,r)=>{const k=r.actual?.plan?.outcome??'no_plan';a[k]=(a[k]??0)+1;return a;},{});
const summarize=rows=>({count:rows.length,passed:rows.filter(r=>r.passed).length,validOutputs:rows.filter(r=>r.actual?.understanding).length,notReached:rows.filter(r=>!r.providerCalls).map(r=>r.id),providerCalls:rows.reduce((n,r)=>n+r.providerCalls,0),outcomes:outcomes(rows)});
const summary={diagnostic:{before:summarize(before.filter(r=>r.id.startsWith('L'))),after:summarize(after.filter(r=>r.id.startsWith('L')))},
 holdout:{before:summarize(before.filter(r=>r.id.startsWith('H'))),after:summarize(after.filter(r=>r.id.startsWith('H')))},regressions,improvements,builds,restoration,initialBudget};
const config=await json(resolve(out,'configuration-freeze.json'));
const connectionEvidence=[];
for(const name of ['before','after'])for(const label of [...[1,2,3,4].map(n=>`review-${name}-${n}`),`review-budget-${name}-v2`]){
 for(const file of await readdir(resolve(root,label))){
  if(!/^provider-\d+\.jsonl$/.test(file))continue;
  const log=await readFile(resolve(root,label,file),'utf8');
  if(log.includes('429 Too Many Requests')||log.includes('request timed out'))connectionEvidence.push({build:name,file:`${label}/${file}`,http429:log.includes('429 Too Many Requests'),timeout:log.includes('request timed out')});
 }
}
summary.connectionEvidence=connectionEvidence;
const envHash=config.envExists?createHash('sha256').update(await readFile('.env')).digest('hex'):null;
if(envHash!==config.envHash)throw Error('LOCAL_ENV_CHANGED');
summary.configurationUnchanged=true;
await writeFile(resolve(out,'comparison.json'),JSON.stringify(summary,null,2));
await writeFile(resolve(out,'check-matrix.json'),JSON.stringify(matrix,null,2));
await writeFile(resolve(out,'scored-results.json'),JSON.stringify({before,after},null,2));
const clean=s=>String(s??'—').replaceAll('|','/').replaceAll('\n',' ');
const actual=r=>r.actual?.understanding?.segments.map(s=>`${s.scopeRelation} → ${s.suggestedAction}`).join('；')??r.actual?.reasonCodes?.join(',')??r.error;
let md='# 意图识别与路由真实模型评测：监督修正版\n\n';
md+='**评测状态：受阻，不能作为最终优化结论。** 两构建已完整遍历原 20 题和新 12 题，但超时、HTTP 429 和熔断导致大量题目没有模型输出。优化后诊断集仅 3 题、留出集 0 题有有效语义输出；这不满足完整真实模型前后比较的验收条件。下列负向差异混有基础设施影响，不能判定提示词退化，也不能宣称优化成功。\n\n';
md+='**适用范围：本次被测和被优化的是默认关闭的 `intent-understanding-v1` 新链路。本次优化对默认配置下的线上消息路由不生效。** 建立使用新链路的会话，需同时满足 `INTENT_UNDERSTANDING_ENABLED=true` 与 `INTENT_ROUTING_MODE=enforce_new_sessions` 或 `enforce_all_current_epoch` 的准入条件。本轮没有开启开关，没有修改默认配置，没有扩展工作流。\n\n';
md+=`生成时间：${new Date().toISOString()}。此前 13→17→20 的三轮使用了非生产 WorkItem 状态夹具，**不再作为最终优化幅度结论**；完整原文保留在 report-pre-supervisor.md。以下以修正夹具后的重跑为准。\n\n`;
md+='## 结果概览\n\n| 集合 | 优化前 | 优化后 | 差异 |\n|---|---:|---:|---:|\n';
for(const [key,name]of [['diagnostic','原 20 题诊断集'],['holdout','新 12 题留出集']]){const s=summary[key];md+=`| ${name} | ${s.before.passed}/${s.before.count} | ${s.after.passed}/${s.after.count} | 无效（连接受阻） |\n`;}
md+='\n诊断集参与过提示词调优，留出集在本轮开始前新写并冻结，未用于提示词修改。两组分别报告，不混合成一个“准确率”。模型为本地 Codex 的 gpt-6-astra/high，使用真实 CLI 调用；不是模拟结果。单次采样不能证明稳定性或生产准确率。\n\n';
md+='### 模型覆盖与连接干扰\n\n| 集合 | 前有效语义输出 | 后有效语义输出 | 前未到提供方 | 后未到提供方 |\n|---|---:|---:|---|---|\n';
for(const [key,name]of [['diagnostic','诊断集'],['holdout','留出集']]){const s=summary[key];md+=`| ${name} | ${s.before.validOutputs}/${s.before.count} | ${s.after.validOutputs}/${s.after.count} | ${s.before.notReached.join('、')||'无'} | ${s.after.notReached.join('、')||'无'} |\n`;}
md+='\n整题成绩包含调用失败、结构错误和路由错误，是本轮服务评测通过数，不是纯模型准确率。HTTP/CLI 超时以及后续 PROVIDER_CIRCUIT_OPEN 属于连接/运行时干扰；没有语义输出的题无法判断模型是否识别正确。前后差异受到这些干扰，不能全部归因于提示词优化。没有仅重跑失败题再拼接成绩。\n\n';
md+=`CLI 原始事件中，${connectionEvidence.filter(e=>e.http429).length} 个调用日志包含 HTTP 429 Too Many Requests，${connectionEvidence.filter(e=>e.timeout).length} 个包含 request timed out（可重叠，包含后来恢复成功的调用，不能直接当作失败题数）。日志显示 WebSocket 重连后回退 HTTPS，部分仍收到 429。逐调用文件清单见 comparison.json 的 connectionEvidence。\n\n`;
md+='| 两边都有有效语义输出的配对子集（仅辅助分析） | 题数 | 前通过 | 后通过 |\n|---|---:|---:|---:|\n';
for(const [prefix,name]of [['L','诊断集'],['H','留出集']]){
 const pairs=before.map((b,i)=>[b,after[i]]).filter(([b,a])=>b.id.startsWith(prefix)&&b.actual?.understanding&&a.actual?.understanding);
 md+=`| ${name} | ${pairs.length} | ${pairs.filter(([b])=>b.passed).length} | ${pairs.filter(([,a])=>a.passed).length} |\n`;
}
md+='\n该配对子集排除了无有效输出的题，有选择偏差；只能辅助定位语义与路由差异，不能替代上方完整集合成绩。\n\n';
md+='## P0：夹具、构建和准入范围\n\n- 夹具直接调用 `SessionsService.workItemStatusForSessionStatus()`，并断言实际快照状态一致：EXECUTING→EXECUTING；PAUSED/INTERRUPTED/WAIT_*→WAITING_USER；FAILED→FAILED。没有再将这些状态统一写成 OPEN。\n';
md+=`- 优化前分类器实际构建 SHA-256：\`${builds.baseline}\`；优化后：\`${builds.final}\`。按监督要求将 baseline-semantic-router.js 换入 dist，全部前测结束后换回最终构建，完成后再次恢复与核验；restoration.json 确认恢复成功。其余运行时和编译器保持同一构建。\n`;
md+=`- 提示词源码冻结 SHA-256：\`${builds.frozenSource}\`。本轮没有第三次调参，前后全部 33 个夹具的题集哈希一致：\`${manifests[0].casesHash}\`。\n`;
md+='- 本地 .env 没有上述 INTENT 开关，默认模式为 shadow；哈希核验确认 .env 未改动。评测仍设 shadow/false 后直接调用新服务，这是隔离的服务级集成评测，绕过产品入口开关，不是当前默认线上链路的端到端成绩。\n- 路径：真实 IntentUnderstandingRoutingService → SemanticIntentRouterService → GenericLlmRuntime → 本地 HTTP/Codex CLI 桥 → 真实 compileIntentRoutePlan。无业务派发；只读沙箱、空工具目录；未修改任何模型连接配置。\n- 每题完整重跑，前后随机 ID 不同，使用相同夹具模板、模型和预算。330 秒逻辑操作、160 秒应用调用、150 秒 CLI 观察上限；原有两次识别预算保留。CLI 自身连接重试/回退仍存在。\n\n';
for(const [prefix,title]of [['L','诊断集'],['H','留出集']]){
 md+=`## ${title}：具体题目与结果\n\n| 题号 | Session / WorkItem | 具体题目 | 优化前 | 优化后 | 整题前→后 |\n|---|---|---|---|---|---|\n`;
 for(let i=0;i<before.length;i++){const b=before[i],a=after[i];if(!b.id.startsWith(prefix))continue;md+=`| ${b.id} | ${clean(b.fixture?.sessionStatus)} / ${clean(b.fixture?.productionWorkItemStatus)} | ${clean(b.message)} | ${clean(actual(b))} | ${clean(actual(a))} | ${b.passed?'通过':'失败'}→${a.passed?'通过':'失败'} |\n`;}
 md+='\n逐项表以本集合全部题目为分母；“未检查”包含该题不适用的条件检查，以及结构校验失败后未能继续检查，不计为通过。\n\n| 检查项 | 前：通过 / 失败 / 未检查 | 后：通过 / 失败 / 未检查 | 题内退步 |\n|---|---|---|---|\n';
 for(const k of keys){const cells=matrix.filter(r=>r.id.startsWith(prefix)&&r.check===k);if(!cells.length)continue;const counts=side=>['通过','失败','未检查'].map(v=>cells.filter(c=>c[side]===v).length).join(' / ');md+=`| ${k} | ${counts('before')} | ${counts('after')} | ${cells.filter(c=>c.before==='通过'&&c.after!=='通过').map(c=>c.id).join('、')||'无'} |\n`;}
 md+='\n';
}
md+='## P1：题内退步与路由结果变化\n\n';
md+='| 题号 | 检查项 | 前 | 后 |\n|---|---|---|---|\n';
for(const r of regressions)md+=`| ${r.id} | ${r.check} | ${r.before} | ${r.after} |\n`;
if(!regressions.length)md+='| — | 本轮没有通过→失败/未检查的检查项 | — | — |\n';
md+='\n不能只看整题 regressed。原三轮中，L20 基线只有动作名不匹配，第一次优化却新增 correctionBinding、routeReferencesAndRelation 失败；该题原本就失败，所以旧的整题 regressed=[] 漏掉了题内退步。旧轮次 routeReferencesAndRelation 为 18→17，applicable 为 6→5，均保留记录，不能描述为全面改善。\n\n';
for(const [key,name]of [['diagnostic','修正诊断集'],['holdout','留出集']])md+=`${name}编译结果分布：前 ${JSON.stringify(summary[key].before.outcomes)}；后 ${JSON.stringify(summary[key].after.outcomes)}。\n\n`;
md+='applicable 下降本身不是错误率指标：应结合每题状态、授权和期望判断。正向恢复 H01/H11 单独检查 positiveResumeApplicable，必须实际编译为 applicable + resume，不能靠安全澄清获得通过。所有检查项的逐题前后状态见 supervisor-revision/check-matrix.json。\n\n';
md+='### 优化后仍失败的题目\n\n| 题号 | 未通过检查 | 编译结果 / 原因 |\n|---|---|---|\n';
for(const r of after.filter(r=>!r.passed))md+=`| ${r.id} | ${clean(r.checks.filter(c=>!c.pass).map(c=>c.field).join('、')||r.error)} | ${clean(r.actual?.plan?.outcome)} / ${clean(r.actual?.plan?.validation?.errorCodes?.join('、')||r.actual?.reasonCodes?.join('、'))} |\n`;
if(after.every(r=>r.passed))md+='| — | 本次单次采样无失败 | 不代表稳定通过 |\n';
md+='\n以上失败保留在最终成绩中，本轮没有据此修改提示词，也没有用单题重跑替换结果。\n\n';
md+='恢复正例应区分动作识别、纯编译与提交执行：本夹具没有历史可执行资源授权，额外请求未解析的 modify_source 会触发 EFFECT_TARGET_UNRESOLVED。但即使授权完整、纯编译结果为 applicable，自然语言 resume 在新链路提交层仍因缺少执行器被 INTENT_ACTION_EXECUTOR_UNAVAILABLE 阻断。因此 positiveResumeApplicable 只检查纯编译，不能证明生产恢复可执行，也不能把失败全部归为过度澄清。精确命令（如“继续”“重试”）在消息入口绕过新链路，不受这条提交拦截影响。\n\n';
md+='## P2：输入 token 预算\n\n估算使用生产函数同口径 `ceil(JSON.stringify({messages}).length / 4)`（JS UTF-16 字符数），从实际发往桥接提供方的 messages 计算；不是 Codex CLI 报告的真实 token。后者包含 CLI 自身系统上下文，不能混作应用的 6000 输入预算。下表多次调用时列出每次估算，差值取首次。\n\n| 题号 | 前估算 | 后估算 | 首次增量 | 后首次距 6000 余量 |\n|---|---:|---:|---:|---:|\n';
const tokens=r=>(r.tokenEstimates??[]).map(t=>t.estimatedInputTokens);
for(let i=0;i<before.length;i++){const b=before[i],a=after[i],bt=tokens(b),at=tokens(a);md+=`| ${b.id} | ${bt.join('、')||'未到提供方'} | ${at.join('、')||'未到提供方'} | ${bt.length&&at.length?at[0]-bt[0]:'—'} | ${at.length?6000-at[0]:'—'} |\n`;}
const b=before.find(r=>r.id==='B01'),a=after.find(r=>r.id==='B01');
md+='\nB01 的初版历史路由夹具未置为已完成，被生产队列顺序规则挡住，前后均无模型调用；原始记录保留在 review-before-4 / review-after-4，不作为模型失败或预算拒绝。随后仅修正历史路由为已完成，对两构建分别进行独立预算实验 review-budget-before-v2 / review-budget-after-v2，上表 B01 使用该有效实验。原 20 题和 12 题成绩没有替换、题目期望没有变化。\n';
md+=`\n大会话 B01 使用真实 ContextManagement 构造：前/后快照分别有 ${b.fixture?.snapshot.correctionCandidates?.length}/${a.fixture?.snapshot.correctionCandidates?.length} 个纠错候选、${b.fixture?.snapshot.validDecisions?.length}/${a.fixture?.snapshot.validDecisions?.length} 条 Decision、${b.fixture?.snapshot.recentRelevantMessages?.length}/${a.fixture?.snapshot.recentRelevantMessages?.length} 条近期消息（上限 8，单条截断上限 400 字符）。不是在模型输出后追加上下文。\n\n`;
md+=`B01 前状态 ${b.actual?.status??b.error}，提供方调用 ${b.providerCalls}；后状态 ${a.actual?.status??a.error}，提供方调用 ${a.providerCalls}。前错误 ${clean(b.actual?.reasonCodes?.join(','))}；后错误 ${clean(a.actual?.reasonCodes?.join(','))}。\n\n`;
md+='**预算实现核查发现额外缺口：** generic-llm-runtime.service.ts 的 assertWithinInputBudget 位于 runWithToolLoop，只有存在工具且满足工作区条件才进入；本次分类空工具路径走 runOpenAiCompatible/requestCompletion，没有执行这条输入预算断言。因此“未被拒绝”不能证明没有超出 6000，也不能据此宣称大会话预算安全。若表中估算超过 6000 仍到达提供方，正是此缺口的实测证据。本轮只记录，不接入新拦截、不增加预算、不改默认配置。工具循环另有安全余量和输出预留，其口径不能冒充本次空工具路径已生效。\n\n';
md+='## 已知缺口与结论边界\n\n- **默认关闭**：本轮收益不作用于默认线上消息入口。开启两个开关或修改准入不是本轮工作。\n- **失败重试提交缺口**：RoutePlanCompiler 要求 recoverableCheckpointId 才允许 retry_failed_step；当前唯一 IntentPlanCommit 调用没有传入该参数，即使提示词提到检查点，生产提交仍会拒绝此动作。这里只记录，没有接线修复。\n- **预算缺口**：空工具分类路径没有使用工具循环的输入预算拦截；新增规则压缩了剩余上下文空间，详见逐题和 B01 实测数据。\n- **执行与资源范围未验收**：PROHIBITION_NOT_ENFORCEABLE、EFFECT_TARGET_UNRESOLVED、多目标确认等仍可能阻断执行；诊断检查通过不等于任务可执行。\n- **纠错绑定边界**：L20/H07 提供旧 Decision，但没有完整历史路由映射，只评语义绑定与纯编译，不证明纠错事务一定可提交。\n- **非独立大样本**：留出题在本轮新写、未用于调参，但仍为同一评测方编写，非盲测/双人标注代表性样本；首轮领域识别、真实 UI/HTTP 全链路和长会话泛化未覆盖。\n- **稳定性未测**：两构建每题一次采样（系统原有修复预算保留）。额度检查时周额度已用 86%、无付费余额，为完成必需 66 个样本，未追加可选重复轮次，未使用额度重置。不能给出逐题重复稳定率，不拼接重跑最佳结果。\n- **历史结论撤回**：原三轮夹具错误可能夸大 Session 状态提示词带来的提升，不能继续把 L16/L11 的旧改善幅度归因于代码；只使用本修正版重跑数据。\n\n';
md+='## 复核与产物\n\n- supervisor-revision/builds.json、restoration.json：实际 dist 替换、冻结源码与恢复哈希。\n- review-before-* / review-after-*：完整原始结果、冻结题集、真实 Codex 输入/输出和调用事件。\n- supervisor-revision/comparison.json、check-matrix.json、scored-results.json：分集统计和全部逐检查项证据。\n- report-pre-supervisor.md、原 baseline/optimized/final 目录：保留历史，已注明夹具问题。\n- 本轮只改评测夹具、留出题、评测/报告脚本与文档；产品提示词、路由策略、默认配置、工作流均未修改。\n';
md=md.replace('## 已知缺口与结论边界\n\n','## 已知缺口与结论边界\n\n- **新链路动作执行器缺失：识别正确 ≠ 新链路可执行。** `intent-plan-commit.service.ts:145–146` 对非 localActions、非 answer_in_chat、非隔离测试步骤的 applicable 计划调用 blockPlan，改为 blocked（`:326–329`），错误码为 INTENT_ACTION_EXECUTOR_UNAVAILABLE。受影响动作包括自然语言 `resume`、`replan`、`retry_failed_step` 和非测试范围的 `enqueue_follow_up`；即使授权充分也无法通过这条提交路径执行。L01/L06/L08/L14/L16、H03 的非测试 enqueue_follow_up，以及 L10/H10 的 replan，识别正确仍不代表可执行。精确命令在 `sessions.service.ts:2383` 绕过新链路，不受此限制。本轮只记录，不接执行器。\n')
 .replace('每题完整重跑，前后随机 ID 不同','逐题执行服务评测（不代表每题获得模型输出），前后随机 ID 不同')
 .replace('本轮收益不作用于默认线上消息入口','本轮所评改动不作用于默认线上消息入口')
 .replace('两构建每题一次采样（系统原有修复预算保留）','两构建逐题进行一次服务评测，部分被熔断而没有模型采样（系统原有修复预算保留）');
md+='\n## 尚未达到的验收条件\n\nP0 的生产状态映射、构建恢复和默认关闭说明已落实；P1 的留出题与逐检查项表已生成，但完整真实模型覆盖仍受阻，特别是两个正向 resume 留出题在优化后均未得到模型输出，不能验收恢复正确性。P2 已证实大会话输入从 7552 增至 8412，且超过 6000 后仍发送；未到提供方的题没有实发 token 数据，表中明确留空，未推算冒充实测。失败重试提交缺口已记录，未修改产品实现。\n\n待本地模型连接不再持续 429/超时后，需将冻结的 20+12 题在两个构建上各重新完整运行，并保留为新的独立轮次，不能只补失败题拼接本轮成绩。新轮次不得修改提示词、题目或期望。本报告是可复核的受阻记录，不是最终准确率报告。\n';
md+='\n## 第二轮复核后的评测脚本修正（未启动重跑）\n\n批次和题目均串行执行，并发为 1。只有 INTENT_PROVIDER_CIRCUIT_OPEN 且本题 providerCalls 为 0、没有模型输出时，才读取调用结果 error.details.retryAfterMs，等待后在同一次运行内重试该题。因原路由已为终态，每次这种准入重试重新建立同一题的隔离夹具，不修改产品路由状态机。每题 transport-<题号>.json 和 results.json 的 transport 字段保存各次结果、retryCount、requestedWaitMs、actualWaitMs、waitTotalMs；等待前即落盘。最多 3 次冷却重试；缺少有效 retryAfterMs 或达到上限时保留受阻记录，不立即循环。只要已调用提供方或得到任何模型输出（含错误/结构失败），就保留该次结果，不进行这种重跑；系统原有单次分类内部修复预算不变。两个构建使用同一个处理函数，后续轮次要求新的 run-label 以保留历史。当前报告仍基于旧轮次，脚本修正不追溯改变成绩。按用户要求，真实模型重跑须等待用户确认额度后手动启动。\n';
await writeFile(resolve(root,'report.md'),md);
console.log(JSON.stringify(summary,null,2));
