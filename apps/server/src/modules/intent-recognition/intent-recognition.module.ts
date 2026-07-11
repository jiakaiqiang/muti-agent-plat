import { Module } from '@nestjs/common';
import { IntentRecognitionService } from './intent-recognition.service.js';

@Module({
  providers: [IntentRecognitionService],
  exports: [IntentRecognitionService]
})
export class IntentRecognitionModule {}
