import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const result = await this.health.ready();
    if (!result.ready) throw new ServiceUnavailableException({ status: 'unavailable' });
    return { status: 'ok' };
  }

}
