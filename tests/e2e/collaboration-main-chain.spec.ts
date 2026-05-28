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
    const body = await response.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
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

function expectNoSnakeCaseKeys(value: unknown, path = "data") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectNoSnakeCaseKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value as Json)) {
    if (key.includes("_")) {
      throw new Error(`Expected camelCase key at ${path}.${key}`);
    }
    expectNoSnakeCaseKeys(nested, `${path}.${key}`);
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

async function listEvents(sessionId: string): Promise<Json[]> {
  const response = await api<{ data: { items: Json[] } }>(
    `/sessions/${sessionId}/events?limit=100`
  );
  response.data.items.forEach((event) => expectContractEvent(event));
  return response.data.items;
}

async function expectApiError(path: string, expectedCode: string) {
  const response = await fetch(`${API_BASE}${path}`);
  if (response.ok) {
    throw new Error(`Expected ${path} to fail`);
  }
  const body = (await response.json()) as Json;
  const error = body.error as Json | undefined;
  if (error?.code !== expectedCode) {
    throw new Error(`Expected ${expectedCode}, got ${String(error?.code)}`);
  }
  if (typeof body.requestId !== "string") {
    throw new Error("ApiError must include requestId");
  }
}

function expectRuntimeResultShape(result: Json, expectedStatus: "completed" | "failed") {
  if (result.status !== expectedStatus) {
    throw new Error(`Expected runtime status ${expectedStatus}, got ${String(result.status)}`);
  }
  if (!("usage" in result)) {
    throw new Error("Runtime result must include usage");
  }
  if (expectedStatus === "completed" && !("output" in result)) {
    throw new Error("Completed runtime result must include output");
  }
  if (expectedStatus === "failed") {
    if (!("error" in result)) {
      throw new Error("Failed runtime result must include error");
    }
    const error = result.error as Json;
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("Runtime error must include code and message");
    }
  }
}

async function runMainChain() {
  const runtimeHappy = await api<{ data: Json }>("/runtimes/mock/smoke?scenario=happy_path");
  expectRuntimeResultShape(runtimeHappy.data, "completed");
  const runtimeFailed = await api<{ data: Json }>("/runtimes/mock/smoke?scenario=task_failed");
  expectRuntimeResultShape(runtimeFailed.data, "failed");
  const genericRuntimeHappy = await api<{ data: Json }>("/runtimes/generic-llm/smoke?scenario=happy_path");
  expectRuntimeResultShape(genericRuntimeHappy.data, "completed");
  if (genericRuntimeHappy.data.runtimeType !== "generic_llm") {
    throw new Error("Generic LLM smoke must return runtimeType=generic_llm");
  }

  const agents = await api<{ data: Json[] }>("/agents");
  expectNoSnakeCaseKeys(agents.data);
  const requiredAgentKeys = [
    "coordinator",
    "requirements",
    "architect",
    "frontend",
    "backend",
    "test",
    "review",
    "notification"
  ];
  const actualAgentKeys = new Set(agents.data.map((agent) => String(agent.key)));
  for (const key of requiredAgentKeys) {
    if (!actualAgentKeys.has(key)) {
      throw new Error(`Missing default agent key: ${key}`);
    }
  }
  const backendAgent = agents.data.find((agent) => agent.key === "backend") as Json | undefined;
  const backendCapabilityIds = (backendAgent?.capabilityIds ?? []) as string[];
  if (!backendCapabilityIds.includes("cap-dry-run")) {
    throw new Error("Backend agent must include default dry-run capability");
  }
  const notificationAgent = agents.data.find((agent) => agent.key === "notification") as Json | undefined;
  const notificationCapabilityIds = (notificationAgent?.capabilityIds ?? []) as string[];
  if (!notificationCapabilityIds.includes("cap-feishu-draft")) {
    throw new Error("Notification agent must include default Feishu draft capability");
  }

  const capabilities = await api<{ data: Json[] }>("/capabilities");
  if (!capabilities.data.some((capability) => capability.id === "cap-file-write")) {
    throw new Error("Default capabilities must include cap-file-write");
  }
  if (!capabilities.data.some((capability) => capability.id === "cap-feishu-draft")) {
    throw new Error("Default capabilities must include cap-feishu-draft");
  }
  const highRiskCheck = await api<{ data: Json }>("/capabilities/cap-file-write/check", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "runtime-smoke-session",
      agentId: String(backendAgent?.id),
      reason: "E2E verifies high-risk capability confirmation."
    })
  });
  if (highRiskCheck.data.allowed !== false || highRiskCheck.data.code !== "CAPABILITY_REQUIRES_CONFIRMATION") {
    throw new Error("High-risk capability must require confirmation before approval");
  }
  await api<{ data: Json }>("/capabilities/cap-file-write/approve", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "runtime-smoke-session",
      agentId: String(backendAgent?.id),
      reason: "Approved by E2E test."
    })
  });
  const approvedHighRiskCheck = await api<{ data: Json }>("/capabilities/cap-file-write/check", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "runtime-smoke-session",
      agentId: String(backendAgent?.id)
    })
  });
  if (approvedHighRiskCheck.data.allowed !== true) {
    throw new Error("Approved high-risk capability should be allowed by the policy check");
  }

  const knowledgeBase = await api<{ data: Json }>("/knowledge-bases", {
    method: "POST",
    body: JSON.stringify({
      name: "Runtime Notes",
      scope: "project"
    })
  });
  const knowledgeBaseId = String(knowledgeBase.data.id);
  await api<{ data: Json }>(`/knowledge-bases/${knowledgeBaseId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      title: "Dry-run Runtime Notes",
      sourceType: "markdown",
      content: "Generic LLM Runtime must return structured JSON and avoid high risk tools during dry-run."
    })
  });
  const ragSearch = await api<{ data: { chunks: Json[] } }>(`/knowledge-bases/${knowledgeBaseId}/search`, {
    method: "POST",
    body: JSON.stringify({ query: "structured JSON dry-run" })
  });
  if (ragSearch.data.chunks.length === 0 || !String(ragSearch.data.chunks[0].snippet).includes("structured JSON")) {
    throw new Error("Knowledge search must return indexed document chunks");
  }
  const boundBackend = await api<{ data: { agent: Json } }>(`/agents/backend/knowledge-bases/${knowledgeBaseId}`, {
    method: "POST"
  });
  const boundKnowledgeBaseIds = boundBackend.data.agent.defaultKnowledgeBaseIds as string[];
  if (!boundKnowledgeBaseIds.includes(knowledgeBaseId)) {
    throw new Error("Agent knowledge binding must persist on the agent");
  }

  const created = await api<{ data: { session: Json; firstEvent: Json }; requestId: string }>(
    "/sessions",
    {
      method: "POST",
      body: JSON.stringify({
        input: "Build the v1 collaboration workflow",
        agentIds: ["coordinator", "requirements", "backend", "test", "review"],
        tokenBudget: 20000,
        knowledgeBaseIds: [knowledgeBaseId]
      })
    }
  );

  const sessionId = String(created.data.session.id);
  expectNoSnakeCaseKeys(created.data.session);
  expectContractEvent(created.data.firstEvent, "user_message");

  const sessionRiskCheck = await api<{ data: Json }>("/capabilities/cap-command-run/check", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      agentId: String(backendAgent?.id),
      reason: "E2E verifies session-level capability audit."
    })
  });
  if (sessionRiskCheck.data.allowed !== false || sessionRiskCheck.data.code !== "CAPABILITY_REQUIRES_CONFIRMATION") {
    throw new Error("Session capability check must be blocked before approval");
  }
  await api<{ data: Json }>("/capabilities/cap-command-run/approve", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      agentId: String(backendAgent?.id),
      reason: "Approved by E2E for audit verification."
    })
  });
  const sessionApprovedCheck = await api<{ data: Json }>("/capabilities/cap-command-run/check", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      agentId: String(backendAgent?.id)
    })
  });
  if (sessionApprovedCheck.data.allowed !== true) {
    throw new Error("Session capability check must be allowed after approval");
  }
  const capabilityAuditEvents = await listEvents(sessionId);
  const auditedStatuses = new Set(
    capabilityAuditEvents
      .filter((event) => ["tool_failed", "tool_completed", "tool_called"].includes(String(event.type)))
      .map((event) => String(((event.metadata as Json).payload as Json).status))
  );
  for (const status of ["blocked", "approved", "allowed"]) {
    if (!auditedStatuses.has(status)) {
      throw new Error(`Capability audit event missing status: ${status}`);
    }
  }

  const briefEvent = await findEvent(sessionId, "brief_created");
  const briefPayload = (briefEvent.metadata as Json).payload as Json;
  const briefId = String(briefPayload.briefId);
  const confirmationEvent = await findEvent(sessionId, "user_confirmation_requested");
  const confirmationPayload = (confirmationEvent.metadata as Json).payload as Json;
  if (confirmationPayload.relatedBriefId !== briefId) {
    throw new Error("Confirmation request must reference the created brief");
  }

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
  const ragRetrieved = await findEvent(sessionId, "rag_retrieved");
  const ragPayload = (ragRetrieved.metadata as Json).payload as Json;
  const matchedChunks = ragPayload.matchedChunks as Json[];
  if (!matchedChunks.some((chunk) => String(chunk.snippet).includes("structured JSON"))) {
    throw new Error("Runtime RAG event must include chunks from the bound knowledge base");
  }
  await findEvent(sessionId, "runtime_completed");

  const postReview = await findEvent(sessionId, "post_review_completed");
  const postReviewPayload = (postReview.metadata as Json).payload as Json;
  for (const field of ["matchedItems", "missingItems", "testResults", "recommendation"]) {
    if (!(field in postReviewPayload)) {
      throw new Error(`Post review payload missing ${field}`);
    }
  }

  const finalDelivery = await findEvent(sessionId, "final_delivery_created");
  const finalDeliveryPayload = (finalDelivery.metadata as Json).payload as Json;
  for (const field of ["summary", "completedItems", "incompleteItems", "risks", "artifactRefs"]) {
    if (!(field in finalDeliveryPayload)) {
      throw new Error(`Final delivery payload missing ${field}`);
    }
  }
  if (!Array.isArray(finalDeliveryPayload.artifactRefs) || finalDeliveryPayload.artifactRefs.length === 0) {
    throw new Error("Final delivery must include artifactRefs");
  }
  if (typeof finalDeliveryPayload.notificationDraftArtifactId !== "string") {
    throw new Error("Final delivery must reference a notification draft artifact");
  }

  const allEvents = await listEvents(sessionId);
  const pivotEventId = String(allEvents.at(1)?.id);
  const backfill = await api<{ data: { items: Json[] } }>(
    `/sessions/${sessionId}/events?afterEventId=${pivotEventId}`
  );
  if (backfill.data.items.some((event) => event.id === pivotEventId)) {
    throw new Error("afterEventId backfill must not duplicate the referenced event");
  }

  const artifacts = await api<{ data: { items: Json[] } }>(`/sessions/${sessionId}/artifacts`);
  if (artifacts.data.items.length === 0) {
    throw new Error("Expected artifacts created during the main chain");
  }
  const feishuDraft = artifacts.data.items.find((artifact) => artifact.type === "feishu_draft") as Json | undefined;
  if (!feishuDraft) {
    throw new Error("Expected a Feishu draft artifact during final delivery");
  }
  if (feishuDraft.id !== finalDeliveryPayload.notificationDraftArtifactId) {
    throw new Error("Final delivery notificationDraftArtifactId must match the Feishu draft artifact");
  }
  const feishuDraftDetail = await api<{ data: Json }>(`/artifacts/${String(feishuDraft.id)}`);
  const feishuDraftMetadata = feishuDraftDetail.data.metadata as Json;
  if (feishuDraftMetadata.dryRun !== true || feishuDraftMetadata.status !== "pending_user_confirmation") {
    throw new Error("Feishu draft artifact must remain unsent and pending confirmation");
  }
  const artifactId = String(artifacts.data.items[0].id);
  const artifactDetail = await api<{ data: Json }>(`/artifacts/${artifactId}`);
  if (artifactDetail.data.sessionId !== sessionId) {
    throw new Error("Artifact detail must return the same sessionId");
  }

  await expectApiError("/sessions/not-found", "SESSION_NOT_FOUND");

  const detail = await api<{ data: Json }>(`/sessions/${sessionId}`);
  if (detail.data.status !== "COMPLETED") {
    throw new Error(`Expected COMPLETED session, got ${String(detail.data.status)}`);
  }
}

void runMainChain();
