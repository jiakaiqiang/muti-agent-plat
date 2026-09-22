import { Module, forwardRef } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AttachmentsController } from './attachments.controller.js';
import {
  ImageContentUnderstandingProvider,
  UnsupportedImageContentUnderstandingProvider
} from './image-recognition.provider.js';
import { AttachmentsService } from './attachments.service.js';

@Module({
  imports: [forwardRef(() => SessionsModule), EventsModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    {
      provide: ImageContentUnderstandingProvider,
      useClass: UnsupportedImageContentUnderstandingProvider
    }
  ],
  exports: [AttachmentsService]
})
export class AttachmentsModule {}
