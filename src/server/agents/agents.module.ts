import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { AgentsGateway } from './agents.gateway.js';

@Module({
    controllers: [AgentsController],
    providers: [AgentsService, AgentsGateway],
    exports: [AgentsService],
})
export class AgentsModule { }
