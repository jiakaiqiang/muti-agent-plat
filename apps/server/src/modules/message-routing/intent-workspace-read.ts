import { createHash } from 'node:crypto';
import type { IntentEffectGrant, SessionDetail } from '@agent-cluster/shared';

/** This only accepts a server-validated binding. Model output never creates authority. */
export function workspaceReadBindingHash(session: SessionDetail): string | undefined {
  const directory = session.workingDirectory, binding = session.workspaceContext?.binding;
  if (session.intentContractVersion !== 'intent-understanding-v1' || !session.dataEpoch ||
    directory?.kind !== 'server_local' || !directory.path || !directory.selectedAt || directory.id !== session.workspaceId ||
    binding?.workspaceId !== session.workspaceId || binding.providerKind !== 'server_local' || !binding.capabilities.read ||
    (session.sourceBinding && session.sourceBinding.state !== 'ready')) return;
  return createHash('sha256').update(JSON.stringify({ epoch: session.dataEpoch, workspaceId: session.workspaceId,
    ownerId: session.ownerId, kind: directory.kind, path: directory.path, selectedAt: directory.selectedAt, boundAt: binding.boundAt })).digest('hex');
}

export function issueWorkspaceReadAuthority(session: SessionDetail, sourceEventId: string, revision = 1) {
  const bindingHash = workspaceReadBindingHash(session);
  if (!bindingHash) return;
  return { bindingHash, grant: { id: `workspace-read:${session.id}:${bindingHash}`, effect: 'read_workspace' as const,
    resource: { kind: 'workspace' as const, refId: session.workspaceId }, revision, sourceEventId } };
}

export function currentWorkspaceReadGrant(session: SessionDetail): IntentEffectGrant | undefined {
  const authority = session.intentWorkspaceReadAuthority;
  if (!authority || authority.grant.revokedAt || authority.bindingHash !== workspaceReadBindingHash(session) ||
    authority.grant.effect !== 'read_workspace' || authority.grant.resource.kind !== 'workspace' ||
    authority.grant.resource.refId !== session.workspaceId || authority.grant.revision < 1) return;
  return authority.grant;
}
