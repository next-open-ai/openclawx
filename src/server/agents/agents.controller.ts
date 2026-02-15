import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Header,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { AgentsService } from './agents.service.js';

@Controller('agents')
export class AgentsController {
    constructor(private readonly agentsService: AgentsService) { }

    @Post('sessions')
    async createSession(
        @Body() body: { id?: string; agentId?: string; workspace?: string; provider?: string; model?: string; title?: string; type?: 'chat' | 'scheduled' | 'system' },
    ) {
        try {
            const session = await this.agentsService.createSession(body);
            return {
                success: true,
                data: session,
            };
        } catch (error: any) {
            throw new HttpException(
                error.message || 'Failed to create session',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('sessions')
    @Header('Cache-Control', 'no-store')
    getSessions() {
        const sessions = this.agentsService.getSessions();
        return {
            success: true,
            data: sessions,
        };
    }

    @Get('sessions/:id')
    getSession(@Param('id') id: string) {
        const session = this.agentsService.getSession(id);
        if (!session) {
            throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
        }
        return {
            success: true,
            data: session,
        };
    }

    @Delete('sessions/:id')
    async deleteSession(@Param('id') id: string) {
        await this.agentsService.deleteSession(id);
        return {
            success: true,
            message: 'Session deleted',
        };
    }

    @Get('sessions/:id/history')
    getHistory(@Param('id') id: string) {
        const history = this.agentsService.getMessageHistory(id);
        return {
            success: true,
            data: history,
        };
    }

    @Post('sessions/:id/messages')
    appendMessage(
        @Param('id') id: string,
        @Body() body: { role: 'user' | 'assistant'; content: string; toolCalls?: any[]; contentParts?: any[] },
    ) {
        this.agentsService.appendMessage(id, body.role, body.content, {
            toolCalls: body.toolCalls,
            contentParts: body.contentParts,
        });
        return { success: true };
    }
}
