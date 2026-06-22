import type { WorkspaceToolDescriptor } from '@agent-cluster/shared';

/** Server-side category used to group executable tools. */
export type ToolCategory = 'file' | 'code' | 'test' | 'db' | 'network' | 'custom';

/** JSON schema shape accepted by internal executable tools. */
export type ToolInputSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

/** Context passed to a tool when the server executes it. */
export type ToolExecutionContext = {
  workingDirectory: string;
  sessionId: string;
  agentId?: string;
  taskId?: string;
  signal?: AbortSignal;
};

/** Normalized result returned by server-side tools. */
export type ToolResult = {
  success: boolean;
  output: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
};

/** Internal executable tool instance. */
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly inputSchema: ToolInputSchema;
  execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult>;
};

/** Convert an internal executable tool into a runtime-visible descriptor. */
export function toWorkspaceToolDescriptor(tool: Tool): WorkspaceToolDescriptor {
  return {
    name: tool.name as WorkspaceToolDescriptor['name'],
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}
