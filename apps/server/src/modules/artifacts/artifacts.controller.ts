import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { ArtifactsService } from './artifacts.service.js';

type DownloadResponse = {
  setHeader: (key: string, value: string) => void;
  send: (body: string) => void;
};

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

  @Get('artifacts/:artifactId/download')
  download(@Param('artifactId') artifactId: string, @Res() response: DownloadResponse) {
    const artifact = this.artifacts.getById(artifactId);
    if (!artifact) {
      throw new NotFoundException(`Artifact not found: ${artifactId}`);
    }
    const { filename, contentType, body } = this.artifacts.toDownload(artifact);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    response.send(body);
  }
}
