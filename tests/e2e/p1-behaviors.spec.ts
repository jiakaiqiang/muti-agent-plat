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
    const body = await response.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

async function expectApiError(path: string, init: RequestInit, expectedCode: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
  if (response.ok) {
    throw new Error(`Expected ${init.method ?? "GET"} ${path} to fail`);
  }
  const body = (await response.json()) as Json;
  const error = body.error as Json | undefined;
  if (error?.code !== expectedCode) {
    throw new Error(`Expected ${expectedCode}, got ${String(error?.code)}`);
  }
}

async function listEvents(sessionId: string) {
  const response = await api<{ data: { items: Json[] } }>(`/sessions/${sessionId}/events?limit=200`);
  return response.data.items;
}

async function findEvent(sessionId: string, type: string) {
  const event = (await listEvents(sessionId)).find((item) => item.type === type);
  if (!event) throw new Error(`Event not found: ${type}`);
  return event;
}

async function createSession(input: string, extra: Json = {}) {
  const created = await api<{ data: { session: Json; firstEvent: Json } }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      input,
      agentIds: ["coordinator", "requirements", "backend", "test", "review"],
      ...extra
    })
  });
  return String(created.data.session.id);
}

function parseSseBlock(block: string) {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return undefined;
  return JSON.parse(dataLines.join("\n")) as Json;
}

async function observeNextStreamEvent(sessionId: string, trigger: () => Promise<unknown>) {
  const controller = new AbortController();
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
    signal: controller.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`SSE stream failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readPromise = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) return event;
      }
    }
    throw new Error("Timed out waiting for SSE event");
  })();

  await trigger();
  try {
    return await readPromise;
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}

async function runP1Behaviors() {
  const transitionSessionId = await createSession("P1 illegal transition coverage");
  await expectApiError(
    `/sessions/${transitionSessionId}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ reason: "Cannot resume before execution is paused." })
    },
    "INVALID_SESSION_TRANSITION"
  );

  const sseSessionId = await createSession("P1 SSE reconnect coverage");
  const firstStreamEvent = await observeNextStreamEvent(sseSessionId, () =>
    api(`/sessions/${sseSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "第一条 SSE 重连验证消息" })
    })
  );
  if (firstStreamEvent.type !== "user_message") {
    throw new Error(`Expected first streamed user_message, got ${String(firstStreamEvent.type)}`);
  }

  const secondStreamEvent = await observeNextStreamEvent(sseSessionId, () =>
    api(`/sessions/${sseSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "第二条 SSE 重连验证消息" })
    })
  );
  if (secondStreamEvent.type !== "user_message") {
    throw new Error(`Expected second streamed user_message, got ${String(secondStreamEvent.type)}`);
  }

  const knowledgeBase = await api<{ data: Json }>("/knowledge-bases", {
    method: "POST",
    body: JSON.stringify({ name: "P1 RAG Contract", scope: "project" })
  });
  const knowledgeBaseId = String(knowledgeBase.data.id);
  await api(`/knowledge-bases/${knowledgeBaseId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      title: "P1 RAG Runtime Guidance",
      sourceType: "markdown",
      content: "P1_RAG_MARKER: runtime must keep dry-run non-destructive and preserve structured evidence."
    })
  });
  await api(`/agents/backend/knowledge-bases/${knowledgeBaseId}`, { method: "POST" });

  const executionSessionId = await createSession("P1 executing interrupt and RAG coverage", {
    knowledgeBaseIds: [knowledgeBaseId]
  });
  const briefPayload = ((await findEvent(executionSessionId, "brief_created")).metadata as Json).payload as Json;
  const briefId = String(briefPayload.briefId);

  const confirmPromise = api(`/sessions/${executionSessionId}/briefs/${briefId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ note: "Start delayed dry-run for interrupt coverage." })
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const interrupt = await api<{ data: { event: Json; handlingPlan: Json } }>(
    `/sessions/${executionSessionId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content: "执行中插话：不要修改数据库，保持 dry-run non-destructive。",
        mentionedAgentIds: ["coordinator", "backend"]
      })
    }
  );
  if (interrupt.data.handlingPlan.shouldPause !== true || interrupt.data.handlingPlan.priority !== "high") {
    throw new Error("Executing constraint interrupt must pause and be high priority");
  }

  await confirmPromise;
  const events = await listEvents(executionSessionId);
  const decisionEvent = events.find(
    (event) =>
      event.type === "session_status_changed" &&
      (((event.metadata as Json).payload as Json).status === "WAIT_USER_DECISION")
  );
  if (!decisionEvent) {
    throw new Error("Executing interrupt must emit WAIT_USER_DECISION status event");
  }
  const decisionConfirmation = events.find(
    (event) =>
      event.type === "user_confirmation_requested" &&
      (((event.metadata as Json).payload as Json).reason === "resolve_contract_conflict")
  );
  if (!decisionConfirmation) {
    throw new Error("Executing interrupt must emit a user decision confirmation card");
  }
  const pausedSession = await api<{ data: Json }>(`/sessions/${executionSessionId}`);
  if (pausedSession.data.status !== "WAIT_USER_DECISION") {
    throw new Error(`Executing interrupt must keep session waiting for a user decision, got ${String(pausedSession.data.status)}`);
  }

  const ragEvents = events.filter((event) => event.type === "rag_retrieved");
  const matchedP1Marker = ragEvents.some((event) =>
    (((event.metadata as Json).payload as Json).matchedChunks as Json[] | undefined)?.some((chunk) =>
      String(chunk.snippet).includes("P1_RAG_MARKER")
    )
  );
  if (!matchedP1Marker) {
    throw new Error("RAG event must include chunks from the bound P1 knowledge base");
  }

  const confirmationPayload = (decisionConfirmation.metadata as Json).payload as Json;
  await api(`/sessions/${executionSessionId}/resume`, {
    method: "POST",
    body: JSON.stringify({
      reason: "Continue after resolving interrupt.",
      confirmationId: confirmationPayload.confirmationId
    })
  });
  const resumedSession = await api<{ data: Json }>(`/sessions/${executionSessionId}`);
  if (resumedSession.data.status !== "COMPLETED") {
    throw new Error(`Resolved dry-run interrupt should close as completed, got ${String(resumedSession.data.status)}`);
  }
  const resolvedEvents = await listEvents(executionSessionId);
  const resolvedConfirmation = resolvedEvents.find(
    (event) =>
      event.type === "user_confirmation_resolved" &&
      (((event.metadata as Json).payload as Json).confirmationId === confirmationPayload.confirmationId)
  );
  if (!resolvedConfirmation) {
    throw new Error("Resolving interrupt must persist the confirmation result");
  }

  console.log("p1 behavior coverage ok");
}

void runP1Behaviors();
