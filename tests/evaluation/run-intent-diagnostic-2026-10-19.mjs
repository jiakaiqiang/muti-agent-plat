import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskCases, fallbackCases, commandCases } from './intent-evaluation-cases-2026-10-19.mjs';
import { IntentRecognitionService } from '../../apps/server/dist/apps/server/src/modules/intent-recognition/intent-recognition.service.js';
import { SemanticIntentRouterService } from '../../apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js';
import * as guard from '../../apps/server/dist/apps/server/src/modules/intent-recognition/deterministic-command-guard.service.js';
import { resolveExactCommand } from '../../apps/server/dist/apps/server/src/modules/message-routing/command-state-resolver.service.js';

const out=resolve('docs/quality/intent-evaluation-2026-10-19/evidence');
await mkdir(out,{recursive:true});
const results=[];
const classifier=new IntentRecognitionService();
function record(item,actual,passed,detail='') { results.push({...item,actual,passed,detail}); }
for(const item of taskCases){const actual=classifier.recognizeTask(item.message);record(item,actual,item.expected.intents.includes(actual.intent)&&actual.requiresCodeChanges===item.expected.requiresCodeChanges);}
for(const item of fallbackCases){const actual=classifier.recognizeUserMessage(item.message,item.status);record(item,actual,actual.requirementRelation===item.expected.relation);}
for(const item of commandCases){const match=guard.matchExactUserCommand(item.message);const actual=match?resolveExactCommand({command:match,sessionStatus:item.status}):null;record(item,actual,(actual?.action??null)===item.expected.action);}

const special=[
 ['S01','现在执行到哪一步了？','status',true],
 ['S02','现在执行到哪一步了？另外加一个导出功能','status',false],
 ['S03','先停下来，另外增加导出功能','compound',true],
 ['S04','不要暂停，继续补充说明','compound',false],
 ['S05','这个改动会不会影响数据库？','consult',true],
 ['S06','能否另外增加一个导出功能？','consult',false],
 ['S07','另外增加一个导出功能','scope',true],
 ['S08','不要增加任何新功能','scope',false]
];
for(const [id,message,type,expected] of special){const fn={status:guard.matchExecutionStatusQuestion,compound:guard.matchCompoundExecutionControl,consult:guard.matchExecutionConsultationQuestion,scope:guard.matchExecutionScopeChange}[type];const actual=fn(message);record({id,feature:'执行期专项规则',message,expected},actual,Boolean(actual)===expected);}

function fixture(message='请补充当前任务',status='WAIT_USER_CONFIRM'){
 const now=new Date().toISOString(); const sid=randomUUID(),wid=randomUUID();
 const session={id:sid,activeWorkItemId:wid,status,revision:1,decisionLedgerRevision:0,originalInput:'实现登录接口',workspaceId:'evaluation',participatingAgentIds:['quality']};
 const snapshot={id:randomUUID(),sessionId:sid,sourceEventId:randomUUID(),currentMessage:message,activeWorkItemId:wid,activeWorkItem:{id:wid,title:'登录任务',goal:'实现登录接口',status:status==='FAILED'?'FAILED':'OPEN',revision:1},candidateWorkItemIds:[wid],candidateWorkItems:[],validDecisionIds:[],validDecisions:[],revision:{sessionRevision:1},createdAt:now};
 const routing={id:randomUUID(),sessionId:sid,status:'RECEIVED',rolloutMode:'enforce_new_sessions',reasonCodes:[],retryCount:0};
 const decision={schemaVersion:'1.0',kind:'intent_routing_decision',dialogueAct:'clarification',scopeRelation:'same_requirement',contextPolicy:'inherit_confirmed',requestedAction:'continue_active_work_item',selectedWorkItemId:wid,selectedDecisionIds:[],selectedArtifactIds:[],requestedAgentIds:[],goalSegments:['补充当前任务'],missingFields:[],ambiguityReasons:[],reasonCodes:['EVALUATION'],riskLevel:'low',modelConfidence:0.99};
 return {session,snapshot,routing,decision};
}
async function fault(id,message,modify,check){
 const f=fixture(message);const control={calls:0,inputs:[],states:[],current:true,outputs:[],errors:[]};modify(f,control);
 const service=new SemanticIntentRouterService({invoke:async(input)=>{control.inputs.push(input);control.calls++;const value=control.outputs.shift();if(value instanceof Error)throw value;return value??{status:'completed',output:f.decision};}}, {resolveSystemRole:()=>({id:'intent-agent'})},{get:()=>({preferredRuntimeType:'mock'})},{updateRoutingRecord:async(_sid,_rid,patch)=>{Object.assign(f.routing,patch);control.states.push(patch.status);return {...f.routing};},isSnapshotCurrent:()=>control.current,getWorkItem:()=>({inheritedArtifactIds:[]})});
 let outcome;try{outcome=await service.classify(f.session,f.routing,f.snapshot);}catch(error){outcome={error:String(error)};}
 const observed={calls:control.calls,autoApplicable:outcome.autoApplicable,decision:outcome.decision,validation:outcome.validation,status:outcome.routing?.status,states:control.states,error:outcome.error};
 record({id,feature:'故障注入与服务端校验',message,expected:check.description},observed,check.test(outcome,control,f));
}
const expect=(description,test)=>({description,test});
await fault('V01','正确的同需求输出',()=>{},expect('允许应用且调用一次',(o,c)=>o.autoApplicable&&c.calls===1));
await fault('V02','第一次连接失败，第二次恢复',(f,c)=>{c.outputs=[new Error('TEMPORARY_FAILURE')];},expect('重试一次后恢复',(o,c)=>o.autoApplicable&&c.calls===2));
await fault('V03','两次连接失败',(f,c)=>{c.outputs=[new Error('TEMPORARY_FAILURE'),new Error('TEMPORARY_FAILURE')];},expect('两次后澄清，不默认继续',(o,c)=>!o.autoApplicable&&o.decision.requestedAction==='clarify'&&c.calls===2));
await fault('V04','第一次输出格式错误，第二次合法',(f,c)=>{c.outputs=[{status:'completed',output:{kind:'broken'}}];},expect('两次后恢复',(o,c)=>o.autoApplicable&&c.calls===2));
await fault('V05','格式修复是否带校验反馈',(f,c)=>{c.outputs=[{status:'completed',output:{kind:'broken'}}];},expect('第二次输入包含本次输出校验错误反馈',(o,c)=>{const env=c.inputs[1]?.contextEnvelopeFactory({identity:{agentId:'i',profileHash:'h',profileRevision:1},toolCatalog:{catalogHash:'t'}});return /INTENT_OUTPUT_INVALID|schema.*error|validation.*error|校验错误/i.test(JSON.stringify(env));}));
await fault('V06','不可重试的认证失败',(f,c)=>{c.outputs=[{status:'failed',error:{code:'AUTH_FAILED',retryable:false}}];},expect('只调用一次并停止自动应用',(o,c)=>!o.autoApplicable&&c.calls===1));
await fault('V07','Runtime 停止状态未确认',(f,c)=>{c.outputs=[{status:'failed',error:{code:'STOP_UNKNOWN',details:{stopUnconfirmed:true}}}];},expect('只调用一次并停止自动应用',(o,c)=>!o.autoApplicable&&c.calls===1));
await fault('V08','模型虚构任务 ID',(f)=>{f.decision.selectedWorkItemId=randomUUID();},expect('拦截快照外目标',o=>!o.autoApplicable&&o.validation.errors.includes('REFERENCE_OUTSIDE_SNAPSHOT')));
await fault('V09','模型遗漏用户 @ 对象',(f)=>{f.snapshot.mentionedAgentIds=['quality'];},expect('拦截遗漏 @',o=>!o.autoApplicable&&o.validation.errors.includes('MENTION_TARGET_DROPPED')));
await fault('V10','模型添加未参加会话的 Agent',(f)=>{f.decision.requestedAgentIds=['outsider'];},expect('拦截越界 Agent',o=>!o.autoApplicable&&o.validation.errors.includes('AGENT_TARGET_OUTSIDE_SNAPSHOT')));
await fault('V11','分类期间快照过期',(f,c)=>{c.current=false;},expect('拦截过期快照',o=>!o.autoApplicable&&o.validation.errors.includes('SNAPSHOT_STALE')));
await fault('V12','模型自报高置信度但有歧义',(f)=>{f.decision.scopeRelation='ambiguous';f.decision.modelConfidence=1;},expect('不得因高置信度放行',o=>!o.autoApplicable));
await fault('V13','独立任务错误继承旧上下文',(f)=>{f.decision.scopeRelation='independent_new_requirement';f.decision.requestedAction='create_independent_work_item';},expect('拦截独立任务继承',o=>!o.autoApplicable));
await fault('V14','模型认为危险取消是高风险',(f)=>{f.decision.requestedAction='cancel';f.decision.riskLevel='high';},expect('要求用户确认',o=>!o.autoApplicable));
await fault('V15','模型把同样的取消动作标成低风险',(f)=>{f.decision.requestedAction='cancel';f.decision.riskLevel='low';},expect('服务端自行识别危险控制，不能仅依赖模型风险标签',o=>!o.autoApplicable));
await fault('V16','模型输出合法目标但需求关系与动作冲突',(f)=>{f.decision.scopeRelation='independent_new_requirement';f.decision.contextPolicy='clean_task_context';f.decision.requestedAction='continue_active_work_item';},expect('拦截独立新需求继续旧任务的矛盾',o=>!o.autoApplicable));
await fault('V17','已完成任务的继续命令与入口裁决一致',(f)=>{f.session.status='COMPLETED';f.snapshot.currentMessage='继续执行';},expect('与命令入口一致，要求澄清',o=>!o.autoApplicable&&o.decision.requestedAction==='clarify'));
await fault('V18','低 modelConfidence 的合法输出',(f)=>{f.decision.modelConfidence=0.1;},expect('记录当前评分边界：serverConfidence 不代表语义概率',o=>o.autoApplicable&&o.validation.serverConfidence===1));
const summary={total:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,byFeature:{}};
for(const item of results){const s=summary.byFeature[item.feature]??={total:0,passed:0};s.total++;if(item.passed)s.passed++;}
await writeFile(resolve(out,'diagnostic-results.json'),JSON.stringify({executedAt:new Date().toISOString(),method:'actual compiled services; injected runtime only for V cases; no live model',summary,results},null,2));
console.log(JSON.stringify({summary,failures:results.filter(x=>!x.passed).map(x=>({id:x.id,message:x.message,actual:x.actual}))},null,2));
