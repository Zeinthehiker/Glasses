import { rms } from './audio'

// Wispr Flow's streaming API is built for dictation: you open a session,
// stream audio, commit, and get the final text. For continuous captions we
// cut the microphone stream into utterances with a small energy-based voice
// activity detector and run one Wispr session per utterance. Silence is
// never sent, which also keeps usage (and cost) down.

export interface SegmenterOptions {
  /** Duration of one packet in ms. */
  packetMs: number
  /** Audio kept from before speech starts, so first syllables are not cut. */
  prerollMs: number
  /** Silence needed to close an utterance. */
  hangoverMs: number
  /** Hard cap on an utterance, so long monologues still produce final text. */
  maxSegmentMs: number
  /** Speech is detected when level > max(minLevel, noiseFloor * ratio). */
  minLevel: number
  ratio: number
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  packetMs: 100,
  prerollMs: 400,
  hangoverMs: 900,
  maxSegmentMs: 25_000,
  minLevel: 0.012,
  ratio: 2.8,
}

export interface SegmentSink {
  start(id: number): void
  packet(id: number, packet: Int16Array, level: number): void
  end(id: number): void
}

export class Segmenter {
  private readonly opts: SegmenterOptions
  private preroll: Array<{ packet: Int16Array; level: number }> = []
  private active: number | null = null
  private nextId = 1
  private silentMs = 0
  private segmentMs = 0
  private noiseFloor: number

  constructor(
    private readonly sink: SegmentSink,
    opts: Partial<SegmenterOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SEGMENTER, ...opts }
    this.noiseFloor = this.opts.minLevel / this.opts.ratio
  }

  get inSpeech(): boolean {
    return this.active !== null
  }

  get threshold(): number {
    return Math.max(this.opts.minLevel, this.noiseFloor * this.opts.ratio)
  }

  push(packet: Int16Array): void {
    const level = rms(packet)
    const speech = level > this.threshold
    const o = this.opts

    if (this.active === null) {
      // Track background noise only while nobody is talking.
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05
      this.preroll.push({ packet, level })
      const keep = Math.max(1, Math.round(o.prerollMs / o.packetMs))
      while (this.preroll.length > keep) this.preroll.shift()
      if (!speech) return
      this.open()
      return
    }

    this.sink.packet(this.active, packet, level)
    this.segmentMs += o.packetMs
    this.silentMs = speech ? 0 : this.silentMs + o.packetMs

    if (this.silentMs >= o.hangoverMs) {
      this.close()
    } else if (this.segmentMs >= o.maxSegmentMs) {
      // Still talking: roll straight into a new utterance.
      this.close()
      this.open()
    }
  }

  /** Close any open utterance, e.g. when pausing. */
  flush(): void {
    if (this.active !== null) this.close()
    this.preroll = []
  }

  private open(): void {
    const id = this.nextId++
    this.active = id
    this.silentMs = 0
    this.segmentMs = 0
    this.sink.start(id)
    for (const p of this.preroll) {
      this.sink.packet(id, p.packet, p.level)
      this.segmentMs += this.opts.packetMs
    }
    this.preroll = []
  }

  private close(): void {
    const id = this.active
    if (id === null) return
    this.active = null
    this.sink.end(id)
  }
}
