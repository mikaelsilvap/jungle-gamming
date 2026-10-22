import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { logEvent } from './logger';
import { MetricRegistry } from './metrics';

export interface DiagnosticServerOptions {
  service: string;
  port: number;
  registry: MetricRegistry;
  ready?: () => Promise<boolean>;
  sample?: () => Promise<void>;
}

/** Internal process-local metrics/liveness endpoint; Compose exposes it only on its private network. */
export function startDiagnosticServer(options: DiagnosticServerOptions): { stop(): void } {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => { void serve(request, response); });
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body));
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split('?')[0];
    if (path === '/health/live') return json(response, 200, { status: 'ok' });
    if (path === '/health/ready') {
      try { const ready = options.ready ? await options.ready() : true; return json(response, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable' }); }
      catch { return json(response, 503, { status: 'unavailable' }); }
    }
    if (path === '/metrics') {
      await options.sample?.().catch(() => undefined);
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(await options.registry.render()); return;
    }
    response.writeHead(404); response.end('Not found');
  };
  server.listen(options.port, '0.0.0.0');
  logEvent(options.service, 'diagnostics_started', { port: options.port });
  return { stop: () => { server.close(); } };
}
