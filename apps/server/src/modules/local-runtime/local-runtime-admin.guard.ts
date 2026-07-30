import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

const MINIMUM_ADMIN_TOKEN_LENGTH = 32;

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
};

export function assertLocalRuntimeAdminConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const token = env.LOCAL_RUNTIME_ADMIN_TOKEN?.trim();
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const loopbackBypass = enabled(env.LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS);

  if (token && token.length < MINIMUM_ADMIN_TOKEN_LENGTH) {
    throw new Error(`LOCAL_RUNTIME_ADMIN_TOKEN must contain at least ${MINIMUM_ADMIN_TOKEN_LENGTH} characters.`);
  }
  if (production && loopbackBypass) {
    throw new Error('LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS cannot be enabled in production.');
  }
  if (production && !token) {
    throw new Error('LOCAL_RUNTIME_ADMIN_TOKEN is required in production.');
  }
}

@Injectable()
export class LocalRuntimeAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const configuredToken = process.env.LOCAL_RUNTIME_ADMIN_TOKEN?.trim();
    const configurationError = validateConfiguredToken(configuredToken);
    if (configurationError) throw new ServiceUnavailableException(configurationError);

    const suppliedToken = bearerToken(request.headers?.authorization);
    if (configuredToken && suppliedToken && tokensEqual(configuredToken, suppliedToken)) return true;

    if (
      process.env.NODE_ENV?.trim().toLowerCase() !== 'production' &&
      enabled(process.env.LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS) &&
      isLoopbackAddress(request.ip ?? request.socket?.remoteAddress)
    ) {
      return true;
    }

    if (!configuredToken) {
      throw new ServiceUnavailableException('Local Runtime administrator credential is not configured.');
    }
    throw new UnauthorizedException('Valid Local Runtime administrator credentials are required.');
  }
}

function validateConfiguredToken(token: string | undefined) {
  return token && token.length < MINIMUM_ADMIN_TOKEN_LENGTH
    ? `LOCAL_RUNTIME_ADMIN_TOKEN must contain at least ${MINIMUM_ADMIN_TOKEN_LENGTH} characters.`
    : undefined;
}

function bearerToken(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function tokensEqual(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function enabled(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function isLoopbackAddress(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('::ffff:127.');
}
