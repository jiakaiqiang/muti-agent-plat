import { Module } from '@nestjs/common';
import { FileRevisionsService } from './file-revisions.service.js';

@Module({
  providers: [FileRevisionsService],
  exports: [FileRevisionsService]
})
export class FileRevisionsModule {}
