import type { EventMetadata } from './contracts.js';

export const createMetadata = <TPayload extends Record<string, unknown>>(
  renderAs: EventMetadata<TPayload>['renderAs'],
  payload: TPayload,
  title?: string
): EventMetadata<TPayload> => ({
  schemaVersion: '0.1',
  renderAs,
  title,
  payload
});
