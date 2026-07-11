import type { RuntimeRoutingInput } from '@agent-cluster/shared';

export type CommandAvailabilityDecision =
  | { ok: true }
  | { ok: false; reason: string; hint: string };

const COMMAND_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['server_local', 'local_bridge']);

export function evaluateCommandAvailability(
  input: RuntimeRoutingInput
): CommandAvailabilityDecision {
  const requiresCommand =
    input.requiredCapabilities.includes('command') || input.writeMode === 'direct_audited';
  if (!requiresCommand) return { ok: true };

  const providerCanRunCommands = COMMAND_CAPABLE_PROVIDERS.has(input.workspace.providerKind);
  const workspaceExposesCommand = input.workspace.capabilities.command === true;
  if (providerCanRunCommands && workspaceExposesCommand) return { ok: true };

  return {
    ok: false,
    reason: 'command-workspace-unavailable',
    hint: 'Connect a server_local workspace or local_bridge to execute commands'
  };
}
