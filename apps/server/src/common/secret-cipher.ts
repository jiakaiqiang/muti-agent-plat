import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from 'node:crypto';

const V2_MARKER = 'enc-v2:';

export function isEncodedSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(V2_MARKER);
}

export function encodeSecret(
  plaintext: string,
  masterSecret = process.env.AGENT_CLUSTER_SECRET_KEY
): string {
  if (!masterSecret?.trim()) {
    throw new Error('AGENT_CLUSTER_SECRET_KEY is required to persist runtime credentials securely.');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(masterSecret, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V2_MARKER.slice(0, -1), salt, iv, tag, encrypted]
    .map((part) => Buffer.isBuffer(part) ? part.toString('base64url') : part)
    .join(':');
}

export function decodeSecret(
  value: string,
  masterSecret = process.env.AGENT_CLUSTER_SECRET_KEY
): string {
  if (!value.startsWith(V2_MARKER)) {
    throw new Error('Persisted runtime credentials must use an enc-v2 secret envelope.');
  }
  if (!masterSecret?.trim()) {
    throw new Error('AGENT_CLUSTER_SECRET_KEY is required to decrypt persisted runtime credentials.');
  }
  const parts = value.split(':');
  if (parts.length !== 5) throw new Error('Invalid enc-v2 secret envelope.');
  const [, saltText, ivText, tagText, encryptedText] = parts;
  const salt = Buffer.from(saltText, 'base64url');
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const encrypted = Buffer.from(encryptedText, 'base64url');
  const key = scryptSync(masterSecret, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
