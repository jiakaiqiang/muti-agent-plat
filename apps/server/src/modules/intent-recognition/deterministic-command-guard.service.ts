import { Injectable } from '@nestjs/common';

export type ExactUserCommand = 'resume' | 'retry' | 'pause' | 'cancel' | 'confirm' | 'reject';

export type ExactCommandReasonCode =
  | 'EXACT_RESUME_COMMAND'
  | 'EXACT_RETRY_COMMAND'
  | 'EXACT_PAUSE_COMMAND'
  | 'EXACT_CANCEL_COMMAND'
  | 'EXACT_CONFIRM_COMMAND'
  | 'EXACT_REJECT_COMMAND';

export type ExactCommandMatch = {
  command: ExactUserCommand;
  normalizedText: string;
  reasonCode: ExactCommandReasonCode;
};

export type CompoundExecutionControlMatch = {
  command: 'pause';
  /** The non-control part must continue through the normal execution-change path. */
  remainder: string;
  normalizedText: string;
  reasonCode: 'COMPOUND_PAUSE_BEFORE_FOLLOW_UP';
};

export type WorkflowAgentSkipCommandMatch = {
  normalizedText: string;
  reasonCode: 'SKIP_CURRENT_WORKFLOW_AGENT_AND_CONTINUE';
};

export type WorkflowAgentDirectiveMatch = {
  kind: 'assign_agent' | 'rerun_upstream';
  /** Raw operator text naming the target Agent; resolved against Session participants. */
  targetText: string;
  normalizedText: string;
  reasonCode: 'ASSIGN_WORKFLOW_AGENT' | 'RERUN_UPSTREAM_WORKFLOW_NODE';
};

export type ExecutionStatusQuestionMatch = {
  normalizedText: string;
  reasonCode: 'EXECUTION_STATUS_QUESTION';
};

export type ExecutionConsultationQuestionMatch = {
  normalizedText: string;
  reasonCode: 'EXECUTION_CONSULTATION_QUESTION';
};

export type ExecutionScopeChangeMatch = {
  normalizedText: string;
  reasonCode: 'EXECUTION_SCOPE_CHANGE';
};

const COMMANDS: ReadonlyArray<{
  command: ExactUserCommand;
  reasonCode: ExactCommandReasonCode;
  aliases: ReadonlySet<string>;
}> = [
  {
    command: 'resume',
    reasonCode: 'EXACT_RESUME_COMMAND',
    aliases: new Set(['继续', '继续执行', '恢复', 'resume', 'continue'])
  },
  {
    command: 'retry',
    reasonCode: 'EXACT_RETRY_COMMAND',
    aliases: new Set(['重试', '重新执行', 'retry'])
  },
  {
    command: 'pause',
    reasonCode: 'EXACT_PAUSE_COMMAND',
    aliases: new Set(['暂停', 'pause'])
  },
  {
    command: 'cancel',
    reasonCode: 'EXACT_CANCEL_COMMAND',
    aliases: new Set(['取消', '终止', 'cancel', 'stop'])
  },
  {
    command: 'confirm',
    reasonCode: 'EXACT_CONFIRM_COMMAND',
    aliases: new Set(['确认', '同意', '通过', 'confirm', 'approve'])
  },
  {
    command: 'reject',
    reasonCode: 'EXACT_REJECT_COMMAND',
    aliases: new Set(['拒绝', '不同意', 'reject'])
  }
];

export function normalizeExactCommandText(content: string) {
  return content
    .normalize('NFKC')
    .trim()
    .replace(/[。！？!?，,；;：:]+$/u, '')
    .trim()
    .toLowerCase();
}

export function matchExactUserCommand(content: string): ExactCommandMatch | undefined {
  const normalizedText = normalizeExactCommandText(content);
  if (!normalizedText) return undefined;
  const matched = COMMANDS.find((candidate) => candidate.aliases.has(normalizedText));
  return matched
    ? { command: matched.command, normalizedText, reasonCode: matched.reasonCode }
    : undefined;
}

/**
 * Matches a deterministic stop prefix followed by additional user content.
 * Exact-command matching intentionally stays strict for ordinary messages, but
 * execution control must win when a user says "先停下来，另外...". The suffix
 * is returned separately so it is not swallowed by the stop operation.
 */
export function matchCompoundExecutionControl(content: string): CompoundExecutionControlMatch | undefined {
  const normalizedText = content
    .normalize('NFKC')
    .trim()
    .replace(/[。！？!?；;：:]+$/u, '')
    .trim();
  if (!normalizedText || normalizedText.length > 500) return undefined;
  const matched = normalizedText.match(
    /^(?:请)?(?:先\s*)?(?:暂停|停下来|停一下|停止|pause|stop)\s*(?:[，,、；;：:]\s*|\s+)(.+)$/iu
  );
  const remainder = matched?.[1]?.trim();
  if (!remainder) return undefined;
  return {
    command: 'pause',
    remainder,
    normalizedText: normalizedText.toLowerCase(),
    reasonCode: 'COMPOUND_PAUSE_BEFORE_FOLLOW_UP'
  };
}

/**
 * Matches the one compound control instruction that has a deterministic stateful
 * meaning while a workflow Agent substitution card is active. It intentionally
 * requires both a leading skip verb and a trailing continue verb so ordinary
 * requirements containing either word still go through semantic intent routing.
 */
export function matchWorkflowAgentSkipCommand(content: string): WorkflowAgentSkipCommandMatch | undefined {
  const normalizedText = content
    .normalize('NFKC')
    .trim()
    .replace(/[。！？!?；;：:]+$/u, '')
    .trim()
    .toLowerCase();
  if (!normalizedText || normalizedText.length > 200) return undefined;
  const chinese = /^(?:请)?(?:跳过|忽略|略过)(?!不了|不得|不要).{0,80}?(?:继续|恢复)(?:执行|运行|后续流程|后续任务|流程|任务)?$/u;
  const english = /^(?:please\s+)?(?:skip|bypass)\b.{0,80}\b(?:and\s+)?(?:continue|resume)(?:\s+(?:execution|the\s+workflow|the\s+task))?$/i;
  if (!chinese.test(normalizedText) && !english.test(normalizedText)) return undefined;
  return { normalizedText, reasonCode: 'SKIP_CURRENT_WORKFLOW_AGENT_AND_CONTINUE' };
}

/**
 * Matches the two stateful workflow directives that name a target Agent, so a
 * pending substitution or upstream-rerun card can be resolved by typing instead
 * of clicking. Both patterns require an explicit operator verb plus a trailing
 * execution verb; a bare Agent mention or a question about an Agent stays on the
 * semantic router. The target is returned as raw text because only the Session
 * knows which Agents participate.
 */
export function matchWorkflowAgentDirective(content: string): WorkflowAgentDirectiveMatch | undefined {
  const normalizedText = content
    .normalize('NFKC')
    .trim()
    .replace(/[。！？!?；;：:]+$/u, '')
    .trim();
  if (!normalizedText || normalizedText.length > 200) return undefined;
  if (/^(?:不要|别|不能|不该|无需|不用)/u.test(normalizedText)) return undefined;
  if (/[？?]/u.test(normalizedText)) return undefined;
  if (/(?:是否|要不要|能不能|可以吗|讨论|评估|为什么)/u.test(normalizedText)) return undefined;

  const rerunChinese = normalizedText.match(
    /^(?:请)?(?:退回|回退|回到|返回|重新回到)(?:给)?\s*([^，,。；;]{1,40}?)(?:节点|环节|阶段|这一步)?\s*(?:重新)?(?:执行|运行|来做|处理|修改|返工)$/u
  );
  if (rerunChinese?.[1]) {
    return {
      kind: 'rerun_upstream',
      targetText: rerunChinese[1].trim(),
      normalizedText,
      reasonCode: 'RERUN_UPSTREAM_WORKFLOW_NODE'
    };
  }
  const rerunEnglish = normalizedText.match(
    /^(?:please\s+)?(?:go\s+back\s+to|return\s+to|rerun|re-run)\s+(?:the\s+)?([^,.;]{1,40}?)(?:\s+(?:node|stage|step))?(?:\s+(?:and\s+)?(?:rerun|re-run|execute|run|redo))?$/i
  );
  if (rerunEnglish?.[1]) {
    return {
      kind: 'rerun_upstream',
      targetText: rerunEnglish[1].trim(),
      normalizedText,
      reasonCode: 'RERUN_UPSTREAM_WORKFLOW_NODE'
    };
  }

  const TAIL = '(?:这个任务|这个节点|当前任务|当前节点|本节点|该任务|吧)?';
  const ACTION = '(?:来)?(?:执行|运行|来做|做|处理|接手|继续|负责)';
  // 改派/指派/交给/换成 already name a reassignment on their own, so the trailing
  // execution verb is optional. 让/叫/由/派 are ordinary verbs, so they require it
  // to keep plain requirements like「让登录页面支持记住密码」off this path.
  const assignExplicit = normalizedText.match(
    new RegExp(`^(?:请)?(?:改派给|改派|指派给|指派|交给|换成|换)\\s*([^，,。；;]{1,40}?)\\s*(?:${ACTION})?${TAIL}$`, 'u')
  );
  const assignWeak = assignExplicit ? undefined : normalizedText.match(
    new RegExp(`^(?:请)?(?:让|叫|由|派)\\s*([^，,。；;]{1,40}?)\\s*${ACTION}${TAIL}$`, 'u')
  );
  const assignChinese = assignExplicit ?? assignWeak;
  if (assignChinese?.[1]) {
    return {
      kind: 'assign_agent',
      targetText: assignChinese[1].trim(),
      normalizedText,
      reasonCode: 'ASSIGN_WORKFLOW_AGENT'
    };
  }
  const assignEnglish = normalizedText.match(
    /^(?:please\s+)?(?:let|have|assign\s+(?:it\s+|this\s+)?to|reassign\s+(?:it\s+|this\s+)?to|switch\s+to|hand\s+(?:it\s+)?(?:over\s+)?to)\s+(?:the\s+)?([^,.;]{1,40}?)(?:\s+(?:execute|run|do\s+it|handle\s+it|take\s+over|continue))?$/i
  );
  if (assignEnglish?.[1]) {
    return {
      kind: 'assign_agent',
      targetText: assignEnglish[1].trim(),
      normalizedText,
      reasonCode: 'ASSIGN_WORKFLOW_AGENT'
    };
  }
  return undefined;
}

/**
 * Matches a read-only "where are we" question so it can be answered from the
 * deterministic progress projection instead of a model call. The patterns are
 * anchored on purpose: a message that also carries a requirement, names an
 * expert or issues a control command is not a status read and must stay on the
 * semantic router, because answering it here would skip the scope-change path.
 */
export function matchExecutionStatusQuestion(content: string): ExecutionStatusQuestionMatch | undefined {
  const normalizedText = normalizeExactCommandText(content);
  if (!normalizedText || normalizedText.length > 200) return undefined;
  // A control command has stateful meaning; a mention is a consultation.
  if (matchExactUserCommand(normalizedText)) return undefined;
  if (/[@＠]/u.test(normalizedText)) return undefined;
  // A supplement tacked onto the question still changes scope.
  if (/(?:顺便|另外|还要|además|also|additionally|by the way)/u.test(normalizedText)) return undefined;

  const chinese = /^(?:现在|目前|当前)?(?:做到|进行到|执行到)(?:哪一?步|哪里|哪个阶段|什么阶段)(?:了)?$/u;
  const chineseProgress = /^(?:现在|目前|当前)?(?:进度|进展)(?:如何|如何了|怎么样|怎样|到哪了)$/u;
  const english = /^(?:what(?:'s|\s+is|\s+are)?\s+(?:the\s+)?(?:progress|status)|how(?:'s|\s+is)\s+(?:it|this)\s+going|how\s+far\s+along(?:\s+are\s+we|\s+is\s+it)?|progress|status)$/i;
  if (!chinese.test(normalizedText) && !chineseProgress.test(normalizedText) && !english.test(normalizedText)) {
    return undefined;
  }
  return { normalizedText, reasonCode: 'EXECUTION_STATUS_QUESTION' };
}

/**
 * Phrases that ask for work rather than for an opinion. A question wrapped
 * around one of these is still a scope change, so it must reach the change
 * request path instead of being answered as a read-only consultation.
 */
const SCOPE_CARRYING_PHRASES =
  /(?:顺便|另外|还要|再加|加一个|加上|增加|改成|换成|去掉|删掉|also|additionally|by the way|\badd\b|\bremove\b|\bdelete\b|\brename\b)/iu;

/**
 * Matches a read-only question addressed to an expert during execution, so it
 * becomes a bounded consultation on the live requirement instead of a re-plan.
 * A message that asks for work is deliberately excluded: answering it here
 * would skip the impact analysis the user is entitled to (AC2/AC3).
 */
export function matchExecutionConsultationQuestion(content: string): ExecutionConsultationQuestionMatch | undefined {
  const normalizedText = normalizeExactCommandText(content);
  if (!normalizedText || normalizedText.length > 200) return undefined;
  if (matchExactUserCommand(normalizedText)) return undefined;
  if (SCOPE_CARRYING_PHRASES.test(normalizedText)) return undefined;

  const chinese = /(?:吗|呢)$|(?:是否|会不会|有没有|能否|可不可以)/u;
  const english = /^(?:does|do|did|would|will|is|are|was|were|should|could|how|what|why|which|whether)\b/i;
  if (!chinese.test(normalizedText) && !english.test(normalizedText)) return undefined;
  return { normalizedText, reasonCode: 'EXECUTION_CONSULTATION_QUESTION' };
}

/**
 * Matches an execution-time supplement that asks for work the confirmed scope
 * does not cover. It only recognises the explicit supplement markers, so an
 * ordinary question or a control command is left to its own path; anything this
 * matches must go through impact analysis and an explicit user choice before a
 * single node moves (AC3).
 */
export function matchExecutionScopeChange(content: string): ExecutionScopeChangeMatch | undefined {
  const normalizedText = normalizeExactCommandText(content);
  if (!normalizedText || normalizedText.length > 200) return undefined;
  if (matchExactUserCommand(normalizedText)) return undefined;
  if (!SCOPE_CARRYING_PHRASES.test(normalizedText)) return undefined;
  return { normalizedText, reasonCode: 'EXECUTION_SCOPE_CHANGE' };
}

@Injectable()
export class DeterministicCommandGuardService {
  match(content: string) {
    return matchExactUserCommand(content);
  }

  matchScopeChange(content: string) {
    return matchExecutionScopeChange(content);
  }

  matchWorkflowDirective(content: string) {
    return matchWorkflowAgentDirective(content);
  }

  matchStatusQuestion(content: string) {
    return matchExecutionStatusQuestion(content);
  }

  matchConsultationQuestion(content: string) {
    return matchExecutionConsultationQuestion(content);
  }
}
