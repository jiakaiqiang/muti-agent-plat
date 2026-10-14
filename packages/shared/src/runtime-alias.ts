import { isRuntimeType, type RuntimeType } from './contracts.js';
import type { RuntimeSwitchFallbackMode } from './runtime-switch-contracts.js';

/**
 * The one Runtime naming registry.
 *
 * Display names and spoken aliases live here, not in each surface, because a
 * Runtime the chat parser can name but the UI cannot label (or the reverse) is
 * how "switch to Claude Code" becomes unrecognised on one client and actionable
 * on another (Spec §7.1).
 */
const DISPLAY_NAMES: Readonly<Record<RuntimeType, string>> = {
  mock: '模拟运行时',
  generic_llm: '通用大模型',
  code_reader: 'Code Reader',
  test_runner: 'Test Runner',
  codex: 'Codex',
  claude_code: 'Claude Code',
  mcp_tool: 'MCP 工具',
  human: '人工处理'
};

export function runtimeDisplayName(runtimeType: RuntimeType): string {
  return DISPLAY_NAMES[runtimeType];
}

/**
 * Spoken aliases for the Runtimes a user can actually switch between.
 *
 * Only the interactive coding Runtimes are listed: `mock`, `human` and the
 * internal helpers are not things a user asks to be switched to, and accepting
 * them here would turn a typo into a silent downgrade of the whole Session.
 *
 * Keys are compared after normalization (NFKC, lowercased, separators removed),
 * so "Claude Code", "claude-code" and "claudecode" all collapse to one entry.
 */
const ALIASES: Readonly<Record<string, RuntimeType>> = {
  codex: 'codex',
  openaicodex: 'codex',
  claudecode: 'claude_code',
  claude: 'claude_code',
  cc: 'claude_code',
  克劳德: 'claude_code',
  genericllm: 'generic_llm',
  通用大模型: 'generic_llm'
};

/** Collapses spacing, case and separator style so one alias covers all spellings. */
function normalizeAliasText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.·]+/gu, '');
}

/**
 * Resolves a spoken Runtime name to a RuntimeType, or `undefined` when the name
 * is not one this platform runs. Refusing is deliberate: an unresolved target
 * must surface as an actionable error, never as a guess.
 */
export function resolveRuntimeAlias(value: string): RuntimeType | undefined {
  const normalized = normalizeAliasText(value);
  if (!normalized) return undefined;
  const resolved = ALIASES[normalized];
  return resolved && isRuntimeType(resolved) ? resolved : undefined;
}

export type RuntimeSwitchCommandMatch = {
  targetRuntimeType: RuntimeType;
  /** True when the same sentence also asks to carry on (Spec AC2). */
  resumeAfterSwitch: boolean;
  /** Only set when the text itself narrows the policy; otherwise the caller's default applies. */
  fallbackMode: RuntimeSwitchFallbackMode | undefined;
  normalizedText: string;
  reasonCode: 'RUNTIME_SWITCH_COMMAND';
};

/** Anything interrogative, comparative or hypothetical is asking, not instructing. */
const QUESTION_MARKERS =
  /[？?]|(?:为什么|为何|是否|要不要|能不能|可不可以|可以吗|应该|该不该|区别|差别|比较|对比|哪个更|哪个好)/u;
const ENGLISH_QUESTION_MARKERS =
  /^(?:why|whether|should|shall|can|could|would|will|do|does|did|is|are|was|were|what|which|how|compare)\b/i;
/** An explicit refusal must never be executed as the request it negates. */
const NEGATION_MARKERS = /^(?:不要|不用|别|不能|不该|无需|勿)|^(?:do\s+not|don't|no\s+need|avoid)\b/iu;

/**
 * Matches an explicit instruction to change the Session's Runtime.
 *
 * The grammar is deliberately narrow. This guard runs before ordinary intent
 * routing and has a side effect that stops a healthy run, so a false positive is
 * far more costly than a false negative: anything questioning, comparing,
 * negated, overlong, or merely mentioning a Runtime inside a requirement is left
 * to the semantic router (Spec §7.1).
 */
export function matchRuntimeSwitchCommand(content: string): RuntimeSwitchCommandMatch | undefined {
  const normalizedText = content
    .normalize('NFKC')
    .trim()
    .replace(/[。！!；;：:，,]+$/u, '')
    .trim()
    .toLowerCase();
  // A deterministic guard only claims short, explicit control text.
  if (!normalizedText || normalizedText.length > 200) return undefined;
  if (NEGATION_MARKERS.test(normalizedText)) return undefined;
  if (QUESTION_MARKERS.test(normalizedText) || ENGLISH_QUESTION_MARKERS.test(normalizedText)) return undefined;

  const TARGET = '([\\p{L}\\p{N}][\\p{L}\\p{N}\\s_\\-.·]{0,30}?)';
  // 继续/恢复 may trail the target; 执行/运行 are filler that must not be eaten
  // into the target name.
  const TAIL = '(?:\\s*(继续|恢复)(?:执行|运行)?|\\s*(?:执行|运行))?';
  const patterns: ReadonlyArray<{ regex: RegExp; targetOnly?: boolean }> = [
    // 只用 / 只能用 X — narrows the policy to the target by its own wording.
    { regex: new RegExp(`^(?:请)?只(?:能|允许)?(?:用|使用)\\s*${TARGET}${TAIL}$`, 'u'), targetOnly: true },
    { regex: new RegExp(`^(?:please\\s+)?only\\s+use\\s+${TARGET}$`, 'iu'), targetOnly: true },
    // 切换到 / 改用 / 换成 / 改为 X
    { regex: new RegExp(`^(?:请)?(?:切换到|切换成|切到|改用|换成|改为|换到)\\s*${TARGET}${TAIL}$`, 'u') },
    // 用 / 使用 X 继续 — the compound form Spec AC2 calls out.
    { regex: new RegExp(`^(?:请)?(?:用|使用)\\s*${TARGET}${TAIL}$`, 'u') },
    { regex: new RegExp(`^(?:please\\s+)?switch\\s+to\\s+${TARGET}(?:\\s+and\\s+(continue|resume))?$`, 'iu') },
    { regex: new RegExp(`^(?:please\\s+)?use\\s+${TARGET}(?:\\s+and\\s+(continue|resume))?$`, 'iu') }
  ];

  for (const { regex, targetOnly } of patterns) {
    const matched = normalizedText.match(regex);
    const rawTarget = matched?.[1]?.trim();
    if (!rawTarget) continue;
    const targetRuntimeType = resolveRuntimeAlias(rawTarget);
    // An unresolved target is refused here so the caller can report which name
    // failed, rather than switching to something the user never said.
    if (!targetRuntimeType) return undefined;
    return {
      targetRuntimeType,
      resumeAfterSwitch: Boolean(matched?.[2]),
      fallbackMode: targetOnly ? 'target_only' : undefined,
      normalizedText,
      reasonCode: 'RUNTIME_SWITCH_COMMAND'
    };
  }
  return undefined;
}
