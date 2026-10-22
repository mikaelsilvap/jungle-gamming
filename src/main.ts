import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logEvent } from './observability/logger';
import { SafeHttpExceptionFilter } from './observability/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  app.useGlobalFilters(new SafeHttpExceptionFilter());
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  logEvent('api', 'process_started', { status: 'ready' });
}

void bootstrap().catch((error: unknown) => {
  logEvent('api', 'process_startup_failed', { errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
  process.exitCode = 1;
});
