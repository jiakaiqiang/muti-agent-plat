import { Injectable } from '@nestjs/common';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  FinalDeliveryOutput,
  AgentMessageOutput,
  PostReviewReportOutput,
  RuntimeUsage,
  RuntimeOutput,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlanOutput,
  RuntimeFileChange
} from '@agent-cluster/shared';
import { mockRuntimeEnabled } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { estimateTokens } from '../../common/token.js';

@Injectable()
export class MockRuntimeService implements AgentRuntimeAdapter {
  readonly type = 'mock' as const;

  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    if (!mockRuntimeEnabled() && input.options?.allowMockFallback !== true) {
      return this.disabledResult(input);
    }

    if (signal?.aborted) {
      return this.cancelledResult(input);
    }

    const delayed = await this.optionalDelay(signal);
    if (!delayed) {
      return this.cancelledResult(input);
    }

    if (input.options?.scenario === 'task_failed') {
      return {
        runId: input.runId,
        runtimeType: 'mock',
        status: 'failed',
        output: {
          kind: 'agent_message',
          messageKind: 'risk',
          content: `${input.agent.name} failed ${input.phase}.`
        } satisfies AgentMessageOutput,
        events: [
          {
            runId: input.runId,
            type: 'runtime_started',
            content: `${input.agent.name} started ${input.phase}`,
            createdAt: nowIso()
          },
          {
            runId: input.runId,
            type: 'runtime_failed',
            content: `${input.agent.name} failed ${input.phase}`,
            metadata: { code: 'MODEL_ERROR' },
            createdAt: nowIso()
          }
        ],
        artifacts: [],
        usage: {
          ...this.usageFor(input),
          model: 'mock'
        },
        error: {
          code: 'MODEL_ERROR',
          message: 'Mock runtime failure scenario: task_failed',
          retryable: true,
          details: {
            scenario: 'task_failed',
            phase: input.phase
          }
        }
      };
    }

    const output = this.applyReviewRecommendationOverride(this.outputFor(input));
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'completed',
      output,
      events: [
        {
          runId: input.runId,
          type: 'runtime_started',
          content: `${input.agent.name} started ${input.phase}`,
          createdAt: nowIso()
        },
        {
          runId: input.runId,
          type: 'runtime_completed',
          content: `${input.agent.name} completed ${input.phase}`,
          createdAt: nowIso()
        }
      ],
      artifacts: output.kind === 'final_delivery' ? [] : [],
      usage: {
        ...this.usageFor(input, output),
        model: 'mock'
      }
    };
  }

  /** Test hook: MOCK_REVIEW_RECOMMENDATION=rework|ask_user forces the mock post-review verdict. */
  private applyReviewRecommendationOverride(output: RuntimeOutput): RuntimeOutput {
    const override = process.env.MOCK_REVIEW_RECOMMENDATION?.trim();
    if (!override || output.kind !== 'post_review_report') {
      return output;
    }
    if (override !== 'rework' && override !== 'ask_user') {
      return output;
    }
    return {
      ...output,
      isConsistentWithBrief: false,
      mismatchedItems: output.mismatchedItems.length ? output.mismatchedItems : ['模拟复盘发现执行结果与契约不一致。'],
      recommendation: override
    };
  }

  private async optionalDelay(signal?: AbortSignal) {    const delayMs = Number(process.env.MOCK_RUNTIME_DELAY_MS ?? 0);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return true;
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => resolve(true), delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        { once: true }
      );
    });
  }

  private disabledResult(input: AgentRunInput): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `${input.agent.name} mock runtime is disabled.`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} mock runtime is disabled`,
          metadata: { code: 'RUNTIME_DISABLED' },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'mock'
      },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message: 'Mock runtime is disabled. Set MOCK_RUNTIME_ENABLED=true to enable explicit local mock mode.',
        retryable: false
      }
    };
  }

  private cancelledResult(input: AgentRunInput): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `${input.agent.name} mock runtime was cancelled.`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} mock runtime was cancelled`,
          metadata: { code: 'RUNTIME_CANCELLED' },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'mock'
      },
      error: {
        code: 'RUNTIME_CANCELLED',
        message: 'Runtime request cancelled by user.',
        retryable: false
      }
    };
  }

  private outputFor(input: AgentRunInput): RuntimeOutput {
    return this.requirementAwareOutputFor(input);
  }

  private requirementAwareOutputFor(input: AgentRunInput): RuntimeOutput {
    const goal = this.goal(input);
    const isArchitectureAnalysis = this.isArchitectureAnalysisRequest(goal);
    const taskTitle = input.contextPack.currentTask?.title ?? goal;
    const taskDescription = input.contextPack.currentTask?.description ?? `Handle the user requirement: ${goal}`;
    const acceptanceCriteria = input.contextPack.currentTask?.acceptanceCriteria?.length
      ? input.contextPack.currentTask.acceptanceCriteria
      : input.contextPack.taskBrief?.acceptanceCriteria?.length
        ? input.contextPack.taskBrief.acceptanceCriteria
        : ['The output directly addresses the user requirement.', 'The result can be reviewed by the user.'];

    switch (input.expectedOutput.kind) {
      case 'task_brief':
        if (isArchitectureAnalysis) {
          return this.architectureAnalysisBrief(input, goal);
        }
        return {
          kind: 'task_brief',
          goal,
          scope: [
            `Clarify and decompose the user requirement: ${goal}`,
            'Coordinate the selected agents to produce stage artifacts.',
            'Generate concrete file changes for the selected local directory when applicable.'
          ],
          outOfScope: ['Do not publish, deploy, or call external systems without explicit user confirmation.'],
          constraints: [
            'Keep file changes inside the selected working directory.',
            'Make every stage output traceable to the original user requirement.'
          ],
          acceptanceCriteria: [
            `All workflow stage outputs reference the user requirement: ${goal}`,
            'Artifact events include concrete fileChanges when a local working directory is selected.',
            'The frontend shows file paths, operation types, and content previews.'
          ],
          risks: ['Mock runtime output is deterministic and should be replaced by a real coding runtime for production edits.'],
          openQuestions: [],
          suggestedTasks: [
            {
              title: `Implement requirement: ${this.shortText(goal, 60)}`,
              description: `Produce concrete artifacts and file changes for: ${goal}`,
              suggestedAgentKey: 'backend',
              acceptanceCriteria: ['Execution output is specific to the user requirement.', 'File changes are safe relative paths.']
            },
            {
              title: `Review requirement output: ${this.shortText(goal, 55)}`,
              description: `Check whether generated artifacts and file changes satisfy: ${goal}`,
              suggestedAgentKey: 'test',
              dependsOnTaskTitles: [`Implement requirement: ${this.shortText(goal, 60)}`],
              acceptanceCriteria: ['Review result compares actual output with the user requirement.']
            }
          ]
        } satisfies TaskBriefOutput;
      case 'task_execution_result':
        if (isArchitectureAnalysis) {
          return this.architectureAnalysisExecutionResult(input, goal);
        }
        return {
          kind: 'task_execution_result',
          status: 'completed',
          summary: `${input.agent.name} generated an execution artifact for the user requirement: ${goal}`,
          completedItems: [
            `Mapped task "${taskTitle}" back to the original requirement.`,
            `Prepared concrete file content for: ${goal}`,
            'Preserved reviewable completion notes, risks, and next actions.'
          ],
          changedArtifacts: [this.requirementAwareExecutionFileArtifact(input)],
          nextSuggestedActions: ['Inspect the generated file under agent-output.', 'Run the review stage against the same requirement.'],
          risks: []
        } satisfies TaskExecutionResultOutput;
      case 'post_review_report':
        if (isArchitectureAnalysis) {
          return {
            kind: 'post_review_report',
            isConsistentWithBrief: true,
            matchedItems: ['已围绕用户指定目录生成项目架构分析', '分析产物包含技术栈、目录职责、入口文件、重点文件和后续熟悉路径'],
            mismatchedItems: [],
            missingItems: [],
            outOfScopeChanges: [],
            testResults: ['项目架构分析产物检查通过'],
            recommendation: 'deliver'
          } satisfies PostReviewReportOutput;
        }
        return {
          kind: 'post_review_report',
          isConsistentWithBrief: true,
          matchedItems: [
            `The generated artifacts reference the original requirement: ${goal}`,
            'File changes use relative paths suitable for the selected local directory.',
            'Execution output can be inspected in the frontend artifact card.'
          ],
          mismatchedItems: [],
          missingItems: [],
          outOfScopeChanges: [],
          testResults: [`Mock review passed for requirement: ${goal}`],
          recommendation: 'deliver'
        } satisfies PostReviewReportOutput;
      case 'final_delivery':
        if (isArchitectureAnalysis) {
          return {
            kind: 'final_delivery',
            summary: `已完成项目架构分析：${goal}`,
            completedItems: ['生成工作区架构分析', '生成项目架构分析报告', '完成分析结果复核'],
            incompleteItems: [],
            risks: [],
            artifactRefs: []
          } satisfies FinalDeliveryOutput;
        }
        return {
          kind: 'final_delivery',
          summary: `Completed the multi-agent workflow for: ${goal}`,
          completedItems: [
            `Created a requirement brief for: ${goal}`,
            `Generated execution artifacts for task: ${taskTitle}`,
            'Completed review and final delivery artifacts.'
          ],
          incompleteItems: ['Use a real coding runtime for exact repository file edits beyond mock artifact generation.'],
          risks: [],
          artifactRefs: []
        } satisfies FinalDeliveryOutput;
      case 'user_message_handling_plan':
        return {
          kind: 'user_message_handling_plan',
          intent: 'constraint',
          priority: 'high',
          shouldPause: true,
          affectedTaskIds: input.taskId ? [input.taskId] : [],
          affectedAgentIds: [input.agent.id],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: `Apply the user's latest message to the current requirement context: ${goal}`
        } satisfies UserMessageHandlingPlanOutput;
      default:
        return {
          kind: 'agent_message',
          messageKind: 'discussion',
          content: [
            `${input.agent.name} reviewed the requirement from the ${input.phase} stage.`,
            `User requirement: ${goal}`,
            `Agent focus: ${input.agent.role}.`,
            input.contextPack.currentTask ? `Related task: ${taskTitle}. ${taskDescription}` : 'No concrete execution task is bound yet.',
            `Recommendation: keep the next output tied to "${this.shortText(goal, 80)}" and include concrete artifact/file evidence.`,
            `Acceptance focus: ${acceptanceCriteria.join('; ')}`
          ].join('\n')
        } satisfies AgentMessageOutput;
    }
  }

  private architectureAnalysisBrief(input: AgentRunInput, goal: string): TaskBriefOutput {
    const workspace = input.contextPack.workspaceSnapshot;
    return {
      kind: 'task_brief',
      goal: `分析并熟悉项目架构：${workspace?.rootName ?? goal}`,
      scope: [
        '读取用户指定目录的工作区快照。',
        '分析项目技术栈、目录职责、入口文件、关键配置和核心模块。',
        '输出中文项目架构分析报告，帮助用户快速熟悉项目。'
      ],
      outOfScope: ['不修改项目源码。', '不发布、部署或调用外部系统。'],
      constraints: ['所有阶段产物必须围绕项目架构分析。', '所有用户可见产物必须使用中文。'],
      acceptanceCriteria: [
        '产物包含项目结构、技术栈、入口文件、核心目录、重点文件和建议阅读路径。',
        '产物引用用户指定的目录或工作区名称。',
        '产物以 fileChanges 形式生成到 agent-output/，方便写入用户选择的目录。'
      ],
      risks: workspace ? [] : ['没有读取到工作区快照，分析可能不完整。'],
      openQuestions: [],
      suggestedTasks: [
        {
          title: '生成项目架构分析报告',
          description: `基于工作区快照分析项目架构：${goal}`,
          suggestedAgentKey: 'architect',
          acceptanceCriteria: ['报告包含技术栈、目录职责、入口文件、重点文件和熟悉路径。']
        },
        {
          title: '复核项目架构分析完整性',
          description: '检查架构分析报告是否覆盖用户指定目录和核心项目结构。',
          suggestedAgentKey: 'review',
          dependsOnTaskTitles: ['生成项目架构分析报告'],
          acceptanceCriteria: ['复核结论指出报告是否足够帮助用户熟悉项目。']
        }
      ]
    };
  }

  private architectureAnalysisExecutionResult(input: AgentRunInput, goal: string): TaskExecutionResultOutput {
    const artifact = this.architectureAnalysisArtifact(input, goal);
    return {
      kind: 'task_execution_result',
      status: 'completed',
      summary: `已生成项目架构分析报告：${input.contextPack.workspaceSnapshot?.rootName ?? goal}`,
      completedItems: ['分析工作区目录结构', '识别项目技术栈和入口文件', '生成中文项目架构分析报告'],
      changedArtifacts: [artifact],
      nextSuggestedActions: ['阅读 agent-output/project-architecture-analysis.md', '按报告中的建议阅读路径逐步熟悉项目'],
      risks: input.contextPack.workspaceSnapshot ? [] : ['缺少工作区快照，报告仅能基于用户文字描述。']
    };
  }

  private architectureAnalysisArtifact(input: AgentRunInput, goal: string) {
    const report = this.buildArchitectureAnalysisReport(input, goal);
    return {
      type: 'markdown',
      title: '项目架构分析报告',
      content: report.content,
      summary: report.summary,
      metadata: {
        phase: 'project_architecture_analysis',
        reportKind: 'project_architecture_analysis',
        primaryReportPath: 'agent-output/project-architecture-analysis.md',
        fileChanges: [
          {
            path: 'agent-output/project-architecture-analysis.md',
            operation: 'create',
            content: report.content,
            encoding: 'utf-8'
          }
        ]
      }
    } satisfies import('@agent-cluster/shared').RuntimeArtifactOutput;
  }

  private buildArchitectureAnalysisReport(input: AgentRunInput, goal: string) {
    const snapshot = input.contextPack.workspaceSnapshot;
    const focus = input.contextPack.workspaceFocus;
    const topDirectories = this.topDirectoriesFromSnapshot(input);
    const importantFiles = [...new Set([...(focus?.relevantFiles ?? []), ...(snapshot?.entrypoints ?? [])])].slice(0, 12);
    const packageFile = snapshot?.files.find((file) => file.path.endsWith('package.json'));
    const packageInfo = this.packageJsonInsights(packageFile?.content);
    const configFiles = this.filesByName(input, [
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'tsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'nest-cli.json'
    ]);
    const sourceFiles = snapshot?.files
      .filter((file) => /^(src|apps|packages)\//.test(file.path))
      .map((file) => file.path)
      .slice(0, 16) ?? [];
    const content = [
      '# 项目架构分析报告',
      '',
      `用户需求：${goal}`,
      `项目目录：${snapshot?.rootName ?? '未识别'}`,
      '',
      '## 总体结论',
      snapshot
        ? `该项目共扫描 ${snapshot.fileCount} 个条目，读取 ${snapshot.files.length} 个文本文件，识别技术栈：${snapshot.detectedStack?.join('、') || '未识别'}。`
        : '当前没有读取到工作区快照，无法给出完整项目结构判断。',
      packageInfo.description ? `项目定位：${packageInfo.description}` : '项目定位：未在 README 或 package.json 中识别到明确描述，需要继续阅读业务入口确认。',
      '',
      '## 技术栈',
      ...(snapshot?.detectedStack?.length ? snapshot.detectedStack.map((item) => `- ${item}`) : ['- 未识别']),
      ...packageInfo.dependencies.map((item) => `- package.json 依赖：${item}`),
      '',
      '## 运行脚本',
      ...(packageInfo.scripts.length ? packageInfo.scripts.map((item) => `- ${item}`) : ['- 未在 package.json 中识别到 scripts。']),
      '',
      '## 入口文件',
      ...(snapshot?.entrypoints?.length ? snapshot.entrypoints.map((item) => `- ${item}`) : ['- 未识别']),
      '',
      '## 核心目录',
      ...(topDirectories.length ? topDirectories.map((item) => `- ${item}`) : ['- 暂无目录统计']),
      '',
      '## 源码结构线索',
      ...(sourceFiles.length ? sourceFiles.map((item) => `- ${item}`) : ['- 暂未读取到 src/apps/packages 下的源码文件。']),
      '',
      '## 重点文件',
      ...(importantFiles.length ? importantFiles.map((item) => `- ${item}`) : ['- 暂无重点文件']),
      '',
      '## 配置与说明文件',
      ...(configFiles.length ? configFiles.map((item) => `- ${item}`) : ['- 暂未识别到 README、AGENTS、CLAUDE 或构建配置文件。']),
      '',
      '## 建议熟悉路径',
      '- 先阅读 README、AGENTS/CLAUDE 等项目说明文件。',
      '- 再阅读 package.json、tsconfig、vite/nest 等配置文件，确认技术栈和启动方式。',
      '- 接着从入口文件进入应用主链路。',
      '- 最后按业务模块目录逐步阅读组件、服务、状态管理和测试用例。',
      '',
      '## 本次分析产物',
      '- agent-output/workspace-analysis.md：工作区扫描与影响面分析。',
      '- agent-output/project-architecture-analysis.md：面向用户熟悉项目的中文架构分析报告。',
      '',
      '## 复核提示',
      '- 如果需要更深入分析，可以继续指定某个目录或模块，我会基于该目录继续拆解。'
    ].join('\n');
    return {
      content,
      summary: `已生成 ${snapshot?.rootName ?? '项目'} 的架构分析报告`
    };
  }

  private packageJsonInsights(content?: string) {
    if (!content) {
      return { description: '', scripts: [] as string[], dependencies: [] as string[] };
    }
    try {
      const parsed = JSON.parse(content) as {
        name?: string;
        description?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dependencies = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
      return {
        description: [parsed.name ? `包名 ${parsed.name}` : '', parsed.description ?? ''].filter(Boolean).join('，'),
        scripts: Object.entries(parsed.scripts ?? {})
          .slice(0, 8)
          .map(([name, command]) => `${name}：${command}`),
        dependencies: Object.entries(dependencies)
          .filter(([name]) => ['vue', 'vite', '@nestjs/core', 'react', 'pinia', 'typescript', 'express'].includes(name))
          .map(([name, version]) => `${name}@${version}`)
      };
    } catch {
      return { description: 'package.json 存在但解析失败，需要人工检查 JSON 格式。', scripts: [] as string[], dependencies: [] as string[] };
    }
  }

  private filesByName(input: AgentRunInput, names: string[]) {
    const lowerNames = new Set(names.map((name) => name.toLowerCase()));
    return (
      input.contextPack.workspaceSnapshot?.files
        .map((file) => file.path)
        .filter((path) => lowerNames.has(path.split('/').at(-1)?.toLowerCase() ?? path.toLowerCase()))
        .slice(0, 12) ?? []
    );
  }

  private topDirectoriesFromSnapshot(input: AgentRunInput) {
    const counts = new Map<string, number>();
    for (const node of input.contextPack.workspaceSnapshot?.tree ?? []) {
      const top = node.path.split('/')[0];
      if (!top || top === node.path) continue;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([directory, count]) => `${directory}/（${count} 个条目）`);
  }

  private isArchitectureAnalysisRequest(goal: string) {
    return /架构|结构|目录|熟悉|分析项目|项目分析|了解项目/i.test(goal);
  }

  private legacyOutputFor(input: AgentRunInput): RuntimeOutput {
    switch (input.expectedOutput.kind) {
      case 'task_brief':
        return {
          kind: 'task_brief',
          goal: input.contextPack.sessionGoal,
          scope: ['基于 dry-run 验证多 Agent 协作闭环', '生成任务、执行事件、复盘和交付'],
          outOfScope: ['不真实修改文件', '不发送真实飞书消息'],
          constraints: ['保持执行非破坏性', '高风险操作必须等待用户确认'],
          acceptanceCriteria: ['生成任务契约', '用户确认后执行 dry-run', '复盘与契约一致'],
          risks: ['真实 Coding Runtime 尚未接入'],
          openQuestions: [],
          suggestedTasks: [
            {
              title: '执行 dry-run 实现任务',
              description: '模拟后端 Agent 执行已确认任务契约。',
              suggestedAgentKey: 'backend',
              acceptanceCriteria: ['生成 runtime_started 和 runtime_completed 事件']
            },
            {
              title: '验证 dry-run 结果',
              description: '模拟测试 Agent 验证任务结果。',
              suggestedAgentKey: 'test',
              dependsOnTaskTitles: ['执行 dry-run 实现任务'],
              acceptanceCriteria: ['生成测试结果摘要']
            }
          ]
        } satisfies TaskBriefOutput;
      case 'task_execution_result':
        return {
          kind: 'task_execution_result',
          status: 'completed',
          summary: `${input.agent.name} 已根据任务契约生成可落地的执行产物，并准备写入本地工作目录。`,
          completedItems: [
            `梳理任务目标：${input.contextPack.currentTask?.title ?? input.contextPack.sessionGoal}`,
            '生成结构化执行记录文件',
            '保留可复盘的完成项、风险和下一步建议'
          ],
          changedArtifacts: [this.executionFileArtifact(input)],
          nextSuggestedActions: ['查看写入的 agent-output 文件', '进入复盘一致性检查'],
          risks: []
        } satisfies TaskExecutionResultOutput;
      case 'post_review_report':
        return {
          kind: 'post_review_report',
          isConsistentWithBrief: true,
          matchedItems: ['未真实修改文件', '执行过程可追溯', '生成最终交付'],
          mismatchedItems: [],
          missingItems: [],
          outOfScopeChanges: [],
          testResults: ['dry-run 验证通过'],
          recommendation: 'deliver'
        } satisfies PostReviewReportOutput;
      case 'final_delivery':
        return {
          kind: 'final_delivery',
          summary: 'v1 协作闭环 dry-run 已完成。',
          completedItems: ['任务契约确认', 'dry-run 执行', '复盘一致性检查'],
          incompleteItems: ['真实 Codex/Claude Code Runtime 后续 v2 接入'],
          risks: [],
          artifactRefs: []
        } satisfies FinalDeliveryOutput;
      case 'user_message_handling_plan':
        return {
          kind: 'user_message_handling_plan',
          intent: 'constraint',
          priority: 'high',
          shouldPause: true,
          affectedTaskIds: input.taskId ? [input.taskId] : [],
          affectedAgentIds: [input.agent.id],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: '将用户新增约束写入当前执行上下文，保持 dry-run 非破坏性。'
        } satisfies UserMessageHandlingPlanOutput;
      default:
        return {
          kind: 'agent_message',
          messageKind: 'discussion',
          content: [
            `${input.agent.name} 已完成 ${input.phase} 阶段处理。`,
            `当前目标：${input.contextPack.sessionGoal}`,
            input.contextPack.currentTask ? `关联任务：${input.contextPack.currentTask.title}` : '当前没有绑定具体执行任务。',
            '我会把结论同步给 Coordinator，并保留后续执行需要的约束、风险和验收依据。'
          ].join('\n')
        } satisfies AgentMessageOutput;
    }
  }

  private requirementAwareExecutionFileArtifact(input: AgentRunInput) {
    const goal = this.goal(input);
    const taskTitle = input.contextPack.currentTask?.title ?? goal;
    const targetPaths = this.workspaceTargetPaths(input);
    const fileName = this.safeFileName(taskTitle);
    const acceptanceCriteria = input.contextPack.currentTask?.acceptanceCriteria?.length
      ? input.contextPack.currentTask.acceptanceCriteria
      : input.contextPack.taskBrief?.acceptanceCriteria ?? [];
    const fallbackPath = `agent-output/${fileName}.md`;
    const fileChanges: RuntimeFileChange[] = targetPaths.length
      ? targetPaths.map((path) => {
          const targetFile = input.contextPack.workspaceSnapshot?.files.find((file) => file.path === path);
          return {
            path,
            operation: 'update',
            content: this.updatedWorkspaceFileContent({
              originalContent: targetFile?.content ?? '',
              path,
              agentName: input.agent.name,
              phase: input.phase,
              goal,
              taskTitle,
              taskDescription: input.contextPack.currentTask?.description ?? `为用户需求生成可审查的具体修改：${goal}`,
              acceptanceCriteria
            }),
            encoding: 'utf-8'
          };
        })
      : [
          {
            path: fallbackPath,
            operation: 'create',
            content: this.markdownExecutionArtifact({
              agentName: input.agent.name,
              phase: input.phase,
              goal,
              taskTitle,
              taskDescription: input.contextPack.currentTask?.description ?? `为用户需求生成可审查的具体修改：${goal}`,
              acceptanceCriteria
            }),
            encoding: 'utf-8'
          }
        ];
    const content = this.multiFileExecutionSummary({
      agentName: input.agent.name,
      phase: input.phase,
      goal,
      taskTitle,
      taskDescription: input.contextPack.currentTask?.description ?? `为用户需求生成可审查的具体修改：${goal}`,
      acceptanceCriteria,
      fileChanges
    });

    return {
      type: 'markdown',
      title: `${taskTitle} 多文件执行产物`,
      content,
      summary: `已为需求生成 ${fileChanges.length} 个文件变更：${goal}`,
      metadata: {
        fileChanges
      }
    } satisfies import('@agent-cluster/shared').RuntimeArtifactOutput;
  }

  private workspaceTargetPaths(input: AgentRunInput) {
    const snapshotPaths = new Set(input.contextPack.workspaceSnapshot?.files.map((file) => file.path) ?? []);
    const candidates = input.contextPack.workspaceFocus?.relevantFiles?.length
      ? input.contextPack.workspaceFocus.relevantFiles
      : input.contextPack.workspaceSnapshot?.files.map((file) => file.path) ?? [];
    return [...new Set(candidates)]
      .filter((path) => snapshotPaths.has(path))
      .filter((path) => !path.startsWith('agent-output/'))
      .slice(0, 6);
  }

  private multiFileExecutionSummary(input: {
    agentName: string;
    phase: string;
    goal: string;
    taskTitle: string;
    taskDescription: string;
    acceptanceCriteria: string[];
    fileChanges: RuntimeFileChange[];
  }) {
    return [
      `# ${input.taskTitle}多文件执行产物`,
      '',
      `执行 Agent：${input.agentName}`,
      `阶段：${input.phase}`,
      '',
      '## 用户需求',
      input.goal,
      '',
      '## 任务说明',
      input.taskDescription,
      '',
      '## 影响文件',
      ...input.fileChanges.map((change) => `- ${change.operation === 'update' ? '修改' : '新增'}：${change.path}`),
      '',
      '## 验收标准',
      ...(input.acceptanceCriteria.length
        ? input.acceptanceCriteria.map((item: string) => `- ${item}`)
        : ['- 所有影响文件都有明确变更', '- 前端可以展示每个文件的修改内容', '- 浏览器可将变更写入用户选择的工作区']),
      '',
      '## 说明',
      '- 这是 mock runtime 生成的多文件变更示例。',
      '- 真实 Codex/Claude Runtime 接入后，应由真实代码执行结果替换这些占位修改。',
      '- 每个文件变更都通过 artifact_created.metadata.payload.fileChanges 下发给前端。'
    ].join('\n');
  }

  private markdownExecutionArtifact(input: {
    agentName: string;
    phase: string;
    goal: string;
    taskTitle: string;
    taskDescription: string;
    acceptanceCriteria: string[];
    targetPath?: string;
  }) {
    return [
      `# ${input.taskTitle}`,
      '',
      `执行 Agent：${input.agentName}`,
      `阶段：${input.phase}`,
      '',
      '## 用户需求',
      input.goal,
      '',
      '## 任务说明',
      input.taskDescription,
      '',
      '## 验收标准',
      ...(input.acceptanceCriteria.length
        ? input.acceptanceCriteria.map((item: string) => `- ${item}`)
        : ['- 产物与用户需求直接相关。', '- 前端可以展示执行结果。']),
      '',
      '## 结果',
      input.targetPath
        ? `- 已为工作区文件 ${input.targetPath} 生成 mock 执行说明：${input.goal}`
        : `- 已为该需求生成本地阶段产物：${input.goal}`,
      '- 前端通过 artifact_created.metadata.payload.fileChanges 接收本文件。',
      '- 用户确认后，浏览器会把文件写入所选本地工作区。',
      '',
      '## 复盘提示',
      `- 检查该产物是否仍符合原始需求：${input.goal}`,
      input.targetPath
        ? '- 接入真实代码 Runtime 后，应使用精确代码修改替换当前 mock 说明。'
        : '- 如需精确仓库代码修改，请启用真实代码 Runtime 并提供目标路径。'
    ].join('\n');
  }

  private updatedWorkspaceFileContent(input: {
    originalContent: string;
    path: string;
    agentName: string;
    phase: string;
    goal: string;
    taskTitle: string;
    taskDescription: string;
    acceptanceCriteria: string[];
  }) {
    const note = [
      `执行 Agent：${input.agentName}`,
      `阶段：${input.phase}`,
      `用户需求：${input.goal}`,
      `任务：${input.taskTitle}`,
      `说明：${input.taskDescription}`,
      `验收：${input.acceptanceCriteria.join('；') || '产物可审查且与需求相关。'}`,
      'Mock runtime note: replace this with exact code edits when a real coding runtime is enabled.'
    ];
    const extension = input.path.toLowerCase().split('.').at(-1) ?? '';
    const comment =
      extension === 'css' || extension === 'scss' || extension === 'ts' || extension === 'tsx' || extension === 'js' || extension === 'jsx'
        ? ['/*', ...note.map((line) => ` * ${line}`), ' */'].join('\n')
        : extension === 'vue'
          ? ['<!--', ...note.map((line) => `  ${line}`), '-->'].join('\n')
          : this.markdownExecutionArtifact({
              agentName: input.agentName,
              phase: input.phase,
              goal: input.goal,
              taskTitle: input.taskTitle,
              taskDescription: input.taskDescription,
              acceptanceCriteria: input.acceptanceCriteria,
              targetPath: input.path
            });
    return [input.originalContent.trimEnd(), '', comment, ''].filter(Boolean).join('\n');
  }

  private executionFileArtifact(input: AgentRunInput) {
    const taskTitle = input.contextPack.currentTask?.title ?? input.contextPack.sessionGoal;
    const fileName = this.safeFileName(taskTitle);
    const path = `agent-output/${fileName}.md`;
    const content = [
      `# ${taskTitle}`,
      '',
      `执行 Agent：${input.agent.name}`,
      `阶段：${input.phase}`,
      '',
      '## 需求目标',
      input.contextPack.sessionGoal,
      '',
      '## 执行说明',
      input.contextPack.currentTask?.description ?? '根据已确认任务契约生成执行产物。',
      '',
      '## 验收标准',
      ...(input.contextPack.currentTask?.acceptanceCriteria?.length
        ? input.contextPack.currentTask.acceptanceCriteria.map((item: string) => `- ${item}`)
        : ['- 产物可被用户查看', '- 执行结果可被复盘 Agent 校验']),
      '',
      '## 结果',
      '- 已生成本文件作为具体交付产物。',
      '- 文件通过 artifact_created 事件下发给前端，并由浏览器写入用户选择的本地工作目录。',
      '',
      '## 后续建议',
      '- 检查本文件内容是否符合预期。',
      '- 如需代码级修改，请在需求中明确目标文件、技术栈和验收方式。'
    ].join('\n');

    return {
      type: 'markdown',
      title: `${taskTitle} 执行产物`,
      content,
      summary: `已生成 ${path}`,
      metadata: {
        fileChanges: [
          {
            path,
            operation: 'create',
            content,
            encoding: 'utf-8'
          }
        ]
      }
    } satisfies import('@agent-cluster/shared').RuntimeArtifactOutput;
  }

  private goal(input: AgentRunInput) {
    return input.contextPack.taskBrief?.goal || input.contextPack.sessionGoal || 'Untitled requirement';
  }

  private shortText(value: string, maxLength: number) {
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
  }

  private safeFileName(value: string) {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || `task-${Date.now()}`
    );
  }

  private usageFor(input: AgentRunInput, output?: RuntimeOutput): RuntimeUsage {
    const inputTokens = Math.max(1, estimateTokens({ contextPack: input.contextPack, expectedOutput: input.expectedOutput }));
    const outputTokens = output ? Math.max(1, estimateTokens(output)) : 1;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: 'mock'
    };
  }
}
