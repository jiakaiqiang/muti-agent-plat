import type { ExpectedRuntimeOutput, RuntimeOutput } from '@agent-cluster/shared';
import { validateRuntimeOutput } from '../runtime-output-schema.js';
import {
  isProviderOutputFrame,
  isResultFrame,
  type RuntimeStreamFrame
} from './runtime-stream-frame.js';

export class MapperError extends Error {
  constructor(
    message: string,
    public readonly expectedKind: ExpectedRuntimeOutput['kind']
  ) {
    super(message);
    this.name = 'MapperError';
  }
}

function findLastFrame<T extends RuntimeStreamFrame>(
  frames: RuntimeStreamFrame[],
  predicate: (frame: RuntimeStreamFrame) => frame is T
): T | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame && predicate(frame)) return frame;
  }
  return undefined;
}

/**
 * Converts the provider result frame at the strict Runtime contract boundary.
 *
 * Hard-cutover rule: this mapper never fills missing fields, rewrites legacy
 * aliases, infers artifacts, or changes a mismatched kind. The provider result
 * must already satisfy the registered version 1.0 contract.
 */
export function framesToOutput(
  expectedKind: ExpectedRuntimeOutput['kind'],
  frames: RuntimeStreamFrame[]
): RuntimeOutput {
  const result = findLastFrame(frames, isResultFrame);
  if (!result) throw new MapperError('no result frame in stream', expectedKind);

  // Codex app-server v2 makes the completed AgentMessage item authoritative
  // for content and the terminal Turn authoritative for status/session. Some
  // versions do not repeat item content in turn/completed, so assemble those
  // two protocol facts before crossing the strict contract boundary.
  const providerOutput = findLastFrame(frames, isProviderOutputFrame);
  const validation = validateRuntimeOutput(providerOutput?.payload ?? result.payload, expectedKind);
  if (!validation.valid) {
    throw new MapperError(
      `RUNTIME_OUTPUT_CONTRACT_VIOLATION: ${expectedKind}: ${validation.errors.join('; ')}`,
      expectedKind
    );
  }
  return validation.value;
}
