import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  RuntimeArtifactOutput,
  RuntimeFileChange,
  RuntimeOutput,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.yml', '.yaml', '.txt']);
const configFileNames = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'nest-cli.json']);
const maxSnapshotFiles = 500;
const maxSnapshotFileBytes = 200_000;

@Injectable()
export class ClaudeCodeRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'claude_code' as const;

  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    if (process.env.CLAUDE_CODE_ENABLED !== 'true') {
      return this.blockedResult(input, 'Claude Code runtime is disabled. Set CLAUDE_CODE_ENABLED=true to run controlled local coding agents.');
    }

    const rootPath = input.contextPack.workingDirectory?.kind === 'server_local'
      ? input.contextPack.workingDirectory.path
      : undefined;
    if (!rootPath) {
      return this.blockedResult(input, 'Claude Code runtime requires a server_local working directory.');
    }

    const command = process.env.CLAUDE_CODE_COMMAND ?? 'claude';
    const timeout = Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 120_000);
    const prompt = this.prompt(input);
    const promptFilePath = await this.writePromptFileIfConfigured(input, prompt);
    try {
      const beforeFiles = await this.snapshotTextFiles(rootPath);
      const { stdout, stderr } = await execFileAsync(
        command,
        [
          '-p',
          '--output-format',
          'json',
          '--permission-mode',
          process.env.CLAUDE_CODE_PERMISSION_MODE ?? 'acceptEdits',
          '--add-dir',
          rootPath,
          '--allowedTools',
          process.env.CLAUDE_CODE_ALLOWED_TOOLS ?? 'Read,Edit,MultiEdit,Write,Bash(npm test*),Bash(npm run test*)',
          promptFilePath ?? prompt
        ],
        {
          cwd: rootPath,
          timeout,
          shell: this.useShell(),
          signal,
          env: this.runtimeEnv(input, promptFilePath),
          maxBuffer: Number(process.env.CLAUDE_CODE_MAX_BUFFER ?? 8 * 1024 * 1024)
        }
      );
      const parsedOutput = this.parseOutput(stdout);
      const actualFileChanges = await this.actualFileChanges(rootPath, beforeFiles);
      const testArtifact = await this.runConfiguredTests(rootPath, signal);
      const output = this.withRuntimeEvidence(parsedOutput, actualFileChanges, testArtifact);
      return {
        runId: input.runId,
        runtimeType: this.type,
        status: 'completed',
        output,
        events: [
          {
            runId: input.runId,
            type: 'runtime_completed',
            content: `${input.agent.name} completed ${input.phase} with Claude Code.`,
            metadata: { stderr: stderr.trim() || undefined },
            createdAt: nowIso()
          }
        ],
        artifacts: this.outputArtifacts(output),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'claude_code'
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        runId: input.runId,
        runtimeType: this.type,
        status: signal?.aborted ? 'cancelled' : 'failed',
        output: {
          kind: 'agent_message',
          messageKind: 'risk',
          content: `${input.agent.name} Claude Code runtime failed: ${message}`
        },
        events: [
          {
            runId: input.runId,
            type: 'runtime_failed',
            content: `${input.agent.name} Claude Code runtime failed.`,
            metadata: { message },
            createdAt: nowIso()
          }
        ],
        artifacts: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'claude_code'
        },
        error: {
          code: signal?.aborted ? 'RUNTIME_CANCELLED' : 'MODEL_ERROR',
          message,
          retryable: !signal?.aborted
        }
      };
    } finally {
      if (promptFilePath) {
        await rm(promptFilePath, { force: true });
      }
    }
  }

  private prompt(input: AgentRunInput) {
    return [
      'You are running as an Agent Cluster coding runtime.',
      'Work inside the allowed server_local directory only.',
      'Return one JSON object and no markdown fences.',
      `Required output kind: ${input.expectedOutput.kind}.`,
      'Follow taskContext.stagePlan: read only the listed evidence/map refs first, do the listed stage actions, and report validation against the listed validate items.',
      'Use taskContext.evidenceSelection.selectedRefs and taskContext.evidenceRefs as the selected minimal evidence set; omittedRefs are intentionally excluded unless you ask for more evidence.',
      'Use workspaceManifest only for workspace structure and file metadata. Use selectedEvidenceContents for readable file/log/artifact content. workspaceSnapshot is a manifest-style fallback and may omit all file contents.',
      'If selected evidence is insufficient, return a blocked task_execution_result or runtime error with code CONTEXT_INSUFFICIENT and requestedContext; do not fabricate unread file contents, APIs, logs, or test results.',
      'Use continuationState to resume or hand off work consistently across phases, agents, pauses, validation, review, and final delivery.',
      'For task_claim_decision, decide whether this agent should accept the currentTask. Return accepted, reason, optional confidence, optional alternativeAgentKeys/alternativeAgentIds, and optional agentMessages for handoff or coordination.',
      'For task_execution_result, include changedArtifacts with metadata.fileChanges for every file you changed or propose to change.',
      'For validation task_execution_result, include a test_report changedArtifact with metadata.validationEvidence mapping each taskContext.validationRules item to verdict status, evidenceRefs, notes, and missingEvidence, plus validatorAgentKey, validatorAgentId, and independentFromAgentKeys from taskContext.agentResponsibilities.',
      'For task_execution_result, include optional agentMessages when you need to communicate progress, risks, questions, or handoffs to other agents. Use targetAgentKeys such as coordinator, frontend, backend, test, review.',
      'If you run tests, include the test result summary in completedItems or risks.',
      '',
      'Runtime input JSON:',
      JSON.stringify(
        {
          phase: input.phase,
          agent: input.agent,
          sessionGoal: input.contextPack.sessionGoal,
          taskBrief: input.contextPack.taskBrief,
          currentTask: input.contextPack.currentTask,
          taskContext: input.contextPack.taskContext,
          projectMap: input.contextPack.projectMap,
          continuationState: input.contextPack.continuationState,
          workspaceFocus: input.contextPack.workspaceFocus,
          workspaceManifest: input.contextPack.workspaceManifest,
          selectedEvidenceContents: input.contextPack.selectedEvidenceContents,
          relevantEvents: input.contextPack.relevantEvents,
          relevantMemories: input.contextPack.relevantMemories,
          ragSnippets: input.contextPack.ragSnippets,
          artifacts: input.contextPack.artifacts,
          constraints: input.contextPack.constraints,
          expectedOutput: input.expectedOutput
        },
        null,
        2
      )
    ].join('\n');
  }

  private async writePromptFileIfConfigured(input: AgentRunInput, prompt: string) {
    if (process.env.CLAUDE_CODE_PROMPT_MODE !== 'file') {
      return undefined;
    }
    const promptFilePath = join(tmpdir(), `agent-cluster-claude-${input.runId}.prompt.txt`);
    await writeFile(promptFilePath, prompt, 'utf8');
    return promptFilePath;
  }

  private useShell() {
    const configured = process.env.CLAUDE_CODE_SHELL?.trim();
    if (configured) {
      return configured === 'true';
    }
    return process.platform === 'win32';
  }

  private runtimeEnv(input: AgentRunInput, promptFilePath?: string) {
    return {
      ...process.env,
      AGENT_CLUSTER_RUNTIME_TYPE: this.type,
      AGENT_CLUSTER_RUNTIME_PHASE: input.phase,
      AGENT_CLUSTER_SESSION_ID: input.sessionId,
      AGENT_CLUSTER_TASK_ID: input.taskId ?? '',
      AGENT_CLUSTER_AGENT_ID: input.agent.id,
      AGENT_CLUSTER_AGENT_KEY: input.agent.key,
      AGENT_CLUSTER_EXPECTED_OUTPUT_KIND: input.expectedOutput.kind,
      AGENT_CLUSTER_PROMPT_FILE: promptFilePath
    };
  }

  private parseOutput(stdout: string): RuntimeOutput {
    const parsed = JSON.parse(stdout.trim());
    const candidate = typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed;
    if (!candidate || typeof candidate.kind !== 'string') {
      throw new Error('Claude Code output did not contain a RuntimeOutput kind.');
    }
    return candidate as RuntimeOutput;
  }

  private outputArtifacts(output: RuntimeOutput) {
    return output.kind === 'task_execution_result' ? output.changedArtifacts : [];
  }

  private evidenceArtifacts(actualFileChanges: RuntimeFileChange[], testArtifact?: RuntimeArtifactOutput) {
    const actualChangeArtifact: RuntimeArtifactOutput | undefined = actualFileChanges.length
      ? {
          type: 'code_diff',
          title: 'Claude Code 实际文件变更',
          summary: `捕获 ${actualFileChanges.length} 个真实落盘文件变更。`,
          metadata: {
            source: 'claude_code_filesystem_snapshot',
            fileChanges: actualFileChanges
          }
        }
      : undefined;
    return [
      ...(actualChangeArtifact ? [actualChangeArtifact] : []),
      ...(testArtifact ? [testArtifact] : [])
    ];
  }

  private withRuntimeEvidence(
    output: RuntimeOutput,
    actualFileChanges: RuntimeFileChange[],
    testArtifact?: RuntimeArtifactOutput
  ): RuntimeOutput {
    if (output.kind !== 'task_execution_result') {
      return output;
    }
    const evidenceItems = [
      ...output.completedItems,
      ...(actualFileChanges.length ? [`捕获 ${actualFileChanges.length} 个真实文件变更。`] : []),
      ...(testArtifact?.summary ? [`测试结果：${testArtifact.summary}`] : [])
    ];
    return {
      ...output,
      completedItems: evidenceItems,
      changedArtifacts: [...output.changedArtifacts, ...this.evidenceArtifacts(actualFileChanges, testArtifact)]
    } satisfies TaskExecutionResultOutput;
  }

  private async snapshotTextFiles(rootPath: string) {
    const files = new Map<string, string>();

    const scan = async (currentPath: string) => {
      if (files.size >= maxSnapshotFiles) {
        return;
      }
      const entries = await readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.size >= maxSnapshotFiles) {
          return;
        }
        const absolutePath = join(currentPath, entry.name);
        const path = relative(rootPath, absolutePath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) {
            await scan(absolutePath);
          }
          continue;
        }
        if (!this.shouldReadTextFile(path)) {
          continue;
        }
        const fileStat = await stat(absolutePath);
        if (fileStat.size > maxSnapshotFileBytes) {
          continue;
        }
        files.set(path, await readFile(absolutePath, 'utf8'));
      }
    };

    await scan(rootPath);
    return files;
  }

  private async actualFileChanges(rootPath: string, beforeFiles: Map<string, string>): Promise<RuntimeFileChange[]> {
    const afterFiles = await this.snapshotTextFiles(rootPath);
    const changes: RuntimeFileChange[] = [];

    for (const [path, beforeContent] of beforeFiles.entries()) {
      if (!afterFiles.has(path)) {
        changes.push({
          path,
          operation: 'delete',
          previousContent: beforeContent,
          encoding: 'utf-8',
          source: 'actual_filesystem_snapshot'
        });
        continue;
      }
      const afterContent = afterFiles.get(path);
      if (afterContent !== beforeContent) {
        changes.push({
          path,
          operation: 'update',
          previousContent: beforeContent,
          content: afterContent,
          encoding: 'utf-8',
          source: 'actual_filesystem_snapshot'
        });
      }
    }

    for (const [path, afterContent] of afterFiles.entries()) {
      if (!beforeFiles.has(path)) {
        changes.push({
          path,
          operation: 'create',
          previousContent: null,
          content: afterContent,
          encoding: 'utf-8',
          source: 'actual_filesystem_snapshot'
        });
      }
    }

    return changes;
  }

  private async runConfiguredTests(rootPath: string, signal?: AbortSignal): Promise<RuntimeArtifactOutput | undefined> {
    const testCommand = process.env.CLAUDE_CODE_TEST_COMMAND?.trim();
    if (!testCommand) {
      return undefined;
    }
    try {
      const { stdout, stderr } = await execFileAsync(testCommand, {
        cwd: rootPath,
        shell: true,
        signal,
        timeout: Number(process.env.CLAUDE_CODE_TEST_TIMEOUT_MS ?? 120_000),
        maxBuffer: Number(process.env.CLAUDE_CODE_MAX_BUFFER ?? 8 * 1024 * 1024)
      });
      const content = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return {
        type: 'test_report',
        title: 'Claude Code 测试结果',
        content,
        summary: '测试命令执行成功。',
        metadata: {
          command: testCommand,
          status: 'completed'
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        type: 'test_report',
        title: 'Claude Code 测试结果',
        content: message,
        summary: `测试命令失败：${message}`,
        metadata: {
          command: testCommand,
          status: 'failed',
          message
        }
      };
    }
  }

  private shouldReadTextFile(path: string) {
    const name = path.split('/').at(-1) ?? path;
    return configFileNames.has(name) || textExtensions.has(extname(path).toLowerCase());
  }

  private blockedResult(input: AgentRunInput, message: string): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: this.type,
      status: 'blocked',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: message
      },
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: message,
          metadata: { code: 'CAPABILITY_BLOCKED', message },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'claude_code'
      },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message,
        retryable: false
      }
    };
  }
}
