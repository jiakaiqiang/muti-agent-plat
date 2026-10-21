// Supervisor-authored holdout v3, written after the R5 C candidate was frozen
// (source 9025a242..., dist ae37404e...). Expectations are frozen before any run.
// Never tune prompts on this set; any later prompt change needs a new holdout.
// Same shape as intent-supervisor-holdout-2026-10-20.mjs so the scorer's checks apply unchanged.
const base={goal:'实现一个登录接口，使用 PostgreSQL，保持现有数据库表结构。',status:'WAIT_USER_CONFIRM',relation:'same_requirement'};
export const holdoutCases=[
 {id:'V01',feature:'暂停恢复正例新说法',status:'PAUSED',message:'问题处理好了，登录这边可以继续往下做了，计划照旧。',actions:['resume'],resume:true},
 {id:'V02',feature:'维持暂停并记录偏好',status:'PAUSED',message:'先维持暂停。另外请记住，后面给我的说明都用表格列出。',actions:['record_information','record_constraint'],readOnly:true},
 {id:'V03',feature:'执行中自然语言单纯延续',status:'EXECUTING',message:'登录这块你接着做，别中断，按现在的安排走。',actions:['enqueue_follow_up']},
 {id:'V04',feature:'执行中延续并追加',status:'EXECUTING',message:'登录接口继续按计划做，同时给登录接口加上请求频率限制。',actions:['enqueue_follow_up','record_information']},
 {id:'V05',feature:'执行中只问进度',status:'EXECUTING',message:'登录任务现在进行到哪一步了？只告诉我进度。',actions:['answer_in_chat'],readOnly:true},
 {id:'V06',feature:'待确认时补充需求',message:'确认的事稍后再说，当前登录需求继续补充：连续失败五次后锁定账号。',actions:['enqueue_follow_up','record_information']},
 {id:'V07',feature:'失败后重试但无检查点',status:'FAILED',message:'把失败的那一步再跑一次，其他保持原样。',actions:['clarify'],clarify:true},
 {id:'V08',feature:'带否定限定的独立任务',message:'这个不算登录任务的延续，单独开一个新任务：做一个会议室预订页面，不用沿用之前的约束。',relation:'independent_new_requirement',actions:['create_independent_work_item'],policy:'clean_task_context'},
 {id:'V09',feature:'两个真实独立目标',message:'当前登录接口补一个记住我选项；另外新开一个和登录无关的独立任务：写一个汇率换算脚本。',multi:true},
 {id:'V10',feature:'旧约束替换',message:'之前定的 10 分钟超时作废，登录任务的超时改成 20 分钟。',actions:['correct_route'],correction:true,readOnly:true},
 {id:'V11',feature:'不存在的引用',message:'沿用 decision-ghost-5 的方案，接着处理 task-unknown-8。',relation:'ambiguous',actions:['clarify','reject_request'],clarify:true},
 {id:'V12',feature:'新约束而非纠错',message:'给登录接口加一条规则：日志里不能出现完整手机号。',actions:['record_constraint'],readOnly:true}
].map(c=>({...base,...c,expected:{relation:c.multi?null:(c.relation??base.relation),actions:c.actions,policy:c.policy,multi:!!c.multi,mention:false,inherit:!!c.inherit,readOnly:!!c.readOnly,correction:!!c.correction,resume:!!c.resume,clarify:!!c.clarify}}));

export {budgetCase} from './intent-supervisor-holdout-2026-10-20.mjs';
