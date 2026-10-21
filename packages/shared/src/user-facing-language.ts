import type { SupplementalContextResolution } from './contracts.js';

/** A completed read is not yet proof that the rebuilt envelope passed its gate. */
export function isContextSupplementResolved(resolution?: Partial<SupplementalContextResolution>): boolean {
  if (!resolution) return false;
  if (resolution.outcome) return resolution.outcome === 'resolved';
  return Boolean((resolution.hydratedPaths?.length || resolution.resolvedRefs?.length) &&
    !resolution.failedPaths?.length && !resolution.failedRefs?.length && !resolution.deferredPaths?.length);
}

export function contextSupplementNotice(resolution: Partial<SupplementalContextResolution>, reason: string): string {
  if (isContextSupplementResolved(resolution)) return '所需上下文已补充，正在重新组装并检查证据。';
  if (resolution.outcome === 'partial') return '已补充部分上下文，正在检查是否足以继续。';
  if (resolution.outcome === 'cancelled') return '上下文准备已取消。';
  return `上下文准备未完成：${localizeBuiltInNotice(reason)}`;
}

/** Natural language only: protocol identifiers, code, paths and diagnostic payloads stay unchanged. */
export const CHINESE_RUNTIME_OUTPUT_INSTRUCTION =
  '语言要求：所有面向用户的自然语言必须使用简体中文，包括进度、回复、标题、摘要、任务说明、风险、问题、阻塞原因、下一步建议、requestedContext.reason 和 followUpInstruction，以及产物中的说明文字。代码、命令、路径、URL、标识符、JSON 字段名、枚举值和错误码保持原样，不要翻译；引用外文原文时附中文解释。其他角色提示中的语言要求与本条冲突时，以本条语言规则为准。此要求适用于所有阶段和重试，不改变输出合同或安全边界。';

export function runtimePhaseLabel(phase: string): string {
  return ({ discussion: 'Agent 讨论', discussion_plan: '讨论规划', brief_generation: '任务契约生成',
    brief_revision: '任务契约修订', task_brief: '任务契约生成', task_acceptance: '任务接收',
    task_execution: '任务执行', post_review: '复盘', final_delivery: '最终交付',
    user_message_routing: '消息路由', intent_recognition: '意图识别',
    file_revision: '文件修订', file_revision_candidate: '文件修订候选生成', brief_consultation: '方案咨询',
    revision_synthesis: '修订结果整合', context_supplement: '上下文补充' } as Record<string, string>)[phase] ?? phase;
}

const evidenceReasons: Record<string, string> = {
  'evidence-empty': '尚未提供可用的源码内容',
  'evidence-only-generated': '当前证据只有生成文件，缺少可用的源码内容',
  'evidence-only-sensitive': '当前证据只有敏感文件，不能用于分析',
  'evidence-not-navigable': '当前证据不属于已授权的工作区文件索引'
};

/** Only recognises complete built-in templates. Never translate arbitrary model/user text or code. */
export function localizeBuiltInNotice(text: string): string {
  const gate = /^Context v2 blocked an ungrounded runtime call: (evidence-empty|evidence-only-generated|evidence-only-sensitive|evidence-not-navigable)\.$/.exec(text);
  if (gate) return `上下文证据不足，暂未调用模型：${evidenceReasons[gate[1]]}（${gate[1]}）。`;
  const context = /^Supplemental context (hydrated for retry|was partially hydrated for retry|request was cancelled|could not be hydrated): ([\s\S]+)$/.exec(text);
  if (context) {
    const labels: Record<string, string> = { 'hydrated for retry': '已补充上下文，准备重试',
      'was partially hydrated for retry': '已补充部分上下文，准备重试',
      'request was cancelled': '上下文补充已取消', 'could not be hydrated': '未能补充上下文' };
    return `${labels[context[1]]}：${localizeBuiltInNotice(context[2])}`;
  }
  const exact: Record<string, string> = {
    'Read at least one non-sensitive source file and retry the same phase.': '请至少读取一个非敏感源码文件，然后重试当前阶段。',
    'Read the active discussion document completely before continuing.': '请完整读取当前讨论方案文档后再继续。',
    'Load the requested workspace files and retry Post Review with grounded evidence.': '请读取请求的工作区文件，再基于实际证据重试复盘。',
    'Continue with partial evidence if the bounded preload deadline is reached.': '预加载达到时限时，基于已取得的证据继续，并说明缺失部分。',
    'Supplemental workspace context deadline exceeded.': '补充工作区上下文已超时。',
    'Workspace provider is unavailable or does not grant read access.': '工作区服务不可用或未授予读取权限。',
    'Workspace file is empty.': '工作区文件内容为空。',
    'Receiver is synthesizing the complete file revision candidate.': '接收者正在整合完整的文件修订候选结果。',
    'Message saved; intent recognition will retry after the context snapshot is available.': '消息已保存，上下文快照就绪后将重试意图识别。',
    'Prepared an isolated Git worktree for this task.': '已为当前任务准备独立的 Git 工作区。',
    'Runtime session resume failed; retrying once with a new session.': '运行时会话恢复失败，将使用新会话重试一次。'
  };
  return exact[text] ?? text;
}

const errorCopy: Record<string, string> = {
  CLARIFICATION_CHOICE_CONFLICT: '这张确认卡已经采用了其他选择，已刷新当前结果。如需修改，请纠正原消息。',
  IDEMPOTENCY_PAYLOAD_CONFLICT: '该请求已提交过不同内容，请刷新后查看实际处理结果。',
  CLARIFICATION_CONFIRMATION_MISMATCH: '该确认卡不属于当前消息或已不可用，请刷新群聊。',
  CLARIFICATION_REVISION_CONFLICT: '任务关系已发生变化，请查看刷新后的确认卡。',
  CLARIFICATION_EXPIRED: '该确认卡已过期，请重新说明要处理的任务关系。',
  CLARIFICATION_SUPERSEDED: '该确认已被后续纠正替代，请查看最新结果。',
  CLARIFICATION_TARGET_CHANGED: '当前任务已变化，请刷新后重新确认目标。',
  INTENT_PROCESSING_BLOCKED: '意图识别暂时无法完成，消息尚未执行，请先处理模型连接或运行错误。',
  GITHUB_APP_OAUTH_NOT_CONFIGURED: '平台尚未配置 GitHub App 授权，请联系管理员配置，或使用访问令牌授权。',
  GITHUB_APP_CALLBACK_INVALID: 'GitHub 授权回调地址无效，请配置合法的 HTTPS 地址。',
  GITHUB_TOKEN_INVALID: 'GitHub 访问令牌格式无效，请重新填写。',
  GITHUB_REPOSITORY_WRITE_REQUIRED: '当前账号没有仓库写入权限，请检查账号和仓库授权。',
  GITHUB_SESSION_CREATE_NOT_ENABLED: '当前环境尚未开放 GitHub 会话入口。',
  SERVER_SESSION_REQUIRES_GITHUB_SOURCE: '新建服务器会话需要选择 GitHub 仓库来源。',
  GITHUB_OAUTH_STATE_INVALID: 'GitHub 授权已过期或无效，请重新发起授权。',
  GITHUB_OAUTH_STATE_USED: '该授权请求已使用，请重新发起授权。',
  GITHUB_PULL_HEAD_CHANGED: 'PR 的代码版本已变化，请刷新并重新审查。',
  SESSION_NOT_FOUND: '会话不存在或已不可用。', BRIEF_NOT_FOUND: '任务契约不存在或已不可用。',
  AGENT_NOT_FOUND: '未找到对应的 Agent。', ARTIFACT_NOT_FOUND: '未找到对应的产物。',
  SESSION_DELETE_CONFLICT: '会话清理尚未完成，请稍后重试。',
  INVALID_SESSION_TRANSITION: '当前会话状态不允许执行此操作，请刷新后重试。',
  brief_has_open_questions: '任务契约仍有未决问题，请补充回答，或在达到修订上限后确认保留未决问题并继续。',
  brief_revision_limit_reached: '已达到方案修订上限，请选择保留未决问题并继续。',
  CONTEXT_INSUFFICIENT: '当前上下文证据不足，需要补充后才能继续。',
  RUNTIME_OUTPUT_CONTRACT_VIOLATION: '模型返回的结果不符合输出合同，请检查运行记录或重试。',
  RUNTIME_TIMEOUT: '模型调用超时，请检查连接或重试。', RUNTIME_CANCELLED: '模型调用已取消。',
  HUMAN_APPROVAL_REQUIRED: '当前操作需要用户授权，请确认后继续。',
  LOCAL_RUNTIME_DISCONNECTED: '本机 Runtime 已断开，请重新连接。',
  MODEL_PROTOCOL_MISMATCH: '模型连接协议与所选 Runtime 不兼容，请检查模型配置。',
  MODEL_ERROR: '模型调用失败，请检查模型服务、凭据和运行日志后重试。',
  PAYLOAD_TOO_LARGE: '提交的内容过大，请减小文件或消息大小。',
  SERVICE_UNAVAILABLE: '服务暂不可用，请恢复服务后重试。',
  RESOURCE_NOT_FOUND: '请求的资源不存在或已不可用。',
  VALIDATION_ERROR: '提交的参数不符合要求，请检查输入。',
  INTERNAL_ERROR: '服务处理失败，请稍后重试；如持续出现，请查看运行日志。'
};

/** API/runtime errors are system diagnostics, not model replies. Keep machine codes separate. */
export function localizeSystemError(message: string, code?: string, status?: number): string {
  const builtin = localizeBuiltInNotice(message);
  if (builtin !== message) return builtin;
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  const embeddedCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
  const resolvedCode = embeddedCode ?? code;
  if (message.includes('AGENT_CLUSTER_SECRET_KEY')) return '平台未配置凭据加密密钥，暂时无法安全保存授权，请联系管理员配置（AGENT_CLUSTER_SECRET_KEY）。';
  const http = /(?:GITHUB_API_HTTP_|HTTP[ :]+)(\d{3})/i.exec(message)?.[1];
  const httpStatus = http ? Number(http) : status;
  if (httpStatus === 401) return '身份验证失败，请检查访问令牌或模型凭据是否有效（HTTP 401）。';
  if (httpStatus === 403) return '访问被拒绝，请检查权限、组织授权或请求限制（HTTP 403）。';
  if (httpStatus === 404) return '未找到资源，请检查地址和访问权限（HTTP 404）。';
  if (httpStatus === 429) return '请求过于频繁，请稍后重试（HTTP 429）。';
  if (resolvedCode && errorCopy[resolvedCode]) return `${errorCopy[resolvedCode]}（${resolvedCode}）`;
  if (/Failed to fetch|fetch failed|NetworkError|Load failed|ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) return '连接服务失败，请检查网络和服务是否已启动。';
  return resolvedCode ? `操作未完成，请查看运行日志中的原因（${resolvedCode}）。` : '操作未完成，请检查配置和运行日志后重试。';
}
