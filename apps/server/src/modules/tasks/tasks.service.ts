import { Injectable } from '@nestjs/common';
import type { AgentTask, SuggestedAgentTask, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';

@Injectable()
export class TasksService {
  private readonly tasksBySession = new Map<string, AgentTask[]>();

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
    return tasks;
  }

  list(sessionId: string) {
    return this.tasksBySession.get(sessionId) ?? [];
  }

  update(task: AgentTask, patch: Partial<AgentTask>) {
    Object.assign(task, patch, { updatedAt: nowIso() });
    return task;
  }
}
