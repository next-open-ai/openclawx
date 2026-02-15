import { Module } from '@nestjs/common';
import { AgentConfigService } from './agent-config.service.js';
import { AgentConfigController } from './agent-config.controller.js';

@Module({
    controllers: [AgentConfigController],
    providers: [AgentConfigService],
    exports: [AgentConfigService],
})
export class AgentConfigModule {}
