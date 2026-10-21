import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { liveCases } from './intent-evaluation-cases-2026-10-19.mjs';
import { createSmokeV2State } from '../e2e/smoke-server.mjs';

const out=resolve('docs/quality/intent-evaluation-2026-10-19/evidence');
const limit=Number(process.argv.find(x=>x.startsWith('--limit='))?.split('=')[1]??liveCases.length);
const paths=(process.argv.find(x=>x.startsWith('--paths='))?.split('=')[1]??'legacy,v2').split(',');
const label=process.argv.find(x=>x.startsWith('--label='))?.split('=')[1]??'live';
const runtimeType=process.argv.find(x=>x.startsWith('--runtime='))?.split('=')[1]??'generic_llm';
const offset=Number(process.argv.find(x=>x.startsWith('--offset='))?.split('=')[1]??0);
const seedPriorTimeout=process.argv.includes('--seed-prior-timeout');
const codexMode=runtimeType==='codex';
const isolatedWorkspace=codexMode?await mkdtemp(resolve(tmpdir(),'intent-eval-')):undefined;
if(isolatedWorkspace){
 await mkdir(resolve(isolatedWorkspace,'src'),{recursive:true});
 await writeFile(resolve(isolatedWorkspace,'package.json'),JSON.stringify({name:'synthetic-intent-fixture',private:true,type:'module'}));
 await writeFile(resolve(isolatedWorkspace,'README.md'),'# Synthetic login project\nImplement a login endpoint using PostgreSQL. Preserve existing database tables. This folder contains no production code or user data.\n');
 await writeFile(resolve(isolatedWorkspace,'src/login.js'),'export function validatePassword(password) { return typeof password === "string" && password.length > 0; }\n');
}
const stateFile=resolve('.cache/agent-cluster',`intent-evaluation-${label}-${randomUUID()}.json`);
await mkdir(out,{recursive:true});await mkdir(resolve('.cache/agent-cluster'),{recursive:true});
await writeFile(stateFile,JSON.stringify(createSmokeV2State()));
// Dedicated evaluation state, synthetic messages only, no execution phase.
// Transport/schema retries are disabled to keep first-pass quality observable;
// service-level retries and validation remain the actual implementation.
Object.assign(process.env,{AGENT_CLUSTER_PERSISTENCE:'true',AGENT_CLUSTER_PERSISTENCE_BACKEND:'file',AGENT_CLUSTER_DATA_FILE:stateFile,AGENT_CLUSTER_SEED_DEFAULT_AGENTS:'true',ENABLE_BULLMQ:'false',INTENT_ROUTING_MODE:'shadow',MAIN_AGENT_DISCUSSION_ENABLED:'false',REQUIREMENT_DOCUMENT_ENABLED:'false',GLOBAL_DEFAULT_RUNTIME_TYPE:'generic_llm',LLM_DRY_RUN:'false',LLM_MOCK_FALLBACK:'false',MOCK_RUNTIME_ENABLED:'false',LLM_MAX_RETRIES:'0',LLM_SCHEMA_REPAIR_ATTEMPTS:'0',LLM_TIMEOUT_MS:'45000',LLM_REMOTE_MAX_OUTPUT_TOKENS:'1600',PHASE_TIMEOUT_USER_MESSAGE_ROUTING_MS:'90000'});
if(codexMode)Object.assign(process.env,{GLOBAL_DEFAULT_RUNTIME_TYPE:'codex',CODEX_RUNTIME_ENABLED:'true',CODEX_RUNTIME_COMMAND:'codex',CODEX_RUNTIME_SHELL:'true',CODEX_RUNTIME_ARGS_JSON:JSON.stringify(['exec','--json','--ephemeral','--skip-git-repo-check']),RUNTIME_STREAMING:'off',AGENT_CLUSTER_WORKDIR_BRIEF:'false',PHASE_TIMEOUT_USER_MESSAGE_ROUTING_MS:'180000',LLM_API_KEY:''});
if(!codexMode&&(!process.env.LLM_API_KEY||!process.env.LLM_BASE_URL))throw Error('Configured model credentials are missing.');
const allowedBase=process.env.LLM_BASE_URL?.replace(/\/$/,'');
const originalFetch=globalThis.fetch;
let providerRequests=0,currentCase;
const rawCalls=[],results=[];
globalThis.fetch=async(input,init)=>{
 if(codexMode)throw Error('EVALUATION_NODE_NETWORK_DISABLED_FOR_CODEX');
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 if(![`${allowedBase}/chat/completions`,`${allowedBase}/models`].includes(url))throw Error('EVALUATION_UNEXPECTED_NETWORK_DESTINATION');
 if(url.endsWith('/chat/completions')){
  if(++providerRequests>60)throw Error('EVALUATION_PROVIDER_CALL_LIMIT');
  const body=JSON.parse(init.body);
  rawCalls.push({case:currentCase,request:providerRequests,model:body.model,inputChars:JSON.stringify(body.messages).length,promptHash:createHash('sha256').update(JSON.stringify(body.messages)).digest('hex'),maxOutputTokens:body.max_tokens??body.max_completion_tokens});
 }
 return originalFetch(input,{...init,redirect:'error'});
};
const load=async(path)=>import(`../../apps/server/dist/apps/server/src/${path}.js`);
let app;
function accepts(expected,actual){return Array.isArray(expected)?expected.includes(actual):expected===actual;}
try{
 const [{NestFactory},{AppModule},{SessionsService},{AgentsService},{ContextManagementService},{EventsService},{PersistenceService},{RuntimeService},{OrchestratorService},{SemanticIntentRouterService}]=await Promise.all([
  import('@nestjs/core'),load('app.module'),load('modules/sessions/sessions.service'),load('modules/agents/agents.service'),load('modules/context-management/context-management.service'),load('modules/events/events.service'),load('modules/persistence/persistence.service'),load('modules/runtimes/runtime.service'),load('modules/orchestrator/orchestrator.service'),load('modules/intent-recognition/semantic-intent-router.service')]);
 app=await NestFactory.createApplicationContext(AppModule,{logger:false,abortOnError:false});
 const sessions=app.get(SessionsService),agents=app.get(AgentsService),context=app.get(ContextManagementService),events=app.get(EventsService),persistence=app.get(PersistenceService),runtime=app.get(RuntimeService),orchestrator=app.get(OrchestratorService),router=app.get(SemanticIntentRouterService);
 const {InvocationWorkspaceBindingsService}=await load('modules/runtimes/invocation-workspace-bindings.service');
 const workspaceBindings=app.get(InvocationWorkspaceBindingsService);
 const adapterModule=await load(codexMode?'modules/runtimes/codex-runtime-adapter.service':'modules/runtimes/generic-llm-runtime.service');
 const adapter=app.get(codexMode?adapterModule.CodexRuntimeAdapterService:adapterModule.GenericLlmRuntimeService);
 const availability=await adapter.checkAvailability();
 console.log(JSON.stringify({availability,registered:runtime.listRuntimeTypes?.()}));
 await writeFile(resolve(out,`${label}-availability.json`),JSON.stringify(availability,null,2));
 if(codexMode){
  const {SystemAgentRuntimePolicyService}=await load('modules/agents/system-agent-runtime-policy.service');
  for(const role of ['coordinator','intent_router'])await app.get(SystemAgentRuntimePolicyService).update(role,{preferredRuntimeType:'codex',allowedRuntimeTypes:['codex']});
  const runCommand=adapter.runBufferedCommand.bind(adapter);
  adapter.runBufferedCommand=async(...args)=>{
   if(++providerRequests>80)throw Error('EVALUATION_PROVIDER_CALL_LIMIT');
   const record={case:currentCase,request:providerRequests,command:args[0],args:args[1],cwd:args[3],promptHash:createHash('sha256').update(args[2]).digest('hex'),inputChars:args[2].length};
   rawCalls.push(record);
   try{const output=await runCommand(...args);record.events=output.stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});return output;}
   catch(error){record.error=String(error?.message??error);record.stderr=String(error?.stderr??'').slice(0,2000);throw error;}
  };
 }
 // Fixture setup must not launch discussion/brief/workflow work.
 sessions.generateBriefInBackground=()=>{};
 const invocations=[];
 const resolutionErrors=[];
 const {InvocationResolverService}=await load('modules/runtime-routing/invocation-resolver.service');
 const resolver=app.get(InvocationResolverService),resolveInvocation=resolver.resolve.bind(resolver);
 resolver.resolve=(input)=>{try{return resolveInvocation(input);}catch(error){resolutionErrors.push({case:currentCase,code:error?.code,message:String(error?.message??error)});throw error;}};
 const start=runtime.start.bind(runtime);
 const {resolveCliToolAuthority}=await load('modules/runtimes/cli-tool-authority');
 runtime.start=(plan,signal)=>{
  if(plan.phase!=='user_message_routing')throw Error('EVALUATION_EXECUTION_PHASE_BLOCKED');
  const authority=resolveCliToolAuthority(plan);
  if(authority.canWrite||authority.canRunTests)throw Error('EVALUATION_WRITE_AUTHORITY_BLOCKED');
  const owner=currentCase;
  if(codexMode)rawCalls.push({case:owner,invocationId:plan.invocationId,runtimeType:plan.executionTarget.runtimeType,phase:plan.phase,writeMode:plan.executionTarget.writeMode,codexSandbox:authority.codexSandbox,toolNames:plan.toolCatalog.tools.map(x=>x.name),transport:'actual server runtime worker; parent fetch does not observe CLI HTTP requests'});
  const execution=start(plan,signal);
  execution.result.then(result=>invocations.push({case:owner,invocationId:plan.invocationId,runtimeType:result.runtimeType,status:result.status,errorCode:result.error?.code,usage:result.usage,output:result.output,envelopeHash:createHash('sha256').update(JSON.stringify(plan.contextEnvelope)).digest('hex'),currentUserMessage:plan.contextEnvelope?.L1?.currentUserMessage,writeMode:plan.executionTarget?.writeMode,toolCount:plan.toolCatalog?.tools?.length??0})).catch(()=>{});
  return execution;
 };
 const testAgent=agents.list().find(x=>x.key==='test')??agents.list().find(x=>x.key==='review');
 for(const item of liveCases.slice(offset,offset+limit))for(const path of paths){
  currentCase=`${item.id}:${path}`;const startedAt=Date.now(),requestStart=providerRequests,invocationStart=invocations.length;
  const {session,firstEvent}=await sessions.create({input:item.goal,runtimePreference:{preferredRuntimeType:runtimeType,allowedRuntimeTypes:[runtimeType]},...(codexMode?{workingDirectory:{kind:'server_local',id:'intent-eval-workspace',name:'isolated-intent-evaluation',path:isolatedWorkspace}}:{}),agentIds:[testAgent.id],tokenBudget:40000});
  if(codexMode)workspaceBindings.bindSession(session);
  session.status=item.status;
  // A new synthetic project is a bootstrap workspace; no existing repository
  // evidence is needed for this semantic-only recognition benchmark.
  if(codexMode)session.workspaceMode='bootstrap';
  await persistence.setCollection('sessions',sessions.listRaw());
  await context.updateActiveWorkItemStatus(session,item.status==='FAILED'?'FAILED':'OPEN');
  const accepted=await context.recordDecision({session,workItemId:session.activeWorkItemId,sourceEventId:firstEvent.id,kind:'constraint',content:'使用 PostgreSQL，保持现有数据库表结构。',confirmed:true});
  if(seedPriorTimeout&&item.id==='L20')await context.recordDecision({session,workItemId:session.activeWorkItemId,sourceEventId:firstEvent.id,kind:'constraint',content:'当前登录任务的超时时间为 10 分钟。',confirmed:true});
  const mentions=item.mention?[testAgent.id]:[];
  let actual,error,checks=[];
  try{
   if(path==='legacy'){
    actual=await orchestrator.recognizeFollowUpMessage(session,item.message,mentions);
    const expectedRelation=item.relation==='same_requirement'?'continuation':'new_requirement';
    if(item.clarify)checks.push({field:'requiresUserConfirmation',pass:actual.requiresUserConfirmation===true});
    else checks.push({field:'requirementRelation',pass:actual.requirementRelation===expectedRelation});
    if(item.status==='FAILED'&&!item.clarify)checks.push({field:'failedExecutionAction',pass:accepts(item.action,actual.failedExecutionAction)});
    if(item.dialogue)checks.push({field:'intent',pass:item.dialogue.includes(actual.intent)});
   }else{
    const event=events.create({sessionId:session.id,type:'user_message',content:item.message,toAgentIds:mentions,metadata:{kind:'chat_message',version:1,payload:{text:item.message,mentionedAgentIds:mentions}}});
    const routing=await context.createRoutingRecord({session,sourceEventId:event.id,idempotencyKey:randomUUID(),rolloutMode:'enforce_new_sessions'});
    const snapshot=await context.buildIntentSnapshot({session,sourceEventId:event.id,currentMessage:item.message,latestEventSeq:events.list(session.id).length,mentionedAgentIds:mentions});
    const outcome=await router.classify(session,routing,snapshot);
    actual={decision:outcome.decision,validation:outcome.validation,autoApplicable:outcome.autoApplicable};
    checks.push({field:'scopeRelation',pass:outcome.decision.scopeRelation===item.relation});
    checks.push({field:'requestedAction',pass:accepts(item.action,outcome.decision.requestedAction)});
    checks.push({field:'autoApplicable',pass:outcome.autoApplicable===!Boolean(item.clarify)});
    if(!item.clarify)checks.push({field:'selectedWorkItemId',pass:outcome.decision.selectedWorkItemId===session.activeWorkItemId||(['create_independent_work_item','create_related_work_item'].includes(outcome.decision.requestedAction)&&!outcome.decision.selectedWorkItemId)});
    if(item.policy)checks.push({field:'contextPolicy',pass:outcome.decision.contextPolicy===item.policy});
    if(item.inherit)checks.push({field:'selectedDecisionIds',pass:outcome.decision.selectedDecisionIds.includes(accepted.id)});
    if(item.mention)checks.push({field:'requestedAgentIds',pass:mentions.every(id=>outcome.decision.requestedAgentIds?.includes(id))});
    if(item.dialogue)checks.push({field:'dialogueAct',pass:item.dialogue.includes(outcome.decision.dialogueAct)});
   }
  }catch(caught){error={name:caught?.name,message:String(caught?.message??caught).slice(0,1000)};}
  const row={id:item.id,path,feature:item.feature,message:item.message,sessionStatus:item.status,fixture:{seedPriorTimeout},expected:item,passed:!error&&checks.every(x=>x.pass),checks,actual,error,resolutionErrors:resolutionErrors.filter(x=>x.case===currentCase),durationMs:Date.now()-startedAt,providerRequests:providerRequests-requestStart,invocations:invocations.slice(invocationStart)};
  results.push(row);
  await writeFile(resolve(out,`${label}-results.json`),JSON.stringify({executedAt:new Date().toISOString(),runtimeType,model:codexMode?'local Codex config (gpt-6-astra, xhigh)':process.env.LLM_MODEL,method:'real configured provider; default Agent profiles; isolated synthetic sessions; actual recognition methods; route application not executed',overrides:{transportRetries:0,schemaRepairAttempts:0,maxOutputTokens:codexMode?'Codex default':1600,isolatedWorkspace,workspaceMode:codexMode?'bootstrap':undefined,workdirBrief:false},providerRequests,providerRequestObservation:codexMode?'CLI runs in child worker; HTTP count not observable; use recorded invocations; zero usage is adapter placeholder, not free execution':'fetch',rawCalls,results},null,2));
  console.log(JSON.stringify({id:row.id,path,passed:row.passed,error:row.error?.message,failedFields:checks.filter(x=>!x.pass).map(x=>x.field),providerRequests:row.providerRequests,durationMs:row.durationMs}));
 }
}finally{globalThis.fetch=originalFetch;await app?.close();}
