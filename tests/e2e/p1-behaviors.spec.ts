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

// Execution and brief generation are now asynchronous, so the chain assertions
// poll instead of reading a single synchronous snapshot.
async function waitForEvent(sessionId: string, type: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await findEvent(sessionId, type);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError ?? new Error(`Timed out waiting for event: ${type}`);
}

async function waitForStatus(sessionId: string, status: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const detail = await api<{ data: Json }>(`/sessions/${sessionId}`);
    last = String(detail.data.status);
    if (last === status) return;
    if (last === "FAILED" && status !== "FAILED") {
      const diagnostics = (await listEvents(sessionId))
        .filter((event) =>
          ["error_reported", "runtime_failed", "session_status_changed", "workflow_run_failed"].includes(
            String(event.type)
          )
        )
        .slice(-8);
      throw new Error(`Session failed while waiting for ${status}: ${JSON.stringify({ detail: detail.data, diagnostics })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for status ${status}, last=${last}`);
}

async function waitForAnyStatus(sessionId: string, statuses: string[], timeoutMs = 60_000) {
  const expected = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const detail = await api<{ data: Json }>(`/sessions/${sessionId}`);
    last = String(detail.data.status);
    if (expected.has(last)) return last;
    if (["FAILED", "CANCELLED"].includes(last)) {
      throw new Error(`Session terminated while waiting for ${statuses.join("/")}: ${JSON.stringify(detail.data)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${statuses.join("/")}, last=${last}`);
}

async function waitForRagMarker(sessionId: string, marker: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastRagEvents: Json[] = [];
  while (Date.now() < deadline) {
    const events = await listEvents(sessionId);
    lastRagEvents = events.filter((event) => event.type === "rag_retrieved");
    const matched = lastRagEvents
      .some((event) =>
        (((event.metadata as Json).payload as Json).matchedChunks as Json[] | undefined)?.some((chunk) =>
          String(chunk.snippet).includes(marker)
        )
      );
    if (matched) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for RAG marker ${marker}: ${JSON.stringify(lastRagEvents)}`);
}

async function waitForTaskExecutionRuntimeStart(sessionId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastRelevantEvents: Json[] = [];
  while (Date.now() < deadline) {
    const events = await listEvents(sessionId);
    const taskStartedIndex = events.findIndex((event) => event.type === "task_started" && Boolean(event.taskId));
    if (taskStartedIndex >= 0) {
      const taskId = String(events[taskStartedIndex].taskId);
      const runtimeStarted = events
        .slice(taskStartedIndex + 1)
        .find((event) => event.type === "runtime_started" && String(event.taskId) === taskId);
      if (runtimeStarted) return runtimeStarted;
    }
    lastRelevantEvents = events.filter((event) =>
      ["task_started", "runtime_started", "runtime_failed", "session_status_changed"].includes(String(event.type))
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task execution Runtime start: ${JSON.stringify(lastRelevantEvents)}`);
}

async function createSession(input: string, extra: Json = {}) {
  const created = await api<{ data: { session: Json; firstEvent: Json } }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      input,
      agentIds: ["coordinator", "requirements", "product-manager", "backend", "test", "review"],
      ...extra
    })
  });
  return String(created.data.session.id);
}

async function createPublishedProductManagerWorkflow() {
  const agents = await api<{ data: Json[] }>("/agents");
  const productManager = agents.data.find((agent) => agent.key === "product-manager");
  if (!productManager) throw new Error("Product Manager Agent is unavailable");
  const draft = await api<{ data: Json }>("/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "P1 executing interrupt workflow",
      nodes: [{ id: "p1-product-manager", type: "agent", agentId: productManager.id, order: 0 }]
    })
  });
  return (
    await api<{ data: Json }>(`/workflows/${String(draft.data.id)}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: draft.data.draftRevision })
    })
  ).data;
}

async function selectWorkflow(sessionId: string, workflow: Json) {
  await waitForStatus(sessionId, "WAIT_WORKFLOW_SELECT");
  const selection = (await listEvents(sessionId)).find(
    (event) =>
      event.type === "user_confirmation_requested" &&
      (((event.metadata as Json).payload as Json | undefined)?.reason === "select_workflow")
  );
  if (!selection) throw new Error("Workflow selection confirmation was not emitted");
  const payload = ((selection.metadata as Json).payload as Json);
  await api(`/sessions/${sessionId}/workflow/select`, {
    method: "POST",
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: payload.confirmationId
    })
  });
}

function parseSseBlock(block: string) {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return undefined;
  return JSON.parse(dataLines.join("\n")) as Json;
}

async function observeStreamEvent(
  sessionId: string,
  trigger: () => Promise<unknown>,
  matches: (event: Json) => boolean
) {
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
        if (event && matches(event)) return event;
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
  const executionWorkflow = await createPublishedProductManagerWorkflow();
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
  // Brief generation now runs in the background; let it flush so the next
  // streamed event is the message we trigger, not a brief-gen event.
  await waitForStatus(sseSessionId, "WAIT_USER_CONFIRM");
  const firstMessage = "第一条 SSE 重连验证消息";
  const firstStreamEvent = await observeStreamEvent(sseSessionId, () =>
    api(`/sessions/${sseSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: firstMessage })
    }),
    (event) => event.type === "user_message" && event.content === firstMessage
  );
  if (firstStreamEvent.type !== "user_message") {
    throw new Error(`Expected first streamed user_message, got ${String(firstStreamEvent.type)}`);
  }

  const secondMessage = "第二条 SSE 重连验证消息";
  const secondStreamEvent = await observeStreamEvent(sseSessionId, () =>
    api(`/sessions/${sseSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: secondMessage })
    }),
    (event) => event.type === "user_message" && event.content === secondMessage
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
  await api(`/agents/product-manager/knowledge-bases/${knowledgeBaseId}`, { method: "POST" });

  const executionSessionId = await createSession("分析 P1 执行中插话与 RAG 覆盖，输出行为说明。", {
    knowledgeBaseIds: [knowledgeBaseId],
    runtimePreference: { preferredRuntimeType: "generic_llm", allowedRuntimeTypes: ["generic_llm"] }
  });
  const briefPayload = ((await waitForEvent(executionSessionId, "brief_created")).metadata as Json).payload as Json;
  const briefId = String(briefPayload.briefId);

  await api(`/sessions/${executionSessionId}/briefs/${briefId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ note: "Start delayed dry-run for interrupt coverage." })
  });
  await selectWorkflow(executionSessionId, executionWorkflow);
  await waitForTaskExecutionRuntimeStart(executionSessionId);
  const interrupt = await api<{ data: { event: Json; handlingPlan: Json } }>(
    `/sessions/${executionSessionId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content: "执行中插话：不要修改数据库，保持 dry-run non-destructive。",
        mentionedAgentIds: ["coordinator", "product-manager"]
      })
    }
  );
  if (interrupt.data.handlingPlan.shouldPause !== true || interrupt.data.handlingPlan.priority !== "high") {
    throw new Error("Executing constraint interrupt must pause and be high priority");
  }

  const events = await listEvents(executionSessionId);
  const interruptTaskEvent = events.find(
    (event) =>
      event.type === "session_status_changed" &&
      (((event.metadata as Json).payload as Json).reason === "executing_user_interrupt_task_created")
  );
  if (!interruptTaskEvent) {
    throw new Error("Executing interrupt must create a task to handle it");
  }

  // 插话后的工作流必须继续到交付，或在 Post Review 明确等待用户决策；不得失败或被误取消。
  const settledStatus = await waitForAnyStatus(executionSessionId, ["COMPLETED", "WAIT_USER_DECISION"]);
  if (settledStatus === "WAIT_USER_DECISION") {
    const confirmation = (await listEvents(executionSessionId)).find(
      (event) => event.type === "user_confirmation_requested"
    );
    if (!confirmation) throw new Error("WAIT_USER_DECISION must expose a user confirmation");
  }
  await waitForRagMarker(executionSessionId, "P1_RAG_MARKER");
  const completedSession = await api<{ data: Json }>(`/sessions/${executionSessionId}`);
  if (!["COMPLETED", "WAIT_USER_DECISION"].includes(String(completedSession.data.status))) {
    throw new Error(`Interrupt with context left an invalid state: ${String(completedSession.data.status)}`);
  }

  console.log("p1 behavior coverage ok");
}

void runP1Behaviors();
