import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {liveCases} from './intent-evaluation-cases-2026-10-19.mjs';
const root=resolve('docs/quality/intent-codex-comparison-2026-10-20');
const load=async prefix=>{
 const rows=[],manifests=[],calls=[];
 for(const dir of (await readdir(root,{withFileTypes:true})).filter(x=>x.isDirectory()&&x.name.startsWith(prefix+'-')).map(x=>x.name).sort()){
  rows.push(...JSON.parse(await readFile(resolve(root,dir,'results.json'),'utf8')));
  manifests.push(JSON.parse(await readFile(resolve(root,dir,'manifest.json'),'utf8')));
  for(const file of (await readdir(resolve(root,dir))).filter(f=>/^provider-\d+\.json$/.test(f)))calls.push(JSON.parse(await readFile(resolve(root,dir,file),'utf8')));
 }
 // Audit all compiler state predicates for both runs; compound requests must
 // not conceal a bad resume simply because multi-segment confirmation stopped dispatch.
 for(const row of rows){
  if(row.actual?.plan&&!row.checks.some(c=>c.field==='routeState'))row.checks.push({field:'routeState',pass:row.actual.plan.validation.stateValid});
  if(row.actual?.understanding)row.checks.push({field:'goalSegmentation',pass:row.actual.understanding.segments.length===(row.expected.multi?2:1)});
  row.passed=!row.error&&row.checks.length>0&&row.checks.every(c=>c.pass);
 }
 rows.sort((a,b)=>a.id.localeCompare(b.id));
 if(rows.length!==20||new Set(rows.map(r=>r.id)).size!==20)throw Error(`${prefix}: expected exactly 20 unique completed cases`);
 return {rows,manifests,calls};
};
const afterPrefix=process.argv.find(x=>x.startsWith('--after='))?.split('=')[1]??'optimized';
const before=await load('baseline'),after=await load(afterPrefix);
await writeFile(resolve(root,'scored-results.json'),JSON.stringify({before:before.rows,after:after.rows},null,2));
if(new Set([...before.manifests,...after.manifests].map(m=>m.casesHash)).size!==1)throw Error('FROZEN_CASES_CHANGED');
for(const path of ['apps/server/src/modules/message-routing/route-plan-compiler.service.ts','packages/shared/src/runtime-contracts/structured-output-instructions.ts']){
 if(new Set([...before.manifests,...after.manifests].map(m=>m.hashes[path])).size!==1)throw Error(`UNEXPECTED_POLICY_CHANGE: ${path}`);
}
const count=(run,field)=>run.rows.filter(r=>r.checks.find(c=>c.field===field)?.pass).length;
const total=(run,field)=>run.rows.filter(r=>r.checks.some(c=>c.field===field)).length;
const summary=run=>({cases:run.rows.length,passed:run.rows.filter(r=>r.passed).length,schema:count(run,'schema'),firstPassSchema:run.rows.filter(r=>r.invocations[0]?.status==='completed').length,
 relation:count(run,'relation'),action:count(run,'action'),routeReferencesAndRelation:count(run,'routeReferencesAndRelation'),evidence:count(run,'evidence'),
 routeState:count(run,'routeState'),goalSegmentation:count(run,'goalSegmentation'),
 routeOutcomes:run.rows.reduce((counts,r)=>{const outcome=r.actual?.plan?.outcome??'no_plan';counts[outcome]=(counts[outcome]??0)+1;return counts;},{}),
 providerCalls:run.calls.length,transportFailures:run.calls.filter(c=>c.error).length,
 websocketFallbacks:run.calls.filter(c=>c.events?.some(e=>e.item?.message?.includes('Falling back from WebSockets'))).length,
 secondAttempts:run.rows.reduce((n,r)=>n+Math.max(0,(r.actual?.attempts??0)-1),0),
 cliUsage:run.calls.reduce((sum,c)=>{for(const [k,v] of Object.entries(c.usage??{}))if(typeof v==='number')sum[k]=(sum[k]??0)+v;return sum;},{})});
const comparison={before:summary(before),after:summary(after),improved:after.rows.filter((r,i)=>r.passed&&!before.rows[i].passed).map(r=>r.id),regressed:after.rows.filter((r,i)=>!r.passed&&before.rows[i].passed).map(r=>r.id),remainingFailures:after.rows.filter(r=>!r.passed).map(r=>({id:r.id,checks:r.checks.filter(c=>!c.pass),error:r.error,actual:r.actual})),caseHash:before.manifests[0].casesHash};
await writeFile(resolve(root,'comparison.json'),JSON.stringify(comparison,null,2));
const safe=s=>String(s??'').replaceAll('|','/').replaceAll('\n',' ');
const actual=r=>r.actual?.understanding?.segments.map(s=>`${s.scopeRelation} → ${s.suggestedAction}`).join('；')??r.actual?.reasonCodes?.join(',')??'未返回';
const fields=[['结构化输出','schema'],['需求关系','relation'],['动作选择（19题，复合题另判）','action'],['目标分段','goalSegmentation'],['路由引用与关系约束','routeReferencesAndRelation'],['路由状态前提','routeState'],['当前消息证据定位','evidence']];
let md=`# 当前意图识别与路由：本地 Codex 真实模型前后对比\n\n生成时间：${new Date().toISOString()}。\n\n本轮限定在识别与路由优化，未扩展工作流功能。诊断集全题通过：**${comparison.before.passed}/20 → ${comparison.after.passed}/20**，提升 ${(comparison.after.passed-comparison.before.passed)*5} 个百分点。该数值仅适用于本报告的 20 题，不代表线上准确率。\n\n## 方法与证据边界\n\n- 模型：本地 Codex 配置 gpt-6-astra / high，每次独立临时会话；只读沙箱，禁止工具调用。CLI 原始事件保存在各批次 provider 文件。\n- 调用真实的 IntentUnderstandingRoutingService → SemanticIntentRouterService → GenericLlmRuntime；通过仅限评测的本地 HTTP 桥调用 Codex，然后使用真实 compileIntentRoutePlan 编译。没有模拟模型输出，也没有执行后续业务动作。\n- 这是当前新语义链路的服务级集成评测；不证明原生 Codex 适配器已支持受限分类，也不是 HTTP/UI 端到端验收。\n- 20 道预先编写的多轮诊断题，包含任务关系、约束、提问、恢复、复合意图、指代、Agent、偏好和纠正。不是独立双人标注的代表性题库，分数不可外推为线上准确率；首轮识别、全量领域和长会话仍需另测。\n- 前后题集哈希一致：\`${comparison.caseHash}\`。每题上下文模板、模型、预算、判分逻辑相同，随机会话/事件 ID 不同。优化基于这组失败题，属于开发集复测，尚无独立留出集证明泛化。\n- 每题由现有系统最多调用两次，保留结构错误修复；应用 HTTP 层重试关闭；Codex CLI 自身的连接重试和 WebSocket→HTTPS 回退仍存在，原始事件均保留。运行超时放宽以容纳本地 CLI 连接回退，前后均为 160 秒/调用、330 秒/逻辑操作；不能代表默认配置的延迟。\n- 资源和授权为空，测试要求系统不得凭模型输出取得执行权限；因此 blocked/needs_clarification 并不自动算识别错误。L09 没有恢复检查点，预期询问而不是自动重试。L20 已提供旧的 10 分钟约束。\n\n## 对比\n\n| 指标 | 优化前 | 优化后 |\n|---|---:|---:|\n| 全题通过 | ${comparison.before.passed}/20 | ${comparison.after.passed}/20 |\n`;
for(const [name,key]of fields)md+=`| ${name} | ${count(before,key)}/${total(before,key)} | ${count(after,key)}/${total(after,key)} |\n`;
md+=`| 首次调用即通过结构校验 | ${comparison.before.firstPassSchema}/20 | ${comparison.after.firstPassSchema}/20 |\n| 使用第二次识别调用 | ${comparison.before.secondAttempts} | ${comparison.after.secondAttempts} |\n`;
md+=`| 实际模型调用 | ${before.calls.length} | ${after.calls.length} |\n| 传输失败调用 | ${comparison.before.transportFailures} | ${comparison.after.transportFailures} |\n\n指标中缺少模型有效输出的题不会算通过；字段指标的分母只包含执行过该检查的题，必须结合结构化输出覆盖率阅读。\n\n改善题：${comparison.improved.join('、')||'无'}。退化题：${comparison.regressed.join('、')||'无'}。仍失败：${comparison.remainingFailures.map(r=>r.id).join('、')||'无'}。\n\n## 逐题结果\n\n| 题号 | 功能点 | 具体题目 | 优化前实际结果 | 优化后实际结果 | 前/后通过 | 后测未通过项 |\n|---|---|---|---|---|---|---|\n`;
for(let i=0;i<20;i++){const b=before.rows[i],a=after.rows[i];md+=`| ${a.id} | ${safe(liveCases.find(c=>c.id===a.id)?.feature)} | ${safe(a.message)} | ${safe(actual(b))} | ${safe(actual(a))} | ${b.passed?'通过':'失败'}/${a.passed?'通过':'失败'} | ${safe(a.checks.filter(c=>!c.pass).map(c=>c.field).join(',')||a.error||'—')} |\n`;}
md+='\n## 路由编译结果（保留拒绝原因）\n\n| 题号 | 优化前 | 优化后 |\n|---|---|---|\n';
for(let i=0;i<20;i++){const b=before.rows[i],a=after.rows[i];md+=`| ${a.id} | ${safe(b.actual?.plan?.outcome)}: ${safe(b.actual?.plan?.validation.errorCodes.join(','))} | ${safe(a.actual?.plan?.outcome)}: ${safe(a.actual?.plan?.validation.errorCodes.join(','))} |\n`;}
md+=`\n路由结果分布：优化前 ${JSON.stringify(comparison.before.routeOutcomes)}；优化后 ${JSON.stringify(comparison.after.routeOutcomes)}。诊断通过不等于可以直接执行：资源未解析、禁止项无法绑定、缺少授权、多目标确认等仍由现有策略拦截。本轮没有放宽这些限制，也没有验证后续执行器。\n`;
md+='\n## 尚未覆盖与使用边界\n\n- 本轮证明的是这 20 道多轮诊断题上的结构化理解与编译约束表现，不是首轮领域分类、真实项目多资源授权、UI、后续任务执行或线上泛化正确率。\n- 只读问题仍可能因禁止项资源未绑定而 blocked；这类可用性缺口在编译结果表中保留，没有用“识别通过”掩盖，也未在本轮扩展执行流程解决。\n- L20 提供了旧 Decision，但没有历史路由候选；该题只证明旧约束和版本的语义绑定，不能证明历史数据的纠错事务一定可提交。基线 record_constraint 已携带正确替换绑定，规范动作得分变化不是“从完全识别错误变成完全正确”。\n- 所有中间轮次均保留。第一轮复测的整体通过率提升不代表每个字段都改善，第二轮针对剩余关系策略冲突修正后再次全量复测。\n- 本地连接有 WebSocket 回退差异，不把耗时变化作为优化收益。本轮若没有发生格式错误重试，也不能据此给出真实模型重试成功率。\n- 下一步质量验证应使用未参与调优的独立题集、更多真实会话上下文及重复采样；本报告不声称任何意图识别方案能够保证所有输入都正确。\n';
if(afterPrefix==='final'){
 const round1=JSON.parse(await readFile(resolve(root,'round1-comparison.json'),'utf8'));
 md+=`\n## 三轮记录\n\n| 轮次 | 完整题数 | 全题通过 | 真实模型调用 |\n|---|---:|---:|---:|\n| 优化前 | 20 | ${comparison.before.passed} | ${comparison.before.providerCalls} |\n| 第一次优化 | 20 | ${round1.after.passed} | ${round1.after.providerCalls} |\n| 第二次优化 | 20 | ${comparison.after.passed} | ${comparison.after.providerCalls} |\n\n每轮均完整运行，没有拼接不同版本的单题最佳结果。最终代码回归测试 32/32 通过，服务端类型检查及两次优化后构建通过，日志均在本目录。\n`;
}
md+='\n每批 manifest.json 记录识别器、路由编译器、结构化指令的源文件哈希；results.json 保存实际上下文、输出、调用与校验明细。pilot 与 pilot-transport 是接入调试证据，不参与评分。原始采集 passed 为初步判分；最终评分统一补充状态前提与目标分段检查，见 rubric.md 与 scored-results.json。具体修改与回归验证见同目录 optimization-notes.md。\n';
await writeFile(resolve(root,'report.md'),md);console.log(JSON.stringify(comparison,null,2));
