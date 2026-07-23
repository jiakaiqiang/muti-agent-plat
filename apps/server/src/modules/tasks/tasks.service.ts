import { Injectable } from '@nestjs/common';
import type { ActorRef, AgentTask, SuggestedAgentTask, TaskRoutingMode, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';

@Injectable()
export class TasksService {
  private readonly tasksBySession = new Map<string, AgentTask[]>();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<Record<string, AgentTask[]>>('tasksBySession', {});
    for (const [sessionId, tasks] of Object.entries(persisted)) {
      this.tasksBySession.set(sessionId, tasks);
    }
  }

  createFromSuggestions(
    sessionId: UUID,
    suggestions: SuggestedAgentTask[],
    agentIdByKey: Map<string, string>,
    options: { assignedBy?: ActorRef; routingMode?: TaskRoutingMode } = {}
  ) {
    const titleToId = new Map<string, string>();
    const tasks: AgentTask[] = suggestions.map((suggestion) => {
      const assigneeId = suggestion.suggestedAgentKey
        ? agentIdByKey.get(suggestion.suggestedAgentKey)
        : undefined;
      const task: AgentTask = {
        id: crypto.randomUUID(),
        sessionId,
        title: suggestion.title,
        description: suggestion.description,
        status: 'assigned',
        assignedBy: options.assignedBy,
        assignee: assigneeId ? { type: 'agent', id: assigneeId } : undefined,
        routingMode: options.routingMode ?? suggestion.routingMode ?? 'coordinator_controlled',
        autoResolutionAttempted: false,
        assignmentReason: suggestion.assignmentReason ?? undefined,
        contextRequirements: suggestion.contextRequirements,
        verificationPlan: suggestion.verificationPlan,
        riskNotes: suggestion.riskNotes,
        requiresUserConfirmation: suggestion.requiresUserConfirmation,
        dependsOnTaskIds: [],
        acceptanceCriteria: suggestion.acceptanceCriteria,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      titleToId.set(this.normalizeTitle(task.title), task.id);
      return task;
    });

    for (const [index, suggestion] of suggestions.entries()) {
      const dependencyIds = (suggestion.dependsOnTaskTitles ?? [])
        .map((title) => titleToId.get(this.normalizeTitle(title)))
        .filter((id): id is string => Boolean(id));
      tasks[index].dependsOnTaskIds = Array.from(new Set(dependencyIds));
    }

    this.tasksBySession.set(sessionId, [...(this.tasksBySession.get(sessionId) ?? []), ...tasks]);
    this.persist();
    return tasks;
  }

  list(sessionId: string) {
    return this.tasksBySession.get(sessionId) ?? [];
  }

  add(task: AgentTask) {
    const existing = this.list(task.sessionId).find((candidate) => candidate.id === task.id);
    if (existing) return existing;
    this.tasksBySession.set(task.sessionId, [...this.list(task.sessionId), task]);
    this.persist();
    return task;
  }

  find(sessionId: string, taskId: string) {
    return this.list(sessionId).find((task) => task.id === taskId);
  }

  update(task: AgentTask, patch: Partial<AgentTask>) {
    Object.assign(task, patch, { updatedAt: nowIso() });
    this.persist();
    return task;
  }

  unfinished(sessionId: string) {
    return this.list(sessionId).filter((task) =>
      ['pending', 'assigned', 'accepted', 'claimed', 'running', 'waiting', 'blocked', 'reworking'].includes(task.status)
    );
  }

  resetStaleRunning(sessionId: string) {
    for (const task of this.list(sessionId)) {
      if (task.status === 'running') {
        this.update(task, { status: 'pending' });
      }
    }
  }

  resetForRework(sessionId: string) {
    for (const task of this.list(sessionId)) {
      if (task.status !== 'cancelled') {
        this.update(task, { status: 'reworking' });
      }
    }
  }

  cancelUnfinished(sessionId: string, reason?: string) {
    for (const task of this.unfinished(sessionId)) {
      this.update(task, { status: 'cancelled', resultSummary: reason });
    }
  }

  deleteSession(sessionId: string) {
    this.tasksBySession.delete(sessionId);
    this.persist();
  }

  private persist() {
    this.persistence.setCollection('tasksBySession', Object.fromEntries(this.tasksBySession));
  }

  private normalizeTitle(title: string) {
    return title.trim().toLocaleLowerCase();
  }

}
