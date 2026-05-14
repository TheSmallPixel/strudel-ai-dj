#!/usr/bin/env node
import { BRIDGE_DEFAULT_PORT } from '@strudel-ai-dj/dj-core';
import { BridgeServer } from './ws-server.js';

const port = Number(process.env['BRIDGE_PORT'] ?? BRIDGE_DEFAULT_PORT);
const server = new BridgeServer({ port });

const shutdown = (signal: string) => {
  console.error(`[bridge] ${signal} received, shutting down`);
  server.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
