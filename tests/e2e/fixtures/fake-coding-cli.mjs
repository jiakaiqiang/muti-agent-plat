// Fake agentic coding CLI used by the v2 runtime smoke test.
// Protocol mirrors the real codex / claude_code adapter contract:
// read a JSON AgentRunInput on stdin, print a JSON response on stdout.
const mode = process.env.FAKE_CLI_MODE ?? 'ok';

if (mode === 'hang') {
  // Never respond; the runtime timeout/cancel path must kill this process.
  setTimeout(() => process.exit(0), 30_000);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(input || '{}');
    } catch {
      payload = {};
    }
    const expectedKind = payload?.expectedOutput?.kind ?? 'task_execution_result';
    const response = {
      output: {
        kind: expectedKind,
        status: 'completed',
        summary: 'fake coding cli completed',
        completedItems: ['ran via fake coding cli'],
        changedArtifacts: [],
        nextSuggestedActions: [],
        risks: []
      },
      toolRequests: [
        { tool: 'file_write', path: 'codex-output.txt', content: 'written by fake coding runtime', summary: 'demo write' }
      ],
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, model: 'codex-fake' }
    };
    process.stdout.write(JSON.stringify(response));
  });
}
