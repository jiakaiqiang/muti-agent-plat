import { Global, Module } from '@nestjs/common';
import { PersistenceService } from './persistence.service.js';

@Global()
@Module({
  providers: [
    {
      provide: PersistenceService,
      useFactory: async () => {
        const service = new PersistenceService();
        await service.initialize();
        return service;
      }
    }
  ],
  exports: [PersistenceService]
})
export class PersistenceModule {}
