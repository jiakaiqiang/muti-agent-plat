import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ApiError } from './api-response.js';

type JsonResponse = {
  status: (statusCode: number) => { json: (body: unknown) => void };
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const status = this.statusFor(exception);
    const message = this.messageFor(exception);
    const structured = this.structuredResponse(exception);
    const error: ApiError = {
      error: {
        code: structured?.code ?? this.codeFor(status, message),
        message,
        ...(structured?.details ? { details: structured.details } : {})
      },
      requestId: crypto.randomUUID()
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }
    response.status(status).json(error);
  }

  private structuredResponse(exception: unknown): { code?: string; details?: Record<string, unknown> } | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const response = exception.getResponse();
    if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined;
    const record = response as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const details = Object.fromEntries(
      Object.entries(record).filter(([key]) => !['code', 'message', 'statusCode', 'error'].includes(key))
    );
    return { ...(code ? { code } : {}), ...(Object.keys(details).length ? { details } : {}) };
  }

  private statusFor(exception: unknown) {
    if (exception instanceof HttpException) return exception.getStatus();
    if (typeof exception === 'object' && exception !== null && 'type' in exception) {
      const type = (exception as { type?: unknown }).type;
      if (type === 'entity.too.large') return HttpStatus.PAYLOAD_TOO_LARGE;
    }
    if (exception instanceof SyntaxError && 'body' in exception) return HttpStatus.BAD_REQUEST;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private messageFor(exception: unknown) {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return response;
      }
      if (typeof response === 'object' && response !== null && 'message' in response) {
        const message = (response as { message?: unknown }).message;
        return Array.isArray(message) ? message.join('; ') : String(message);
      }
    }
    return exception instanceof Error ? exception.message : 'Internal server error';
  }

  private codeFor(status: number, message: string) {
    if (message.includes('Session not found')) return 'SESSION_NOT_FOUND';
    if (message.includes('Invalid session transition')) return 'INVALID_SESSION_TRANSITION';
    if (message.includes('Brief not found')) return 'BRIEF_NOT_FOUND';
    if (message.includes('Agent not found')) return 'AGENT_NOT_FOUND';
    if (message.includes('Artifact not found')) return 'ARTIFACT_NOT_FOUND';
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) return 'PAYLOAD_TOO_LARGE';
    if (status === HttpStatus.BAD_REQUEST) return 'VALIDATION_ERROR';
    if (status === HttpStatus.NOT_FOUND) return 'RESOURCE_NOT_FOUND';
    return 'INTERNAL_ERROR';
  }
}
