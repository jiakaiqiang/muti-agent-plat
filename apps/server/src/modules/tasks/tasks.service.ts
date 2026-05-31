import { Injectable } from '@nestjs/common';
import type { AgentTask, SuggestedAgentTask, UUID } from '@agent-cluster/shared';
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

  createFromSuggestions(sessionId: UUID, suggestions: SuggestedAgentTask[], agentIdByKey: Map<string, string>) {
    const tasks: AgentTask[] = suggestions.map((suggestion) => ({
      id: crypto.randomUUID(),
      sessionId,
      title: suggestion.title,
      description: suggestion.description,
      status: 'pending',
      assigneeAgentId: suggestion.suggestedAgentKey ? agentIdByKey.get(suggestion.suggestedAgentKey) : undefined,
      dependsOnTaskIds: [],
      acceptanceCriteria: suggestion.acceptanceCriteria,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }));

    this.tasksBySession.set(sessionId, [...(this.tasksBySession.get(sessionId) ?? []), ...tasks]);
    this.persist();
    return tasks;
  }

  create(input: {
    sessionId: UUID;
    title: string;
    description: string;
    assigneeAgentId?: string;
    acceptanceCriteria?: string[];
  }): AgentTask {
    const task: AgentTask = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      title: input.title,
      description: input.description,
      status: 'pending',
      assigneeAgentId: input.assigneeAgentId,
      dependsOnTaskIds: [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    this.tasksBySession.set(input.sessionId, [...(this.tasksBySession.get(input.sessionId) ?? []), task]);
    this.persist();
    return task;
  }

  list(sessionId: string) {
    return this.tasksBySession.get(sessionId) ?? [];
  }

  update(task: AgentTask, patch: Partial<AgentTask>) {
    Object.assign(task, patch, { updatedAt: nowIso() });
    this.persist();
    return task;
  }

  private persist() {
    this.persistence.setCollection('tasksBySession', Object.fromEntries(this.tasksBySession));
  }
}
