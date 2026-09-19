import type { ISODateTime, UUID } from './contracts.js';

/**
 * Phase 4: the formal requirement/plan document the coordinator publishes for
 * the user to read, compare and confirm. Versions are immutable; a change is a
 * new documentRevision. The document references the brief, the decisions and
 * the delegations it was built from — it does not hold a second editable copy
 * of any of them (plan §2.1).
 *
 * Confirmation binding (`RequirementConfirmationBinding`) was frozen in phase
 * 0; this record supplies the documentId / documentRevision / contentHash it
 * refers to.
 */
export const REQUIREMENT_DOCUMENT_CONTRACT_VERSION = '1.0' as const;

export type RequirementDocumentStatus = 'draft' | 'formal' | 'confirmed' | 'superseded';

/** Closed shape. Approval, authorship and timestamps are record fields, never content. */
export type RequirementDocumentSections = {
  goal: string;
  scope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  risks: string[];
  pendingItems: string[];
};

export type RequirementDocument = {
  id: UUID;
  sessionId: UUID;
  workItemId: UUID;
  /** The requirement revision the content was written against. */
  workItemRevision: number;
  documentRevision: number;
  /** Server-computed digest of `canonicalRequirementDocumentContent(sections)`. */
  contentHash: string;
  status: RequirementDocumentStatus;
  publishedByAgentId: UUID;
  sourceBriefId?: UUID;
  sourceDecisionIds: UUID[];
  sourceDelegationIds: UUID[];
  sections: RequirementDocumentSections;
  createdAt: ISODateTime;
  confirmedAt?: ISODateTime;
  /** The confirmation that approved this exact version; absent until confirmed. */
  confirmationId?: UUID;
  supersededAt?: ISODateTime;
};

const SECTION_KEYS = ['goal', 'scope', 'outOfScope', 'acceptanceCriteria', 'risks', 'pendingItems'] as const;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isRequirementDocumentSections(value: unknown): value is RequirementDocumentSections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(SECTION_KEYS as readonly string[]).includes(key))) return false;
  return (
    typeof record.goal === 'string' &&
    record.goal.trim().length > 0 &&
    isStringList(record.scope) &&
    isStringList(record.outOfScope) &&
    isStringList(record.acceptanceCriteria) &&
    isStringList(record.risks) &&
    isStringList(record.pendingItems)
  );
}

/**
 * The exact bytes a content hash is computed over. Field order is fixed and
 * surrounding whitespace is trimmed so two assemblies of the same content
 * produce the same hash; list order is preserved because it carries meaning.
 *
 * Returns a string rather than a digest: `shared` is consumed by the browser
 * workspaces, so hashing happens server-side.
 */
export function canonicalRequirementDocumentContent(sections: RequirementDocumentSections): string {
  const clean = (items: string[]) => items.map((item) => item.trim());
  return JSON.stringify({
    contract: REQUIREMENT_DOCUMENT_CONTRACT_VERSION,
    goal: sections.goal.trim(),
    scope: clean(sections.scope),
    outOfScope: clean(sections.outOfScope),
    acceptanceCriteria: clean(sections.acceptanceCriteria),
    risks: clean(sections.risks),
    pendingItems: clean(sections.pendingItems)
  });
}

export function requirementDocumentLogicalKey(
  document: Pick<RequirementDocument, 'workItemId' | 'workItemRevision' | 'documentRevision'>
): string {
  return [document.workItemId.replaceAll('|', '%7C'), String(document.workItemRevision), String(document.documentRevision)].join('|');
}

const DOCUMENT_TRANSITIONS: Readonly<Record<RequirementDocumentStatus, readonly RequirementDocumentStatus[]>> = {
  draft: ['formal', 'superseded'],
  formal: ['confirmed', 'superseded'],
  // A confirmed version is never edited back; a change is a new revision.
  confirmed: ['superseded'],
  superseded: []
};

export function canTransitionRequirementDocument(from: RequirementDocumentStatus, to: RequirementDocumentStatus): boolean {
  return DOCUMENT_TRANSITIONS[from].includes(to);
}

/**
 * Marks every revision below the latest as superseded. Nothing is removed: a
 * confirmed old version stays readable as the record of what was once agreed.
 */
export function supersedeOlderDocuments(
  documents: readonly RequirementDocument[],
  input: { latestDocumentRevision: number; now: ISODateTime }
): RequirementDocument[] {
  return documents.map((item) => {
    if (item.documentRevision >= input.latestDocumentRevision) return item;
    if (!canTransitionRequirementDocument(item.status, 'superseded')) return item;
    return { ...item, status: 'superseded', supersededAt: input.now };
  });
}
