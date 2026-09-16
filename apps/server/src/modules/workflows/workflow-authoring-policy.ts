import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';

/** Configure on the shared backend; no client-provided role/surface can grant this capability. */
export function assertWorkflowAuthoring(token?: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.WORKFLOW_AUTHORING_MODE === 'read_only') throw new ForbiddenException('流程定义在此服务上只读。');
  const expected = env.WORKFLOW_AUTHORING_TOKEN;
  if (!expected) {
    if (env.WORKFLOW_AUTHORING_MODE === 'token') throw new ForbiddenException('流程维护授权尚未配置。');
    return; // Existing local Web-author deployment compatibility; see API contract.
  }
  const supplied = token ?? '';
  if (supplied.length > 4096 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new ForbiddenException('当前身份没有流程维护权限。');
}
