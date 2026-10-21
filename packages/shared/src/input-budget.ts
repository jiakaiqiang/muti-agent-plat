/** Server-owned admission scope. Never accepted from model output or tool arguments. */
export type InputBudgetPolicy = {
  actorId: string;
  dataEpoch: string;
  sessionGeneration: number;
  kind: 'agent_task' | 'intent_understanding';
  slot: string;
  taskId?: string;
  routingId?: string;
  routingRevision?: number;
};

export type InputBudgetEstimate = {
  estimatedInputTokens: number;
  outputReservationTokens: number;
  effectiveMaxInputTokens: number;
  maxInputTokens: number;
  safetyMarginTokens: number;
};

export type InputBudgetDecision = InputBudgetPolicy & InputBudgetEstimate & {
  id: string;
  operationId: string;
  sessionId: string;
  status: 'pending' | 'granted' | 'consumed' | 'ended';
  createdAt: string;
  decidedAt?: string;
  decision?: 'continue' | 'end';
  consumedByInvocationId?: string;
  consumedByProcessId?: string;
};

export type DecideInputBudgetInput = {
  operationId: string;
  decisionId: string;
  decision: 'continue' | 'end';
};
