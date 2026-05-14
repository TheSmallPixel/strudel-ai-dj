import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient } from './bridge-client.js';
import { makeTools } from './tools.js';
import { zodToJsonSchema } from './zod-to-json-schema.js';

export interface McpServerOptions {
  bridgePort?: number;
  bridgeHost?: string;
}

export async function startMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const bridgeClientOpts: Parameters<typeof BridgeClient.prototype.constructor>[0] = {};
  if (opts.bridgePort !== undefined) bridgeClientOpts.port = opts.bridgePort;
  if (opts.bridgeHost !== undefined) bridgeClientOpts.host = opts.bridgeHost;
  const bridge = new BridgeClient(bridgeClientOpts);
  await bridge.connect().catch((e) => {
    console.error('[mcp-server] failed to connect to bridge:', e.message);
    console.error('[mcp-server] retrying in background...');
  });

  const tools = makeTools(bridge);

  const server = new Server(
    { name: 'strudel-ai-dj', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-server] ready on stdio');
}
