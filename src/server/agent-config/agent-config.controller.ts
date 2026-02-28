import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { AgentConfigService, AgentConfigItem } from './agent-config.service.js';

@Controller('agent-config')
export class AgentConfigController {
    constructor(private readonly agentConfigService: AgentConfigService) {}

    @Get()
    async listAgents() {
        const agents = await this.agentConfigService.listAgents();
        return { success: true, data: agents };
    }

    @Get(':id')
    async getAgent(@Param('id') id: string) {
        const agent = await this.agentConfigService.getAgent(id);
        if (!agent) {
            return { success: false, data: null };
        }
        return { success: true, data: agent };
    }

    @Post()
    async createAgent(
        @Body()
        body: {
            name: string;
            workspace: string;
            provider?: string;
            model?: string;
            modelItemCode?: string;
            systemPrompt?: string;
            icon?: string;
        },
    ) {
        const agent = await this.agentConfigService.createAgent(body);
        return { success: true, data: agent };
    }

    @Put(':id')
    async updateAgent(
        @Param('id') id: string,
        @Body()
            body: Partial<
                Pick<
                    AgentConfigItem,
                    'name' | 'provider' | 'model' | 'modelItemCode' | 'mcpServers' | 'mcpMaxResultTokens' | 'systemPrompt' | 'icon' | 'runnerType' | 'coze' | 'openclawx' | 'opencode' | 'claudeCode' | 'useLongMemory' | 'webSearch'
                >
            >,
    ) {
        const agent = await this.agentConfigService.updateAgent(id, body);
        return { success: true, data: agent };
    }

    @Delete(':id')
    async deleteAgent(
        @Param('id') id: string,
        @Query('deleteWorkspaceDir') deleteWorkspaceDir?: string,
    ) {
        const options =
            deleteWorkspaceDir === 'true' || deleteWorkspaceDir === '1'
                ? { deleteWorkspaceDir: true }
                : undefined;
        await this.agentConfigService.deleteAgent(id, options);
        return { success: true };
    }
}
