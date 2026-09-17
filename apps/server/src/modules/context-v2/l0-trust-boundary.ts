import type { ContextEnvelopeV2 } from '@agent-cluster/shared';

/**
 * L0 is the authority layer: only server-declared rules may live there. Summary
 * memory, workspace file bodies and chat/event text are untrusted content and
 * must stay in their own layers, no matter which phase assembled the envelope.
 * A rule that copies one of those bodies verbatim is an escalation path, so the
 * envelope build fails loudly instead of shipping it.
 */
export function assertL0SystemRuleTrustBoundary(envelope: ContextEnvelopeV2): void {
  if (containsUntrustedLayerContent(envelope, envelope.L0.systemRules)) {
    throw new Error(
      'L0_TRUST_BOUNDARY_VIOLATION: L0.systemRules must not carry summary, file or chat content.'
    );
  }
}

function containsUntrustedLayerContent(envelope: ContextEnvelopeV2, l0: string[]): boolean {
  const fragments: string[] = [
    ...envelope.L5.bullets,
    ...envelope.L3.files.map((file) => file.content),
    ...(envelope.L3.fileRevisions ?? []).map((revision) => revision.userDraft?.content ?? '')
  ];
  return fragments.some((fragment) =>
    fragment.length >= 16 && l0.some((rule) => rule.includes(fragment))
  );
}
