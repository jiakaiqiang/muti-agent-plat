import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { assertWorkflowAuthoring } from './workflow-authoring-policy.js';
import { ok } from '../../common/api-response.js';
import { WorkflowsService, type WorkflowInput } from './workflows.service.js';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list() {
    return ok(this.workflows.list());
  }

  @Get(':workflowId/versions')
  versions(@Param('workflowId') workflowId: string) {
    return ok(this.workflows.listVersions(workflowId));
  }

  @Get('catalog/published')
  catalog() {
    return ok({ items: this.workflows.catalog(), hasMore: false });
  }

  @Get(':workflowId/versions/:version')
  version(@Param('workflowId') workflowId: string, @Param('version') version: string) {
    return ok(this.workflows.getVersion(workflowId, Number(version)));
  }

  @Get(':workflowId')
  detail(@Param('workflowId') workflowId: string) {
    return ok(this.workflows.get(workflowId));
  }

  @Post()
  create(@Body() body: WorkflowInput, @Headers('x-workflow-author-token') token?: string) {
    assertWorkflowAuthoring(token);
    return ok(this.workflows.create(body));
  }

  @Patch(':workflowId')
  update(@Param('workflowId') workflowId: string, @Body() body: Partial<WorkflowInput>, @Headers('x-workflow-author-token') token?: string) {
    assertWorkflowAuthoring(token);
    return ok(this.workflows.update(workflowId, body));
  }

  @Patch(':workflowId/draft')
  updateDraft(@Param('workflowId') workflowId: string, @Body() body: Partial<WorkflowInput>, @Headers('x-workflow-author-token') token?: string) {
    assertWorkflowAuthoring(token);
    return ok(this.workflows.update(workflowId, body));
  }

  @Post(':workflowId/publish')
  publish(
    @Param('workflowId') workflowId: string,
    @Body() body: { expectedDraftRevision?: number; publishedBy?: string },
    @Headers('x-workflow-author-token') token?: string
  ) {
    assertWorkflowAuthoring(token);
    return ok(this.workflows.publish(workflowId, body));
  }

  @Post(':workflowId/archive')
  archive(@Param('workflowId') workflowId: string, @Headers('x-workflow-author-token') token?: string) {
    assertWorkflowAuthoring(token);
    return ok(this.workflows.archive(workflowId));
  }

  @Delete(':workflowId')
  remove(@Param('workflowId') workflowId: string, @Headers('x-workflow-author-token') token?: string) {
    assertWorkflowAuthoring(token);
    return ok(this.workflows.remove(workflowId));
  }
}
