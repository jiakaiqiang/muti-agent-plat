import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { PersistenceService } from '../persistence/persistence.service.js';

// Encrypts model-connection credentials at rest with AES-256-GCM. The master key comes from
// MODEL_CREDENTIAL_KEY (derived via scrypt); if unset, a random key is generated once and
// persisted locally so encryption survives restarts in dev (with a loud warning).
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private readonly key: Buffer;

  constructor(private readonly persistence: PersistenceService) {
    this.key = this.resolveKey();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `gcm.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(token: string): string {
    const [scheme, ivB64, tagB64, ctB64] = token.split('.');
    if (scheme !== 'gcm' || !ivB64 || !tagB64 || !ctB64) {
      throw new Error('Unrecognized credential token');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  }

  private resolveKey(): Buffer {
    const configured = process.env.MODEL_CREDENTIAL_KEY?.trim();
    if (configured) {
      return scryptSync(configured, 'agent-cluster.model-credential', 32);
    }

    const stored = this.persistence.getCollection<{ key?: string }>('modelCredentialKey', {});
    if (stored.key) {
      return Buffer.from(stored.key, 'base64');
    }

    const generated = randomBytes(32);
    this.persistence.setCollection('modelCredentialKey', { key: generated.toString('base64') });
    this.logger.warn(
      'MODEL_CREDENTIAL_KEY is not set; generated a local credential key in the data store. Set MODEL_CREDENTIAL_KEY for production.'
    );
    return generated;
  }
}
