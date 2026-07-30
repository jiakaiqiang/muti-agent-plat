import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { concatMap } from 'rxjs';
import { PersistenceService } from './persistence.service.js';
import { SKIP_PERSISTENCE_COMMIT } from './skip-persistence-commit.js';

/** 确保控制器返回成功响应前，当前请求触发的持久化写入已经完成。 */
@Injectable()
export class PersistenceCommitInterceptor implements NestInterceptor {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly reflector: Reflector
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skipCommit = this.reflector.getAllAndOverride<boolean>(SKIP_PERSISTENCE_COMMIT, [
      context.getHandler(),
      context.getClass()
    ]);
    if (skipCommit) return next.handle();

    return next.handle().pipe(
      concatMap(async (value) => {
        await this.persistence.flush();
        return value;
      })
    );
  }
}
