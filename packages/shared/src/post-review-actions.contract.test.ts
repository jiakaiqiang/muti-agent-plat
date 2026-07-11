import type {
  PostReviewAction,
  PostReviewActionKey,
  PostReviewReportOutput
} from './contracts.js';
import { POST_REVIEW_ACTION_KEYS } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type PostReviewActionKeysAreStable = Assert<
  IsExact<
    PostReviewActionKey,
    'request_workspace_context' | 'deliver_with_limitations' | 'save_progress' | 'cancel'
  >
>;

const actions = [
  {
    action: 'request_workspace_context',
    reason: 'Review cannot verify behavior without the implementation file.',
    missingPaths: ['src/feature.ts']
  },
  {
    action: 'deliver_with_limitations',
    limitations: ['The unscanned implementation file was not verified.']
  },
  {
    action: 'save_progress',
    artifactIds: ['artifact-review-report']
  },
  {
    action: 'cancel',
    reason: 'Do not continue without evidence.'
  }
] satisfies PostReviewAction[];

const report: PostReviewReportOutput = {
  kind: 'post_review_report',
  isConsistentWithBrief: false,
  matchedItems: [],
  mismatchedItems: [],
  missingItems: ['Evidence for src/feature.ts'],
  outOfScopeChanges: [],
  testResults: [],
  recommendation: 'ask_user',
  actions
};

const actionKeys = POST_REVIEW_ACTION_KEYS satisfies readonly PostReviewActionKey[];

void report;
void actionKeys;
