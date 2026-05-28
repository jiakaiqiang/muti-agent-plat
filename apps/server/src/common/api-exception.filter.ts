import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { ApiError } from './api-response.js';

type JsonResponse = {
  status: (statusCode: number) => { json: (body: unknown) => void };
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.messageFor(exception);
    const error: ApiError = {
      error: {
        code: this.codeFor(status, message),
        message
      },
      requestId: crypto.randomUUID()
    };

    response.status(status).json(error);
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
    if (message.includes('Brief not found')) return 'BRIEF_NOT_FOUND';
    if (message.includes('Agent not found')) return 'AGENT_NOT_FOUND';
    if (message.includes('Artifact not found')) return 'ARTIFACT_NOT_FOUND';
    if (status === HttpStatus.BAD_REQUEST) return 'VALIDATION_ERROR';
    if (status === HttpStatus.NOT_FOUND) return 'RESOURCE_NOT_FOUND';
    return 'INTERNAL_ERROR';
  }
}
