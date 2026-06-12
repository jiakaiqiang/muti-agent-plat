# Agent Cluster Harness Reference 参考实例索引

## 定位

本文档与以下目录属于 reference 层：只说明 Agent Cluster 如何映射 Harness Engineering，不定义 Harness 本体。

## 参考映射索引

| 目录 / 文档 | 映射内容 | 交叉验证 |
| --- | --- | --- |
| ../alignment/ | Session、Orchestrator、Events、Artifacts 与阶段协议的对齐 | validate-phase2 |
| ../prompt-context/ | Agent prompt 与 runtime context 合同 | validate-phase3 |
| ../capability-binding/ | 工具治理与人工干预绑定 | validate-phase4 |
| ../delivery-memory/ | 交付记忆绑定与知识沉淀 | validate-phase5 |
| ../09-phase-two-alignment.md | 第二阶段对齐方案 | - |
| ../11-delivery-memory-practice.md | 第四阶段交付记忆实践 | - |

概念映射：SessionStatus -> 阶段状态；CollaborationEvent -> 过程留痕；ContextPack -> 上下文载体；RuntimeInvocation -> 调用记录；Capability -> 工具治理。

## 禁止反推

- 不要求其他项目实现 SessionStatus、Capability API、RuntimeInvocation 或 Agent Cluster 的 UI。
- 本层任何概念不得写入 core 文档作为要求。
