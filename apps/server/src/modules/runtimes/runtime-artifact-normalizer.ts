import { ARTIFACT_TYPES, type ArtifactType, type RuntimeArtifactOutput } from '@agent-cluster/shared';

const artifactTypeSet = new Set<string>(ARTIFACT_TYPES);
const legacyArtifactTypeMap: Record<string, ArtifactType> = {
  architecture_analysis: 'markdown'
};

export function normalizeRuntimeArtifact(value: unknown): RuntimeArtifactOutput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const artifact = value as Record<string, unknown>;
  const type = canonicalArtifactType(artifact.type);
  const title = stringValue(artifact.title);
  const topLevelContent = stringValue(artifact.content);
  const sourceMetadata = recordValue(artifact.metadata);
  const { content: legacyContentValue, ...metadata } = sourceMetadata ?? {};
  const content = topLevelContent ?? stringValue(legacyContentValue);
  if (!type || !title || !content) {
    return undefined;
  }
  return {
    type,
    title,
    content,
    ...(stringValue(artifact.uri) ? { uri: stringValue(artifact.uri) } : {}),
    ...(stringValue(artifact.summary) ? { summary: stringValue(artifact.summary) } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {})
  };
}

function canonicalArtifactType(value: unknown): ArtifactType | undefined {
  const type = stringValue(value);
  if (!type) return undefined;
  if (artifactTypeSet.has(type)) return type as ArtifactType;
  return legacyArtifactTypeMap[type];
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
