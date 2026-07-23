import { assertWithinRootRealpath } from '../../common/path-safety.js';
import { resolveWorkspacePath } from './workspace-path.js';

export async function assertWorkspacePathWithinRoot(
  rootPath: string,
  relativePath: string
): Promise<string> {
  const { absolute } = resolveWorkspacePath(rootPath, relativePath);
  return await assertWithinRootRealpath(rootPath, absolute);
}
