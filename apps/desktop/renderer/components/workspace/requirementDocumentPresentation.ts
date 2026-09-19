import type {
  DiscussionProgressInput,
  DocumentVersionSummary,
  RequirementDocumentSections
} from '@agent-cluster/shared'
import { discussionProgressView, documentSectionChanges, documentVersionTimeline } from '@agent-cluster/shared'
import { diffLines, splitDiffRows } from '@/utils/historyDiffModel'

/**
 * Desktop projection of the phase 4 document and phase 3 discussion state.
 *
 * The business answers — which version is current, whether the user still has to
 * confirm, which sections moved, who is still consulting — come from the shared
 * projection so this end can never disagree with web or with the server. Only the
 * rendering differs: desktop shows changed sections side by side through the
 * existing history diff helper, web shows them inline.
 */

type SectionKey = keyof RequirementDocumentSections

export type DesktopSectionDiff = {
  section: SectionKey
  rows: ReturnType<typeof splitDiffRows>
}

export function buildDocumentVersionPanel(input: {
  versions: DocumentVersionSummary[]
  previousSections?: RequirementDocumentSections
  nextSections?: RequirementDocumentSections
}) {
  const timeline = documentVersionTimeline(input.versions)
  const changes =
    input.previousSections && input.nextSections
      ? documentSectionChanges(input.previousSections, input.nextSections)
      : { changed: [] as SectionKey[], unchanged: [] as SectionKey[], hasChanges: false }

  const diffs: DesktopSectionDiff[] = changes.changed.map((section) => ({
    section,
    rows: splitDiffRows(
      diffLines(
        sectionText(input.previousSections, section),
        sectionText(input.nextSections, section)
      ) ?? []
    )
  }))

  return {
    versions: timeline.versions,
    currentRevision: timeline.current?.documentRevision,
    awaitingConfirmation: timeline.awaitingConfirmation,
    changedSections: changes.changed,
    hasChanges: changes.hasChanges,
    diffs,
    staleness: timeline.staleness
  }
}

export function buildDiscussionPanel(input: DiscussionProgressInput) {
  const view = discussionProgressView(input)
  return {
    headline: view.headline,
    roundLabel: view.roundLabel,
    awaitingUser: view.awaitingUser,
    completeAnswer: view.completeAnswer,
    pendingAgentIds: view.pending.map((item) => item.targetAgentId),
    answeredAgentIds: view.answered.map((item) => item.targetAgentId),
    // Failures stay visible with their reason: a round that lost a required
    // expert must not read as a finished answer on either end.
    failures: view.failed.map((item) => ({
      targetAgentId: item.targetAgentId,
      ...(item.failureReason === undefined ? {} : { failureReason: item.failureReason })
    }))
  }
}

function sectionText(sections: RequirementDocumentSections | undefined, section: SectionKey): string {
  if (!sections) return ''
  const value = sections[section]
  return Array.isArray(value) ? value.join('\n') : String(value ?? '')
}
