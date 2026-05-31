import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { ArtifactsService } from './artifacts.service.js';

@Controller()
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get('sessions/:sessionId/artifacts')
  list(@Param('sessionId') sessionId: string) {
    return ok({ items: this.artifacts.list(sessionId), hasMore: false });
  }

  @Get('artifacts/:artifactId')
  detail(@Param('artifactId') artifactId: string) {
    const artifact = this.artifacts.getById(artifactId);
    if (!artifact) {
      throw new NotFoundException(`Artifact not found: ${artifactId}`);
    }
    return ok(artifact);
  }
}
