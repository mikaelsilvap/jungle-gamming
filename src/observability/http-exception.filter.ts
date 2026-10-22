import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { logEvent } from './logger';

@Catch()
export class SafeHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    let errorCode: string | undefined;
    if (exception instanceof HttpException) {
      const body: unknown = exception.getResponse();
      if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
        && /^[A-Z0-9_]{1,80}$/.test(body.code)) errorCode = body.code;
    }
    logEvent('api', 'http_request_failed', { statusCode, errorCode }, statusCode >= 500 ? 'error' : 'warn');
    const body = exception instanceof HttpException && statusCode < 500
      ? exception.getResponse() : { statusCode, message: 'Internal server error.' };
    response.status(statusCode).json(body);
  }
}
