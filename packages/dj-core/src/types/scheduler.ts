export type ScheduledEventKind =
  | 'in_bars'
  | 'at_bar'
  | 'in_minutes'
  | 'on_silence'
  | 'on_onset_burst'
  | 'on_energy_drop'
  | 'on_loud_transient'
  | 'on_track_change'
  | 'on_track_section_change'
  | 'on_track_ending'
  | 'on_phase_boundary'
  | 'on_chat_message'
  | 'on_feedback'
  | 'on_track_request';

export interface ScheduledCallback {
  id: string;
  kind: ScheduledEventKind;
  reason: string;
  createdAtBar: number;
  fireAtBar?: number;
  fireAtMs?: number;
  recurring?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SchedulerTick {
  callbackId: string;
  kind: ScheduledEventKind;
  reason: string;
  firedAtBar: number;
  firedAtMs: number;
  metadata?: Record<string, unknown>;
}
