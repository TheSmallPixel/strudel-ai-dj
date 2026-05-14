import { WebSocketServer, type WebSocket } from 'ws';
import { BRIDGE_DEFAULT_PORT, type BridgeMessage } from '@strudel-ai-dj/dj-core';
import { StateStore } from './state-store.js';

interface Client {
  id: string;
  role: 'controller' | 'console';
  ws: WebSocket;
}

let nextClientId = 1;

export interface BridgeServerOptions {
  port?: number;
  onMessage?: (msg: BridgeMessage, from: Client) => void;
}

export class BridgeServer {
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  readonly state = new StateStore();
  private onMessage?: (msg: BridgeMessage, from: Client) => void;

  constructor(opts: BridgeServerOptions = {}) {
    const port = opts.port ?? BRIDGE_DEFAULT_PORT;
    if (opts.onMessage) this.onMessage = opts.onMessage;
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    console.error(`[bridge] listening on ws://localhost:${port}`);
  }

  broadcast(msg: BridgeMessage, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (exceptId && client.id === exceptId) continue;
      if (client.ws.readyState === 1) client.ws.send(data);
    }
  }

  sendTo(clientId: string, msg: BridgeMessage): boolean {
    const c = this.clients.get(clientId);
    if (!c || c.ws.readyState !== 1) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  sendToRole(role: 'controller' | 'console', msg: BridgeMessage): number {
    let sent = 0;
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.role === role && c.ws.readyState === 1) {
        c.ws.send(data);
        sent++;
      }
    }
    return sent;
  }

  close(): void {
    for (const c of this.clients.values()) c.ws.close();
    this.wss.close();
  }

  private handleConnection(ws: WebSocket): void {
    const id = `client_${nextClientId++}`;
    const client: Client = { id, role: 'console', ws };
    this.clients.set(id, client);
    console.error(`[bridge] connect ${id}`);

    ws.on('message', (data) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(data.toString()) as BridgeMessage;
      } catch (e) {
        console.error(`[bridge] bad json from ${id}:`, e);
        return;
      }
      this.handleMessage(client, msg);
    });

    ws.on('close', () => {
      this.clients.delete(id);
      console.error(`[bridge] disconnect ${id}`);
    });

    ws.on('error', (e) => {
      console.error(`[bridge] ws error from ${id}:`, e);
    });

    this.sendTo(id, { type: 'ping' });
  }

  private handleMessage(client: Client, msg: BridgeMessage): void {
    switch (msg.type) {
      case 'hello':
        client.role = msg.role;
        client.id = msg.clientId || client.id;
        console.error(`[bridge] hello from ${client.id} (${client.role})`);
        break;
      case 'transport.update':
        this.state.updateTransport(msg.transport);
        this.broadcast(msg, client.id);
        break;
      case 'pattern.evaluate':
        this.state.updatePatternCode(msg.code);
        this.broadcast(msg, client.id);
        break;
      case 'pattern.set_slot':
      case 'pattern.set_tempo':
      case 'pattern.hush':
      case 'pattern.introspect.request':
      case 'audio.spectrogram.request':
      case 'visual.style':
      case 'provider.play':
      case 'provider.pause':
      case 'provider.seek':
      case 'panic':
        this.sendToRole('console', msg);
        break;
      case 'pattern.introspect.response':
        this.state.updateIntrospection(msg.introspection);
        this.sendToRole('controller', msg);
        break;
      case 'audio.features':
        this.state.updateFeatures(msg.features);
        this.sendToRole('controller', msg);
        break;
      case 'audio.spectrogram.response':
        this.sendToRole('controller', msg);
        break;
      case 'chat.message':
        if (msg.message.role === 'user') this.state.pushChat(msg.message);
        this.broadcast(msg, client.id);
        break;
      case 'feedback.signal':
        this.state.pushFeedback(msg.signal);
        this.broadcast(msg, client.id);
        break;
      case 'track.request':
        this.state.pushTrackRequest(msg.request);
        this.broadcast(msg, client.id);
        break;
      case 'visual.reference':
        this.state.pushVisualReference(msg.image);
        this.broadcast(msg, client.id);
        break;
      case 'ping':
        this.sendTo(client.id, { type: 'pong' });
        break;
      case 'pong':
        break;
      default:
        // Forward unknown shapes to the other role for forward-compat.
        this.broadcast(msg, client.id);
    }
    if (this.onMessage) this.onMessage(msg, client);
  }
}
