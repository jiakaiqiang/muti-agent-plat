/**
 * Claude Code CLI 的 control_request / control_response 双向帧处理。
 *
 * CLI 在需要平台参与决策时(权限、工具授权等)会主动发送
 * `{type:'control_request', request_id, request:{subtype, ...}}`, 平台必须
 * 在 stdin 中回一条对应 `{type:'control_response', request_id, response}`。
 *
 * 我们在 --permission-mode bypassPermissions 下工作, 因此默认策略是:
 *   - `can_use_tool` → 允许
 *   - 未知 subtype → 拒绝并 warn (安全兜底)
 *
 * 详见 docs/task-trans/M2-02-claude-control-request.md 与
 * docs/design/multica-refactor-development-design-v1.md §3.3。
 */

export type ControlRequest = {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: 'can_use_tool' | (string & Record<never, never>);
    [key: string]: unknown;
  };
};

export type ControlResponsePayload =
  | { allow: true }
  | { allow: false; reason?: string };

export type ControlHandlerDeps = {
  warn?: (message: string) => void;
};

export class ControlRequestHandler {
  private readonly warn: (message: string) => void;

  constructor(deps: ControlHandlerDeps = {}) {
    this.warn = deps.warn ?? (() => undefined);
  }

  handle(req: ControlRequest): ControlResponsePayload {
    const subtype = req.request.subtype;
    switch (subtype) {
      case 'can_use_tool':
        return { allow: true };
      default:
        this.warn(`Unknown control_request subtype: ${subtype}`);
        return { allow: false, reason: `unsupported subtype: ${subtype}` };
    }
  }
}

export function encodeControlResponse(
  requestId: string,
  response: ControlResponsePayload
): string {
  return `${JSON.stringify({ type: 'control_response', request_id: requestId, response })}\n`;
}
