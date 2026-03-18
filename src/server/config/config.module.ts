import { Module, forwardRef } from '@nestjs/common';
import { ConfigController } from './config.controller.js';
import { ConfigService } from './config.service.js';
import { LocalModelsService } from './local-models.service.js';
import { AgentConfigModule } from '../agent-config/agent-config.module.js';
import { AgentsModule } from '../agents/agents.module.js';

@Module({
    imports: [forwardRef(() => AgentConfigModule), AgentsModule],
    controllers: [ConfigController],
    providers: [ConfigService, LocalModelsService],
    exports: [ConfigService, LocalModelsService],
})
export class ConfigModule { }
