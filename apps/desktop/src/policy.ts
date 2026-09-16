import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { normalizeLocalRuntimeServerUrl } from '../../../packages/local-runtime-cli/src/protocol-handler';

export const APP_URL = 'agent-cluster://app';
export const normalizeServer = normalizeLocalRuntimeServerUrl;
export function platformKey(server: string) {
  return createHash('sha256').update(server ? normalizeServer(server) : 'unconfigured').digest('hex').slice(0, 32);
}
export function isAppUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'agent-cluster:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}
export function apiTarget(value: string, server: string, method: string) {
  if (!isAppUrl(value)) throw new Error('Untrusted application origin');
  const url = new URL(value);
  // Reject escaped separators and dot segments, including double-encoding.
  if (/%(?:2f|5c|2e|25)/i.test(url.pathname)) throw new Error('Unsupported encoded API path');
  if (!url.pathname.startsWith('/api/')) throw new Error('Unsupported API path');
  if (/^\/api\/workflows(?:\/|$)/i.test(decodeURIComponent(url.pathname)) && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    throw new Error('桌面端只能查看和使用已发布流程，不能修改流程定义。');
  }
  return new URL(url.pathname + url.search, normalizeServer(server)).toString();
}
export function assetPath(root: string, value: string) {
  if (!isAppUrl(value)) throw new Error('Untrusted application origin');
  const pathname = decodeURIComponent(new URL(value).pathname);
  if (pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid resource path');
  const candidate = resolve(root, '.' + pathname);
  const child = relative(root, candidate);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('Resource is outside application');
  return !extname(pathname) || pathname === '/' ? resolve(root, 'index.html') : candidate;
}
export function validateUpdateUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('更新源必须是不含凭据、查询参数和片段的 HTTPS 地址。');
  }
  return url.toString();
}
