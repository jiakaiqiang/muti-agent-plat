import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, createSessionAndWaitForBrief, listEvents, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';

const out=resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
await mkdir(out,{recursive:true});
const results=[];
let server;
const message='先继续修复登录问题，再新增导出功能。';
async function save(){await writeFile(resolve(out,'correction-http-results.json'),JSON.stringify({executedAt:new Date().toISOString(),method:'real localhost HTTP; isolated file state; mock model; no real professional execution',results},null,2));}
async function record(id,feature,expected,actual,passed){results.push({id,feature,message,expected,actual,passed});await save();console.log(JSON.stringify({id,passed,actual}));}
async function fixture(){
 const {sessionId}=await createSessionAndWaitForBrief(server.apiBase,'修复登录流程，并保留现有的审批边界。',{runtimePreference:{preferredRuntimeType:'mock',allowedRuntimeTypes:['mock']}});
 const response=await api(server.apiBase,`/sessions/${sessionId}/messages`,{method:'POST',headers:{'idempotency-key':randomUUID()},body:JSON.stringify({content:message})});
 const routingId=response.data.routingId;
 const deadline=Date.now()+30000;let routing;
 while(Date.now()<deadline){routing=(await api(server.apiBase,`/sessions/${sessionId}/message-routings/${routingId}`)).data;if(routing.status==='CLARIFICATION_REQUIRED')break;await new Promise(r=>setTimeout(r,100));}
 if(routing.status!=='CLARIFICATION_REQUIRED')throw Error(`Fixture did not clarify: ${routing.status}`);
 const events=await listEvents(server.apiBase,sessionId);
 const confirmationId=events.filter(e=>e.metadata?.payload?.routingId===routingId).map(e=>e.metadata?.payload?.confirmationId).find(Boolean);
 return {sessionId,routingId,confirmationId,routingRevision:routing.routingRevision};
}
async function clarify(f,choice,confirmationId=f.confirmationId){
 const response=await fetch(`${server.apiBase}/sessions/${f.sessionId}/message-routings/${f.routingId}/clarify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({choice,confirmationId})});
 return {status:response.status,body:await response.json()};
}
async function count(f){
 const items=(await api(server.apiBase,`/sessions/${f.sessionId}/work-items`)).data.items;
 const events=await listEvents(server.apiBase,f.sessionId);
 return {workItems:items.length,routeEvents:events.filter(e=>['work_item_created','work_item_activated'].includes(e.type)&&e.metadata?.payload?.routingId===f.routingId).length,resolutionEvents:events.filter(e=>e.type==='user_confirmation_resolved'&&e.metadata?.payload?.routingId===f.routingId).length};
}
try{
 server=await startSmokeServer('intent-correction-sdd',{DISCUSSION_MAX_ROUNDS:'0',GLOBAL_DEFAULT_RUNTIME_TYPE:'mock',INTENT_ROUTING_MODE:'enforce_new_sessions',ENABLE_BULLMQ:'false'});
 const f=await fixture();
 const invalid=await clarify(f,'invalid_choice');
 await record('H01','人工纠错参数校验','非法 choice 返回 HTTP 400',invalid,invalid.status===400);
 const initial=await count(f),first=await clarify(f,'independent_new'),afterFirst=await count(f);
 const firstData=first.body.data;
 await record('H02','人工澄清为独立任务','产生一个新 WorkItem，clean_task_context，不继承旧决定',{status:first.status,before:initial,after:afterFirst,routing:firstData?.routing,workItem:firstData?.workItem},first.status===201&&afterFirst.workItems===initial.workItems+1&&firstData?.routing?.decision?.contextPolicy==='clean_task_context'&&firstData?.workItem?.inheritedDecisionIds?.length===0);
 const replay=await clarify(f,'independent_new'),afterReplay=await count(f);
 await record('H03','同一选择重复提交','重复提交不增加任务、路由或确认事件',{status:replay.status,before:afterFirst,after:afterReplay},JSON.stringify(afterFirst)===JSON.stringify(afterReplay)&&replay.status<300);
 const opposite=await clarify(f,'continue_current'),afterOpposite=await count(f);
 await record('H04','已应用路由再次纠正','相反选择应明确冲突，或生成可追踪的新纠正；不可静默成功返回旧选择',{status:opposite.status,returnedAction:opposite.body.data?.routing?.decision?.requestedAction,before:afterReplay,after:afterOpposite},opposite.status===409||(opposite.status<300&&opposite.body.data?.routing?.decision?.requestedAction==='continue_active_work_item'));
 const forged=await fixture(),forgedResponse=await clarify(forged,'independent_new','nonexistent-evaluation-confirmation');
 await record('H05','确认目标绑定','传入不存在的 confirmationId 应拒绝；这是额外验收要求，当前 DTO 字段可选',{status:forgedResponse.status,returnedAction:forgedResponse.body.data?.routing?.decision?.requestedAction,counts:await count(forged)},[400,404,409].includes(forgedResponse.status));
 const same=await fixture(),sameBefore=await count(same);
 const sameResponses=await Promise.all([clarify(same,'independent_new'),clarify(same,'independent_new')]);
 const sameAfter=await count(same);
 await record('H06','并发重复纠错','并发同选择只产生一个业务效果；另一个可重放或返回冲突',{statuses:sameResponses.map(r=>r.status),before:sameBefore,after:sameAfter,responses:sameResponses},sameAfter.workItems===sameBefore.workItems+1&&sameAfter.routeEvents===1&&sameAfter.resolutionEvents===1&&sameResponses.some(r=>r.status<300)&&sameResponses.every(r=>r.status<300||r.status===409));
 const conflict=await fixture(),conflictBefore=await count(conflict);
 const conflictResponses=await Promise.all([clarify(conflict,'independent_new'),clarify(conflict,'continue_current')]);
 const conflictAfter=await count(conflict);
 await record('H07','并发相反选择','一个选择生效，另一个明确返回 409；路由/确认事件各一个',{statuses:conflictResponses.map(r=>r.status),before:conflictBefore,after:conflictAfter,responses:conflictResponses},conflictResponses.filter(r=>r.status<300).length===1&&conflictResponses.filter(r=>r.status===409).length===1&&conflictAfter.routeEvents===1&&conflictAfter.resolutionEvents===1);

 const modern=await fixture();
 async function submitModern(patch={}) {
  const response=await fetch(`${server.apiBase}/sessions/${modern.sessionId}/message-routings/${modern.routingId}/clarify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contractVersion:'intent-clarify-v1',confirmationId:modern.confirmationId,expectedRoutingRevision:modern.routingRevision,idempotencyKey:'modern-choice',choice:'independent_new',...patch})});
  return {status:response.status,body:await response.json()};
 }
 const stale=await submitModern({expectedRoutingRevision:9999});
 await record('H08','版本过期','错误版本返回 409',stale,stale.status===409);
 const unknown=await submitModern({safeToApply:true});
 await record('H09','严格合同','未声明字段返回 400',unknown,unknown.status===400);
 const modernBefore=await count(modern),modernFirst=await submitModern(),modernReplay=await submitModern(),modernAfter=await count(modern);
 await record('H10','版本化幂等收据','首次及旧版本相同网络重放均成功，仅一项业务效果',{statuses:[modernFirst.status,modernReplay.status],before:modernBefore,after:modernAfter,receipt:modernReplay.body.data?.routing?.resolution},modernFirst.status===201&&modernReplay.status===201&&modernAfter.workItems===modernBefore.workItems+1&&modernAfter.routeEvents===1&&modernAfter.resolutionEvents===1&&modernReplay.body.data?.routing?.resolution?.idempotencyKey==='modern-choice');
}finally{await save();if(server)await stopSmokeServer(server);}
if(results.some(item=>!item.passed)) process.exitCode=1;
