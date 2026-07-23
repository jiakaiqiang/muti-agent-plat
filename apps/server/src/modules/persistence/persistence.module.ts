import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ContentReferenceCodec } from './content-reference-codec.js';
import { LocalContentStore } from './local-content-store.js';
import { PersistenceCommitInterceptor } from './persistence-commit.interceptor.js';
import { PersistenceService } from './persistence.service.js';

export async function initializeV2Persistence(
  service: Pick<PersistenceService, 'initialize' | 'assertCurrentDataReady'>
) {
  await service.initialize();
  service.assertCurrentDataReady();
  return service;
}

@Global()
@Module({
  providers: [
    {
      provide: LocalContentStore,
      useFactory: () => new LocalContentStore()
    },
    ContentReferenceCodec,
    {
      provide: PersistenceService,
      useFactory: async () => {
        const service = new PersistenceService();
        return initializeV2Persistence(service);
      }
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: PersistenceCommitInterceptor
    }
  ],
  exports: [PersistenceService, LocalContentStore, ContentReferenceCodec]
})
export class PersistenceModule {}
