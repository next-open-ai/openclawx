import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service.js';
import { TasksController } from './tasks.controller.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ConfigModule } from '../config/config.module.js';
import { UsageModule } from '../usage/usage.module.js';

@Module({
    imports: [AgentsModule, ConfigModule, UsageModule],
    controllers: [TasksController],
    providers: [TasksService],
    exports: [TasksService],
})
export class TasksModule {}
