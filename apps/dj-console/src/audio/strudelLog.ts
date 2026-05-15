/**
 * Captures Strudel's console output into a rolling buffer so the agent can
 * ask "what happened with my last evaluation?" via a bridge tool.
 *
 * Strudel logs lines like:
 *   [eval] code updated
 *   [cyclist] start / [cyclist] stop
 *   [sampler] load sound "bd:0:0"... done!
 *   [getTrigger] error: sound supersquare not found!
 *
 * We monkey-patch `console.log`, `console.error`, and `console.warn` and
 * filter for messages that look Strudel-flavoured (start with `[<word>]` or
 * the `%c[<word>]` Strudel formatting prefix). Everything else passes through
 * untouched.
 */

const MAX_ENTRIES = 200;
const PATTERN = /^(?:%c)?\[(eval|cyclist|sampler|getTrigger|superdough|core|strudel)\]/i;

export interface StrudelLogEntry {
  timestampMs: number;
  level: 'log' | 'warn' | 'error';
  text: string;
}

const buffer: StrudelLogEntry[] = [];
let installed = false;

function pushEntry(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  if (args.length === 0) return;
  // Strudel uses `console.log('%c[scope] ...', 'css')` — strip the trailing CSS arg.
  let text: string;
  if (typeof args[0] === 'string' && args[0].startsWith('%c')) {
    text = String(args[0]).replace(/%c/g, '').trim();
  } else {
    text = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');
  }
  if (!PATTERN.test(text)) return;
  buffer.push({ timestampMs: Date.now(), level, text });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function installStrudelLogCapture(): void {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args: unknown[]) => {
    pushEntry('log', args);
    orig.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    pushEntry('warn', args);
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    pushEntry('error', args);
    orig.error(...args);
  };
}

export function readStrudelLogSince(sinceMs?: number): StrudelLogEntry[] {
  if (sinceMs === undefined) return buffer.slice();
  return buffer.filter((e) => e.timestampMs >= sinceMs);
}

export function summarizeStrudelLog(sinceMs?: number, limit = 40): string {
  const entries = readStrudelLogSince(sinceMs);
  if (entries.length === 0) return 'no Strudel log entries';
  // Deduplicate consecutive identical messages (Strudel often repeats them).
  const compact: { count: number; entry: StrudelLogEntry }[] = [];
  for (const e of entries) {
    const last = compact[compact.length - 1];
    if (last && last.entry.text === e.text && last.entry.level === e.level) {
      last.count += 1;
    } else {
      compact.push({ count: 1, entry: e });
    }
  }
  const tail = compact.slice(-limit);
  return tail
    .map(({ count, entry }) => {
      const ago = Math.round((Date.now() - entry.timestampMs) / 1000);
      const reps = count > 1 ? ` (×${count})` : '';
      const prefix = entry.level === 'error' ? '✗' : entry.level === 'warn' ? '!' : '·';
      return `${prefix} ${ago}s ago: ${entry.text}${reps}`;
    })
    .join('\n');
}
