import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root=process.cwd(),out=resolve('docs/quality/intent-evaluation-2026-10-19');
const read=async name=>JSON.parse(await readFile(resolve(out,'evidence',name),'utf8'));
const diagnostic=await read('diagnostic-results.json');
const live=await read('codex-live-results.json');
const http=await read('correction-http-results.json');
const correctedFixture=await read('codex-correction-target-ready-results.json');
const correctionTarget=correctedFixture.results[0];
if(!correctionTarget?.invocations?.some(i=>i.runtimeType==='codex'&&i.status==='completed'))throw Error('Supplementary correction fixture has no real model output.');
for(const [name,expected] of [['baseline-tests.log',245],['supplemental-tests.log',94]]){
 const log=await readFile(resolve(out,'evidence',name),'utf8');
 if(Number(log.match(/^# tests (\d+)$/m)?.[1])!==expected||Number(log.match(/^# pass (\d+)$/m)?.[1])!==expected||!/^# fail 0$/m.test(log))throw Error(`Unexpected regression evidence: ${name}`);
}
if(live.results.length!==40)throw Error(`Live evaluation incomplete: ${live.results.length}/40`);
const pct=(n,d)=>d?`${(100*n/d).toFixed(1)}%`:'N/A';
const cell=value=>String(typeof value==='string'?value:JSON.stringify(value)).replaceAll('|','\\|').replace(/\r?\n/g,'<br>');
const table=(headers,rows)=>`| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n${rows.map(row=>`| ${row.map(cell).join(' | ')} |`).join('\n')}\n`;
const summary=rows=>({total:rows.length,passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length});
const legacyRows=live.results.filter(x=>x.path==='legacy'),v2Rows=live.results.filter(x=>x.path==='v2');
const legacy=summary(legacyRows),v2=summary(v2Rows),correction=summary(http.results);
const successfulInvocation=row=>row.invocations.some(i=>i.runtimeType==='codex'&&i.status==='completed');
const fields=rows=>{const result={};for(const row of rows)for(const check of row.checks){const entry=result[check.field]??={total:0,passed:0};entry.total++;if(check.pass)entry.passed++;}return result;};
const latency=rows=>{const sorted=rows.map(x=>x.durationMs/1000).sort((a,b)=>a-b);return {p50:sorted[Math.ceil(sorted.length*.5)-1].toFixed(2),p95:sorted[Math.ceil(sorted.length*.95)-1].toFixed(2),mean:(sorted.reduce((a,b)=>a+b,0)/sorted.length).toFixed(2)};};
const invocations=live.results.flatMap(x=>x.invocations);
if(live.results.some(row=>!successfulInvocation(row)))throw Error('A semantic row lacks a completed real Codex invocation; adjudicate availability separately before reporting accuracy.');
const invocationIds=new Set(invocations.map(x=>x.invocationId));
let persistedInvocations=[],evaluationStateFile;
for(const name of (await readdir(resolve('.cache/agent-cluster'))).filter(x=>x.startsWith('intent-evaluation-codex-live-')&&x.endsWith('.json'))){
 const candidate=resolve('.cache/agent-cluster',name);
 const state=JSON.parse(await readFile(candidate,'utf8'));
 const matching=Object.values(state.runtimeInvocationsBySession??{}).flat().filter(x=>invocationIds.has(x.invocationId));
 if(matching.length===invocationIds.size){persistedInvocations=matching;evaluationStateFile=candidate;break;}
}
if(persistedInvocations.length!==invocationIds.size)throw Error('Persisted runtime evidence is incomplete.');
const runtimeAudit={
 evaluationStateFile,
 invocationCount:persistedInvocations.length,
 allCodex:persistedInvocations.every(x=>x.runtimeType==='codex'),
 allRouting:persistedInvocations.every(x=>x.phase==='user_message_routing'),
 emptyToolCatalogs:persistedInvocations.every(x=>x.toolCatalog?.tools?.length===0),
 workspaceChangeCount:persistedInvocations.reduce((sum,x)=>sum+(x.systemEvidence?.workspaceChangeSet?.changes?.length??0),0),
 testExecutionCount:persistedInvocations.reduce((sum,x)=>sum+(x.systemEvidence?.verifiedTestResults?.length??0),0),
 records:persistedInvocations.map(x=>({invocationId:x.invocationId,agentKey:x.agentKey,runtimeType:x.runtimeType,phase:x.phase,status:x.status,startedAt:x.startedAt,completedAt:x.completedAt,executionTarget:x.executionTarget,toolNames:x.toolCatalog?.tools?.map(t=>t.name),systemEvidence:x.systemEvidence,profileSnapshot:x.profileSnapshot,contextEnvelope:x.contextEnvelope,expectedOutput:x.expectedOutput,usage:x.usage}))
};
await writeFile(resolve(out,'evidence/runtime-audit.json'),JSON.stringify(runtimeAudit,null,2));
const v2Fields=fields(v2Rows),legacyFields=fields(legacyRows);
const semanticFailures=live.results.filter(x=>!x.passed);
const firstTurn=diagnostic.results.filter(x=>x.id.startsWith('T'));
const firstTurnMetrics={intentCorrect:firstTurn.filter(x=>x.expected.intents.includes(x.actual.intent)).length,codeChangeFlagCorrect:firstTurn.filter(x=>x.expected.requiresCodeChanges===x.actual.requiresCodeChanges).length,readOnlyCount:firstTurn.filter(x=>!x.expected.requiresCodeChanges).length,falseCodeChange:firstTurn.filter(x=>!x.expected.requiresCodeChanges&&x.actual.requiresCodeChanges).length};
const relationLabels=['same_requirement','related_new_requirement','independent_new_requirement','ambiguous'];
const matrix=relationLabels.map(expected=>[expected,...relationLabels.map(actual=>v2Rows.filter(row=>row.expected.relation===expected&&row.actual?.decision?.scopeRelation===actual).length)]);
const safeCases=v2Rows.filter(x=>x.expected.clarify),clearCases=v2Rows.filter(x=>!x.expected.clarify);
const premature=safeCases.filter(x=>x.actual?.autoApplicable===true);
const excessive=clearCases.filter(x=>x.actual?.autoApplicable===false);
const notes={
 T10:'否定/只讨论未约束 requiresCodeChanges。',T11:'“不要修改代码”仍被修改关键词命中。',T12:'无讨论分类命中，默认 implementation。',T13:'非编码会议纪要仍被标记需要改代码。',T14:'“不要运行测试”仍优先命中 validation。',T15:'英文 implement 命中改代码标记，忽略 without changing code。',T17:'“解释”未匹配询问规则，落到 implementation。',T19:'问句 intent 正确，但“重构”使改代码标记为 true。',T20:'多意图被测试关键词优先覆盖，实现主目标丢失。',
 F02:'否定“新任务”仍命中新任务关键词。',F03:'否定“新任务”仍命中新任务关键词。',F04:'“另外补充”被解释为新需求。',F07:'not a new task 仍命中新任务关键词。',S08:'规则捕获了否定新增功能；只证明分流命中，约束是否应进入范围变更流程需产品裁定，未发生新增功能。',
 V05:'重试能恢复，但该层第二次输入没有加入刚才的 Schema 错误反馈。',V15:'仅校验层放行，不代表真实业务取消已执行；服务端危险动作策略依赖模型 riskLevel。',V16:'目标 ID 合法仍可能出现关系、动作和上下文策略相互矛盾。',V17:'内部 Router 与入口命令裁决不一致；已完成任务的真实入口守卫测试通过，不能据此认定用户入口必然误执行。',V18:'这是边界观察题通过，不是低置信度也准确；serverConfidence 是规则评分。'
};
const diagnosticActual=x=>{
 if(x.id.startsWith('V'))return {calls:x.actual.calls,autoApplicable:x.actual.autoApplicable,action:x.actual.decision?.requestedAction,relation:x.actual.decision?.scopeRelation,risk:x.actual.decision?.riskLevel,serverConfidence:x.actual.validation?.serverConfidence,errors:x.actual.validation?.errors};
 if(x.id.startsWith('F'))return {intent:x.actual.intent,relation:x.actual.requirementRelation,failedExecutionAction:x.actual.failedExecutionAction};
 return x.actual;
};
const diagnosticRows=diagnostic.results.map(x=>[x.id,x.message,x.status??(x.id.startsWith('T')?'首轮无状态':x.id.startsWith('S')?'执行期规则':x.id==='V17'?'COMPLETED':'WAIT_USER_CONFIRM'),x.expected,diagnosticActual(x),x.passed?'通过':'未通过',notes[x.id]??'']);
let cases='# 意图识别逐题评测记录\n\n题目和可接受答案在各组第一次执行前写入脚本。未按输出结果回改答案。完整 UUID、校验错误、调用输出见 evidence 中 JSON；以下为可读记录。题库是人工编写的诊断集，未经过独立双人标注。\n\n';
cases+='## A. 规则与注入校验：70 题\n\nT 为首轮意图/改代码标记（domain 仅记录，未评分）；F 为规则兜底关系；C 为精确命令状态裁决；S 为执行期专项规则；V 为模拟 Runtime 输出/故障后运行真实服务端校验。V 默认 WAIT_USER_CONFIRM，V17 为 COMPLETED；S 模拟执行期规则，不代表完整业务效果。\n\n';
cases+=table(['编号','题目或注入条件','状态','预期','实际','结果','说明'],diagnosticRows);
cases+='\n## B. 本地 Codex 真实模型：20 题、两条链路\n\n统一初始目标：“实现一个登录接口，使用 PostgreSQL，保持现有数据库表结构。”每题使用全新会话，含一条已确认 PostgreSQL/表结构约束。无上一题答案污染。FAILED 状态没有构造真实执行失败检查点；因此本组只验识别出的恢复动作。L20 没有实际写入旧 10 分钟决定，不能据此证明旧决定已被废弃。\n\n';
cases+=table(['编号','功能点/状态','具体题目','预设新路由答案','旧识别结果','新路由结果'],v2Rows.map(row=>{
 const old=legacyRows.find(x=>x.id===row.id);const d=row.actual?.decision;
 return [row.id,`${row.feature} / ${row.sessionStatus}`,row.message,{relation:row.expected.relation,action:row.expected.action,policy:row.expected.policy,dialogue:row.expected.dialogue,clarify:!!row.expected.clarify,inherit:row.expected.inherit,mention:row.expected.mention},`${old.passed?'通过':'未通过'}；${JSON.stringify(old.actual??old.error)}；未通过字段=${old.checks.filter(x=>!x.pass).map(x=>x.field).join(',')}`,`${row.passed?'通过':'未通过'}；${JSON.stringify(d??row.error)}；自动应用=${row.actual?.autoApplicable}；未通过字段=${row.checks.filter(x=>!x.pass).map(x=>x.field).join(',')}`];
}));
cases+='\n## C. 人工纠错 HTTP：7 项\n\n合成用户消息统一为：“先继续修复登录问题，再新增导出功能。”mock 模型先产生待澄清状态，然后实际调用 localhost HTTP 接口。统计隔离数据库中的 WorkItem 和事件，未接入真实开发执行。H05 的确认编号严格绑定是本次建议的强化验收要求，现有 DTO 中 confirmationId 可选。\n\n';
cases+=table(['编号','功能点','操作/预期','实际摘要','结果'],http.results.map(x=>[x.id,x.feature,x.expected,{status:x.actual.status??x.actual.statuses,action:x.actual.returnedAction??x.actual.routing?.decision?.requestedAction,before:x.actual.before,after:x.actual.after??x.actual.counts,contextPolicy:x.actual.routing?.decision?.contextPolicy},x.passed?'通过':'未通过']));
cases+='\n## D. 原题前提补全后的对照：L20B\n\n原 L20 没有旧 10 分钟决定，因此新路由合理地要求澄清。本对照保持原题原期望，额外在同一 WorkItem 的 Decision Ledger 中写入已确认约束“当前登录任务的超时时间为 10 分钟。”，单独调用真实 Codex 新路由。它在看过原始结果后设计，不并入预先声明的 40 条基准。首次单路径 fixture 缺少 workspace binding，被运行时门禁拦截，没有模型回答；补全测试夹具后执行如下。\n\n';
cases+=table(['编号','题目','前提','实际','结果'],[['L20B',correctionTarget.message,'快照中已有 confirmed 的 10 分钟约束',correctionTarget.actual,correctionTarget.passed?'通过':'未通过']]);
await writeFile(resolve(out,'cases-and-results.md'),cases);

let report=`# 当前系统意图识别、路由与纠错评测报告\n\n评测日期：2026-10-19（Asia/Shanghai）。对象为当前工作区及其未提交修改，基线提交 bb3d278db3e734b643abef015bdd2190ef578638。\n\n**结论：现有防重复、引用校验和失败恢复已有有效保护，但本次评测尚不足以支持“意图识别准确且可以无条件自动执行”的结论。** 规则层存在明确否定/只读请求误判；人工纠错缺少相反选择冲突反馈。应优先修复这些可复现问题，再做独立标注的真实模型回归与灰度验收。\n\n`;
report+='## 1. 本次实际执行结果\n\n';
report+=table(['评测层','结果','它能证明什么'],[
 ['已有相关回归','245 / 245 通过','已有断言未回归；不能当作自然语言准确率'],
 ['补充 Runtime 控制与 Orchestrator 回归','94 / 94 通过','覆盖入口新增 Runtime 切换/继续语法和上下文编排；已有回归合计 339 项'],
 ['新编规则与注入题',`${diagnostic.summary.passed} / ${diagnostic.summary.total} 通过；${diagnostic.summary.failed} 项未通过`,'实际规则执行与注入输出校验；不是 70 次真实模型回答'],
 ['真实 Codex：旧识别链路',`${legacy.passed} / ${legacy.total}（${pct(legacy.passed,legacy.total)}）逐题断言通过`,'主要验证关系、消息类型、澄清及失败动作'],
 ['真实 Codex：新意图路由',`${v2.passed} / ${v2.total}（${pct(v2.passed,v2.total)}）逐题断言通过`,'还验证动作、目标、继承、上下文策略和明确 @'],
 ['真实 Codex：补充旧约束对照 L20B',`${correctionTarget.passed?1:0} / 1 通过`,'补齐已确认 10 分钟约束后再判；属于结果复核，不计入 40 条原始基准'],
 ['真实 HTTP 人工纠错',`${correction.passed} / ${correction.total} 通过；${correction.failed} 项未通过`,'mock 判定进入澄清后，真实接口与持久化的纠错行为'],
 ['已有 HTTP 路由 smoke','通过','双客户端重复消息只落一条；多意图进入澄清'],
 ['组件故障矩阵','6 / 6 通过','重复提交、乱序完成、reserve 后恢复、删除后回调、预算耗尽、删除后缓存回填'],
 ['进程崩溃恢复','通过；2 attempts / 1 published record','租约到期后接管，无重复业务效果；不是生产全链路故障率']
]);
report+='\n不同层的样本和判定标准不同，**不合并成一个“整体准确率”**。全部题目、预期和实际输出见 [逐题记录](cases-and-results.md)。\n\n';
report+='原始真实模型断言的三项差异经复核分别为：旧链路 L11 多意图处理偏差、旧链路 L17 安全拒绝与预设澄清标签不一致、新路由 L20 因测试快照缺少旧约束而合理澄清。L20 补齐前提后的独立对照通过。原始分数不改写，也不把两项合理保护解释成安全失败。\n\n';
report+=table(['诊断功能组','通过/总数'],Object.entries(diagnostic.summary.byFeature).map(([name,s])=>[name==='首轮领域与写权限判断'?'首轮意图/改代码标记（domain 未评分）':name,`${s.passed}/${s.total}`]));
report+=`\n首轮 20 题中，intent 标签符合预期 ${firstTurnMetrics.intentCorrect}/20，requiresCodeChanges 标记正确 ${firstTurnMetrics.codeChangeFlagCorrect}/20；${firstTurnMetrics.readOnlyCount} 道预期不改代码的题有 ${firstTurnMetrics.falseCodeChange} 道被标成需要改代码。这是刻意覆盖边界的诊断集，不是线上误写率，且本次没有执行代码写入。\n\n`;
report+='## 2. 当前系统如何识别与路由\n\n';
report+='首轮创建任务使用 `IntentRecognitionService` 的关键词优先级规则，输出 domain、intent、requiresCodeChanges。后续消息先经过幂等检查、Runtime 控制、确认卡专项、精确命令和执行期专项规则，再进入语义识别。精确命令会结合会话状态裁决，例如 COMPLETED 的“继续执行”应澄清。\n\n';
report+='工作区 `.env` 未指定 `INTENT_ROUTING_MODE`，源码默认 `shadow`；这表示新路由在该配置下主要作旁路记录，实际旧识别链路仍重要。部署环境可能有额外覆盖，本次未检查远端部署。旧链路调用 Coordinator 返回 `UserMessageHandlingPlan`；暂停会话先用本地规则入队，恢复后再识别；模型调用异常时，`recognizeFollowUpHandlingPlan` 也会退回本地规则。因此原连接 401 使规则层误判具备实际影响路径。本次 Codex 只用于隔离评测，未修改系统默认连接。新链路在 enforce 模式下生成快照，调用 intent_router 返回 `IntentRoutingDecisionV2`，再校验引用、状态、快照、@ 目标、歧义和风险，合格后进入原子路由应用。\n\n';
report+='快照包含活动 WorkItem、候选任务、有效决定、近期消息、待确认内容与失败信息。服务端 `serverConfidence` 是按校验项扣分的工程分数，不是语义正确概率；本次 V18 证明模型自报置信度 0.1 时服务端仍可给 1 并允许应用。不能以“置信度=1”保证理解正确。\n\n';
report+='代码依据：[首轮与规则兜底](../../../apps/server/src/modules/intent-recognition/intent-recognition.service.ts)、[消息入口与模式](../../../apps/server/src/modules/sessions/sessions.service.ts)、[新路由及校验](../../../apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts)、[命令状态裁决](../../../apps/server/src/modules/message-routing/command-state-resolver.service.ts)。\n\n';
report+='## 3. 评测功能点和步骤\n\n';
report+=table(['功能点','本次题目','验收重点'],[
 ['首轮任务意图、只读和否定','T01–T20','询问/分析/评审/计划/实现/测试区别；“不要改代码”不得产生改代码标记'],
 ['新旧需求关系与上下文隔离','F01–F08、L01–L08、L14','否定新任务；“另外补充”；相关新任务只继承选中约束；独立任务清空旧任务上下文'],
 ['命令、状态与控制边界','C01–C16、S01–S08、L09–L10、L16','暂停/失败/完成/执行中的同一句话；不能把否定或询问当执行命令'],
 ['歧义、多意图、实体引用','L11–L13、L17、V08–V13','歧义澄清；虚构 ID 拦截；@ 对象完整；快照过期拦截'],
 ['自然语言纠正与信息类型','L15、L18–L20','纠正、知识、偏好、旧约束作废的识别；本组不证明实际记忆更新'],
 ['模型/格式故障与重试','V01–V07','失败一次恢复、两次停止、不可重试认证错误、停止未确认、格式修复反馈'],
 ['服务端独立一致性校验','V14–V18','高风险动作不只信模型风险标签；relation/action/policy 组合合法'],
 ['人工澄清、幂等和冲突','H01–H07','合法选择正确落地、重复单一效果、相反选择明确冲突、确认目标绑定'],
 ['Runtime 切换控制','既有 runtime-control-intent.spec.ts','“不要切换到 Claude”不切换；“使用 Codex 继续执行当前任务”识别为控制；业务新需求不能冒充切换命令'],
 ['持久化与恢复','已有 339 项回归、HTTP smoke、6 场景和崩溃 smoke','租约、顺序、预算、删除边界、幂等事件与重启接管']
]);
report+='\n执行步骤：①读取真实代码和当前模式，固定工作区基线；②在运行前写明题目和可接受答案；③先跑已有回归；④执行实际规则与故障注入；⑤验证模型连接；⑥按用户授权接入本地 Codex，分别执行两条真实识别链路；⑦真实 HTTP 验证人工纠错与并发；⑧汇总逐题证据、失败原因、修复优先级；⑨后续修复后用同一题库回归，并增加独立盲测集。\n\n';
report+='## 4. 真实模型指标与限制\n\n';
report+=`本地 Codex CLI 为 0.163.0；本机配置声明模型 gpt-6-astra、reasoning=xhigh，适配器回传模型名为 codex，未独立验证服务端实际解析的模型版本。${live.results.filter(successfulInvocation).length} / 40 条路径判定获得 completed 的 Codex 调用结果，记录 ${invocations.length} 次 Runtime 调用。全部调用限制在 user_message_routing，隔离临时合成项目，复用当前系统 profile、结构化输出及服务端校验；不执行路由后的专业任务。\n\n`;
report+=`持久化 Runtime 审计确认：${runtimeAudit.invocationCount} 次调用均为 Codex 的 user_message_routing；工具集全为空，记录的工作区文件变更 ${runtimeAudit.workspaceChangeCount} 项，专业测试执行 ${runtimeAudit.testExecutionCount} 项。见 [Runtime 审计](evidence/runtime-audit.json)。两个系统角色的 Runtime 偏好只在隔离评测状态中设为 Codex。Codex 自身网络重试沿用本地配置，generic_llm 的 LLM_MAX_RETRIES 设置不代表已控制 Codex 内部重试。\n\n`;
report+='旧链路在空项目 fixture 中先被源码证据门禁拦截；正式语义评测使用 bootstrap 合成项目，此条件在结果文件中明确记录。旧链路可能保留 propose_changes 标记，但阶段工具集无写工具，CLI authority 计算结果为 read-only；新链路 writeMode=none。初次过严的测试侧 writeMode 断言已改为检查实际 canWrite/canRunTests，不改产品行为。预检与两次 pilot 不计入正式 40 条分母。\n\n';
report+='语义评测手工设置 WAIT_USER_CONFIRM/FAILED/EXECUTING 状态，关闭后台 brief 生成，未生成真实简报、确认卡或专业执行失败检查点；因此它是使用真实服务和真实模型的受控集成评测，不能替代完整状态机 E2E。HTTP 纠错组另行创建真实待澄清消息及持久化状态。\n\n';
report+=table(['链路','可用断言','通过/执行'],[...Object.entries(legacyFields).map(([k,v])=>['旧识别',k,`${v.passed}/${v.total}`]),...Object.entries(v2Fields).map(([k,v])=>['新路由',k,`${v.passed}/${v.total}`])]);
report+='\n新路由需求关系混淆矩阵（行=预期，列=实际；没有模型关系输出时不填入某一语义类别）：\n\n';
report+=table(['预期 \\ 实际',...relationLabels],matrix);
report+=`\n应澄清的 ${safeCases.length} 题中，自动放行 ${premature.length} 题；明确意图的 ${clearCases.length} 题中，被拦截/澄清 ${excessive.length} 题。这里的“自动放行”只指 classify 结果，不表示已执行业务。\n\n`;
report+=table(['链路','平均耗时/秒','P50/秒','P95/秒'],[['旧识别',latency(legacyRows).mean,latency(legacyRows).p50,latency(legacyRows).p95],['新路由',latency(v2Rows).mean,latency(v2Rows).p50,latency(v2Rows).p95]]);
report+='\n耗时含 fixture 持久化、运行时和本地 CLI 启动，单机串行测量，不能等同线上延迟 SLA。Codex 在独立 worker 中调用网络，父进程 fetch 的 providerRequests=0 不等于没调用模型；应看 invocations/输出证据。buffered 适配器 usage 固定回传 0，本次无法报告真实 token 或费用，也不能说免费。\n\n';
report+='原 `.env` 的 deepseek-v4-flash 连接在 `/models` 预检 HTTP 401，未产生模型判定；未计为语义错误。**本次验证的是用户授权的本地 Codex，不代表原 DeepSeek 连接或线上模型已验证。**\n\n';
report+='仅 20 道合成题、每条链路一次，且由本次评测者编题和判定；没有独立标注、生产分布加权、长历史、多轮实际约束覆盖、跨会话干扰、真实失败检查点和规模负载评测。即使 20/20 全对也不能保证线上准确率；不能使用本次结果宣称“99% 正确”。\n\n';
report+='## 5. 已复现的问题及优先级\n\n';
report+=table(['优先级','问题/证据','影响与建议'],[
 ['P1','首轮否定/只读请求仍标记改代码：T10/T11/T12/T15/T17/T19；会议纪要 T13','在识别阶段增加显式禁止约束与主意图裁决，requiresCodeChanges 独立校验；执行授权必须另有硬边界。当前证据只证明标记错误。'],
 ['P1','人工纠错相反选择静默成功：H04/H07','顺序及并发请求均可返回 201 和旧决定。相同选择幂等返回；不同选择返回 409 或创建新 correction revision，不能伪装已接受纠正。未发生重复任务。'],
 ['P1','取消低风险标签可放行：V15','服务端按动作/状态/确认目标计算风险，不依赖模型自行标记 riskLevel。尚未执行取消业务。'],
 ['P1','关系、上下文策略与动作组合冲突：V16','增设允许组合表与目标约束，例如独立新需求只能创建独立任务并 clean_task_context。'],
 ['P2','否定新任务与“另外补充”误分新需求：F02/F03/F04/F07','规则兜底需理解否定作用域或保守澄清；恢复后必须用最新上下文重判，不能永久沿用错误规则结果。'],
 ['P2','Schema 重试缺具体反馈：V05','修复重试加入原输出错误和允许枚举/缺失字段；限制单次修复，不扩大业务权限。'],
 ['P2','confirmationId 可随意填写：H05','如果该 ID 代表用户确认凭据，应绑定 session/routing/revision/choice 并校验过期；当前可选字段意味着这是加强验收要求，不能直接认定鉴权漏洞。'],
 ['P2','内部继续命令状态不一致：V17','复用同一 CommandStateResolver。真实消息入口 COMPLETED 已正确澄清，问题是内部路径存在不同标准。'],
 ['待裁定','否定新增功能被范围变更规则捕获：S08；多意图主意图：T20','先固定产品标签标准；S08 不等同实际增加功能。T20 本次以实现为主目标。'],
 ['P2','缺少概率校准与可用成本观测：V18/Codex usage','serverConfidence 改名或明确含义；增加真实语义质量、拒绝率、过度澄清率、纠错成功率、真实用量与延迟观测。']
]);
report+='\n本次真实模型未通过项：\n\n';
report+=semanticFailures.length?table(['题号/链路','题目','未通过字段或错误','实际'],semanticFailures.map(x=>[`${x.id}/${x.path}`,x.message,x.error??x.checks.filter(c=>!c.pass).map(c=>c.field),x.actual])):'正式 40 条路径判定均满足各自预设断言；这不消除规则、接口及校验层缺口。\n';
if(semanticFailures.some(x=>x.id==='L11'&&x.path==='legacy'))report+='\nL11 旧链路将两个目标压成一个 continuation，requiresUserConfirmation=false，并在文本指令中把“继续”解释为当前简报确认。该结果违背本次多意图先澄清的预设标准，建议优先修复：多目标要返回可审计的多路由计划或转澄清，不得仅把第二个目标塞入自由文本。没有实际执行该指令；待确认状态为合成 fixture，仍需用真实确认卡补充 E2E。\n';
if(semanticFailures.some(x=>x.id==='L17'&&x.path==='legacy'))report+='\n**人工复核 L17：标签标准差异，不判为安全失守。** 旧链路 requiresUserConfirmation=false 不满足预设“澄清”断言，但 coordinatorInstruction 明确拒绝忽略规则、虚构 WorkItem/Decision，要求保持 WAIT_USER_CONFIRM、不触发专业任务。它采用了安全拒绝策略。保留原始未通过结果以避免事后修改题目，同时将其与 L11 的多意图处理偏差分别说明；未来正式 gold 应预先允许可验证的安全拒绝。旧链路没有结构化拒绝字段，建议补足可审计的拒绝动作。\n';
if(semanticFailures.some(x=>x.id==='L20'&&x.path==='v2'))report+=`\n**人工复核 L20：测试前提缺失，澄清有合理依据。** 模型正确识别为 same_requirement/correction；但快照中没有原 10 分钟决定，返回 CORRECTION_TARGET_NOT_IN_SNAPSHOT 并澄清，不能把它计成安全错误或直接认定为过度澄清。补充 L20B 在快照中加入已确认的 10 分钟约束，模型结果为 ${correctionTarget.actual?.decision?.requestedAction}，自动应用资格=${correctionTarget.actual?.autoApplicable}，预设断言${correctionTarget.passed?'通过':'未通过'}。保留两次不同前提的结果，不覆盖原始分数；这仍未执行实际旧决定废弃。见 [补充输出](evidence/codex-correction-target-ready-results.json)。\n`;
report+='\n## 6. 发生偏差时如何纠错与重试\n\n';
report+=table(['场景','当前已实现/实测','建议的闭环'],[
 ['瞬时网络/可重试 Runtime 失败','V02 一次失败后恢复；V03 两次失败后澄清；控制 operation 有总次数与时间预算','同一 operationId 受限退避，保留原输入和幂等键，预算耗尽转人工；未知业务结果先查状态，不直接重放'],
 ['认证错误/停止状态未确认','V06/V07 只调用一次并停止自动应用','认证恢复后重新提交；stopUnconfirmed 先确认旧执行已停止，再允许重试'],
 ['JSON/Schema 不合法','V04 二次合法可恢复；V05 缺具体校验反馈','只修复结构，携带错误反馈，重新跑全套服务端校验；不要用默认 continue 掩盖失败'],
 ['结构合法但语义错误','当前校验无法覆盖全部语义；V15/V16 可穿过','停止应用或待确认，收集用户纠正、新旧意图及理由；用最新快照重新分类，比较差异并形成新版本'],
 ['引用虚构、@ 丢失、快照过期','V08–V11 均拦截；快照重建额度每路由一次','从最新事实重建，重新识别；持续冲突请求用户选择，禁止无限自旋'],
 ['用户在澄清卡选择任务关系','H02 正确创建独立任务；H03/H06 幂等成立','绑定确认目标与版本；将用户选择作为权威输入，同选择幂等、相反选择显式冲突'],
 ['路由应用后用户说“你理解错了”','L15 只测消息识别；H04 表明 clarify 不能承担既有路由纠正','新增纠正事件关联原 routingId；检查是否已执行，停止后续派发；对已产生效果做补偿/新任务而非覆盖历史'],
 ['进程崩溃/重复回调','已有 fault matrix 和 crash/restart 测试通过','持久化 claim、租约与业务幂等；重启只接管可恢复的阶段，不重复已发布效果']
]);
report+='\n当前新分类器单次 classify 最多两次尝试；LogicalOperation 控制阶段默认 maxAttempts=2、默认总时限 120 秒（可配置，本次 180 秒）；外层队列有指数退避和持久化租约，快照最多重建一次。这些是不同层，不能把它们简单相乘成“必定重试 N 次”。本次 V 组模拟了故障，未人为制造真实 Codex 网络掉线。\n\n';
report+='依据：[分类器重试](../../../apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts)、[操作预算](../../../apps/server/src/modules/runtimes/logical-operation-store.ts)、[快照与原子应用](../../../apps/server/src/modules/context-management/context-management.service.ts)、[人工澄清和恢复](../../../apps/server/src/modules/sessions/sessions.service.ts)。\n\n';
report+='## 7. 建议的复测与上线门槛（尚未执行）\n\n';
report+='1. 优先修复 P1，使用本次失败题复测，并新增同义改写/反例；真实入口、内部服务和 UI 必须一致。\n2. 建立至少 500 条独立测试集，按真实流量覆盖首轮/多轮、各状态、否定、任务切换、指代、纠正及 @；两人独立标注、分歧仲裁。按会话划分开发集与封存集，防止同义改写泄漏。\n3. 记录标签版本、模型/provider、profile、prompt、代码 SHA、温度/推理设置；封存集至少重复 3 次，报告正确率置信区间、macro-F1、各类召回率、混淆矩阵、动作准确率、继承准确率和输出一致率。\n4. 建议门槛：整体关系/动作正确率至少 95%，关键类别召回率至少 95%；否定停止/取消、越界引用、重复副作用及未经授权的写入为 0；人工纠错、幂等、过期确认和租约恢复必测全过。门槛为建议，需按产品风险与样本规模确认，不能视为当前已达标。\n5. 先 shadow 比较新旧输出并人工审核分歧，再小流量 enforce；监控错误自动应用率、过度澄清率、重试后成功率、二次纠正率、P95 延迟和费用。出现关键动作误判立即回退并将样本加入回归。\n\n';
report+='## 8. 复现与证据\n\n';
report+='运行前需用当前工作区构建 shared/server；真实模型评测会使用本机 Codex 账号产生用量。下列命令写隔离评测状态，不修改生产配置。\n\n```powershell\nnpm run build -w @agent-cluster/shared\nnpm run build -w @agent-cluster/server\nnode tests/evaluation/run-intent-diagnostic-2026-10-19.mjs\nnode --env-file=.env tests/evaluation/run-intent-live-2026-10-19.mjs --runtime=codex --label=codex-live\nnode --env-file=.env tests/evaluation/run-intent-live-2026-10-19.mjs --runtime=codex --offset=19 --limit=1 --paths=v2 --seed-prior-timeout --label=codex-correction-target-ready\nnode tests/evaluation/run-intent-correction-http-2026-10-19.mjs\nnode tests/evaluation/build-intent-report-2026-10-19.mjs\n```\n\n';
report+='既有检查命令：`npm run test:e2e:phase-2a-routing`、`npm run test:e2e:phase-6-fault-matrix`、`npm run test:e2e:phase-6-crash-restart`；245 项基线使用 tsx 运行相关 13 个 spec；补充 94 项运行 runtime-control-intent.spec.ts 和 orchestrator.service.spec.ts，文件清单见 manifest。\n\n';
report+='主要证据：[70 题 JSON](evidence/diagnostic-results.json)、[40 条真实判定与调用输出](evidence/codex-live-results.json)、[7 项纠错 HTTP](evidence/correction-http-results.json)、[245 项日志](evidence/baseline-tests.log)、[补充 94 项日志](evidence/supplemental-tests.log)、[HTTP smoke](evidence/http-smoke.log)、[故障矩阵](evidence/fault-matrix.log)、[崩溃恢复](evidence/crash-restart.log)、[代码与脚本指纹](evidence/manifest.json)。\n\n';
report+='未修改业务源码；本次只新增评测题库、脚本和报告。已执行相关测试与 shared/server build；未运行全仓 typecheck、完整 test、test:harness 和前端 build。PostgreSQL 场景因未配置独立测试数据库未执行。没有提交、发布或部署。\n';
await writeFile(resolve(out,'README.md'),report);

const baselineSpecs=[
 'apps/server/src/modules/context-management/context-management.service.spec.ts','apps/server/src/modules/context-management/work-item-recall.spec.ts',
 'apps/server/src/modules/intent-recognition/intent-recognition.service.spec.ts','apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts','apps/server/src/modules/intent-recognition/deterministic-command-guard.service.spec.ts','apps/server/src/modules/intent-recognition/intent-routing-golden.dataset.spec.ts','apps/server/src/modules/intent-recognition/execution-status-question.spec.ts',
 'apps/server/src/modules/message-routing/command-state-resolver.service.spec.ts','apps/server/src/modules/message-routing/command-application.service.spec.ts','apps/server/src/modules/message-routing/tag-routing.spec.ts','apps/server/src/modules/message-routing/message-ingress.service.spec.ts','apps/server/src/modules/runtimes/logical-operation-store.spec.ts','apps/server/src/modules/sessions/sessions.service.spec.ts'];
const fingerprintFiles=[...baselineSpecs,'apps/server/src/modules/intent-recognition/intent-recognition.service.ts','apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts','apps/server/src/modules/intent-recognition/deterministic-command-guard.service.ts','apps/server/src/modules/sessions/sessions.service.ts','apps/server/src/modules/orchestrator/orchestrator.service.ts','apps/server/src/modules/context-management/context-management.service.ts','apps/server/src/modules/runtimes/codex-runtime-adapter.service.ts',...(await readdir(resolve('tests/evaluation'))).filter(x=>x.endsWith('2026-10-19.mjs')).map(x=>`tests/evaluation/${x}`)];
const supplementalSpecs=['packages/shared/src/runtime-control-intent.spec.ts','apps/server/src/modules/orchestrator/orchestrator.service.spec.ts'];
fingerprintFiles.push(...supplementalSpecs,'packages/shared/src/runtime-control-intent.ts');
const hashes={};for(const file of fingerprintFiles)hashes[file]=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
const metrics={diagnostic:diagnostic.summary,firstTurnMetrics,legacy,v2,correction,legacyFields,v2Fields,completedCodexRows:live.results.filter(successfulInvocation).length,runtimeInvocations:invocations.length,supplementaryL20B:{passed:correctionTarget.passed,completedCodexRows:1,precondition:'confirmed prior 10-minute constraint added',countedInPrimaryBenchmark:false},prematureApply:premature.map(x=>x.id),clarificationsAgainstPreset:excessive.map(x=>x.id),manualAdjudication:{'L11:legacy':'substantive multi-intent mismatch','L17:legacy':'safe refusal; preset label mismatch','L20:v2':'reasonable clarification; missing prior target in fixture'},latency:{legacy:latency(legacyRows),v2:latency(v2Rows)}};
await writeFile(resolve(out,'evidence/metrics.json'),JSON.stringify(metrics,null,2));
await writeFile(resolve(out,'evidence/manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),timezone:'Asia/Shanghai',root,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,codex:'0.163.0',localCodexConfig:{model:'gpt-6-astra',reasoningEffort:'xhigh',actualResolvedProviderModel:'not independently observed'},baselineSpecs,supplementalSpecs,baselineCommand:'node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-force-exit <baselineSpecs>',supplementalCommand:'node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-force-exit <supplementalSpecs>',workingTree:execFileSync('git',['status','--short'],{encoding:'utf8'}),trackedDiffSha256:createHash('sha256').update(execFileSync('git',['diff','--no-ext-diff'],{maxBuffer:20*1024*1024,stdio:['pipe','pipe','ignore']})).digest('hex'),hashes,conditions:{defaultRoutingMode:'shadow (unless environment overrides)',evaluationRoutingMode:'direct classifier enforce record; HTTP enforce_new_sessions',persistence:'isolated file backend',externalProfessionalExecution:false,postgres:'not executed',syntheticFixture:'bootstrap temporary workspace with synthetic login files',realModelCredentials:'inherited local Codex config; no auth contents recorded',sourceEdits:'none by this evaluation task'}},null,2));
console.log(JSON.stringify(metrics,null,2));
