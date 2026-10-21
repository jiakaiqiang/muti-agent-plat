import { Controller, Get, Param } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { ArtifactsService } from './artifacts.service.js';

@Controller()
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get('sessions/:sessionId/artifacts')
  listBySession(@Param('sessionId') sessionId: string) {
    return ok({
      items: this.artifacts.listBySession(sessionId),
      hasMore: false
    });
  }

  @Get('artifacts/:artifactId')
  detail(@Param('artifactId') artifactId: string) {
    return ok(this.artifacts.get(artifactId));
  }
}
