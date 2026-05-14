import type { Provider } from '@strudel-ai-dj/dj-core';

/**
 * The null provider. Always present. Has no metadata; the agent falls
 * back to audio.features and tempo estimation from the loopback stream.
 */
export class GenericProvider implements Provider {
  readonly id = 'generic' as const;
  isConnected(): boolean {
    return true;
  }
}
