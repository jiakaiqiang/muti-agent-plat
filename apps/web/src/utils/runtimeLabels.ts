import type { RuntimeType } from '@/types/contracts'

export function runtimeTypeLabel(runtimeType?: RuntimeType | string) {
  if (!runtimeType) return '未配置'
  return (
    {
      mock: '模拟运行时',
      generic_llm: '通用大模型',
      code_reader: 'Code Reader',
      test_runner: 'Test Runner',
      codex: 'Codex',
      claude_code: 'Claude Code',
      mcp_tool: 'MCP 工具',
      human: '人工处理'
    } satisfies Record<RuntimeType, string>
  )[runtimeType as RuntimeType] ?? runtimeType
}
