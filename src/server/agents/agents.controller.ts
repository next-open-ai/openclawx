import {
    Controller,
    Delete,
    Get,
    Patch,
    Post,
    Body,
    Param,
    Res,
    Header,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { AgentsService } from './agents.service.js';
import { runForChannelStream, runForChannelCollect } from '../../core/agent/proxy/index.js';

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

    @Patch('sessions/:id')
    updateSession(@Param('id') id: string, @Body() body: { agentId?: string }) {
        const session = this.agentsService.getSession(id);
        if (!session) {
            throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
        }
        if (body.agentId != null) {
            this.agentsService.updateSessionAgentId(id, String(body.agentId));
        }
        const updated = this.agentsService.getSession(id);
        return { success: true, data: updated };
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

    @Delete('sessions/:id/messages')
    clearHistory(@Param('id') id: string) {
        const session = this.agentsService.getSession(id);
        if (!session) {
            throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
        }
        this.agentsService.clearSessionMessages(id);
        return { success: true, message: 'Messages cleared' };
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

    /** 供远程 OpenClawX 代理调用：一次性返回助手回复 */
    @Post('proxy-chat')
    async proxyChat(@Body() body: { sessionId: string; message: string; agentId?: string }) {
        const sessionId = body?.sessionId ?? '';
        const message = body?.message ?? '';
        const agentId = body?.agentId ?? 'default';
        if (!sessionId || !message) {
            throw new HttpException('sessionId and message are required', HttpStatus.BAD_REQUEST);
        }
        try {
            const text = await runForChannelCollect({ sessionId, message, agentId });
            return { success: true, text };
        } catch (error: any) {
            throw new HttpException(
                error?.message ?? 'Proxy chat failed',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /** 供远程 OpenClawX 代理调用：SSE 流式返回助手回复 */
    @Post('proxy-chat/stream')
    @Header('Content-Type', 'text/event-stream')
    @Header('Cache-Control', 'no-cache')
    @Header('Connection', 'keep-alive')
    async proxyChatStream(
        @Body() body: { sessionId: string; message: string; agentId?: string },
        @Res() res: Response,
    ) {
        const sessionId = body?.sessionId ?? '';
        const message = body?.message ?? '';
        const agentId = body?.agentId ?? 'default';
        if (!sessionId || !message) {
            res.status(400).json({ error: 'sessionId and message are required' });
            return;
        }
        res.flushHeaders();
        try {
            await runForChannelStream(
                { sessionId, message, agentId },
                {
                    onChunk(delta: string) {
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    },
                    onDone() {
                        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                        res.end();
                    },
                },
            );
        } catch (error: any) {
            res.write(`data: ${JSON.stringify({ error: error?.message ?? 'Stream failed' })}\n\n`);
            res.end();
        }
    }
}
