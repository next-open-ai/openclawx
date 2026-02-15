import { Module } from '@nestjs/common';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentConfigModule } from '../agent-config/agent-config.module.js';

@Module({
    imports: [AgentsModule, AgentConfigModule],
    controllers: [SkillsController],
    providers: [SkillsService],
    exports: [SkillsService],
})
export class SkillsModule {}
