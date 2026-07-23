import type { LoggerService } from '@nestjs/common';

type LifecycleSnapshot = {
  pid: number;
  ppid: number;
  exitCode: number | undefined;
};

export function createProcessLifecycleHandlers(
  logger: LoggerService,
  snapshot: () => LifecycleSnapshot = () => ({
    pid: process.pid,
    ppid: process.ppid,
    exitCode: typeof process.exitCode === 'number' ? process.exitCode : undefined
  })
) {
  return {
    onUncaughtException(error: Error, origin: string) {
      logger.error(
        {
          event: 'process_uncaught_exception',
          origin,
          error: { name: error.name, message: error.message },
          ...snapshot()
        },
        error.stack,
        'ProcessLifecycle'
      );
    },
    onBeforeExit(code: number) {
      logger.warn({ event: 'process_before_exit', code, ...snapshot() }, 'ProcessLifecycle');
    },
    onExit(code: number) {
      logger.log({ event: 'process_exit', code, ...snapshot() }, 'ProcessLifecycle');
    }
  };
}

export function installProcessLifecycleLogging(logger: LoggerService) {
  const handlers = createProcessLifecycleHandlers(logger);
  process.on('uncaughtExceptionMonitor', handlers.onUncaughtException);
  process.once('beforeExit', handlers.onBeforeExit);
  process.once('exit', handlers.onExit);
}
