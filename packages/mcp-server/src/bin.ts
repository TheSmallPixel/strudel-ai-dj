#!/usr/bin/env node
import { startMcpServer } from './server.js';

const port = process.env['BRIDGE_PORT'] ? Number(process.env['BRIDGE_PORT']) : undefined;
const host = process.env['BRIDGE_HOST'];

const opts: Parameters<typeof startMcpServer>[0] = {};
if (port !== undefined) opts.bridgePort = port;
if (host !== undefined) opts.bridgeHost = host;

startMcpServer(opts).catch((e) => {
  console.error('[mcp-server] fatal:', e);
  process.exit(1);
});
