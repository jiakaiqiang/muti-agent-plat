/**
 * E2E skeleton for the v0.1 collaboration main chain.
 *
 * This file is intentionally runner-light. Once Playwright, Vitest, or another
 * test runner is available in the workspace, replace the minimal helpers with
 * the repo-local fixtures while preserving the assertions below.
 */

type Json = Record<string, unknown>;

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000/api";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function expectContractEvent(event: Json, expectedType?: string) {
  if (expectedType && event.type !== expectedType) {
    throw new Error(`Expected event type ${expectedType}, got ${String(event.type)}`);
  }

  for (const field of ["id", "sessionId", "type", "content", "metadata", "createdAt"]) {
    if (!(field in event)) {
      throw new Error(`Missing event field: ${field}`);
    }
  }

  const metadata = event.metadata as Json;
  if (metadata.schemaVersion !== "0.1") {
    throw new Error("Event metadata.schemaVersion must be 0.1");
  }
}

async function findEvent(sessionId: string, type: string): Promise<Json> {
  const response = await api<{ data: { items: Json[] } }>(
    `/sessions/${sessionId}/events?limit=100`
  );
  const event = response.data.items.find((item) => item.type === type);
  if (!event) {
    throw new Error(`Event not found: ${type}`);
  }
  expectContractEvent(event, type);
  return event;
}

async function runMainChain() {
  const created = await api<{ data: { session: Json; firstEvent: Json }; requestId: string }>(
    "/sessions",
    {
      method: "POST",
      body: JSON.stringify({
        input: "Build the v1 collaboration workflow",
        agentIds: ["coordinator", "requirements", "backend", "test", "review"],
        tokenBudget: 20000,
        knowledgeBaseIds: ["kb-contracts"]
      })
    }
  );

  const sessionId = String(created.data.session.id);
  expectContractEvent(created.data.firstEvent, "user_message");

  const briefEvent = await findEvent(sessionId, "brief_created");
  const briefPayload = (briefEvent.metadata as Json).payload as Json;
  const briefId = String(briefPayload.briefId);

  const confirmed = await api<{ data: { brief: Json; event: Json; createdTasks: Json[] } }>(
    `/sessions/${sessionId}/briefs/${briefId}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ note: "Confirmed for non-destructive dry-run." })
    }
  );

  if (confirmed.data.brief.confirmedByUser !== true) {
    throw new Error("Confirmed brief must set confirmedByUser=true");
  }
  expectContractEvent(confirmed.data.event, "brief_confirmed");
  if (confirmed.data.createdTasks.length === 0) {
    throw new Error("Brief confirmation must create tasks");
  }

  const interrupt = await api<{ data: { event: Json; handlingPlan?: Json } }>(
    `/sessions/${sessionId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content: "While executing, keep the dry-run non-destructive.",
        mentionedAgentIds: ["coordinator"]
      })
    }
  );

  expectContractEvent(interrupt.data.event, "user_message");
  if (!interrupt.data.handlingPlan) {
    throw new Error("Executing user interrupt must return handlingPlan");
  }
  if (interrupt.data.handlingPlan.priority !== "high") {
    throw new Error("Executing user interrupt that changes constraints must be high priority");
  }

  await findEvent(sessionId, "runtime_started");
  await findEvent(sessionId, "rag_retrieved");
  await findEvent(sessionId, "runtime_completed");
  await findEvent(sessionId, "post_review_completed");
  await findEvent(sessionId, "final_delivery_created");

  const detail = await api<{ data: Json }>(`/sessions/${sessionId}`);
  if (detail.data.status !== "COMPLETED") {
    throw new Error(`Expected COMPLETED session, got ${String(detail.data.status)}`);
  }
}

void runMainChain();
