import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export type ArtifactCleanupTarget = {
  artifactId: string;
  path: string;
};

export type ArtifactCleanupBlocked = {
  artifactId: string;
  code: string;
};

export type ArtifactCleanupPlan = {
  dataRoot: string;
  targets: ArtifactCleanupTarget[];
  blocked: ArtifactCleanupBlocked[];
};

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'ARTIFACT_PATH_INVALID';
  return error.message.split(':', 1)[0] || 'ARTIFACT_PATH_INVALID';
}

function isOutside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..\\`) || pathFromRoot.startsWith('../') || isAbsolute(pathFromRoot);
}

export function assertArtifactPathWithinDataRoot(dataRoot: string, candidate: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    throw new Error('ARTIFACT_PATH_EXTERNAL_URI: external Artifact URIs cannot be deleted by cutover.');
  }
  const root = resolve(dataRoot);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (isOutside(root, target)) {
    throw new Error('ARTIFACT_PATH_OUTSIDE_DATA_ROOT: refusing to delete a path outside the platform data root.');
  }
  if (existsSync(target)) {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (isOutside(realRoot, realTarget)) {
      throw new Error('ARTIFACT_PATH_SYMLINK_ESCAPE: Artifact symlink resolves outside the platform data root.');
    }
    if (!lstatSync(target).isFile()) {
      throw new Error('ARTIFACT_PATH_NOT_FILE: cutover deletes Artifact files only.');
    }
  }
  return target;
}

export function planArtifactCleanup(state: Record<string, unknown>, dataRoot: string): ArtifactCleanupPlan {
  const persistedArtifacts = state.artifacts;
  const artifacts = Array.isArray(persistedArtifacts)
    ? persistedArtifacts
    : persistedArtifacts && typeof persistedArtifacts === 'object'
      ? Object.values(
          ((persistedArtifacts as { artifactsById?: Record<string, unknown> }).artifactsById ?? {})
        )
      : [];
  const targets: ArtifactCleanupTarget[] = [];
  const blocked: ArtifactCleanupBlocked[] = [];
  for (const [index, value] of artifacts.entries()) {
    if (!value || typeof value !== 'object') continue;
    const artifact = value as { id?: unknown; uri?: unknown };
    if (typeof artifact.uri !== 'string' || !artifact.uri.trim()) continue;
    const artifactId = typeof artifact.id === 'string' && artifact.id ? artifact.id : `artifact-${index}`;
    try {
      targets.push({ artifactId, path: assertArtifactPathWithinDataRoot(dataRoot, artifact.uri.trim()) });
    } catch (error) {
      blocked.push({ artifactId, code: errorCode(error) });
    }
  }
  return { dataRoot: resolve(dataRoot), targets, blocked };
}

export function executeArtifactCleanup(plan: ArtifactCleanupPlan): { deletedCount: number; missingCount: number } {
  if (plan.blocked.length) {
    throw new Error(`ARTIFACT_CLEANUP_BLOCKED: ${plan.blocked.length} Artifact path(s) failed validation.`);
  }
  let deletedCount = 0;
  let missingCount = 0;
  for (const target of plan.targets) {
    const verifiedPath = assertArtifactPathWithinDataRoot(plan.dataRoot, target.path);
    if (!existsSync(verifiedPath)) {
      missingCount += 1;
      continue;
    }
    rmSync(verifiedPath, { force: true });
    deletedCount += 1;
  }
  return { deletedCount, missingCount };
}
