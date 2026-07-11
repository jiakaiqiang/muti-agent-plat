import { isSensitivePath } from '../../../common/path-safety.js';

export function isSensitiveWorkspacePath(path: string): boolean {
  return isSensitivePath(path);
}
