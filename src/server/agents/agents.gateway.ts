import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AgentsService } from './agents.service.js';

@WebSocketGateway({
    cors: {
        origin: ['http://localhost:5173', 'http://localhost:38081'],
        credentials: true,
    },
})
export class AgentsGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server!: Server;

    private sessionSubscriptions = new Map<string, Map<string, () => void>>();

    constructor(private readonly agentsService: AgentsService) { }

    afterInit(server: Server) {
        console.log('WebSocket Gateway initialized');
    }

    handleConnection(client: Socket) {
        console.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        console.log(`Client disconnected: ${client.id}`);
        // Clean up subscriptions
        const subscriptions = this.sessionSubscriptions.get(client.id);
        if (subscriptions) {
            subscriptions.forEach(unsubscribe => unsubscribe());
            this.sessionSubscriptions.delete(client.id);
        }
    }

    @SubscribeMessage('subscribe_session')
    handleSubscribeSession(client: Socket, payload: { sessionId: string }) {
        const { sessionId } = payload;
        console.log(`Client ${client.id} subscribing to session ${sessionId}`);

        // Unsubscribe from previous session if any
        const existingSubscriptions = this.sessionSubscriptions.get(client.id);
        if (existingSubscriptions) {
            existingSubscriptions.forEach(unsubscribe => unsubscribe());
        }

        const subscriptions = new Map<string, () => void>();

        // Subscribe to agent chunks
        const unsubChunk = this.agentsService.addEventListener(
            'agent.chunk',
            (data: any) => {
                client.emit('agent_chunk', data);
            },
        );
        subscriptions.set('chunk', unsubChunk);

        // Subscribe to tool events
        const unsubTool = this.agentsService.addEventListener(
            'agent.tool',
            (data: any) => {
                client.emit('agent_tool', data);
            },
        );
        subscriptions.set('tool', unsubTool);

        // Subscribe to message completion
        const unsubComplete = this.agentsService.addEventListener(
            'message_complete',
            (data: any) => {
                // Ensure we only emit for the subscribed session
                if (data.sessionId === sessionId) {
                    client.emit('message_complete', data);
                }
            },
        );
        subscriptions.set('complete', unsubComplete);

        this.sessionSubscriptions.set(client.id, subscriptions);

        return { success: true };
    }

    @SubscribeMessage('unsubscribe_session')
    handleUnsubscribeSession(client: Socket) {
        const subscriptions = this.sessionSubscriptions.get(client.id);
        if (subscriptions) {
            subscriptions.forEach(unsubscribe => unsubscribe());
            this.sessionSubscriptions.delete(client.id);
        }
        return { success: true };
    }

    // Broadcast message completion to all clients
    broadcastMessageComplete(sessionId: string, content: string) {
        this.server.emit('message_complete', { sessionId, content });
    }
}
