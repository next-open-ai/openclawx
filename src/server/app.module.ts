import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { AgentConfigModule } from './agent-config/agent-config.module.js';
import { SkillsModule } from './skills/skills.module.js';
import { ConfigModule } from './config/config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { UsageModule } from './usage/usage.module.js';
import { SavedItemsModule } from './saved-items/saved-items.module.js';

@Module({
    imports: [
        DatabaseModule,
        AgentsModule,
        AgentConfigModule,
        SkillsModule,
        ConfigModule,
        AuthModule,
        UsersModule,
        WorkspaceModule,
        TasksModule,
        UsageModule,
        SavedItemsModule,
    ],
})
export class AppModule {}
