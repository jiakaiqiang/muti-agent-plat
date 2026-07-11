#!/usr/bin/env node
/**
 * claude-stream-json-stub: 模拟 `claude --output-format stream-json`。
 *
 * 协议: 逐行 JSON (每行一条事件, 以 \n 分隔).
 * 输入: 从 stdin 读一行 prompt JSON (触发场景).
 * 输出顺序:
 *   1. system/init
 *   2. assistant/text (中文长文本 + 代码块)
 *   3. assistant/tool_use (read_file)
 *   4. control_request (询问 can_use_tool)  → 等 stdin 收到 control_response 再继续
 *   5. user/tool_result
 *   6. result (session_id + usage)
 *
 * 环境变量:
 *   STUB_CRASH=1     首帧后立即 exit(1)
 *   STUB_EXIT_WITHOUT_RESULT=1  首帧后 exit(0)，但不发送 result
 *   STUB_RESULT_ERROR=1  返回 CLI result error 帧
 *   STUB_FIRST_DELAY_MS=<n>  首帧前等待毫秒 (测首帧超时看门狗)
 *   STUB_SKIP_CONTROL=1  跳过 control_request 步骤
 */

const stdin = process.stdin;
const stdout = process.stdout;

let stdinBuf = '';
const controlResponders = new Map(); // request_id -> resolve

function writeLine(obj) {
  stdout.write(JSON.stringify(obj) + '\n');
}

function nextControlResponse(requestId) {
  return new Promise((resolve) => {
    controlResponders.set(requestId, resolve);
  });
}

function makePayload(kind) {
  if (kind === 'task_execution_result') {
    return {
      kind,
      status: 'completed',
      summary: '任务完成: 读取了 sample.ts',
      completedItems: ['stub'],
      changedArtifacts: [],
      nextSuggestedActions: [],
      risks: []
    };
  }
  if (kind === 'task_brief') {
    return {
      kind,
      goal: 'stub goal',
      scope: [],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: [],
      risks: [],
      openQuestions: [],
      suggestedTasks: []
    };
  }
  return { kind: 'agent_message', messageKind: 'summary', content: '任务完成: 读取了 sample.ts' };
}

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'control_response' && parsed.request_id) {
        const resolver = controlResponders.get(parsed.request_id);
        if (resolver) {
          controlResponders.delete(parsed.request_id);
          resolver(parsed.response ?? { allow: true });
        }
      } else if (!started && (parsed.prompt || parsed.type === 'user')) {
        // 一条 prompt 请求 → 启动场景
        started = true;
        runScenario().catch((err) => {
          process.stderr.write(String(err));
          process.exit(2);
        });
      }
    } catch {
      // ignore
    }
  }
});

let started = false;

async function runScenario() {
  const firstDelay = Number(process.env.STUB_FIRST_DELAY_MS ?? 0);
  if (firstDelay > 0) await new Promise((r) => setTimeout(r, firstDelay));

  writeLine({ type: 'system', subtype: 'init', session_id: 'stub-claude-session-1', model: 'claude-stub' });
  if (process.env.STUB_CRASH === '1') {
    process.exit(1);
    return;
  }
  if (process.env.STUB_EXIT_WITHOUT_RESULT === '1') {
    process.exit(0);
    return;
  }
  if (process.env.STUB_RESULT_ERROR === '1') {
    writeLine({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['stub execution error'],
      usage: { input_tokens: 0, output_tokens: 0 },
      session_id: 'stub-claude-session-error'
    });
    setTimeout(() => process.exit(1), 10);
    return;
  }

  // assistant 长文本
  const longText = '你好世界\n\n```ts\nexport const x = 1;\n```\n\n下面调用工具读取源文件.';
  writeLine({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: longText }]
    }
  });

  // assistant tool_use
  writeLine({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'read_file',
          input: { path: 'sample.ts' }
        }
      ]
    }
  });

  // control_request → 等待应答再继续 (除非 skip)
  if (process.env.STUB_SKIP_CONTROL !== '1') {
    const requestId = 'req-1';
    writeLine({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: 'read_file' }
    });
    await nextControlResponse(requestId);
  }

  // user tool_result
  writeLine({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: '/* sample.ts content */',
          is_error: false
        }
      ]
    }
  });

  // result
  writeLine({
    type: 'result',
    subtype: 'success',
    result: JSON.stringify(makePayload(process.env.STUB_KIND ?? 'agent_message')),
    usage: { input_tokens: 128, output_tokens: 64 },
    session_id: 'stub-claude-session-1'
  });

  setTimeout(() => process.exit(0), 10);
}

// 如果 stdin 直接 end 也启动 (兼容 pipe 关闭)
stdin.on('end', () => {
  if (!started) {
    started = true;
    runScenario().catch((err) => {
      process.stderr.write(String(err));
      process.exit(2);
    });
  }
});
