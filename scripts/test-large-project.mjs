#!/usr/bin/env node

/**
 * 创建一个大项目测试会话，验证 token 修复
 */

import http from 'http';

// 模拟一个大项目的 workspace snapshot
const largeWorkspaceSnapshot = {
  rootName: 'large-test-project',
  scannedAt: new Date().toISOString(),
  fileCount: 350,  // 和你的实际项目一样
  totalBytes: 4845670,
  tree: Array.from({ length: 100 }, (_, i) => ({
    path: `src/module${i}`,
    kind: 'directory',
    children: Array.from({ length: 3 }, (_, j) => ({
      path: `src/module${i}/file${j}.ts`,
      kind: 'file'
    }))
  })),
  files: Array.from({ length: 80 }, (_, i) => ({
    path: `src/module${Math.floor(i / 3)}/file${i % 3}.ts`,
    size: 5000 + i * 100,
    language: 'typescript',
    // 注意：根据修复，这里的 content 应该被移除
    summary: `Module ${Math.floor(i / 3)} implementation file`
  })),
  skipped: [],
  detectedStack: ['TypeScript', 'Node.js', 'Vue'],
  entrypoints: ['src/main.ts', 'src/index.ts']
};

const postData = JSON.stringify({
  input: '分析当前项目的架构 从前后端以及架构设计方面分析',
  agentIds: ['coordinator', 'architect', 'backend', 'frontend'],
  tokenBudget: 30000,  // 使用和之前一样的预算
  workspaceSnapshot: largeWorkspaceSnapshot
});

const options = {
  hostname: '127.0.0.1',
  port: 8089,
  path: '/api/sessions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('🔬 创建大项目测试会话...');
console.log(`📊 项目规模: ${largeWorkspaceSnapshot.fileCount} 文件`);
console.log(`💰 Token 预算: 30000`);
console.log(`🎯 输入上限: 21000 tokens\n`);

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (result.data && result.data.session) {
        const session = result.data.session;
        console.log('✅ 会话创建成功！');
        console.log(`   ID: ${session.id}`);
        console.log(`   状态: ${session.status}`);
        console.log(`\n⏳ 等待任务契约生成...`);
        console.log(`\n🔗 查看会话: http://127.0.0.1:8099/#/sessions/${session.id}`);
        console.log(`\n📡 监控状态: curl http://127.0.0.1:8089/api/sessions/${session.id}\n`);
      } else if (result.error) {
        console.error('❌ 创建失败:', result.error.message);
      }
    } catch (e) {
      console.error('❌ 解析响应失败:', e.message);
      console.log('原始响应:', data.substring(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.error('❌ 请求失败:', e.message);
});

req.write(postData);
req.end();
