import { Controller, Get, Res } from '@nestjs/common';
import { metrics } from '../observability/metrics';
import { HealthService } from './health.service';

@Controller()
export class MetricsController {
  constructor(private readonly health: HealthService) {}

  @Get('metrics')
  async metrics(@Res({ passthrough: true }) response: { type(value: string): unknown }): Promise<string> {
    await this.health.sampleOperationalGauges();
    response.type('text/plain; version=0.0.4; charset=utf-8');
    return await metrics.render();
  }
}
