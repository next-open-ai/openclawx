import { Module, forwardRef } from '@nestjs/common';
import { ConfigController } from './config.controller.js';
import { ConfigService } from './config.service.js';
import { AgentConfigModule } from '../agent-config/agent-config.module.js';

@Module({
    imports: [forwardRef(() => AgentConfigModule)],
    controllers: [ConfigController],
    providers: [ConfigService],
    exports: [ConfigService],
})
export class ConfigModule { }
