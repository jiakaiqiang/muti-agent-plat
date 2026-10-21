// Frozen before either build sees these cases. No prompt tuning on this set.
const base={goal:'实现一个登录接口，使用 PostgreSQL，保持现有数据库表结构。',status:'WAIT_USER_CONFIRM',relation:'same_requirement'};
export const holdoutCases=[
 {id:'H01',feature:'暂停恢复正例',status:'PAUSED',message:'暂停原因已经消除，请恢复登录模块的工作，沿用确认过的方案。',actions:['resume'],resume:true},
 {id:'H02',feature:'暂停中只问不恢复',status:'PAUSED',message:'仍然保持暂停。我想先弄清楚登录令牌的有效期为何这样设置，请说明理由。',actions:['answer_in_chat'],readOnly:true},
 {id:'H03',feature:'执行中追加范围',status:'EXECUTING',message:'登录模块照常推进，顺带把用户名为空时的报错补齐。',actions:['enqueue_follow_up','record_information']},
 {id:'H04',feature:'带否定限定的独立任务',message:'别把这项归入登录模块，也不沿用它的约束。请另起一个独立任务，设计个人记账工具。',relation:'independent_new_requirement',actions:['create_independent_work_item'],policy:'clean_task_context'},
 {id:'H05',feature:'相关任务继承',message:'以现有登录需求为父任务新增一个相关任务：导出访问统计，沿用已经确认的 PostgreSQL 约束。',relation:'related_new_requirement',actions:['create_related_work_item'],policy:'inherit_selected',inherit:true},
 {id:'H06',feature:'两个真实独立目标',message:'为当前登录需求补充密码强度校验；另外单独建立一个不继承登录上下文的图书借阅项目。两件事分别处理。',multi:true},
 {id:'H07',feature:'旧约束替换新说法',message:'登录任务先前约定的十分钟超时不再适用，请用四十五分钟替换那条约束。',actions:['correct_route'],correction:true,readOnly:true},
 {id:'H08',feature:'参考资料输入',message:'补充一份登录模块的背景说明：客户端会缓存访问令牌，服务端负责检查有效期。这段文字仅作为后续讨论的参考。',actions:['record_information'],readOnly:true},
 {id:'H09',feature:'不存在的引用',message:'把处理对象切到 work-absent-42，再带上 decision-missing-73 的约束。',relation:'ambiguous',actions:['clarify','reject_request'],clarify:true},
 {id:'H10',feature:'失败后重新规划',status:'FAILED',message:'登录需求的最终目标保留，已经失败的实现路线全部弃用，请重新设计实现方案。',actions:['replan']},
 {id:'H11',feature:'暂停恢复正例另一说法',status:'PAUSED',message:'可以解除当前暂停了。接着完成尚未做完的登录工作，任务范围和方案都不变。',actions:['resume'],resume:true},
 {id:'H12',feature:'新约束而非纠错',message:'给登录模块增加一项限制：错误响应里不得包含用户的原始密码。',actions:['record_constraint'],readOnly:true}
].map(c=>({...base,...c,expected:{relation:c.multi?null:(c.relation??base.relation),actions:c.actions,policy:c.policy,multi:!!c.multi,mention:false,inherit:!!c.inherit,readOnly:!!c.readOnly,correction:!!c.correction,resume:!!c.resume,clarify:!!c.clarify}}));

export const budgetCase={...base,id:'B01',feature:'大会话预算边界',large:true,
 message:'请解释当前登录模块为什么采用现有的令牌过期策略，只作说明。',
 expected:{relation:'same_requirement',actions:['answer_in_chat'],multi:false,readOnly:true}};
