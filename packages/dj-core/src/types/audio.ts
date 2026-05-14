export type AudioStreamId = 'strudel' | 'system' | 'external';

export interface AudioFeatures {
  stream: AudioStreamId;
  timestampMs: number;
  rms: number;
  peak: number;
  spectralCentroidHz: number;
  spectralFlatness: number;
  onsetDensityPerSec: number;
  tempoEstimateBpm: number | null;
  tempoConfidence: number;
  keyEstimate: string | null;
  lowEnergy: number;
  midEnergy: number;
  highEnergy: number;
}

export function emptyFeatures(stream: AudioStreamId): AudioFeatures {
  return {
    stream,
    timestampMs: 0,
    rms: 0,
    peak: 0,
    spectralCentroidHz: 0,
    spectralFlatness: 0,
    onsetDensityPerSec: 0,
    tempoEstimateBpm: null,
    tempoConfidence: 0,
    keyEstimate: null,
    lowEnergy: 0,
    midEnergy: 0,
    highEnergy: 0,
  };
}

export interface SpectrogramImage {
  stream: AudioStreamId;
  seconds: number;
  pngBase64: string;
  width: number;
  height: number;
}
