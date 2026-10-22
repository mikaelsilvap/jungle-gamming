import { Injectable, NestMiddleware } from '@nestjs/common';
import { logEvent, requestCorrelationId, withLogContext } from './logger';
import { metrics } from './metrics';

@Injectable()
export class HttpObservabilityMiddleware implements NestMiddleware {
  use(request: { headers: Record<string, string | string[] | undefined>; method: string; path: string },
    response: { setHeader(name: string, value: string): void; statusCode: number; once(event: string, callback: () => void): void },
    next: () => void): void {
    const supplied = request.headers['x-correlation-id'];
    const correlationId = requestCorrelationId(Array.isArray(supplied) ? supplied[0] : supplied);
    const startedAt = performance.now();
    response.setHeader('x-correlation-id', correlationId);
    withLogContext({ correlationId }, () => {
      logEvent('api', 'http_request_started', { method: request.method });
      response.once('finish', () => {
        const durationMs = Math.max(0, performance.now() - startedAt);
        metrics.increment('http_requests_total', { status: String(response.statusCode) });
        metrics.observe('http_request_duration_seconds', durationMs / 1_000, { status: String(Math.floor(response.statusCode / 100)) });
        logEvent('api', 'http_request_completed', { method: request.method,
          statusCode: response.statusCode, durationMs: Math.round(durationMs * 100) / 100 });
      });
      next();
    });
  }
}
