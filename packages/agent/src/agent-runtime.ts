import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BridgeServer } from '@strudel-ai-dj/bridge';
import type { VibeJournalEntry } from '@strudel-ai-dj/dj-core';
import { NIGHT_SYSTEM_PROMPT } from './system-prompt.js';

export type AgentBackend = 'subscription' | 'api-key';

export interface AgentRuntimeOptions {
  backend?: AgentBackend;
  apiKey?: string;
  model?: string;
  bridge: BridgeServer;
  maxTokens?: number;
}

export class AgentRuntime {
  private bridge: BridgeServer;
  private model: string;
  private maxTokens: number;
  private backend: AgentBackend;
  private apiKey?: string;
  private busy = false;

  constructor(opts: AgentRuntimeOptions) {
    this.bridge = opts.bridge;
    this.model = opts.model ?? 'claude-sonnet-4-6';
    this.maxTokens = opts.maxTokens ?? 2048;
    this.backend = opts.backend ?? 'subscription';
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
  }

  /**
   * Run a single turn against Claude with the given prompt and the
   * registered MCP tools available. Returns the text the agent emitted
   * and any tool-call summaries for journaling.
   */
  async turn(prompt: string, systemAddendum?: string): Promise<AgentTurnResult> {
    if (this.busy) {
      return { text: '', toolCalls: [], skipped: 'busy' };
    }
    this.busy = true;
    const text: string[] = [];
    const toolCalls: { tool: string; args: Record<string, unknown> }[] = [];

    try {
      const options: Options = {
        model: this.model,
        maxTurns: 8,
        systemPrompt: systemAddendum
          ? `${NIGHT_SYSTEM_PROMPT}\n\n${systemAddendum}`
          : NIGHT_SYSTEM_PROMPT,
      };
      if (this.backend === 'api-key' && this.apiKey) {
        process.env['ANTHROPIC_API_KEY'] = this.apiKey;
      }

      const iter = query({ prompt, options });
      for await (const msg of iter as AsyncIterable<SDKMessage>) {
        this.collectFromMessage(msg, text, toolCalls);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { text: '', toolCalls, error: message };
    } finally {
      this.busy = false;
    }

    return { text: text.join('\n').trim(), toolCalls };
  }

  emitAgentChat(text: string): void {
    if (!text) return;
    this.bridge.broadcast({
      type: 'chat.message',
      message: {
        id: `agent_${Date.now()}`,
        timestampMs: Date.now(),
        role: 'agent',
        text,
      },
    });
  }

  journal(entry: VibeJournalEntry): void {
    this.bridge.state.appendJournal(entry);
  }

  private collectFromMessage(
    msg: SDKMessage,
    textOut: string[],
    toolOut: { tool: string; args: Record<string, unknown> }[],
  ): void {
    const m = msg as unknown as Record<string, unknown>;
    if (m['type'] === 'assistant' && m['message']) {
      const innerMessage = m['message'] as { content?: unknown };
      const content = innerMessage.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b['type'] === 'text' && typeof b['text'] === 'string') {
              textOut.push(b['text'] as string);
            } else if (b['type'] === 'tool_use') {
              toolOut.push({
                tool: String(b['name']),
                args: (b['input'] as Record<string, unknown>) ?? {},
              });
            }
          }
        }
      }
    }
  }
}

export interface AgentTurnResult {
  text: string;
  toolCalls: { tool: string; args: Record<string, unknown> }[];
  error?: string;
  skipped?: 'busy';
}
