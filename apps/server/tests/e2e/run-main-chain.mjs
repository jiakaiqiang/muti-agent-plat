#!/usr/bin/env node

/**
 * E2E Test: Agent Profile Markdown 主链路验证
 *
 * 测试目标：
 * 1. Agent 使用 profileMarkdown 创建
 * 2. Compiler 正确编译 Markdown
 * 3. Runtime 使用编译后的 executionTarget
 * 4. Session 创建并执行成功
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..', '..');

// ANSI 颜色
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function log(color, prefix, message) {
  console.log(`${color}${prefix}${RESET} ${message}`);
}

function runCommand(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      cwd: rootDir,
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });
  } catch (err) {
    if (!options.ignoreError) {
      throw err;
    }
    return null;
  }
}

async function testMainChain() {
  log(BLUE, '[E2E]', '开始主链路测试');

  // Step 1: 确保服务构建完成
  log(YELLOW, '[1/6]', '构建项目...');
  runCommand('npm run build');
  log(GREEN, '✓', '构建完成');

  // Step 2: 启动服务（后台）
  log(YELLOW, '[2/6]', '启动后端服务...');
  const serverProcess = runCommand('npm run --workspace=@agent-cluster/server dev &', {
    detached: true,
    ignoreError: true
  });

  // 等待服务启动
  await new Promise(resolve => setTimeout(resolve, 5000));
  log(GREEN, '✓', '服务启动完成');

  try {
    // Step 3: 创建测试 Agent（使用 profileMarkdown）
    log(YELLOW, '[3/6]', '创建测试 Agent...');
    const testAgent = {
      name: 'e2e-test-agent',
      profileMarkdown: `---
name: e2e-test-agent
description: E2E 测试专用 Agent
---

# E2E Test Agent

## 运行时配置
- **模型**: mock-runtime
- **超时**: 30s

## 工具权限
- read_file
- write_file

## 技能
- code_review
`,
      avatarUrl: null
    };

    const createResult = runCommand(
      `curl -X POST http://localhost:3000/api/agents \
        -H "Content-Type: application/json" \
        -d '${JSON.stringify(testAgent)}'`,
      { silent: true, ignoreError: true }
    );

    if (!createResult || createResult.includes('error')) {
      throw new Error('Agent 创建失败: ' + createResult);
    }

    const createdAgent = JSON.parse(createResult);
    log(GREEN, '✓', `Agent 创建成功: ${createdAgent.id}`);

    // Step 4: 验证编译结果
    log(YELLOW, '[4/6]', '验证编译结果...');
    const getResult = runCommand(
      `curl -s http://localhost:3000/api/agents/${createdAgent.id}`,
      { silent: true }
    );
    const agent = JSON.parse(getResult);

    if (!agent.compiledAt) {
      throw new Error('Agent 未编译');
    }
    if (!agent.compiledTools || agent.compiledTools.length === 0) {
      throw new Error('Tools 编译失败');
    }
    if (!agent.compiledSkills || agent.compiledSkills.length === 0) {
      throw new Error('Skills 编译失败');
    }
    if (agent.compiledModel !== 'mock-runtime') {
      throw new Error(`模型编译错误: 期望 mock-runtime，实际 ${agent.compiledModel}`);
    }
    log(GREEN, '✓', '编译结果验证通过');

    // Step 5: 创建 Session
    log(YELLOW, '[5/6]', '创建测试 Session...');
    const sessionPayload = {
      agentId: createdAgent.id,
      workDir: '/tmp/e2e-test',
      brief: '测试主链路功能'
    };

    const sessionResult = runCommand(
      `curl -X POST http://localhost:3000/api/sessions \
        -H "Content-Type: application/json" \
        -d '${JSON.stringify(sessionPayload)}'`,
      { silent: true, ignoreError: true }
    );

    if (!sessionResult || sessionResult.includes('error')) {
      throw new Error('Session 创建失败: ' + sessionResult);
    }

    const session = JSON.parse(sessionResult);
    log(GREEN, '✓', `Session 创建成功: ${session.id}`);

    // Step 6: 验证 executionTarget
    log(YELLOW, '[6/6]', '验证 executionTarget...');
    if (!session.executionTarget) {
      throw new Error('Session.executionTarget 为空');
    }
    if (!session.executionTarget.model) {
      throw new Error('executionTarget.model 为空');
    }
    if (session.executionTarget.model !== 'mock-runtime') {
      throw new Error(`executionTarget.model 错误: 期望 mock-runtime，实际 ${session.executionTarget.model}`);
    }
    if (!session.executionTarget.tools || session.executionTarget.tools.length === 0) {
      throw new Error('executionTarget.tools 为空');
    }
    log(GREEN, '✓', 'executionTarget 验证通过');

    log(GREEN, '[E2E]', '✅ 主链路测试全部通过');
    process.exit(0);

  } catch (error) {
    log(RED, '[ERROR]', error.message);
    process.exit(1);
  } finally {
    // 清理：停止服务
    log(YELLOW, '[CLEANUP]', '停止服务...');
    runCommand('pkill -f "node.*dist/apps/server"', { ignoreError: true });
  }
}

// 运行测试
testMainChain().catch(err => {
  log(RED, '[FATAL]', err.message);
  process.exit(1);
});
