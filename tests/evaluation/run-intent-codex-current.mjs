import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {holdoutCases,budgetCase} from './intent-supervisor-holdout-2026-10-20.mjs';
import {holdoutCases as holdoutV3Cases} from './intent-holdout-v3-2026-10-20.mjs';
import {liveCases} from './intent-evaluation-cases-2026-10-19.mjs';
import {createSmokeV2State} from '../e2e/smoke-server.mjs';
import {startLocalCodexProvider} from './local-codex-provider.mjs';
import {withCircuitCooldown} from './intent-evaluation-transport.mjs';

const label=process.argv.find(x=>x.startsWith('--label='))?.split('=')[1]??'baseline';
if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(label))throw Error('Use a simple unique evaluation label');
const limit=Number(process.argv.find(x=>x.startsWith('--limit='))?.split('=')[1]??20);
const offset=Number(process.argv.find(x=>x.startsWith('--offset='))?.split('=')[1]??0);
const out=resolve('docs/quality/intent-codex-comparison-2026-10-20',label);
await mkdir(dirname(out),{recursive:true});
await mkdir(out); // Never overwrite historical model evidence on a rerun.
const provider=await startLocalCodexProvider(out);
const stateFile=resolve('.cache/agent-cluster',`intent-current-${randomUUID()}.json`);
await mkdir(resolve('.cache/agent-cluster'),{recursive:true});
await writeFile(stateFile,JSON.stringify(createSmokeV2State()));
Object.assign(process.env,{AGENT_CLUSTER_PERSISTENCE:'true',AGENT_CLUSTER_PERSISTENCE_BACKEND:'file',AGENT_CLUSTER_DATA_FILE:stateFile,
 AGENT_CLUSTER_SEED_DEFAULT_AGENTS:'true',ENABLE_BULLMQ:'false',INTENT_ROUTING_MODE:'shadow',INTENT_UNDERSTANDING_ENABLED:'false',
 MAIN_AGENT_DISCUSSION_ENABLED:'false',REQUIREMENT_DOCUMENT_ENABLED:'false',GLOBAL_DEFAULT_RUNTIME_TYPE:'generic_llm',
 LLM_DRY_RUN:'false',LLM_MOCK_FALLBACK:'false',MOCK_RUNTIME_ENABLED:'false',LLM_MAX_RETRIES:'0',LLM_SCHEMA_REPAIR_ATTEMPTS:'0',
 LLM_TIMEOUT_MS:'160000',PHASE_TIMEOUT_USER_MESSAGE_ROUTING_MS:'330000',LLM_REMOTE_MAX_OUTPUT_TOKENS:'3000',
 LLM_REMOTE_STREAMING:'false',LLM_API_KEY:'local-evaluation-placeholder',LLM_BASE_URL:provider.baseUrl,LLM_MODEL:'local-codex'});
// Expectations frozen before inference. This authored set is diagnostic, not a population accuracy estimate.
const actions={L01:['enqueue_follow_up','record_information'],L02:['record_constraint'],L03:['answer_in_chat'],L04:['create_independent_work_item'],
 L05:['create_related_work_item'],L06:['enqueue_follow_up','record_information'],L07:['enqueue_follow_up'],L08:['enqueue_follow_up','record_information'],
 L09:['clarify'],L10:['replan'],L12:['clarify'],L13:['answer_in_chat','enqueue_follow_up'],L14:['enqueue_follow_up','record_information'],
 L15:['answer_in_chat','record_constraint','correct_route'],L16:['enqueue_follow_up'],L17:['clarify','reject_request'],L18:['record_information'],L19:['record_constraint','record_information'],L20:['correct_route']};
const diagnosticCases=liveCases.map(c=>({...c,expected:{relation:c.id==='L11'?null:c.relation,actions:actions[c.id],
 policy:c.policy,multi:c.id==='L11',mention:!!c.mention,inherit:!!c.inherit,
 readOnly:['L02','L03','L15','L18','L19','L20'].includes(c.id),correction:c.id==='L20'}}));
const supervisor=process.argv.includes('--supervisor');
const cases=supervisor?[...diagnosticCases,...holdoutCases,...holdoutV3Cases,budgetCase]:diagnosticCases;
await writeFile(resolve(out,'cases.json'),JSON.stringify(cases,null,2));
const hashes={};for(const p of ['apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts','apps/server/src/modules/message-routing/route-plan-compiler.service.ts','packages/shared/src/runtime-contracts/structured-output-instructions.ts'])hashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');
await writeFile(resolve(out,'manifest.json'),JSON.stringify({label,startedAt:new Date().toISOString(),hashes,casesHash:createHash('sha256').update(JSON.stringify(cases)).digest('hex'),buildHash:createHash('sha256').update(await readFile('apps/server/dist/apps/server/src/modules/intent-recognition/semantic-intent-router.service.js')).digest('hex'), fixtureVersion:'production-status-v2', method:'actual SemanticIntentRouter + durable IntentUnderstandingRouting + GenericLlmRuntime via isolated local Codex HTTP bridge + actual route compiler; no dispatch',model:'local config: gpt-6-astra/high',transportTimeoutMs:160000,operationTimeoutMs:330000},null,2));
const load=p=>import(`../../apps/server/dist/apps/server/src/${p}.js`);
let app;const results=[];
try{
 const {NestFactory}=await import('@nestjs/core');const {AppModule}=await load('app.module');
 app=await NestFactory.createApplicationContext(AppModule,{logger:false,abortOnError:false});
 const get=async(p,n)=>app.get((await load(p))[n]);
 const sessions=await get('modules/sessions/sessions.service','SessionsService');
 const agents=await get('modules/agents/agents.service','AgentsService');
 const context=await get('modules/context-management/context-management.service','ContextManagementService');
 const events=await get('modules/events/events.service','EventsService');
 const persistence=await get('modules/persistence/persistence.service','PersistenceService');
 const runtime=await get('modules/runtimes/runtime.service','RuntimeService');
 const classifier=await get('modules/intent-recognition/intent-understanding-routing.service','IntentUnderstandingRoutingService');
 const {compileIntentRoutePlan}=await load('modules/message-routing/route-plan-compiler.service');
 const {INTENT_EFFECT_KINDS}=await import('@agent-cluster/shared');
 sessions.generateBriefInBackground=()=>{};
 const start=runtime.start.bind(runtime);const invocations=[];
 runtime.start=(plan,signal)=>{
  if(plan.phase!=='user_message_routing'||plan.toolCatalog.tools.length||plan.executionTarget.writeMode!=='none')throw Error('EVALUATION_BUSINESS_EXECUTION_BLOCKED');
  const execution=start(plan,signal);execution.result.then(result=>invocations.push({invocationId:plan.invocationId,status:result.status,error:result.error,output:result.output,envelope:plan.contextEnvelope,budget:plan.budget,tokenEstimation:result.tokenEstimation})).catch(()=>{});return execution;
 };
 const agent=agents.list().find(a=>a.key==='test')??agents.list()[0];
 for(const item of cases.slice(offset,offset+limit)){
  const caseStarted=Date.now();
  const row=await withCircuitCooldown(async()=>{
  const began=Date.now(),callStart=provider.calls.length,invocationStart=invocations.length;
  let row={id:item.id,message:item.message,expected:item.expected,checks:[]};
  try{
   const {session,firstEvent}=await sessions.create({input:item.goal,runtimePreference:{preferredRuntimeType:'generic_llm',allowedRuntimeTypes:['generic_llm']},agentIds:[agent.id],tokenBudget:100000});
   session.status=item.status;session.workspaceMode='bootstrap';
   await persistence.setCollection('sessions',sessions.listRaw());
   // Reuse the production mapping, including PAUSED/WAIT_* -> WAITING_USER.
   const mapped=sessions.workItemStatusForSessionStatus(item.status);
   if(!mapped)throw Error('UNMAPPED_FIXTURE_SESSION_STATUS: '+item.status);
   await context.updateActiveWorkItemStatus(session,mapped);
   const decision=await context.recordDecision({session,workItemId:session.activeWorkItemId,sourceEventId:firstEvent.id,kind:'constraint',content:'使用 PostgreSQL，保持现有数据库表结构。',confirmed:true});
   let old;if(item.expected.correction)old=await context.recordDecision({session,workItemId:session.activeWorkItemId,sourceEventId:firstEvent.id,kind:'constraint',content:'当前登录任务的超时时间为 10 分钟。',confirmed:true});
   if(item.large){
    for(let i=0;i<8;i++){
     const text=`历史登录讨论 ${i+1}：`+'已确认登录接口遵循最小披露原则；客户端缓存令牌，服务端统一检查有效期。'.repeat(18);
     const history=events.create({sessionId:session.id,type:'user_message',workItemId:session.activeWorkItemId,content:text,toAgentIds:[]});
     const historicalRoute=await context.createRoutingRecord({session,sourceEventId:history.id,idempotencyKey:randomUUID(),rolloutMode:'enforce_new_sessions'});
     if(process.argv.includes('--budget-ready')){
      // Large-history fixture only: these are completed historical routes, not pending queue entries.
      await persistence.mutateCollections(['intentRoutingRecordsBySession'],draft=>{
       const saved=draft.intentRoutingRecordsBySession[session.id].find(r=>r.id===historicalRoute.id);
       saved.status='ROUTED';saved.actionStatus='applied';
      },{sessionIds:[session.id]});
     }
     for(let d=0;d<2;d++)await context.recordDecision({session,workItemId:session.activeWorkItemId,sourceEventId:history.id,kind:'constraint',content:`历史约束 ${i+1}-${d+1}：`+'错误响应不包含凭证，审计事件只记录非敏感摘要。'.repeat(8),confirmed:true});
    }
   }
   const mentions=item.mention?[agent.id]:[];
   const event=events.create({sessionId:session.id,type:'user_message',content:item.message,toAgentIds:mentions,metadata:{kind:'chat_message',version:1,payload:{text:item.message,mentionedAgentIds:mentions}}});
   const routing=await context.createRoutingRecord({session,sourceEventId:event.id,idempotencyKey:randomUUID(),rolloutMode:'enforce_new_sessions'});
   const snapshot=await context.buildIntentSnapshot({session,sourceEventId:event.id,currentMessage:item.message,latestEventSeq:events.list(session.id).length,mentionedAgentIds:mentions});
   if(snapshot.activeWorkItem.status!==mapped)throw Error('FIXTURE_STATUS_DIFFERS_FROM_PRODUCTION');
   if(item.large && (snapshot.correctionCandidates.length!==8||snapshot.recentRelevantMessages.length!==8||snapshot.validDecisions.length<16))throw Error('LARGE_FIXTURE_INCOMPLETE');
   const classified=await classifier.classify({sessionId:session.id,routingId:routing.id,snapshotId:snapshot.id});
   const understanding=classified.semanticProposal?.understanding;
   row.actual={status:classified.status,reasonCodes:classified.reasonCodes,attempts:classified.classificationAttempts,understanding};
   row.fixture={productionWorkItemStatus:mapped,sessionStatus:session.status,activeWorkItemId:session.activeWorkItemId,decisionId:decision.id,oldDecision:old,snapshot};
   const check=(field,pass)=>row.checks.push({field,pass:!!pass});
   check('schema',!!understanding);
   if(understanding){
    const seg=understanding.segments[0],segs=understanding.segments;
    check('relation',item.expected.multi?segs.length>=2&&segs.some(s=>s.scopeRelation==='same_requirement')&&segs.some(s=>s.scopeRelation==='independent_new_requirement'):item.id==='L09'?['same_requirement','ambiguous'].includes(seg.scopeRelation):seg.scopeRelation===item.expected.relation);
    if(item.expected.actions)check('action',item.expected.actions.includes(seg.suggestedAction));
    if(item.policy)check('contextPolicy',seg.contextPolicy===item.policy);
    if(item.inherit)check('inheritDecision',seg.target.decisionIds.includes(decision.id));
    if(item.mention)check('mentionedAgents',mentions.every(id=>segs.some(s=>s.target.agentIds.includes(id))));
    if(item.expected.readOnly)check('noExecutionEffects',segs.every(s=>s.requestedEffects.every(e=>['answer','read_workspace'].includes(e.kind))));
    if(item.expected.correction)check('correctionBinding',seg.correction?.supersedesDecisionId===old.id&&seg.correction?.expectedDecisionRevision===old.revision&&seg.correction?.replacementText===item.message);
    if(!['L04','L11','L12','L17'].includes(item.id)&&seg.scopeRelation==='same_requirement')check('workItemTarget',seg.target.workItemId===session.activeWorkItemId);
    const plan=compileIntentRoutePlan({session,routing,snapshot,understanding,snapshotCurrent:true,intentRevision:1,requirementRevision:1,executionEpoch:1,sessionGeneration:1,validArtifactIds:[],correctionRoutingIds:[],stopConfirmed:true,
      scopePolicy:{grants:[],phaseAllowed:[...INTENT_EFFECT_KINDS],toolAllowed:[...INTENT_EFFECT_KINDS],workspaceAllowed:[...INTENT_EFFECT_KINDS],runtimeAllowed:[...INTENT_EFFECT_KINDS],resources:[],enforceableProhibitions:[]}});
    row.actual.plan=plan;
    check('routeReferencesAndRelation',plan.validation.referencesValid&&plan.validation.relationActionValid);
    if(supervisor){
     check('routeState',plan.validation.stateValid);
     check('goalSegmentation',segs.length===(item.expected.multi?2:1));
     if(item.expected.resume){
      check('positiveResumeApplicable',plan.outcome==='applicable'&&seg.suggestedAction==='resume');
      const resumes=segs.filter(segment=>segment.suggestedAction==='resume');
      check('resumeDeclaresNoEffects',resumes.length>0&&resumes.every(segment=>Array.isArray(segment.requestedEffects)&&segment.requestedEffects.length===0));
     }
    }
    check('evidence',!plan.validation.errorCodes.includes('SOURCE_EVIDENCE_INVALID'));
    if(['L09','L11','L12','L17'].includes(item.id)||item.expected.clarify||item.expected.multi)check('safeClarification',plan.outcome!=='applicable');
    check('noUnauthorizedExecution',plan.steps.every(s=>s.effectScope.effects.every(e=>e.kind==='answer')));
   }
  }catch(e){row.error=String(e?.stack??e);}
  row.tokenEstimates=provider.calls.slice(callStart).map(call=>({providerCall:call.index,messagesChars:JSON.stringify({messages:call.request.messages}).length,estimatedInputTokens:Math.ceil(JSON.stringify({messages:call.request.messages}).length/4),estimator:'chars/4',configuredMaxInputTokens:6000}));
  row.durationMs=Date.now()-began;row.providerCalls=provider.calls.length-callStart;row.invocations=invocations.slice(invocationStart);
  row.modelOutputSeen=!!row.actual?.understanding||provider.calls.slice(callStart).some(call=>typeof call.output==='string');
  row.passed=!row.error&&row.checks.length>0&&row.checks.every(c=>c.pass);
  return row;
  },{
   persist: audit=>writeFile(resolve(out,`transport-${item.id}.json`),JSON.stringify(audit,null,2)),
   progress: status=>console.log(JSON.stringify({id:item.id,...status}))
  });
  row.totalDurationMs=Date.now()-caseStarted;
  results.push(row);
  await writeFile(resolve(out,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({id:row.id,passed:row.passed,failed:row.checks.filter(c=>!c.pass).map(c=>c.field),error:row.error,status:row.actual?.status,reasons:row.actual?.reasonCodes,calls:row.providerCalls,durationMs:row.durationMs}));
 }
}finally{await app?.close();await provider.close();}
