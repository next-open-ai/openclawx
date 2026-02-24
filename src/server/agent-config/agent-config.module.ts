import { Module, forwardRef } from '@nestjs/common';
import { AgentConfigService } from './agent-config.service.js';
import { AgentConfigController } from './agent-config.controller.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

@Module({
    imports: [forwardRef(() => WorkspaceModule)],
    controllers: [AgentConfigController],
    providers: [AgentConfigService],
    exports: [AgentConfigService],
})
export class AgentConfigModule {}
