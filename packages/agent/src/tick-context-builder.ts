import type { StateStore } from '@strudel-ai-dj/bridge';
import type {
  Provider,
  SchedulerTick,
  TickContext,
} from '@strudel-ai-dj/dj-core';
import { RECENT_DECISIONS_PER_TICK } from '@strudel-ai-dj/dj-core';

export interface BuildTickContextOptions {
  store: StateStore;
  tick: SchedulerTick;
  provider: Provider;
  scheduledPending: TickContext['scheduledPending'];
}

export async function buildTickContext(opts: BuildTickContextOptions): Promise<TickContext> {
  const { store, tick, provider } = opts;

  const chatQueue = store.drainChat();
  const feedbackQueue = store.drainFeedback();
  const trackRequestQueue = store.drainTrackRequests();

  const [nowPlaying, analysis] = await Promise.all([
    provider.nowPlaying?.() ?? Promise.resolve(null),
    Promise.resolve(null),
  ]).catch(() => [null, null]);
  if (nowPlaying) store.updateNowPlaying(nowPlaying);

  let currentPhaseName: string | null = null;
  if (store.setPlan) {
    const phase = store.setPlan.phases[store.setPlan.currentPhaseIndex];
    if (phase) currentPhaseName = phase.name;
  }

  return {
    reason: tick.reason,
    firedAtMs: tick.firedAtMs,
    transport: store.transport,
    setPlan: store.setPlan,
    currentPhaseName,
    vibeJournalRecent: store.vibeJournal.slice(-RECENT_DECISIONS_PER_TICK),
    bookmarks: store.bookmarks,
    introspect: store.introspection,
    audio: {
      strudel: store.audio.strudel,
      system: store.audio.system,
      external: store.audio.external,
    },
    provider: {
      nowPlaying: store.provider.nowPlaying,
      analysis: store.provider.analysis ?? analysis,
    },
    chatQueue,
    feedbackQueue,
    trackRequestQueue,
    visualStyle: store.visualStyle,
    visualReferences: store.visualReferences.slice(0, 5),
    scheduledPending: opts.scheduledPending,
  };
}

export function renderTickContextAsText(ctx: TickContext): string {
  const lines: string[] = [];
  lines.push(`# Tick — reason: ${ctx.reason}`);
  lines.push(`bar=${ctx.transport.bar} beat=${ctx.transport.beat} bpm=${ctx.transport.bpm}`);
  if (ctx.currentPhaseName) lines.push(`current phase: ${ctx.currentPhaseName}`);
  if (ctx.setPlan) {
    lines.push(`set phases: ${ctx.setPlan.phases.map((p) => p.name).join(' -> ')}`);
  }
  lines.push('');
  lines.push('## audio (strudel | system | external)');
  for (const stream of ['strudel', 'system', 'external'] as const) {
    const f = ctx.audio[stream];
    lines.push(
      `${stream}: rms=${f.rms.toFixed(3)} centroid=${f.spectralCentroidHz.toFixed(0)}Hz ` +
        `onsets/s=${f.onsetDensityPerSec.toFixed(2)} tempo=${f.tempoEstimateBpm?.toFixed(1) ?? 'n/a'} ` +
        `low/mid/high=${f.lowEnergy.toFixed(2)}/${f.midEnergy.toFixed(2)}/${f.highEnergy.toFixed(2)}`,
    );
  }
  if (ctx.provider.nowPlaying?.track) {
    const t = ctx.provider.nowPlaying.track;
    lines.push('');
    lines.push(`## provider: ${ctx.provider.nowPlaying.provider} - "${t.title}" by ${t.artist}`);
  }
  if (ctx.provider.analysis) {
    const a = ctx.provider.analysis;
    lines.push(`provider analysis: bpm=${a.bpm.toFixed(1)} key=${a.key} ${a.mode}`);
  }
  if (ctx.introspect) {
    lines.push('');
    lines.push(`## current pattern (${ctx.introspect.voiceCount} voices, ${ctx.introspect.notesPerBar.toFixed(1)} notes/bar):`);
    lines.push('```js');
    lines.push(ctx.introspect.patternCode);
    lines.push('```');
  }
  if (ctx.chatQueue.length > 0) {
    lines.push('');
    lines.push('## new chat messages from user:');
    for (const m of ctx.chatQueue) lines.push(`- "${m.text}"`);
  }
  if (ctx.feedbackQueue.length > 0) {
    lines.push('');
    lines.push(`## feedback signals: ${ctx.feedbackQueue.map((s) => s.kind).join(', ')}`);
  }
  if (ctx.trackRequestQueue.length > 0) {
    lines.push('');
    lines.push('## track requests pending:');
    for (const r of ctx.trackRequestQueue)
      lines.push(`- ${r.uri} when=${r.when} intent=${r.intent}`);
  }
  if (ctx.visualStyle) lines.push(`\nvisualStyle: "${ctx.visualStyle}"`);
  if (ctx.visualReferences.length > 0)
    lines.push(`${ctx.visualReferences.length} visual reference image(s) pinned`);
  if (ctx.vibeJournalRecent.length > 0) {
    lines.push('');
    lines.push('## recent journal:');
    for (const e of ctx.vibeJournalRecent.slice(-8)) {
      lines.push(`  bar ${e.bar}: ${e.decision} (${e.reason})`);
    }
  }
  return lines.join('\n');
}
