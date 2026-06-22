/** Planned capability IDs that are mapped now but not yet part of defaultCapabilities. */
export const PLANNED_TOOL_CAPABILITY_IDS = ['cap-file-read', 'cap-code-search'] as const;

/** Maps runtime capability IDs to executable tool names. */
export const CAPABILITY_TOOL_MAPPING: Record<string, string[]> = {
  'cap-file-read': ['read_file'],
  'cap-file-write': ['read_file', 'write_file'],
  'cap-command-run': ['run_test'],
  'cap-test-report': ['run_test'],
  'cap-post-review': ['read_file', 'search_code'],
  'cap-brief': ['read_file', 'search_code'],
  'cap-router': ['read_file'],
  'cap-dry-run': ['read_file'],
  'cap-feishu-draft': [],
  'cap-code-search': ['search_code']
};

/** Return the tool names required by a single capability ID. */
export function getToolsForCapability(capability: string): string[] {
  return [...(CAPABILITY_TOOL_MAPPING[capability] ?? [])];
}

/** Return unique tool names required by multiple capability IDs. */
export function getToolsForCapabilities(capabilities: string[]): string[] {
  const toolNames = new Set<string>();
  for (const capability of capabilities) {
    for (const toolName of getToolsForCapability(capability)) {
      toolNames.add(toolName);
    }
  }
  return [...toolNames];
}

/** Return whether a capability currently maps to at least one tool. */
export function hasToolsForCapability(capability: string): boolean {
  return getToolsForCapability(capability).length > 0;
}
