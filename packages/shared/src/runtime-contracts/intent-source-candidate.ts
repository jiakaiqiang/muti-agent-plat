import { Type, type Static } from '@sinclair/typebox';
import { strictObject } from './schema-primitives.js';

/** Only proposed replacement content. IDs, hashes, grants and read sets are server-owned. */
export const IntentSourceCandidateOutputSchema = strictObject({
  schemaVersion: Type.Literal('1.0'),
  kind: Type.Literal('intent_source_candidate'),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  updates: Type.Array(strictObject({
    path: Type.String({ minLength: 1, maxLength: 500 }),
    content: Type.String({ maxLength: 262_144 })
  }), { minItems: 1, maxItems: 16 })
});
export type IntentSourceCandidateOutput = Static<typeof IntentSourceCandidateOutputSchema>;
export const intentSourceCandidateExample: IntentSourceCandidateOutput = {
  schemaVersion: '1.0', kind: 'intent_source_candidate', summary: '补充登录参数校验的候选。',
  updates: [{ path: 'src/login.ts', content: 'export const validPassword = (value: string) => value.length > 0;\n' }]
};
