import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

@Controller('workflow-runs')
export class WorkflowRunsController {
  constructor(private readonly runtime: WorkflowRuntimeService) {}

  @Get(':runId')
  detail(@Param('runId') runId: string) {
    const run = this.runtime.get(runId);
    return ok({
      run,
      nodeRuns: this.runtime.listNodeRuns(runId),
      approvals: this.runtime.listApprovals(runId)
    });
  }

  @Get(':runId/nodes')
  nodes(@Param('runId') runId: string) {
    return ok(this.runtime.listNodeRuns(runId));
  }

  @Post(':runId/nodes/:nodeRunId/decision')
  async decide(
    @Param('runId') runId: string,
    @Param('nodeRunId') nodeRunId: string,
    @Body()
    body: {
      confirmationId: string;
      expectedRunRevision?: number;
      decision: 'approve' | 'revise' | 'cancel';
      instruction?: string;
    }
  ) {
    const run = this.runtime.get(runId);
    return ok(await this.runtime.decideHuman({
      ...body,
      runId,
      nodeRunId,
      userId: run.ownerId
    }));
  }

  @Post(':runId/cancel')
  async cancel(@Param('runId') runId: string, @Body() body: { reason?: string }) {
    return ok(await this.runtime.cancel(runId, body.reason));
  }
}
