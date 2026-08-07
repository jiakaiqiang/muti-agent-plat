// 映射器已移到 @agent-cluster/shared/runtime-streaming,供 server 与
// local-runtime-cli 共用。保留此处 re-export,现有 import 路径不受影响。
export { frameToRuntimeEvent } from '@agent-cluster/shared';
