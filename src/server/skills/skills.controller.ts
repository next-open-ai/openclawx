import { Controller, Get, Post, Delete, Param, Query, Body, HttpException, HttpStatus } from '@nestjs/common';
import { SkillsService } from './skills.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { AgentConfigService } from '../agent-config/agent-config.service.js';

@Controller('skills')
export class SkillsController {
    constructor(
        private readonly skillsService: SkillsService,
        private readonly agentsService: AgentsService,
        private readonly agentConfigService: AgentConfigService,
    ) {}

    @Get()
    async getSkills(
        @Query('workspace') workspace?: string,
        @Query('scope') scope?: string,
    ) {
        if (scope === 'global') {
            const skills = await this.skillsService.getGlobalSkills();
            return { success: true, data: skills };
        }
        const skills = workspace
            ? await this.skillsService.getSkillsForWorkspace(workspace)
            : await this.skillsService.getSkills();
        return { success: true, data: skills };
    }

    /** 静态 POST 路由放在 :name 等参数路由之前，确保能被正确匹配 */
    @Post('install')
    async installSkill(
        @Body()
        body: {
            url: string;
            scope?: 'global' | 'workspace';
            workspace?: string;
            sessionId?: string;
            /** 安装目标：具体 agentId，或 "global"|"all" 表示全局；优先于 sessionId */
            targetAgentId?: string;
        },
    ) {
        const url = body?.url?.trim();
        if (!url) {
            throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
        }
        let scope: 'global' | 'workspace' = body?.scope ?? 'global';
        let workspace: string | undefined = body?.workspace;

        const tid = (body?.targetAgentId ?? '').trim().toLowerCase();
        if (tid === 'global' || tid === 'all') {
            scope = 'global';
            workspace = undefined;
        } else if (body?.targetAgentId?.trim()) {
            const agent = await this.agentConfigService.getAgent(body.targetAgentId!.trim());
            if (agent?.workspace) {
                scope = 'workspace';
                workspace = agent.workspace;
            }
        } else if (body?.sessionId) {
            const session = this.agentsService.getSession(body.sessionId);
            const agentId = session?.agentId ?? 'default';
            const agent = await this.agentConfigService.getAgent(agentId);
            if (agent?.workspace) {
                scope = 'workspace';
                workspace = agent.workspace;
            }
        }

        const result = await this.skillsService.installSkillByUrl(url, {
            scope,
            workspace: scope === 'workspace' ? workspace ?? 'default' : undefined,
        });
        return { success: true, data: result };
    }

    @Post('install-from-path')
    async installSkillFromPath(
        @Body()
        body: {
            path: string;
            scope?: 'global' | 'workspace';
            workspace?: string;
            targetAgentId?: string;
        },
    ) {
        const localPath = body?.path?.trim();
        if (!localPath) {
            throw new HttpException('path is required', HttpStatus.BAD_REQUEST);
        }
        let scope: 'global' | 'workspace' = body?.scope ?? 'global';
        let workspace: string | undefined = body?.workspace;

        const tid = (body?.targetAgentId ?? '').trim().toLowerCase();
        if (tid === 'global' || tid === 'all') {
            scope = 'global';
            workspace = undefined;
        } else if (body?.targetAgentId?.trim()) {
            const agent = await this.agentConfigService.getAgent(body.targetAgentId!.trim());
            if (agent?.workspace) {
                scope = 'workspace';
                workspace = agent.workspace;
            }
        }

        const result = await this.skillsService.installSkillFromPath(localPath, {
            scope,
            workspace: scope === 'workspace' ? workspace ?? 'default' : undefined,
        });
        return { success: true, data: result };
    }

    @Get(':name')
    async getSkill(@Param('name') name: string) {
        const skill = await this.skillsService.getSkill(name);
        if (!skill) {
            throw new HttpException('Skill not found', HttpStatus.NOT_FOUND);
        }
        return { success: true, data: skill };
    }

    @Get(':name/content')
    async getSkillContent(
        @Param('name') name: string,
        @Query('workspace') workspace?: string,
    ) {
        const content = workspace
            ? await this.skillsService.getSkillContentForWorkspace(workspace, name)
            : await this.skillsService.getSkillContent(name);
        if (!content) {
            throw new HttpException('Skill not found', HttpStatus.NOT_FOUND);
        }
        return { success: true, data: { content } };
    }

    @Post()
    async addSkill(
        @Body() body: { workspace: string; name: string; description?: string; content?: string },
    ) {
        const { workspace, name, description, content } = body;
        if (!workspace || !name) {
            throw new HttpException('workspace and name are required', HttpStatus.BAD_REQUEST);
        }
        const skill = await this.skillsService.addSkill(workspace, name, {
            description,
            content,
        });
        return { success: true, data: skill };
    }

    @Delete(':name')
    async deleteSkill(
        @Param('name') name: string,
        @Query('workspace') workspace?: string,
        @Query('scope') scope?: string,
    ) {
        if (scope === 'global') {
            await this.skillsService.deleteGlobalSkill(name);
            return { success: true };
        }
        if (!workspace) {
            throw new HttpException('workspace query is required', HttpStatus.BAD_REQUEST);
        }
        await this.skillsService.deleteSkill(workspace, name);
        return { success: true };
    }
}
