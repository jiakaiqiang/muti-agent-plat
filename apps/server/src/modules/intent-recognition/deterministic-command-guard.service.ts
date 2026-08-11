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

@Injectable()
export class DeterministicCommandGuardService {
  match(content: string) {
    return matchExactUserCommand(content);
  }
}
