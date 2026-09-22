# 阶段 6 成本与质量报告 v1

> 生成日期：2026-09-20T06:06:11.075Z  
> 结论：确定性 fixture + mock 计量；本次没有真实模型证据，不代表业务数据质量或第三方缓存折扣。

## 样本

- Fixture：`79cb4bc7-0e19-447d-a23e-5673af5cfbc7`
- WorkItem：100
- 消息：1000
- 受控上下文：10 个无关需求 348 tokens；100 个无关需求 348 tokens；增长 100.0%，门槛 通过。
- 召回/歧义/修订：早期需求 通过；同名需求澄清 通过；过期 CSV 约束排除 通过。

## 冷热缓存计量（mock）

| 场景 | 输入 tokens | 输出 tokens | cache read | cache write | 费用 |
| --- | ---: | ---: | ---: | ---: | --- |
| cold | 348 | 120 | 0 | 348 | unknown (this run did not configure a priceVersion or collect provider usage) |
| hot | 348 | 120 | 348 | 0 | unknown (this run did not configure a priceVersion or collect provider usage) |

平台已支持通过部署侧 `AGENT_CLUSTER_RUNTIME_PRICING_JSON` 为精确 Runtime connection 配置带版本价格，并在 Provider 返回实际 usage 时生成带 `priceVersion`、`costBasis=estimated` 的金额。mock 栏的费用保持 unknown，不用真实模型结果反填。模型质量状态（确定性 fixture）：not measured: deterministic fixture evaluator only。

真实模型质量、usage、价格、TTFT、总耗时、失败率和索引开销均为 unknown；没有可核验的完整真实模型证据。
