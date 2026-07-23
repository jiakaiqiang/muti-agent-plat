import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import type {
  WorkspaceCapabilities,
  WorkspaceOperationResult,
  WorkspaceProviderKind
} from '@agent-cluster/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { BrokerGateway, type BrokerClient } from './broker-gateway.js';
import { HeartbeatTracker } from './heartbeat-tracker.js';
import { PendingRequestRegistry } from './pending-request-registry.js';

type ClientMessage =
  | {
      kind: 'workspace.register';
      payload: {
        workspaceId: string;
        providerKind: WorkspaceProviderKind;
        capabilities: WorkspaceCapabilities;
        displayName: string;
      };
    }
  | { kind: 'workspace.unregister'; payload: { workspaceId: string } }
  | { kind: 'workspace.operation.result'; payload: WorkspaceOperationResult }
  | { kind: 'workspace.heartbeat'; payload: { workspaceId: string } };

@Injectable()
export class WorkspaceBrokerTransport {
  private readonly logger = new Logger(WorkspaceBrokerTransport.name);
  private attached = false;

  constructor(
    private readonly gateway: BrokerGateway,
    private readonly pending: PendingRequestRegistry,
    private readonly heartbeats: HeartbeatTracker
  ) {}

  attach(server: Server, allowedOrigins: ReadonlySet<string> = new Set()): void {
    if (this.attached) return;
    this.attached = true;
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/workspace-broker') return;
      const origin = request.headers.origin;
      if (allowedOrigins.size > 0 && (!origin || !allowedOrigins.has(origin))) {
        socket.destroy();
        return;
      }
      const clientId = url.searchParams.get('clientId')?.trim();
      if (!clientId) {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.attachClient(webSocket, clientId);
      });
    });
  }

  private attachClient(socket: WebSocket, clientId: string): void {
    const client: BrokerClient = {
      clientId,
      send: (payload) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      }
    };
    this.gateway.attachClient(client);
    socket.on('message', (data) => {
      try {
        this.handleMessage(client, JSON.parse(data.toString()) as ClientMessage);
      } catch (error) {
        socket.send(JSON.stringify({
          kind: 'workspace.protocol.error',
          payload: { message: error instanceof Error ? error.message : String(error) }
        }));
      }
    });
    socket.on('close', () => {
      const workspaceIds = this.gateway
        .listRegistrations()
        .filter((registration) => registration.clientId === clientId)
        .map((registration) => registration.workspaceId);
      this.gateway.detachClient(clientId);
      for (const workspaceId of workspaceIds) {
        this.heartbeats.drop(workspaceId);
        this.pending.rejectByWorkspace(workspaceId, new Error('browser broker disconnected'));
      }
    });
  }

  private handleMessage(client: BrokerClient, message: ClientMessage): void {
    if (message.kind === 'workspace.register') {
      const registration = this.gateway.registerWorkspace(client, {
        clientId: client.clientId,
        ...message.payload
      });
      this.heartbeats.record(registration.workspaceId);
      client.send({ kind: 'workspace.registered', payload: registration });
      return;
    }
    if (message.kind === 'workspace.heartbeat') {
      this.heartbeats.record(message.payload.workspaceId);
      return;
    }
    if (message.kind === 'workspace.unregister') {
      if (this.gateway.unregisterWorkspace(client.clientId, message.payload.workspaceId)) {
        this.heartbeats.drop(message.payload.workspaceId);
        this.pending.rejectByWorkspace(message.payload.workspaceId, new Error('browser workspace unregistered'));
      }
      return;
    }
    if (message.kind === 'workspace.operation.result') {
      if (!this.pending.settle(message.payload)) {
        this.logger.warn(`Ignored unmatched workspace result: ${message.payload.requestId}`);
      }
      return;
    }
    throw new Error('unsupported workspace broker message');
  }
}
