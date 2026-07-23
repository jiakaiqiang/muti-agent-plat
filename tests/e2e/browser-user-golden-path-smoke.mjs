import {
  api,
  buildServer,
  listEvents,
  waitForEvent,
  waitForStatus
} from './smoke-server.mjs';
import {
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

const requirementText =
  'Create the requested implementation artifacts, validate the result, and write the reviewed files to the selected workspace.';

function installMemoryDirectoryPicker(page) {
  return page.addInitScript(
    ({ initialFiles, rootName }) => {
      class MemoryFileHandle {
        constructor(name, entry) {
          this.kind = 'file';
          this.name = name;
          this.entry = entry;
        }

        async getFile() {
          return new File([this.entry.content], this.name, {
            type: 'text/plain',
            lastModified: this.entry.lastModified
          });
        }

        async createWritable() {
          let nextContent = this.entry.content;
          return {
            write: async (value) => {
              if (value instanceof Blob) {
                nextContent = await value.text();
              } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                const bytes = value instanceof ArrayBuffer
                  ? new Uint8Array(value)
                  : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                nextContent = new TextDecoder().decode(bytes);
              } else {
                nextContent = String(value);
              }
            },
            close: async () => {
              this.entry.content = nextContent;
              this.entry.lastModified = Date.now();
            }
          };
        }

        async queryPermission() {
          return 'granted';
        }

        async requestPermission() {
          return 'granted';
        }
      }

      class MemoryDirectoryHandle {
        constructor(name) {
          this.kind = 'directory';
          this.name = name;
          this.children = new Map();
        }

        async *entries() {
          for (const entry of this.children.entries()) yield entry;
        }

        async *values() {
          for (const value of this.children.values()) yield value;
        }

        async getDirectoryHandle(name, options = {}) {
          const current = this.children.get(name);
          if (current?.kind === 'directory') return current;
          if (current || !options.create) throw new DOMException(`Directory not found: ${name}`, 'NotFoundError');
          const created = new MemoryDirectoryHandle(name);
          this.children.set(name, created);
          return created;
        }

        async getFileHandle(name, options = {}) {
          const current = this.children.get(name);
          if (current?.kind === 'file') return current;
          if (current || !options.create) throw new DOMException(`File not found: ${name}`, 'NotFoundError');
          const created = new MemoryFileHandle(name, { content: '', lastModified: Date.now() });
          this.children.set(name, created);
          return created;
        }

        async removeEntry(name) {
          if (!this.children.delete(name)) throw new DOMException(`Entry not found: ${name}`, 'NotFoundError');
        }

        async queryPermission() {
          return 'granted';
        }

        async requestPermission() {
          return 'granted';
        }
      }

      const root = new MemoryDirectoryHandle(rootName);

      const directoryAt = async (parts, create) => {
        let current = root;
        for (const part of parts) current = await current.getDirectoryHandle(part, { create });
        return current;
      };

      const seedFile = async (path, content) => {
        const parts = path.split('/');
        const name = parts.pop();
        const directory = await directoryAt(parts, true);
        const file = await directory.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        await writable.write(content);
        await writable.close();
      };

      const readFile = async (path) => {
        const parts = path.split('/').filter(Boolean);
        const name = parts.pop();
        const directory = await directoryAt(parts, false);
        return (await (await directory.getFileHandle(name)).getFile()).text();
      };

      const listFiles = async () => {
        const paths = [];
        const visit = async (directory, prefix) => {
          for await (const [name, entry] of directory.entries()) {
            const path = prefix ? `${prefix}/${name}` : name;
            if (entry.kind === 'directory') await visit(entry, path);
            else paths.push(path);
          }
        };
        await visit(root, '');
        return paths.sort();
      };

      window.showDirectoryPicker = async () => root;
      window.__goldenPathWorkspace = { readFile, listFiles };
      window.__goldenPathReady = Promise.all(
        Object.entries(initialFiles).map(([path, content]) => seedFile(path, content))
      );
    },
    {
      rootName: 'golden-path-workspace',
      initialFiles: {
        'README.md': '# Golden Path Workspace\n',
        'package.json': '{"name":"golden-path-workspace","scripts":{"test":"node --test"}}',
        'src/index.ts': 'export const goldenPathMarker = true;\n'
      }
    }
  );
}

async function waitForCreatedSession(apiBase, existingSessionIds) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await api(apiBase, '/sessions');
    const session = response.data.items.find((item) => !existingSessionIds.has(item.id));
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the session created through the browser.');
}

async function waitForSessionStatus(apiBase, sessionId, expectedStatuses, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const response = await api(apiBase, `/sessions/${sessionId}`);
    lastStatus = response.data.status;
    if (expectedStatuses.has(lastStatus)) return lastStatus;
    if (['FAILED', 'CANCELLED'].includes(lastStatus)) {
      throw new Error(`Session reached terminal status ${lastStatus} before delivery.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${[...expectedStatuses].join(' or ')}, last=${lastStatus}.`);
}

function requireEvent(events, type, predicate = () => true) {
  const event = events.find((item) => item.type === type && predicate(item));
  if (!event) throw new Error(`Required event was not emitted: ${type}`);
  return event;
}

await buildServer();
let handle;
let activeSessionId;

try {
  handle = await startBrowserSmokeServer('browser-user-golden-path', {
    DISCUSSION_MAX_ROUNDS: '1',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  const { server, webPort } = handle;
  const existingSessions = await api(server.apiBase, '/sessions');
  const existingSessionIds = new Set(existingSessions.data.items.map((session) => session.id));
  const agentsResponse = await api(server.apiBase, '/agents');
  const selectedAgentNames = agentsResponse.data.map((agent) => agent.name);
  if (selectedAgentNames.length < 3) throw new Error('Golden path requires at least three selectable Agents.');

  Object.assign(handle, await startBrowserPage(server.apiBase, webPort));
  const { page, web } = handle;
  await installMemoryDirectoryPicker(page);
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__goldenPathReady);

  await page.getByRole('button', { name: '新建会话' }).click();
  const createDialog = page.getByRole('region', { name: '新建会话' });
  await createDialog.getByPlaceholder('描述要让 Agent 协作完成的目标').fill(requirementText);
  await createDialog.getByRole('button', { name: '选择目录' }).click();
  await createDialog.getByText('golden-path-workspace', { exact: true }).waitFor({ state: 'visible' });

  for (const agentName of selectedAgentNames) {
    await createDialog.locator('.dialog-agent-picker button').filter({ hasText: agentName }).click();
  }
  await createDialog.getByRole('button', { name: '保存', exact: true }).click();
  const saveConfirmation = page.getByRole('region', { name: '确认保存会话' });
  await saveConfirmation.getByRole('button', { name: '确认保存', exact: true }).click();

  const createdSession = await waitForCreatedSession(server.apiBase, existingSessionIds);
  const sessionId = createdSession.id;
  activeSessionId = sessionId;
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_CONFIRM', 90_000);

  let events = await listEvents(server.apiBase, sessionId);
  requireEvent(events, 'agent_message', (event) => Number(event.metadata.payload?.round) >= 1);
  const discussionAgentIds = new Set(
    events
      .filter((event) => event.type === 'agent_message' && Number(event.metadata.payload?.round) >= 1)
      .map((event) => event.fromAgentId)
      .filter(Boolean)
  );
  if (discussionAgentIds.size < 2) throw new Error('Discussion must include contributions from multiple Agents.');
  requireEvent(events, 'brief_created');
  requireEvent(events, 'user_confirmation_requested', (event) => event.metadata.payload?.reason === 'confirm_task_brief');

  await page.locator('.collaboration-task-board').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.task-board-collapse-button').click();
  await page.getByText('讨论证据', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('任务拆解', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('.confirmation-card__actions .action-button.primary').first().click();

  await waitForEvent(server.apiBase, sessionId, 'task_created', 30_000);
  await waitForEvent(server.apiBase, sessionId, 'post_review_completed', 30_000);
  const postReviewStatus = await waitForSessionStatus(
    server.apiBase,
    sessionId,
    new Set(['WAIT_USER_DECISION', 'COMPLETED'])
  );
  if (postReviewStatus === 'WAIT_USER_DECISION') {
    events = await listEvents(server.apiBase, sessionId);
    requireEvent(
      events,
      'user_confirmation_requested',
      (event) =>
        event.metadata.payload?.reason === 'coordinator_routing_needs_user_decision' &&
        event.metadata.payload?.actions?.some((action) => action.action === 'deliver_with_limitations')
    );
    const limitedDeliveryButton = page.locator('[data-action="deliver_with_limitations"]');
    await limitedDeliveryButton.waitFor({ state: 'visible', timeout: 20_000 });
    await limitedDeliveryButton.click();
  }
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);
  events = await listEvents(server.apiBase, sessionId);
  const createdTasks = events.filter((event) => event.type === 'task_created');
  if (!createdTasks.length) throw new Error('The confirmed Brief did not produce executable tasks.');
  requireEvent(events, 'post_review_completed');
  requireEvent(events, 'final_delivery_created');

  const writebackButton = page.locator('.workspace-file-apply-button');
  await writebackButton.waitFor({ state: 'visible', timeout: 30_000 });
  await writebackButton.click();
  const reviewDialog = page.getByRole('region', { name: '文件写回审阅' });
  await reviewDialog.getByRole('heading', { name: '审阅文件写回' }).waitFor({ state: 'visible' });
  const reviewedPath = (await reviewDialog.locator('li strong').first().innerText()).trim();
  const diff = await reviewDialog.locator('li pre').first().innerText();
  if (!diff.includes('+ ')) throw new Error(`Writeback review did not expose an added diff for ${reviewedPath}.`);

  const confirmWrite = reviewDialog.getByRole('button', { name: /^写入 \d+ 项$/ });
  await confirmWrite.click();
  await reviewDialog.waitFor({ state: 'hidden', timeout: 20_000 });

  const writtenContent = await page.evaluate(
    (path) => window.__goldenPathWorkspace.readFile(path),
    reviewedPath
  );
  if (!writtenContent.trim()) throw new Error(`Reviewed file was not written: ${reviewedPath}`);
  const writtenFiles = await page.evaluate(() => window.__goldenPathWorkspace.listFiles());
  if (!writtenFiles.includes(reviewedPath)) throw new Error(`Written file is missing from the workspace: ${reviewedPath}`);

  console.log(
    `browser user golden path smoke ok: session=${sessionId}, tasks=${createdTasks.length}, written=${reviewedPath}`
  );
} catch (error) {
  if (handle?.server?.apiBase && activeSessionId) {
    const session = await api(handle.server.apiBase, `/sessions/${activeSessionId}`).catch(() => undefined);
    const diagnosticEvents = await listEvents(handle.server.apiBase, activeSessionId).catch(() => []);
    console.error(
      'browser user golden path diagnostics:',
      JSON.stringify(
        {
          status: session?.data?.status,
          events: diagnosticEvents.slice(-20).map((event) => ({
            type: event.type,
            taskId: event.taskId,
            content: event.content,
            payload: event.metadata?.payload
          }))
        },
        null,
        2
      )
    );
  }
  throw error;
} finally {
  if (handle) await stopBrowserCollaborationSmoke(handle);
}
