import { writeFileSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => {
  setTimeout(() => {
    writeFileSync('README.md', '# Changed by desktop test\n');
    process.stdout.write(JSON.stringify({
      schemaVersion: '1.0', kind: 'agent_message', messageKind: 'summary', content: 'Desktop test finished.',
      targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: []
    }) + '\n');
  }, 4000);
});
