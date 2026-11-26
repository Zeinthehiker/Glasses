import type { Transcript } from './transcript'

/** Common surface of the speech-to-text engines the app can use. */
export interface CaptionEngine {
  readonly transcript: Transcript
  readonly isPaused: boolean
  start(): void
  stop(): void
  setPaused(paused: boolean): void
  clear(): void
  pushSamples(samples: Int16Array): void
  /** Called every few seconds for housekeeping. */
  tick(): void
}

export type EngineStatus = 'idle' | 'listening' | 'hearing' | 'paused'

export interface EngineEvents {
  onCaption(text: string): void
  onStatus(status: EngineStatus): void
  onError(message: string): void
  onLanguage?(code: string): void
}
