export interface WordTiming {
  text: string;
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
}

export interface TtsResult {
  /** 16-bit PCM WAV bytes. */
  wav: Buffer;
  /** Word timestamps when the provider reports them (Kokoro durations, ElevenLabs alignment). */
  words?: WordTiming[];
  /** Characters billed (for cost estimates). */
  characters: number;
  /** Voice identifier actually used, for the manifest. */
  voice: string;
}

export interface TtsProvider {
  readonly name: string;
  /** Cheap check (keys/model files present). Doesn't spend quota. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  synthesize(text: string): Promise<TtsResult>;
}
