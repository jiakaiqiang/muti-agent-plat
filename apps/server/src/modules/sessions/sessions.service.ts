import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import crypto from 'node:crypto';
import type {
  AgentDefinition as Agent,
  AgentMessageOutput,
  AgentTask,
  CollaborationEvent,
  PostReviewAction,
  SessionDetail,
  SessionStatus,
  RuntimePreference,
  SessionWorkingDirectory,
  WorkspaceSnapshot,
  TaskBrief
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { messages } from '../../common/messages.js';
import { abortWithTermination, createExecutionTermination } from '../../common/execution-termination.js';
import { extractRuntimeError } from '../../common/runtime-error.js';
import { buildBudget } from '../../common/token.js';
import {
  isRuntimeType,
  reworkMaxRounds
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { extractServerWorkspacePath, scanServerWorkspace } from '../../common/workspace-scanner.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { IntentRecognitionService } from '../intent-recognition/intent-recognition.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { ExecutionOutcome, OrchestratorService, usableAgentMessageOutput } from '../orchestrator/orchestrator.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { assertCurrentDataEpoch } from '../persistence/data-epoch-guard.js';
import { TasksService } from '../tasks/tasks.service.js';
import { WorkflowRuntimeService, type WorkflowRuntimeUpdate } from '../workflows/workflow-runtime.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { WorktreeExecutionService } from '../worktree-execution/worktree-execution.service.js';
import { BrowserWorkspaceMirrorService } from '../worktree-execution/browser-workspace-mirror.service.js';
import { WorkdirBriefService } from '../runtimes/streaming/workdir-brief.service.js';

type CreateSessionInput = {
  input: string;
  agentIds?: string[];
  projectId?: string;
  tokenBudget?: number;
  knowledgeBaseIds?: string[];
  workingDirectory?: SessionWorkingDirectory;
  workspaceSnapshot?: WorkspaceSnapshot;
  runtimePreference?: RuntimePreference;
  origin?: 'user' | 'autopilot';
  autopilotRunId?: string;
};

@Injectable()
export class SessionsService {
  private readonly sessions = new Map<string, SessionDetail>();
  private readonly briefGenerationSeqBySession = new Map<string, number>();
  private readonly briefGenerationRuns = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly deletingSessionIds = new Set<string>();

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly memories: MemoryService,
    private readonly intentRecognition: IntentRecognitionService,
    private readonly orchestrator: OrchestratorService,
    private readonly execution: ExecutionService,
    private readonly tasks: TasksService,
    private readonly persistence: PersistenceService,
    @Optional() private readonly workflows?: WorkflowsService,
    @Optional() private readonly workflowRuntime?: WorkflowRuntimeService,
    @Optional() private readonly worktreeExecution?: WorktreeExecutionService,
    @Optional() private readonly browserWorkspaceMirror?: BrowserWorkspaceMirrorService,
    @Optional() private readonly workdirBrief?: WorkdirBriefService
  ) {
    const persisted = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    for (const session of persisted) {
      this.assertCurrentSchema(session);
      this.sessions.set(session.id, session);
    }
    for (const session of this.sessions.values()) {
      this.orchestrator.ensureArchitectureReportSaveConfirmation(session);
    }
    this.workflowRuntime?.updates().subscribe((update) => this.applyWorkflowRuntimeUpdate(update));
  }

  list() {
    return [...this.sessions.values()]
      .sort((left, right) => this.compareSessionRecency(left, right))
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        tokenBudget: session.tokenBudget,
        tokenUsed: session.tokenUsed,
        agentCount: session.participatingAgentIds.length,
        requiresUserAction: [
          'WAIT_USER_CONFIRM',
          'WAIT_WORKFLOW_SELECT',
          'WAIT_WORKFLOW_STEP_CONFIRM',
          'WAIT_USER_DECISION'
        ].includes(session.status),
        latestEventSummary: this.events.list(session.id).at(-1)?.content,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }));
  }

  get(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }
    return session;
  }

  listRaw() {
    return [...this.sessions.values()];
  }

  refreshBrowserWorkspaceSnapshot(
    sessionId: string,
    workspaceId: string,
    workspaceSnapshot: WorkspaceSnapshot
  ) {
    this.persistence.assertWritable();
    const sourceSession = this.get(sessionId);
    if (sourceSession.workingDirectory?.kind !== 'browser_local') {
      throw new BadRequestException('Workspace snapshot refresh is only available for browser-local Sessions.');
    }
    if (sourceSession.workingDirectory.id !== workspaceId || sourceSession.workspaceId !== workspaceId) {
      throw new BadRequestException('Workspace snapshot refresh does not match the Session workspace.');
    }
    if (!workspaceSnapshot.revision?.id) {
      throw new BadRequestException('Workspace snapshot refresh requires an immutable revision.');
    }
    if (workspaceSnapshot.rootName !== sourceSession.workingDirectory.name) {
      throw new BadRequestException('Workspace snapshot root does not match the selected directory.');
    }

    const updatedSessionIds: string[] = [];
    const updatedAt = nowIso();
    for (const session of this.sessions.values()) {
      if (session.workingDirectory?.kind !== 'browser_local' || session.workspaceId !== workspaceId) continue;
      session.workspaceSnapshot = structuredClone(workspaceSnapshot);
      session.updatedAt = updatedAt;
      updatedSessionIds.push(session.id);
    }
    this.persist();
    return { session: this.get(sessionId), updatedSessionIds, revision: workspaceSnapshot.revision };
  }

  async delete(sessionId: string) {
    this.persistence.assertWritable();
    const session = this.get(sessionId);
    if (this.deletingSessionIds.has(sessionId)) {
      throw new ConflictException(`Session deletion is already in progress: ${sessionId}`);
    }

    this.deletingSessionIds.add(sessionId);
    try {
      const termination = createExecutionTermination({
        kind: 'user_cancelled',
        source: 'user',
        scope: 'session',
        diagnosticRef: 'session_delete'
      });
      // Invalidate background brief callbacks before requesting termination so
      // a late completion cannot recreate state while deletion is in progress.
      this.briefGenerationSeqBySession.set(
        sessionId,
        (this.briefGenerationSeqBySession.get(sessionId) ?? 0) + 1
      );
      const briefRun = this.briefGenerationRuns.get(sessionId);
      if (briefRun) abortWithTermination(briefRun.controller, termination);
      const workflowCancellation = session.workflowRunId && this.workflowRuntime
        ? this.workflowRuntime.cancel(session.workflowRunId, '会话删除前终止工作流。')
        : Promise.resolve();
      const executionCancellation = this.execution.cancelAndWait(sessionId, termination);
      const briefStopped = briefRun ? await settlesWithin(briefRun.done, 10_000) : true;
      const [executionStopped] = await Promise.all([executionCancellation, workflowCancellation]);
      if (!briefStopped || executionStopped.timedOut) {
        throw new ConflictException(
          `Session runtime did not stop within the deletion grace period: ${sessionId}`
        );
      }

      await this.worktreeExecution?.deleteSessionDirectory(sessionId);
      await this.browserWorkspaceMirror?.deleteSessionDirectory(sessionId);
      this.workdirBrief?.deleteSessionDirectory(sessionId);
      this.sessions.delete(sessionId);
      this.briefGenerationSeqBySession.delete(sessionId);
      this.briefGenerationRuns.delete(sessionId);
      this.tasks.deleteSession(sessionId);
      this.memories.deleteSession(sessionId);
      this.events.deleteSession(sessionId);
      this.orchestrator.deleteSession(sessionId);
      this.persist();
      return { deleted: true, sessionId: session.id };
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  async create(input: CreateSessionInput) {
    this.persistence.assertWritable();
    const dataEpoch = this.persistence.currentDataEpoch();
    const now = nowIso();
    const participatingAgentIds = this.agents.resolveIds(input.agentIds);
    const workspaceBinding = await this.resolveWorkspaceBinding(input);
    const recognizedIntent = this.intentRecognition.recognizeTask(input.input, workspaceBinding.workspaceSnapshot);
    const session: SessionDetail = {
      id: crypto.randomUUID(),
      dataEpoch,
      title: this.titleFromInput(input.input),
      originalInput: input.input,
      status: 'AGENT_DISCUSSING',
      ownerId: 'local-user',
      workspaceId: workspaceBinding.workingDirectory?.id ?? 'default-workspace',
      projectId: input.projectId,
      origin: input.origin ?? 'user',
      autopilotRunId: input.autopilotRunId,
      knowledgeBaseIds: input.knowledgeBaseIds ?? [],
      workingDirectory: workspaceBinding.workingDirectory,
      workspaceSnapshot: workspaceBinding.workspaceSnapshot,
      runtimePreference: this.normalizeRuntimePreference(input.runtimePreference),
      tokenBudget: input.tokenBudget,
      tokenUsed: 0,
      taskDomain: recognizedIntent.domain,
      taskIntent: recognizedIntent.intent,
      requiresCodeChanges: recognizedIntent.requiresCodeChanges,
      participatingAgentIds,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    this.persist();

    const firstEvent = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      userMessageIntent: 'clarification',
      priority: 'normal',
      content: input.input,
      toAgentIds: participatingAgentIds,
      metadata: createMetadata('chat_message', {
        text: input.input,
        mentionedAgentIds: participatingAgentIds,
        origin: session.origin,
        autopilotRunId: session.autopilotRunId
      })
    });

    this.generateBriefInBackground(session);

    return { session, firstEvent };
  }

  private async resolveWorkspaceBinding(input: CreateSessionInput) {
    if (input.workingDirectory?.kind === 'server_local') {
      const path = input.workingDirectory.path?.trim();
      if (!path) {
        throw new BadRequestException('server_local workingDirectory requires an absolute path.');
      }
      try {
        return await scanServerWorkspace(path);
      } catch (error) {
        throw new BadRequestException(
          `Invalid server_local working directory: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (input.workspaceSnapshot) {
      return {
        workingDirectory: input.workingDirectory,
        workspaceSnapshot: input.workspaceSnapshot
      };
    }

    const path = extractServerWorkspacePath(input.input);
    if (!path) {
      return {
        workingDirectory: input.workingDirectory,
        workspaceSnapshot: undefined
      };
    }

    try {
      return await scanServerWorkspace(path);
    } catch (error) {
      return {
        workingDirectory: input.workingDirectory,
        workspaceSnapshot: undefined,
        scanError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private generateBriefInBackground(session: SessionDetail) {
    const generationSeq = (this.briefGenerationSeqBySession.get(session.id) ?? 0) + 1;
    this.briefGenerationSeqBySession.set(session.id, generationSeq);
    const previousRun = this.briefGenerationRuns.get(session.id);
    if (previousRun) {
      abortWithTermination(
        previousRun.controller,
        createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
      );
    }
    const controller = new AbortController();
    const done = this.orchestrator
      .discussAndCreateBrief(session, controller.signal)
      .then((brief) => {
        if (
          controller.signal.aborted ||
          this.deletingSessionIds.has(session.id) ||
          this.briefGenerationSeqBySession.get(session.id) !== generationSeq
        ) {
          return;
        }
        session.currentTaskBriefId = brief.id;
        this.setStatus(session, 'WAIT_USER_CONFIRM');
        if (session.origin === 'autopilot') {
          void this.confirmBrief(session.id, brief.id).catch((error) =>
            this.failSessionWithFullError(session, error, 'autopilot_auto_confirm')
          );
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || this.deletingSessionIds.has(session.id)) return;
        this.failSessionWithFullError(session, error, 'brief_generation');
      })
      .finally(() => {
        if (this.briefGenerationRuns.get(session.id)?.controller === controller) {
          this.briefGenerationRuns.delete(session.id);
        }
      });
    this.briefGenerationRuns.set(session.id, { controller, done });
    void done;
  }

  /**
   * Re-drives brief generation after a process restart. The discussion phase
   * runs on an in-memory promise (generateBriefInBackground), so a session
   * that was AGENT_DISCUSSING when the process died has no driver anymore.
   */
  resumeBriefGeneration(sessionId: string) {
    const session = this.get(sessionId);
    if (session.status !== 'AGENT_DISCUSSING') {
      return false;
    }
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: messages.discussionRecoveredAfterRestart,
      metadata: createMetadata('system_notice', {
        status: 'AGENT_DISCUSSING',
        reason: 'brief_generation_recovered_on_boot'
      })
    });
    this.generateBriefInBackground(session);
    return true;
  }

  async sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
    const session = this.get(sessionId);

    // P2: WAIT_USER_CONFIRM 下带 @Agent 走持续探讨
    if (session.status === 'WAIT_USER_CONFIRM' && mentionedAgentIds.length > 0 && session.currentTaskBriefId) {
      return this.consultBrief(session, content, mentionedAgentIds);
    }

    const handlingPlan = this.intentRecognition.recognizeUserMessage(content, session.status);
    const event = this.events.create({
      sessionId,
      type: 'user_message',
      userMessageIntent: handlingPlan.intent,
      priority: handlingPlan.priority,
      content,
      toAgentIds: mentionedAgentIds,
      metadata: createMetadata('chat_message', {
        text: content,
        mentionedAgentIds
      })
    });

    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.events.create({
      sessionId,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      toAgentIds: mentionedAgentIds,
      content: handlingPlan.coordinatorInstruction,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        handlingPlan
      })
    });

    if (handlingPlan.intent === 'preference_input') {
      this.events.create({
        sessionId,
        type: 'user_confirmation_requested',
        priority: 'normal',
        content: messages.confirmMemoryWrite,
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'confirm_memory_write',
          title: messages.confirmMemoryWriteTitle,
          description: messages.confirmMemoryWriteDescription,
          candidate: {
            content,
            sourceEventId: event.id,
            scope: 'long_term_candidate',
            confidence: 0.72
          },
          options: [
            { key: 'approve', label: messages.saveMemory, style: 'primary' },
            { key: 'reject', label: messages.skipMemory, style: 'default' }
          ]
        })
      });
    }

    if (handlingPlan.intent === 'preference_input') {
      this.touchSession(session);
    } else if (session.status === 'FAILED' && this.isResumeCommand(content)) {
      this.retryFailedSession(session, event.id);
    } else if (handlingPlan.shouldPause) {
      const relevantAgentIds = this.relevantAgentIds(session, content, handlingPlan.affectedAgentIds);
      this.recordAgentRequirementContext(session, content, event.id, relevantAgentIds);

      // 创建插话任务并立即标记完成（插话内容已通过记忆分发给相关 agent）
      const coordinator = this.pickSessionAgent(session, ['coordinator']);
      const assignedAgentId = relevantAgentIds[0] || coordinator.id;
      const interruptTask: AgentTask = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        title: '处理用户执行中插话',
        description: content,
        status: 'completed',
        assignedBy: { type: 'agent', id: coordinator.id },
        assignee: { type: 'agent', id: assignedAgentId },
        routingMode: 'coordinator_controlled',
        autoResolutionAttempted: false,
        dependsOnTaskIds: [],
        acceptanceCriteria: [],
        resultSummary: '已将插话内容分发给相关 Agent 作为执行上下文。',
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      this.tasks.add(interruptTask);

      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        taskId: interruptTask.id,
        fromAgentId: coordinator.id,
        toAgentIds: relevantAgentIds,
        content: `任务已创建：${interruptTask.title}`,
        metadata: createMetadata('task_card', {
          taskId: interruptTask.id,
          title: interruptTask.title,
          description: interruptTask.description,
          status: interruptTask.status,
          assignedBy: interruptTask.assignedBy,
          assignee: interruptTask.assignee,
          routingMode: interruptTask.routingMode,
          autoResolutionAttempted: interruptTask.autoResolutionAttempted,
          acceptanceCriteria: interruptTask.acceptanceCriteria
        })
      });

      this.events.create({
        sessionId: session.id,
        type: 'agent_message',
        taskId: interruptTask.id,
        fromAgentId: coordinator.id,
        toAgentIds: relevantAgentIds,
        content: `Coordinator：收到用户执行中补充要求，已同步给相关 Agent，并会注入后续任务上下文。补充内容：${content}`,
        metadata: createMetadata('chat_message', {
          messageKind: 'handoff',
          phase: 'user_message_routing',
          relatedTaskIds: [interruptTask.id],
          mentionedAgentIds: relevantAgentIds,
          handlingPlan
        })
      });

      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: `执行中收到用户插话，已创建任务 [${interruptTask.title}] 并分发给相关 Agent。`,
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'executing_user_interrupt_task_created',
          sourceEventId: event.id,
          affectedAgentIds: relevantAgentIds,
          taskId: interruptTask.id
        })
      });
      this.restartExecutionWithUpdatedContext(session, event.id, relevantAgentIds, interruptTask.id);
      this.touchSession(session);
    } else if (this.shouldReopenRequirementLoop(session.status, handlingPlan.requiresBriefRevision)) {
      this.reopenRequirementLoop(session, content, event, handlingPlan.affectedAgentIds, 'user_requirement_supplement');
    } else {
      this.touchSession(session);
    }


    return { event, handlingPlan };
  }

  async confirmBrief(sessionId: string, briefId: string) {
    const session = this.get(sessionId);
    if (session.currentTaskBriefId !== briefId) {
      throw new BadRequestException(`Brief is not current: ${briefId}`);
    }
    const brief = this.orchestrator.confirmBrief(session, briefId);
    session.currentTaskBriefId = brief.id;
    const availableWorkflows = this.workflows?.list().filter((workflow) => workflow.status === 'published') ?? [];
    this.setStatus(session, 'WAIT_WORKFLOW_SELECT');
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.events.create({
      sessionId,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: '任务契约已确认。请选择并检查本次执行使用的 Agent 工作流。',
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        phase: 'workflow_selection',
        relatedBriefId: brief.id
      })
    });
    const confirmationId = crypto.randomUUID();
    this.events.create({
      sessionId,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: '请选择工作流后开始执行。',
      metadata: createMetadata('confirmation_card', {
        confirmationId,
        reason: 'select_workflow',
        title: '选择执行工作流',
        description: '任务契约已确认，工作流确定 Agent 的执行顺序。',
        relatedBriefId: brief.id,
        workflowOptions: availableWorkflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          version: workflow.currentPublishedVersion ?? workflow.version,
          nodeCount: workflow.nodes.length,
          agentCount: workflow.nodes.filter((node) => node.type === 'agent').length,
          humanApprovalCount: workflow.nodes.filter((node) => node.type === 'human_approval').length,
          robotApprovalCount: workflow.nodes.filter((node) => node.type === 'robot_approval').length,
          status: workflow.status
        })),
        options: availableWorkflows.length
          ? [{ key: 'open_workflow_selector', label: '选择工作流', style: 'primary' }]
          : [{ key: 'manage_workflows', label: '创建工作流', style: 'primary' }]
      })
    });
    return { accepted: true, sessionId: session.id, status: session.status, confirmationId };
  }

  async selectWorkflow(
    sessionId: string,
    input: { workflowId: string; workflowVersion?: number; confirmationId: string }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_WORKFLOW_SELECT') {
      throw new BadRequestException(`Workflow selection requires WAIT_WORKFLOW_SELECT: ${session.status}`);
    }
    if (!this.workflows || !this.workflowRuntime) throw new BadRequestException('Workflow runtime is unavailable.');
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'select_workflow');
    const workflow = this.workflows.get(input.workflowId);
    if (workflow.status !== 'published') throw new BadRequestException('Only published workflows can be executed.');
    const briefId = session.currentTaskBriefId;
    const brief = briefId ? this.orchestrator.getBrief(session.id, briefId) : undefined;
    if (!brief) throw new BadRequestException('Current confirmed brief is missing.');
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const version = this.workflows.getVersion(workflow.id, input.workflowVersion);
    session.participatingAgentIds = Array.from(new Set([...session.participatingAgentIds, ...version.involvedAgentIds]));
    if (this.isEmptyWorkspace(session) && session.workspaceMode !== 'bootstrap') {
      const confirmationId = crypto.randomUUID();
      session.workspaceMode = 'empty_pending_decision';
      session.pendingBootstrapWorkflow = {
        workflowId: workflow.id,
        workflowVersion: version.version,
        selectionConfirmationId: input.confirmationId
      };
      this.setStatus(session, 'WAIT_USER_DECISION');
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: `当前工作区“${session.workingDirectory?.name ?? session.workspaceSnapshot?.rootName ?? 'workspace'}”为空，请确认是否初始化新项目。`,
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'initialize_empty_workspace',
          title: '当前工作区为空',
          description: '可以从零创建项目文件。初始化确认不会自动安装依赖或执行命令，这些操作仍需再次确认。',
          options: [
            { key: 'initialize_project', label: '初始化新项目', style: 'primary' },
            { key: 'reselect_workspace', label: '重新选择目录', style: 'default' },
            { key: 'cancel', label: '取消任务', style: 'danger' }
          ],
          workflowId: workflow.id,
          workflowName: workflow.name
        })
      });
      return { session, workflow, workflowRun: undefined, createdTasks: [] };
    }
    const run = await this.workflowRuntime.start({
      session,
      brief,
      coordinatorId: coordinator.id,
      workflowId: workflow.id,
      workflowVersion: version.version,
      confirmationId: input.confirmationId
    });
    session.workflowRunId = run.id;
    this.setStatus(session, 'EXECUTING');
    const createdTasks = this.tasks.list(session.id).filter((task) => task.workflowRunId === run.id);
    return { session, workflow, workflowRun: run, createdTasks };
  }

  async resolveEmptyWorkspaceDecision(
    sessionId: string,
    input: {
      confirmationId: string;
      decision: 'initialize_project' | 'reselect_workspace' | 'cancel';
    }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION' || session.workspaceMode !== 'empty_pending_decision') {
      throw new BadRequestException(`Empty workspace decision is not pending: ${session.status}`);
    }
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'initialize_empty_workspace');
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: `用户处理空工作区：${input.decision}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: input.decision === 'initialize_project' ? 'approved' : 'rejected',
        selectedOptionKey: input.decision
      })
    });
    if (input.decision === 'cancel') {
      session.pendingBootstrapWorkflow = undefined;
      this.setStatus(session, 'CANCELLED');
      return { session };
    }
    if (input.decision === 'reselect_workspace') {
      session.workspaceMode = undefined;
      session.pendingBootstrapWorkflow = undefined;
      this.setStatus(session, 'WAIT_WORKFLOW_SELECT');
      return { session };
    }
    const pending = session.pendingBootstrapWorkflow;
    if (!pending || !this.workflows || !this.workflowRuntime) {
      throw new BadRequestException('Pending bootstrap workflow is unavailable.');
    }
    const briefId = session.currentTaskBriefId;
    const brief = briefId ? this.orchestrator.getBrief(session.id, briefId) : undefined;
    if (!brief) throw new BadRequestException('Current confirmed brief is missing.');
    const workflow = this.workflows.get(pending.workflowId);
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    session.workspaceMode = 'bootstrap';
    session.pendingBootstrapWorkflow = undefined;
    const run = await this.workflowRuntime.start({
      session,
      brief,
      coordinatorId: coordinator.id,
      workflowId: workflow.id,
      workflowVersion: pending.workflowVersion,
      confirmationId: pending.selectionConfirmationId
    });
    session.workflowRunId = run.id;
    this.setStatus(session, 'EXECUTING');
    const createdTasks = this.tasks.list(session.id).filter((task) => task.workflowRunId === run.id);
    return { session, workflow, workflowRun: run, createdTasks };
  }

  async resolveWorkflowHumanDecision(
    sessionId: string,
    runId: string,
    nodeRunId: string,
    input: {
      confirmationId: string;
      expectedRunRevision?: number;
      decision: 'approve' | 'revise' | 'cancel';
      instruction?: string;
    }
  ) {
    const session = this.get(sessionId);
    if (!this.workflowRuntime) throw new BadRequestException('Workflow runtime is unavailable.');
    if (session.workflowRunId !== runId) throw new BadRequestException(`Workflow run is not active for session: ${runId}`);
    const result = await this.workflowRuntime.decideHuman({
      runId,
      nodeRunId,
      confirmationId: input.confirmationId,
      userId: session.ownerId,
      expectedRunRevision: input.expectedRunRevision,
      decision: input.decision,
      instruction: input.instruction
    });
    this.touchSession(session);
    return { session, ...result };
  }

  async applyQueuedExecutionOutcome(sessionId: string, outcome: ExecutionOutcome) {
    if (await this.workflowRuntime?.acceptExecutionOutcome(sessionId, outcome)) return;
    this.applyOutcome(sessionId, outcome);
  }

  resolveWorkflowStep(
    sessionId: string,
    input: {
      confirmationId: string;
      taskId: string;
      decision: 'approve' | 'revise';
      instruction?: string;
    }
  ) {
    const session = this.get(sessionId);
    const run = session.workflowRun;
    if (session.status !== 'WAIT_WORKFLOW_STEP_CONFIRM' || !run) {
      throw new BadRequestException(`Workflow step confirmation is not active: ${session.status}`);
    }
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'confirm_workflow_step');
    const expectedTaskId = run.nodeTaskIds[run.currentStepIndex];
    if (expectedTaskId !== input.taskId) {
      throw new BadRequestException(`Workflow step is not current: ${input.taskId}`);
    }
    const task = this.tasks.list(sessionId).find((candidate) => candidate.id === input.taskId);
    if (!task) throw new BadRequestException(`Workflow task not found: ${input.taskId}`);
    const approved = input.decision === 'approve';
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: approved ? `用户确认工作流环节：${task.title}` : `用户要求修改工作流环节：${task.title}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: approved ? 'approved' : 'rejected',
        selectedOptionKey: input.decision,
        relatedTaskId: task.id,
        workflowRunId: run.id
      })
    });

    if (approved) {
      run.completedTaskIds = Array.from(new Set([...run.completedTaskIds, task.id]));
      run.currentStepIndex += 1;
      run.status = run.currentStepIndex >= run.nodeTaskIds.length ? 'completed' : 'running';
      run.updatedAt = nowIso();
    } else {
      const instruction = input.instruction?.trim() || '请重新检查并修改本环节输出。';
      this.tasks.update(task, { status: 'reworking', resultSummary: instruction });
      run.status = 'running';
      run.updatedAt = nowIso();
      const assigneeId = task.assignee?.type === 'agent' ? task.assignee.id : undefined;
      this.events.create({
        sessionId,
        type: 'user_message',
        userMessageIntent: 'correction',
        priority: 'high',
        content: instruction,
        toAgentIds: assigneeId ? [assigneeId] : [],
        taskId: task.id,
        metadata: createMetadata('chat_message', {
          text: instruction,
          relatedTaskIds: [task.id],
          workflowRunId: run.id,
          workflowStepIndex: run.currentStepIndex
        })
      });
    }

    this.setStatus(session, 'EXECUTING');
    this.resumeExecution(session);
    return { session, task, decision: input.decision };
  }

  reviseBrief(
    sessionId: string,
    briefId: string,
    input: { reason?: string; userMessage?: string; confirmationId?: string; assignedAgentKeys?: string[] } = {}
  ) {
    const session = this.get(sessionId);
    if (session.currentTaskBriefId !== briefId) {
      throw new BadRequestException(`Brief is not current: ${briefId}`);
    }
    const brief = this.orchestrator.getBrief(session.id, briefId);
    if (!brief) {
      throw new BadRequestException(`Brief not found: ${briefId}`);
    }

    const content = (input.userMessage || input.reason || '用户要求修改当前任务契约。').trim();
    const coordinator = this.pickSessionAgent(session, ['coordinator']);

    // P1 分流:指定 Agent 定向修订 vs 全量重跑
    if (input.assignedAgentKeys && input.assignedAgentKeys.length > 0) {
      return this.reviseBriefDirected(session, brief, content, input.confirmationId, input.assignedAgentKeys);
    }

    const userEvent = this.events.create({
      sessionId,
      type: 'user_message',
      userMessageIntent: 'correction',
      priority: 'high',
      content,
      toAgentIds: [coordinator.id],
      metadata: createMetadata('chat_message', {
        text: content,
        mentionedAgentIds: [coordinator.id],
        relatedBriefId: briefId,
        revisionOfBriefId: briefId
      })
    });

    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: '用户选择修改当前任务契约。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'rejected',
        selectedOptionKey: 'revise',
        relatedBriefId: briefId
      })
    });

    this.events.create({
      sessionId,
      type: 'brief_rejected',
      fromAgentId: coordinator.id,
      content: '当前任务契约已进入修订，Coordinator 将基于用户修改重新组织讨论。',
      metadata: createMetadata('system_notice', {
        briefId,
        reason: content,
        coordinatorAgentId: coordinator.id
      })
    });

    this.reopenRequirementLoop(session, content, userEvent, [coordinator.id], 'brief_revision_requested');
    return { accepted: true, sessionId: session.id, status: session.status, event: userEvent };
  }

  private reviseBriefDirected(
    session: SessionDetail,
    brief: TaskBrief,
    userModification: string,
    confirmationId: string | undefined,
    assignedAgentKeys: string[]
  ) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);

    // 更新 session.latestContractGoal 为用户修改后的目标（从 userModification 提取或直接使用）
    session.latestContractGoal = userModification;

    const userEvent = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      userMessageIntent: 'correction',
      priority: 'high',
      content: userModification,
      toAgentIds: [coordinator.id],
      metadata: createMetadata('chat_message', {
        text: userModification,
        mentionedAgentIds: [coordinator.id],
        relatedBriefId: brief.id,
        revisionOfBriefId: brief.id
      })
    });

    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_resolved',
      content: '用户选择修改当前任务契约（定向修订模式）。',
      metadata: createMetadata('system_notice', {
        confirmationId,
        status: 'rejected',
        selectedOptionKey: 'revise_directed',
        relatedBriefId: brief.id,
        assignedAgentKeys
      })
    });

    this.events.create({
      sessionId: session.id,
      type: 'brief_rejected',
      fromAgentId: coordinator.id,
      content: `当前任务契约已进入定向修订，指定的 ${assignedAgentKeys.length} 个 Agent 将审阅用户修改，最后由 Coordinator 定稿。`,
      metadata: createMetadata('system_notice', {
        briefId: brief.id,
        reason: userModification,
        coordinatorAgentId: coordinator.id,
        assignedAgentKeys
      })
    });

    // 取消正在进行的执行（如果有）
    this.execution.cancel(
      session.id,
      createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
    );
    this.tasks.cancelUnfinished(session.id, messages.requirementChangedCancelTasks);

    this.setStatus(session, 'AGENT_DISCUSSING');
    this.generateDirectedRevisionInBackground(session, brief, userModification, assignedAgentKeys, userEvent.id);

    return { accepted: true, sessionId: session.id, status: session.status, event: userEvent };
  }

  private generateDirectedRevisionInBackground(
    session: SessionDetail,
    oldBrief: TaskBrief,
    userModification: string,
    assignedAgentKeys: string[],
    sourceEventId: string
  ) {
    const generationSeq = (this.briefGenerationSeqBySession.get(session.id) ?? 0) + 1;
    this.briefGenerationSeqBySession.set(session.id, generationSeq);
    const previousRun = this.briefGenerationRuns.get(session.id);
    if (previousRun) {
      abortWithTermination(
        previousRun.controller,
        createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
      );
    }
    const controller = new AbortController();
    const done = this.orchestrator
      .runDirectedBriefRevision(session, oldBrief, userModification, assignedAgentKeys, sourceEventId, controller.signal)
      .then((brief) => {
        if (
          controller.signal.aborted ||
          this.deletingSessionIds.has(session.id) ||
          this.briefGenerationSeqBySession.get(session.id) !== generationSeq
        ) {
          return;
        }
        session.currentTaskBriefId = brief.id;
        this.setStatus(session, 'WAIT_USER_CONFIRM');
      })
      .catch((error) => {
        if (controller.signal.aborted || this.deletingSessionIds.has(session.id)) return;
        this.failSessionWithFullError(session, error, 'directed_brief_revision');
      })
      .finally(() => {
        if (this.briefGenerationRuns.get(session.id)?.controller === controller) {
          this.briefGenerationRuns.delete(session.id);
        }
      });
    this.briefGenerationRuns.set(session.id, { controller, done });
    void done;
  }

  private async consultBrief(session: SessionDetail, content: string, mentionedAgentIds: string[]) {
    const { userEvent } = await this.orchestrator.consultBriefWithAgent(session, content, mentionedAgentIds);
    this.touchSession(session);
    return { event: userEvent };
  }

  /** Applied when the background execution pipeline finishes. */
  applyOutcome(sessionId: string, outcome: ExecutionOutcome) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'CANCELLED' || session.status === 'COMPLETED') {
      return;
    }
    if (outcome.kind === 'workflow_step_completed') {
      this.pauseForWorkflowStepConfirmation(session, outcome.taskId, outcome.resultSummary);
      return;
    }
    if (outcome.kind === 'cancelled') {
      return;
    }
    if (
      session.status === 'WAIT_USER_DECISION' &&
      outcome.kind !== 'ask_user' &&
      outcome.kind !== 'delivered'
    ) {
      // delivered 是终态权威结果（执行真的完成了），允许它覆盖之前由竞态
      // 进入的 WAIT_USER_DECISION；其他非 ask_user 结果（rework/failed）继续被吞。
      return;
    }
    const nextStatus: SessionStatus =
      outcome.kind === 'delivered'
        ? 'COMPLETED'
        : outcome.kind === 'rework'
          ? 'REWORKING'
          : outcome.kind === 'ask_user'
            ? 'WAIT_USER_DECISION'
            : 'FAILED';
    this.setStatus(session, nextStatus);
    if (outcome.kind === 'delivered') {
      return;
    }
    const reason = 'reason' in outcome ? outcome.reason : '';
    this.events.create({
      sessionId,
      type: outcome.kind === 'failed' ? 'error_reported' : 'session_status_changed',
      priority: 'high',
      content:
        outcome.kind === 'rework'
          ? messages.outcomeRework(reason)
          : outcome.kind === 'ask_user'
            ? messages.outcomeAskUser(reason)
            : messages.outcomeFailed(reason),
      metadata: createMetadata(outcome.kind === 'failed' ? 'error_card' : 'system_notice', {
        status: nextStatus,
        outcome: outcome.kind,
        reason,
        runtimeError: outcome.kind === 'failed' ? outcome.error : undefined,
        actions: outcome.kind === 'ask_user' ? outcome.actions : undefined
      })
    });
    if (outcome.kind === 'ask_user') {
      this.events.create({
        sessionId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: 'Coordinator 自动处理未能继续推进，请确认下一步。',
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'coordinator_routing_needs_user_decision',
          title: '需要用户确认下一步',
          description: reason || '任务在自动恢复后仍无法继续，需要用户确认是否继续执行或取消。',
          actions: outcome.actions,
          options: [
            { key: 'resume', label: messages.reworkResume, style: 'primary' },
            { key: 'cancel', label: messages.reworkCancel, style: 'default' }
          ]
        })
      });
    }
    if (outcome.kind === 'rework') {
      this.startRework(session, reason);
    }
  }

  async resolvePostReviewAction(
    sessionId: string,
    input: { confirmationId: string; action: PostReviewAction['action'] }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION') {
      throw new BadRequestException(`Post Review action requires WAIT_USER_DECISION: ${session.status}`);
    }
    const action = this.confirmedPostReviewAction(sessionId, input.confirmationId, input.action);
    const alreadyResolved = this.events.list(sessionId).some(
      (event) =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === input.confirmationId
    );
    if (alreadyResolved) {
      throw new BadRequestException(`Confirmation already resolved: ${input.confirmationId}`);
    }

    const resolvedEvent = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: `用户选择 Post Review 动作：${action.action}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: action.action === 'cancel' ? 'rejected' : 'approved',
        selectedOptionKey: action.action,
        action
      })
    });

    if (action.action === 'request_workspace_context') {
      const reviewer = this.pickSessionAgent(session, ['review', 'test', 'coordinator']);
      const requestedContext = {
        reason: action.reason,
        requestedRefs: action.missingPaths.map((path) => ({
          type: 'workspace_file' as const,
          label: path,
          ref: path
        })),
        requestedPaths: action.missingPaths,
        followUpInstruction: 'Load the requested workspace files and retry Post Review with grounded evidence.'
      };
      const resolution = await this.orchestrator.hydrateSupplementalContext(session, requestedContext);
      session.supplementalContextRequests = [
        ...(session.supplementalContextRequests ?? []),
        {
          id: crypto.randomUUID(),
          taskId: session.currentTaskBriefId ?? session.id,
          agentId: reviewer.id,
          requestedContext,
          resolution,
          createdAt: nowIso()
        }
      ].slice(-12);
      this.events.create({
        sessionId,
        type: 'agent_message',
        fromAgentId: reviewer.id,
        content: resolution.hydratedPaths.length
          ? `Post Review loaded workspace context: ${resolution.hydratedPaths.join(', ')}`
          : `Post Review could not load workspace context: ${resolution.failedPaths.map((item) => `${item.path}:${item.code}`).join(', ') || 'no readable paths'}`,
        metadata: createMetadata('chat_message', {
          messageKind: 'progress',
          phase: 'context_supplement',
          requestedContext,
          resolution,
          action
        })
      });
      if (resolution.hydratedPaths.length) {
        this.setStatus(session, 'EXECUTING');
        this.resumeExecution(session);
      } else {
        this.touchSession(session);
      }
    } else if (action.action === 'deliver_with_limitations') {
      this.setStatus(session, 'EXECUTING');
      this.resumeExecution(session);
    } else if (action.action === 'save_progress') {
      this.touchSession(session);
    } else {
      this.execution.cancel(
        sessionId,
        createExecutionTermination({ kind: 'user_cancelled', source: 'user', scope: 'session' })
      );
      this.tasks.cancelUnfinished(sessionId, action.reason ?? '用户取消 Post Review 后续流程。');
      this.setStatus(session, 'CANCELLED');
    }

    return { session, action, resolvedEvent };
  }

  private confirmedPostReviewAction(
    sessionId: string,
    confirmationId: string,
    actionKey: PostReviewAction['action']
  ): PostReviewAction {
    const confirmation = this.events
      .list(sessionId)
      .find(
        (event) =>
          event.type === 'user_confirmation_requested' &&
          (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === confirmationId
      );
    const actions = (confirmation?.metadata.payload as { actions?: PostReviewAction[] } | undefined)?.actions;
    const action = actions?.find((candidate) => candidate.action === actionKey);
    if (!action) {
      throw new BadRequestException(`Post Review action is not available: ${actionKey}`);
    }
    return action;
  }

  /**
   * Automatically re-drives execution after a post-review `rework` outcome.
   * Bounded by REWORK_MAX_ROUNDS (default 1); beyond the limit the session is
   * handed to the user instead of looping.
   */
  private startRework(session: SessionDetail, reason: string) {
    const reworkRounds = this.events
      .list(session.id)
      .filter(
        (event) =>
          event.type === 'session_status_changed' &&
          (event.metadata?.payload as { outcome?: string } | undefined)?.outcome === 'rework'
      ).length;
    const maxRounds = reworkMaxRounds();
    if (reworkRounds > maxRounds) {
      this.setStatus(session, 'WAIT_USER_DECISION');
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: messages.reworkLimitReached(maxRounds),
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'rework_limit_reached',
          title: messages.reworkLimitTitle,
          description: `${messages.reworkLimitReached(maxRounds)}${reason ? ` 复盘意见：${reason}` : ''}`,
          options: [
            { key: 'resume', label: messages.reworkResume, style: 'primary' },
            { key: 'cancel', label: messages.reworkCancel, style: 'default' }
          ]
        })
      });
      return;
    }

    const brief = session.currentTaskBriefId
      ? this.orchestrator.getBrief(session.id, session.currentTaskBriefId)
      : undefined;
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.reworkBriefMissing });
      return;
    }

    if (session.workflowRunId && this.workflowRuntime) {
      const previousRun = this.workflowRuntime.get(session.workflowRunId);
      const coordinator = this.pickSessionAgent(session, ['coordinator']);
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: messages.reworkStarted(reworkRounds, maxRounds),
        metadata: createMetadata('system_notice', {
          status: 'REWORKING',
          reworkRound: reworkRounds,
          maxReworkRounds: maxRounds,
          reason,
          previousWorkflowRunId: previousRun.id
        })
      });
      void this.workflowRuntime.start({
        session,
        brief,
        coordinatorId: coordinator.id,
        workflowId: previousRun.workflowId,
        workflowVersion: previousRun.workflowVersion,
        confirmationId: `workflow-rework:${session.id}:${reworkRounds}`
      }).catch((error) => this.failSession(session, error, 'workflow_rework'));
      return;
    }

    this.tasks.resetForRework(session.id);
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: messages.reworkStarted(reworkRounds, maxRounds),
      metadata: createMetadata('system_notice', {
        status: 'REWORKING',
        reworkRound: reworkRounds,
        maxReworkRounds: maxRounds,
        reason
      })
    });
    this.execution.start(session, brief, this.tasks.unfinished(session.id), (outcome) =>
      this.applyOutcome(session.id, outcome)
    );
  }

  listBriefs(sessionId: string) {
    return this.orchestrator.listBriefs(sessionId);
  }

  control(sessionId: string, status: SessionStatus, reason?: string, confirmationId?: string) {
    const session = this.get(sessionId);
    this.assertControlTransition(session.status, status);
    const nextStatus = status === 'EXECUTING' && this.hasFinalDelivery(sessionId) ? 'COMPLETED' : status;
    this.setStatus(session, nextStatus);
    if (nextStatus === 'WAIT_USER_DECISION' || nextStatus === 'CANCELLED') {
      this.execution.cancel(
        sessionId,
        createExecutionTermination({ kind: 'user_cancelled', source: 'user', scope: 'session' })
      );
    }
    if (nextStatus === 'CANCELLED' && session.workflowRunId && this.workflowRuntime) {
      void this.workflowRuntime.cancel(session.workflowRunId, reason ?? '用户已取消会话');
    }
    const event = this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: reason ?? messages.sessionStatusUpdated(nextStatus),
      metadata: createMetadata('system_notice', { status: nextStatus, requestedStatus: status, reason })
    });
    const confirmationEvent = confirmationId
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
          content: status === 'CANCELLED' ? messages.userSelectedCancel : messages.userSelectedResume,
          metadata: createMetadata('system_notice', {
            confirmationId,
            status: status === 'CANCELLED' ? 'rejected' : 'approved',
            selectedOptionKey: status === 'CANCELLED' ? 'cancel' : 'resume'
          })
        })
      : undefined;
    if (nextStatus === 'EXECUTING') {
      this.resumeExecution(session);
    }
    return { session, event, confirmationEvent };
  }

  confirmMemory(
    sessionId: string,
    input: {
      content: string;
      confirmationId?: string;
      sourceEventId?: string;
      confidence?: number;
    }
  ) {
    this.get(sessionId);
    const memory = this.memories.create({
      sessionId,
      scope: 'long_term_candidate',
      content: input.content,
      sourceEventId: input.sourceEventId,
      confidence: input.confidence ?? 0.72
    });
    const event = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: messages.memoryConfirmed,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'approved',
        selectedOptionKey: 'approve',
        reason: 'confirm_memory_write',
        memoryId: memory.id
      })
    });
    this.touchSession(this.get(sessionId));
    return { memory, event };
  }

  decideFeishuNotification(
    sessionId: string,
    input: {
      confirmationId?: string;
      notificationDraftArtifactId?: string;
      decision: 'send_notification' | 'skip_notification';
    }
  ) {
    const session = this.get(sessionId);
    const approved = input.decision === 'send_notification';
    const resolvedEvent = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: approved ? '用户确认发送飞书通知。' : '用户选择不发送飞书通知。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: approved ? 'approved' : 'rejected',
        selectedOptionKey: input.decision,
        reason: 'confirm_feishu_notification',
        notificationDraftArtifactId: input.notificationDraftArtifactId
      })
    });
    const notificationEvent = approved
      ? this.events.create({
          sessionId,
          type: 'tool_completed',
          content: '飞书通知已确认发送（dry-run 记录）。',
          metadata: createMetadata('tool_card', {
            invocationId: crypto.randomUUID(),
            capabilityId: 'cap-feishu-draft',
            capabilityKey: 'notification.feishu_draft',
            capabilityName: '飞书通知',
            riskLevel: 'medium',
            status: 'completed',
            approvalKey: input.confirmationId,
            outputSummary: '用户已确认发送飞书通知；当前实现记录 dry-run 通知动作，不直接调用外部飞书接口。'
          })
        })
      : this.events.create({
          sessionId,
          type: 'agent_message',
          content: '已按用户选择跳过飞书通知，仅保留通知草稿供后续查看。',
          metadata: createMetadata('chat_message', {
            messageKind: 'decision',
            relatedArtifactIds: input.notificationDraftArtifactId ? [input.notificationDraftArtifactId] : []
          })
        });
    this.touchSession(session);
    return { session, resolvedEvent, notificationEvent };
  }

  async decideLocalReportSave(
    sessionId: string,
    input: {
      confirmationId: string;
      artifactId: string;
      decision: 'save_local' | 'keep_in_session';
    }
  ) {
    const session = this.get(sessionId);
    const result = await this.orchestrator.decideLocalReportSave(session, input);
    this.touchSession(session);
    return { session, ...result };
  }

  private compareSessionRecency(left: SessionDetail, right: SessionDetail) {
    return this.sessionRecencyTime(right) - this.sessionRecencyTime(left);
  }

  private sessionRecencyTime(session: SessionDetail) {
    return Date.parse(session.updatedAt || session.createdAt) || Date.parse(session.createdAt) || 0;
  }

  private touchSession(session: SessionDetail) {
    session.updatedAt = nowIso();
    this.persist();
  }

  private applyWorkflowRuntimeUpdate(update: WorkflowRuntimeUpdate) {
    const session = this.sessions.get(update.sessionId);
    if (!session) return;
    session.workflowRunId = update.workflowRunId;
    if (update.kind === 'session_outcome') {
      this.applyOutcome(session.id, update.outcome);
      return;
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(session.status)) return;
    if (update.status === 'waiting_human') {
      this.setStatus(session, 'WAIT_WORKFLOW_STEP_CONFIRM');
      return;
    }
    if (update.status === 'failed') {
      this.setStatus(session, 'FAILED');
      return;
    }
    if (update.status === 'cancelled') {
      this.setStatus(session, 'CANCELLED');
      return;
    }
    // A completed workflow still runs the existing Post Review/final delivery pipeline.
    this.setStatus(session, 'EXECUTING');
  }

  private setStatus(session: SessionDetail, status: SessionStatus) {
    session.status = status;
    session.updatedAt = nowIso();
    this.persist();
  }

  private failSession(session: SessionDetail, error: unknown, phase: string) {
    const runtimeError = extractRuntimeError(error);
    const message = runtimeError?.message ?? (error instanceof Error ? error.message : String(error));
    this.setStatus(session, 'FAILED');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: `会话在${messages.phaseLabel(phase)}阶段失败：${message}`,
      metadata: createMetadata('system_notice', {
        status: 'FAILED',
        phase,
        message,
        runtimeError
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'error_reported',
      priority: 'high',
      content: message,
      metadata: createMetadata('error_card', {
        phase,
        message,
        runtimeError
      })
    });
  }

  private failSessionWithFullError(session: SessionDetail, error: unknown, phase: string) {
    const runtimeError = extractRuntimeError(error);
    const message = runtimeError?.message ?? (error instanceof Error ? error.message : String(error));
    const runtimePhase = typeof runtimeError?.details?.phase === 'string'
      ? runtimeError.details.phase
      : undefined;
    const effectivePhase = runtimePhase ?? phase;
    const phaseLabel = messages.phaseLabel(effectivePhase);
    const fullMessage = `会话在${phaseLabel}阶段失败：${message}`;
    this.setStatus(session, 'FAILED');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: fullMessage,
      metadata: createMetadata('system_notice', {
        status: 'FAILED',
        phase: effectivePhase,
        phaseLabel,
        message,
        fullMessage,
        runtimeError
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'error_reported',
      priority: 'high',
      content: fullMessage,
      metadata: createMetadata('error_card', {
        phase: effectivePhase,
        phaseLabel,
        message,
        fullMessage,
        runtimeError
      })
    });
  }

  private assertControlTransition(current: SessionStatus, next: SessionStatus) {
    const allowed: Partial<Record<SessionStatus, SessionStatus[]>> = {
      AGENT_DISCUSSING: ['CANCELLED'],
      WAIT_USER_CONFIRM: ['REVISING_BRIEF', 'CANCELLED'],
      WAIT_WORKFLOW_SELECT: ['REVISING_BRIEF', 'CANCELLED'],
      WAIT_WORKFLOW_STEP_CONFIRM: ['EXECUTING', 'CANCELLED'],
      REVISING_BRIEF: ['WAIT_USER_CONFIRM', 'CANCELLED'],
      EXECUTING: ['WAIT_USER_DECISION', 'CANCELLED'],
      POST_REVIEW: ['WAIT_USER_DECISION', 'CANCELLED'],
      REWORKING: ['WAIT_USER_DECISION', 'CANCELLED', 'EXECUTING'],
      WAIT_USER_DECISION: ['EXECUTING', 'CANCELLED'],
      COMPLETED: [],
      FAILED: [],
      CANCELLED: []
    };
    if (!(allowed[current] ?? []).includes(next)) {
      throw new BadRequestException(`Invalid session transition: ${current} -> ${next}`);
    }
  }

  private hasFinalDelivery(sessionId: string) {
    return this.events.list(sessionId).some((event) => event.type === 'final_delivery_created');
  }

  private shouldReopenRequirementLoop(status: SessionStatus, requiresBriefRevision: boolean) {
    return (
      requiresBriefRevision ||
      ['AGENT_DISCUSSING', 'WAIT_USER_CONFIRM', 'WAIT_WORKFLOW_SELECT', 'REVISING_BRIEF', 'WAIT_USER_DECISION'].includes(status)
    );
  }

  private pauseForWorkflowStepConfirmation(session: SessionDetail, taskId: string, resultSummary: string) {
    const run = session.workflowRun;
    if (!run || run.nodeTaskIds[run.currentStepIndex] !== taskId) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: `工作流执行状态与任务不一致：${taskId}` });
      return;
    }
    const task = this.tasks.list(session.id).find((candidate) => candidate.id === taskId);
    if (!task) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: `未找到工作流任务：${taskId}` });
      return;
    }
    const assigneeId = task.assignee?.type === 'agent' ? task.assignee.id : undefined;
    const agent = assigneeId ? this.agents.findByIdOrKey(assigneeId) : undefined;
    run.status = 'awaiting_step_confirmation';
    run.updatedAt = nowIso();
    this.setStatus(session, 'WAIT_WORKFLOW_STEP_CONFIRM');
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId,
      fromAgentId: assigneeId,
      content: `${agent?.name ?? 'Agent'} 完成工作流环节「${task.title}」。阶段输出：${resultSummary}`,
      metadata: createMetadata('chat_message', {
        messageKind: 'summary',
        phase: 'workflow_step_completed',
        workflowRunId: run.id,
        workflowId: run.workflowId,
        workflowStepIndex: run.currentStepIndex,
        relatedTaskIds: [task.id],
        resultSummary
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      taskId,
      priority: 'high',
      content: `请确认工作流环节「${task.title}」的输出。`,
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_workflow_step',
        title: `确认环节 ${run.currentStepIndex + 1}/${run.nodeTaskIds.length}`,
        description: resultSummary,
        relatedTaskId: task.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        workflowStepIndex: run.currentStepIndex,
        workflowStepCount: run.nodeTaskIds.length,
        outputSummary: resultSummary,
        options: [
          { key: 'approve', label: '确认并继续', style: 'primary' },
          { key: 'revise', label: '要求修改', style: 'default' }
        ]
      })
    });
  }

  private emitWorkflowTaskCreated(
    session: SessionDetail,
    task: AgentTask,
    coordinatorId: string,
    assigneeId: string,
    workflowId: string,
    workflowNodeId: string,
    workflowStepIndex: number
  ) {
    const payload = {
      taskId: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      assignedBy: task.assignedBy,
      assignee: task.assignee,
      routingMode: task.routingMode,
      assignmentReason: task.assignmentReason,
      contextRequirements: task.contextRequirements,
      verificationPlan: task.verificationPlan,
      riskNotes: task.riskNotes,
      requiresUserConfirmation: true,
      dependsOnTaskIds: task.dependsOnTaskIds,
      acceptanceCriteria: task.acceptanceCriteria,
      workflowId,
      workflowNodeId,
      workflowStepIndex
    };
    this.events.create({
      sessionId: session.id,
      type: 'task_created',
      taskId: task.id,
      content: `已创建工作流任务：${task.title}`,
      metadata: createMetadata('task_card', payload)
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_assigned',
      taskId: task.id,
      fromAgentId: coordinatorId,
      toAgentIds: [assigneeId],
      content: `Coordinator 已分配工作流任务：${task.title}`,
      metadata: createMetadata('task_card', payload)
    });
  }

  private assertPendingConfirmation(sessionId: string, confirmationId: string, reason: string) {
    const events = this.events.list(sessionId);
    const request = events.find(
      (event) =>
        event.type === 'user_confirmation_requested' &&
        (event.metadata.payload as { confirmationId?: string; reason?: string } | undefined)?.confirmationId === confirmationId &&
        (event.metadata.payload as { reason?: string } | undefined)?.reason === reason
    );
    const resolved = events.some(
      (event) =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === confirmationId
    );
    if (!request || resolved) throw new BadRequestException(`Confirmation is missing or already resolved: ${confirmationId}`);
  }

  private isEmptyWorkspace(session: SessionDetail) {
    const snapshot = session.workspaceSnapshot;
    return Boolean(
      snapshot &&
      snapshot.fileCount === 0 &&
      snapshot.files.length === 0 &&
      snapshot.tree.length === 0
    );
  }

  private reopenRequirementLoop(
    session: SessionDetail,
    content: string,
    sourceEvent: CollaborationEvent,
    affectedAgentIds: string[],
    reason: string
  ) {
    this.execution.cancel(
      session.id,
      createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
    );
    this.tasks.cancelUnfinished(session.id, messages.requirementChangedCancelTasks);
    const relevantAgentIds = this.relevantAgentIds(session, content, affectedAgentIds);
    this.recordAgentRequirementContext(session, content, sourceEvent.id, relevantAgentIds);
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: messages.requirementChangedNotice,
      metadata: createMetadata('system_notice', {
        status: 'AGENT_DISCUSSING',
        reason,
        sourceEventId: sourceEvent.id,
        affectedAgentIds: relevantAgentIds
      })
    });
    this.setStatus(session, 'AGENT_DISCUSSING');
    this.generateBriefInBackground(session);
  }

  private recordAgentRequirementContext(
    session: SessionDetail,
    content: string,
    sourceEventId: string,
    relevantAgentIds: string[]
  ) {
    for (const agentId of relevantAgentIds) {
      const agent = this.agents.findByIdOrKey(agentId);
      if (!agent) {
        continue;
      }
      this.memories.create({
        sessionId: session.id,
        agentId,
        scope: 'session',
        content: messages.requirementUpdateForAgent(agent.name, content),
        sourceEventId,
        confidence: 0.9
      });
      this.events.create({
        sessionId: session.id,
        type: 'agent_status_changed',
        fromAgentId: agentId,
        content: messages.agentMarkedUpdateRelevant(agent.name),
        metadata: createMetadata('system_notice', {
          agentId,
          status: 'thinking',
          thoughtSummary: messages.agentUpdateThought,
          actionSummary: messages.agentUpdateAction,
          sourceEventId
        })
      });
    }
  }

  private relevantAgentIds(session: SessionDetail, content: string, affectedAgentIds: string[]) {
    const agents = this.participatingAgents(session);
    const explicit = new Set(affectedAgentIds);
    for (const agent of agents) {
      if (
        content.includes(agent.id) ||
        content.includes(`@${agent.key}`) ||
        content.includes(`@${agent.name}`) ||
        new RegExp(this.escapeRegExp(agent.key), 'i').test(content) ||
        new RegExp(this.escapeRegExp(agent.name), 'i').test(content)
      ) {
        explicit.add(agent.id);
      }
    }
    return Array.from(explicit.size ? explicit : new Set(agents.map((agent) => agent.id)));
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private isResumeCommand(content: string) {
    return /^(继续|重试|恢复|resume|retry|continue)$/i.test(content.trim());
  }

  private retryFailedSession(session: SessionDetail, sourceEventId: string) {
    const failurePhase = this.latestFailurePhase(session.id);
    const shouldRetryBrief =
      !session.currentTaskBriefId ||
      ['discussion', 'brief_generation', 'brief_revision'].includes(failurePhase ?? '');
    if (shouldRetryBrief) {
      this.setStatus(session, 'AGENT_DISCUSSING');
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '收到继续指令，正在重新生成任务契约。',
        metadata: createMetadata('system_notice', {
          status: 'AGENT_DISCUSSING',
          reason: 'failed_brief_generation_user_retry',
          sourceEventId
        })
      });
      this.generateBriefInBackground(session);
      return;
    }

    this.setStatus(session, 'EXECUTING');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: '收到继续指令，正在恢复任务执行。',
      metadata: createMetadata('system_notice', {
        status: 'EXECUTING',
        reason: 'failed_execution_user_retry',
        sourceEventId
      })
    });
    this.resumeExecution(session);
  }

  private latestFailurePhase(sessionId: string) {
    const events = this.events.list(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const metadata = events[index]?.metadata as { payload?: { phase?: unknown } } | undefined;
      if (typeof metadata?.payload?.phase === 'string') return metadata.payload.phase;
    }
    return undefined;
  }

  private resumeExecution(session: SessionDetail) {
    if (!session.currentTaskBriefId) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.resumeBriefMissing });
      return;
    }
    const brief = this.orchestrator.getBrief(session.id, session.currentTaskBriefId);
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.resumeBriefMissing });
      return;
    }
    if (session.workflowRunId && this.workflowRuntime) {
      void this.workflowRuntime
        .resumeCurrentExecution(session.workflowRunId)
        .then((resumed) => {
          if (!resumed) {
            this.applyOutcome(session.id, {
              kind: 'ask_user',
              reason: '当前工作流没有可恢复的运行中节点。'
            });
          }
        })
        .catch((error) => this.failSession(session, error, 'workflow_resume'));
      return;
    }
    this.tasks.resetStaleRunning(session.id);
    const unfinishedTasks = this.tasks.unfinished(session.id);
    this.execution.start(session, brief, unfinishedTasks, (outcome) => this.applyOutcome(session.id, outcome));
  }

  private normalizeRuntimePreference(input?: RuntimePreference): RuntimePreference | undefined {
    if (!input) return undefined;
    const preferredRuntimeType = isRuntimeType(input.preferredRuntimeType) ? input.preferredRuntimeType : undefined;
    const allowedRuntimeTypes = Array.from(new Set((input.allowedRuntimeTypes ?? []).filter(isRuntimeType)));
    const preferredModelId = input.preferredModelId?.trim() || undefined;
    const preference = {
      ...(preferredRuntimeType ? { preferredRuntimeType } : {}),
      ...(preferredModelId ? { preferredModelId } : {}),
      ...(allowedRuntimeTypes.length ? { allowedRuntimeTypes } : {})
    };
    return Object.keys(preference).length ? preference : undefined;
  }

  private assertCurrentSchema(session: SessionDetail) {
    if (typeof session.dataEpoch !== 'string' || !session.dataEpoch) {
      throw new Error(`CUTOVER_REQUIRED: persisted Session has no dataEpoch: ${session.id ?? 'unknown'}`);
    }
    assertCurrentDataEpoch(this.persistence.currentDataEpoch(), session.dataEpoch, `Session ${session.id}`);
  }
  private restartExecutionWithUpdatedContext(
    session: SessionDetail,
    sourceEventId: string,
    affectedAgentIds: string[],
    interruptTaskId: string
  ) {
    if (session.status !== 'EXECUTING' || !this.execution.isRunning(session.id)) {
      return;
    }
    const brief = session.currentTaskBriefId
      ? this.orchestrator.getBrief(session.id, session.currentTaskBriefId)
      : undefined;
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.resumeBriefMissing });
      return;
    }

    const unfinishedTasks = this.tasks.unfinished(session.id).filter((task) => task.id !== interruptTaskId);
    if (!unfinishedTasks.length) {
      return;
    }

    if (session.workflowRunId && this.workflowRuntime) {
      void this.workflowRuntime.rescheduleCurrentExecution(session.workflowRunId, sourceEventId);
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '执行中补充需求已写入相关 Agent 上下文，正在重调度当前工作流节点。',
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'executing_user_interrupt_rescheduled',
          sourceEventId,
          affectedAgentIds,
          interruptTaskId,
          affectedTaskIds: unfinishedTasks.map((task) => task.id),
          workflowRunId: session.workflowRunId
        })
      });
      return;
    }

    this.execution.cancel(
      session.id,
      createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
    );
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: '执行中补充需求已写入相关 Agent 上下文，正在重调度未完成任务。',
      metadata: createMetadata('system_notice', {
        status: session.status,
        reason: 'executing_user_interrupt_rescheduled',
        sourceEventId,
        affectedAgentIds,
        interruptTaskId,
        affectedTaskIds: unfinishedTasks.map((task) => task.id)
      })
    });
    this.execution.start(session, brief, unfinishedTasks, (outcome) => this.applyOutcome(session.id, outcome));
  }

  private titleFromInput(input: string) {
    return input.trim().slice(0, 28) || '新协作会话';
  }

  private participatingAgents(session: SessionDetail) {
    const agents = session.participatingAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId))
      .filter((agent): agent is Agent => Boolean(agent));
    return agents.length ? agents : this.agents.list();
  }

  private pickSessionAgent(session: SessionDetail, preferredKeys: string[]) {
    const agents = this.participatingAgents(session);
    for (const key of preferredKeys) {
      const preferred = agents.find((agent) => agent.key === key);
      if (preferred) {
        return preferred;
      }
    }
    const fallback = agents[0];
    if (!fallback) {
      throw new Error(messages.noAvailableAgent);
    }
    return fallback;
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

