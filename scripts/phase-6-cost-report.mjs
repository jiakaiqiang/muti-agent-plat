import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildLongSessionFixture, evaluateLongSession } from './phase-6-long-session-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(process.env.PHASE_6_COST_REPORT_PATH || resolve(root, 'docs/quality/main-agent-collaboration-phase-6-cost-report-v1.md'));
const liveEvidencePath = resolve(process.env.PHASE_6_LIVE_MODEL_EVIDENCE_PATH || resolve(root, '.cache/agent-cluster/phase-6/live-model-evidence.json'));
const fixture = buildLongSessionFixture();
const evaluation = evaluateLongSession(fixture);
const cold = { inputTokens: evaluation.expandedTokens, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: evaluation.expandedTokens };
const hot = { inputTokens: evaluation.expandedTokens, outputTokens: 120, cacheReadTokens: evaluation.expandedTokens, cacheWriteTokens: 0 };
const unknownCost = 'unknown (this run did not configure a priceVersion or collect provider usage)';
const liveEvidence = await readLiveEvidence(liveEvidencePath);

function liveEvidenceSection(evidence) {
  if (!evidence) return '真实模型质量、usage、价格、TTFT、总耗时、失败率和索引开销均为 unknown；没有可核验的完整真实模型证据。';
  const aggregate = evidence.aggregate;
  const reported = (value) => value === null ? 'unknown' : value;
  const cold = evidence.scenarios.find((item) => item.id === 'cache_cold');
  const hot = evidence.scenarios.find((item) => item.id === 'cache_hot');
  return `## 受批真实模型抽样（合成数据）

- 价格版本：\`${cold.usage.priceVersion}\`；费用基准：\`estimated\`，按 Provider 实际 usage 与受控费率估算。
- 质量：${aggregate.qualityPassed}/${aggregate.qualityTotal}；完成 ${aggregate.completedCalls}/${evidence.scenarioCount}；失败率 ${(aggregate.failureRate * 100).toFixed(1)}%。
- Provider 请求：${evidence.providerRequestCount}；输入 ${aggregate.totalInputTokens} tokens，输出 ${aggregate.totalOutputTokens} tokens，cache read ${reported(aggregate.cacheReadTokens)}，cache write ${reported(aggregate.cacheWriteTokens)}。
- 总估算费用：USD ${aggregate.totalCostUsd.toFixed(9)}；平均 TTFT ${aggregate.averageTtftMs} ms，平均总耗时 ${aggregate.averageDurationMs} ms。
- 索引准备：${evidence.indexPreparation.reason}。

| 场景 | 输入 tokens | 输出 tokens | cache read | cache write | 估算费用 USD | TTFT ms | 总耗时 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | ${cold.usage.inputTokens} | ${cold.usage.outputTokens} | ${cold.usage.cacheReadInputTokens ?? 'unknown'} | ${cold.usage.cacheWriteInputTokens ?? 'unknown'} | ${cold.usage.cost.toFixed(9)} | ${cold.streamMetrics.firstFrameLatencyMs} | ${cold.streamMetrics.durationMs} |
| hot | ${hot.usage.inputTokens} | ${hot.usage.outputTokens} | ${hot.usage.cacheReadInputTokens ?? 'unknown'} | ${hot.usage.cacheWriteInputTokens ?? 'unknown'} | ${hot.usage.cost.toFixed(9)} | ${hot.streamMetrics.firstFrameLatencyMs} | ${hot.streamMetrics.durationMs} |

此结果只代表固定合成样本；Provider 未报告缓存计数时为 unknown，不把零缓存命中或百分比降本当作结论。`;
}

async function readLiveEvidence(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (value?.schemaVersion !== 'phase-6-live-model-evidence-v1' || value.status !== 'completed' ||
    value.dataScope !== 'synthetic_fixture_only' || value.providerRequestCount !== 5 ||
    value.aggregate?.completedCalls !== 5 || value.aggregate?.failedCalls !== 0 ||
    !Number.isFinite(value.aggregate?.qualityPassed) || value.aggregate?.qualityTotal !== 5 ||
    !Number.isFinite(value.aggregate?.failureRate) || !Number.isFinite(value.aggregate?.totalCostUsd) ||
    !Number.isFinite(value.aggregate?.totalInputTokens) || !Number.isFinite(value.aggregate?.totalOutputTokens) ||
    !(value.aggregate?.cacheReadTokens === null || Number.isFinite(value.aggregate?.cacheReadTokens)) ||
    !(value.aggregate?.cacheWriteTokens === null || Number.isFinite(value.aggregate?.cacheWriteTokens)) ||
    !Number.isFinite(value.aggregate?.averageTtftMs) || !Number.isFinite(value.aggregate?.averageDurationMs) ||
    value.scenarios?.length !== 5 ||
    !value.scenarios.every((item) => item.status === 'completed' && Number.isFinite(item.usage?.cost) &&
      typeof item.usage?.priceVersion === 'string' && Number.isFinite(item.streamMetrics?.firstFrameLatencyMs) &&
      Number.isFinite(item.streamMetrics?.durationMs)) ||
    !value.scenarios.find((item) => item.id === 'cache_cold') ||
    !value.scenarios.find((item) => item.id === 'cache_hot')) return undefined;
  return value;
}

const markdown = `# 阶段 6 成本与质量报告 v1

> 生成日期：${new Date().toISOString()}  
> 结论：确定性 fixture + mock 计量${liveEvidence ? '，附受批合成数据真实模型抽样' : '；本次没有真实模型证据'}，不代表业务数据质量或第三方缓存折扣。

## 样本

- Fixture：\`${fixture.fixtureId}\`
- WorkItem：${evaluation.workItemCount}
- 消息：${evaluation.messageCount}
- 受控上下文：10 个无关需求 ${evaluation.baselineTokens} tokens；100 个无关需求 ${evaluation.expandedTokens} tokens；增长 ${(evaluation.growthRatio * 100).toFixed(1)}%，门槛 ${evaluation.withinGrowthLimit ? '通过' : '失败'}。
- 召回/歧义/修订：早期需求 ${evaluation.recall.earlyReference ? '通过' : '失败'}；同名需求澄清 ${evaluation.ambiguity.sameNameRequiresClarification ? '通过' : '失败'}；过期 CSV 约束排除 ${evaluation.constraints.supersededConstraintExcluded ? '通过' : '失败'}。

## 冷热缓存计量（mock）

| 场景 | 输入 tokens | 输出 tokens | cache read | cache write | 费用 |
| --- | ---: | ---: | ---: | ---: | --- |
| cold | ${cold.inputTokens} | ${cold.outputTokens} | ${cold.cacheReadTokens} | ${cold.cacheWriteTokens} | ${unknownCost} |
| hot | ${hot.inputTokens} | ${hot.outputTokens} | ${hot.cacheReadTokens} | ${hot.cacheWriteTokens} | ${unknownCost} |

平台已支持通过部署侧 \`AGENT_CLUSTER_RUNTIME_PRICING_JSON\` 为精确 Runtime connection 配置带版本价格，并在 Provider 返回实际 usage 时生成带 \`priceVersion\`、\`costBasis=estimated\` 的金额。mock 栏的费用保持 unknown，不用真实模型结果反填。模型质量状态（确定性 fixture）：${evaluation.modelQuality}。

${liveEvidenceSection(liveEvidence)}
`;

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, markdown, 'utf8');
console.log(JSON.stringify({ reportPath, fixtureId: fixture.fixtureId, evaluation, cost: unknownCost, liveEvidenceIncluded: Boolean(liveEvidence) }, null, 2));
