import { Injectable } from '@nestjs/common';
import type { ExactCommandResolution } from './command-state-resolver.service.js';

export type ExactCommandApplicationPort = {
  resume(confirmationId?: string): unknown | Promise<unknown>;
  retryCurrent(confirmationId?: string): unknown | Promise<unknown>;
  pause(): unknown | Promise<unknown>;
  cancel(): unknown | Promise<unknown>;
};

export async function applyExactCommandResolution(input: {
  resolution: ExactCommandResolution;
  port: ExactCommandApplicationPort;
}) {
  switch (input.resolution.action) {
    case 'resume_session':
      await input.port.resume(input.resolution.confirmationId);
      return;
    case 'retry_current':
      await input.port.retryCurrent(input.resolution.confirmationId);
      return;
    case 'pause_session':
      await input.port.pause();
      return;
    case 'cancel_session':
      await input.port.cancel();
      return;
    case 'acknowledge':
    case 'clarify':
      return;
  }
}

@Injectable()
export class CommandApplicationService {
  apply(input: Parameters<typeof applyExactCommandResolution>[0]) {
    return applyExactCommandResolution(input);
  }
}
