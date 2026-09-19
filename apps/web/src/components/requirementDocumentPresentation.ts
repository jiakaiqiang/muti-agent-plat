import {
  discussionProgressView,
  documentSectionChanges,
  documentVersionTimeline,
  type DiscussionProgressInput,
  type DocumentVersionSummary,
  type RequirementDocumentSections
} from '@agent-cluster/shared'
import { buildReportDiffPreview, type ReportDiffPreview } from './reportDiffPreview'

/**
 * Web projection of the phase 4 requirement document and phase 3 discussion.
 *
 * The business verdicts (current version, staleness, which sections moved, who
 * is still consulting) come from the shared projection so this end and the
 * desktop end cannot disagree about what the server will accept. Only the row
 * shape is local: web renders one inline add/remove preview per changed section,
 * desktop renders its side-by-side history rows from the same section set.
 */
export interface DocumentSectionDiff {
  section: keyof RequirementDocumentSections
  preview: ReportDiffPreview
}

export interface DocumentVersionPanel {
  versions: DocumentVersionSummary[]
  currentRevision?: number
  awaitingConfirmation: boolean
  changedSections: Array<keyof RequirementDocumentSections>
  diffs: DocumentSectionDiff[]
  staleness: ReturnType<typeof documentVersionTimeline>['staleness']
}

function sectionText(value: string | string[]): string {
  return Array.isArray(value) ? value.join('\n') : value
}

export function buildDocumentVersionPanel(input: {
  versions: DocumentVersionSummary[]
  previousSections?: RequirementDocumentSections
  nextSections?: RequirementDocumentSections
}): DocumentVersionPanel {
  const timeline = documentVersionTimeline(input.versions)
  const changes =
    input.previousSections && input.nextSections
      ? documentSectionChanges(input.previousSections, input.nextSections)
      : undefined
  const changedSections = changes?.changed ?? []
  const diffs = changedSections.map((section) => ({
    section,
    preview: buildReportDiffPreview({
      path: section,
      previousContent: sectionText(input.previousSections![section]),
      nextContent: sectionText(input.nextSections![section])
    })
  }))

  return {
    versions: timeline.versions,
    ...(timeline.current ? { currentRevision: timeline.current.documentRevision } : {}),
    awaitingConfirmation: timeline.awaitingConfirmation,
    changedSections,
    diffs,
    staleness: timeline.staleness
  }
}

export interface DiscussionPanel {
  headline: string
  roundLabel: string
  pendingAgentIds: string[]
  answeredAgentIds: string[]
  failures: Array<{ targetAgentId: string; failureReason?: string }>
  awaitingUser: boolean
  completeAnswer: boolean
}

export function buildDiscussionPanel(input: DiscussionProgressInput): DiscussionPanel {
  const view = discussionProgressView(input)
  return {
    headline: view.headline,
    roundLabel: view.roundLabel,
    pendingAgentIds: view.pending.map((item) => item.targetAgentId),
    answeredAgentIds: view.answered.map((item) => item.targetAgentId),
    // Only the attributable failure reason is projected: an expert that failed
    // must stay visible, but nothing beyond its stated reason reaches a client.
    failures: view.failed.map((item) => ({
      targetAgentId: item.targetAgentId,
      ...(item.failureReason ? { failureReason: item.failureReason } : {})
    })),
    awaitingUser: view.awaitingUser,
    completeAnswer: view.completeAnswer
  }
}
