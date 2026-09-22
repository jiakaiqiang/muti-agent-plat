import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ok } from '../../common/api-response.js';
import { SessionsService } from '../sessions/sessions.service.js';
import {
  AttachmentsService,
  GROUP_CHAT_FILE_MAX_BYTES,
  type AttachmentUploadFile,
  assertHumanAttachmentUpload
} from './attachments.service.js';

const uploadOptions = {
  limits: { files: 8, fileSize: GROUP_CHAT_FILE_MAX_BYTES }
};

@Controller()
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly sessions: SessionsService
  ) {}

  @Post('sessions/:sessionId/attachments')
  @UseInterceptors(AnyFilesInterceptor(uploadOptions))
  async upload(
    @Param('sessionId') sessionId: string,
    @UploadedFiles() files: AttachmentUploadFile[],
    @Body() body: { messageId?: string; batchId?: string },
    @Headers('x-actor-type') actorType?: string,
    @Headers('x-agent-id') agentId?: string
  ) {
    assertHumanAttachmentUpload(actorType, agentId);
    this.sessions.get(sessionId);
    return ok(await this.attachments.upload(sessionId, files ?? [], body));
  }

  @Get('sessions/:sessionId/attachments')
  list(@Param('sessionId') sessionId: string) {
    this.sessions.getIncludingDeleted(sessionId);
    return ok({ items: this.attachments.list(sessionId) });
  }

  @Post('sessions/:sessionId/attachments/:attachmentId/retry')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  async retry(
    @Param('sessionId') sessionId: string,
    @Param('attachmentId') attachmentId: string,
    @UploadedFile() file: AttachmentUploadFile,
    @Headers('x-actor-type') actorType?: string,
    @Headers('x-agent-id') agentId?: string
  ) {
    assertHumanAttachmentUpload(actorType, agentId);
    this.sessions.get(sessionId);
    if (!file) throw new BadRequestException('A replacement file is required.');
    return ok(await this.attachments.retry(sessionId, attachmentId, file));
  }

  @Post('sessions/:sessionId/attachments/:attachmentId/recognition/retry')
  async retryRecognition(
    @Param('sessionId') sessionId: string,
    @Param('attachmentId') attachmentId: string,
    @Headers('x-actor-type') actorType?: string,
    @Headers('x-agent-id') agentId?: string
  ) {
    assertHumanAttachmentUpload(actorType, agentId);
    this.sessions.get(sessionId);
    return ok(await this.attachments.retryRecognition(sessionId, attachmentId));
  }

  @Delete('sessions/:sessionId/attachments/:attachmentId')
  async remove(
    @Param('sessionId') sessionId: string,
    @Param('attachmentId') attachmentId: string,
    @Headers('x-actor-type') actorType?: string,
    @Headers('x-agent-id') agentId?: string
  ) {
    assertHumanAttachmentUpload(actorType, agentId);
    this.sessions.get(sessionId);
    return ok(await this.attachments.remove(sessionId, attachmentId));
  }
}
