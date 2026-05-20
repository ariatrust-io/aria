import { type Request } from 'express';
import type { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

export function normalizeIP(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

export function getRateLimitKey(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') return cfIp;
  return normalizeIP(req.ip);
}

export function createRedisStore(
  redis: Redis | null,
  prefix: string
): RedisStore | undefined {
  if (!redis) return undefined;
  try {
    return new RedisStore({
      sendCommand: (...args: string[]) =>
        (redis as any).call(...args) as any,
      prefix
    });
  } catch {
    return undefined;
  }
}
