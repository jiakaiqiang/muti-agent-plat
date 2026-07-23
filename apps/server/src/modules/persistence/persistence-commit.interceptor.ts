import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { concatMap } from 'rxjs';
import { PersistenceService } from './persistence.service.js';

/** 确保控制器返回成功响应前，当前请求触发的持久化写入已经完成。 */
@Injectable()
export class PersistenceCommitInterceptor implements NestInterceptor {
  constructor(private readonly persistence: PersistenceService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      concatMap(async (value) => {
        await this.persistence.flush();
        return value;
      })
    );
  }
}
