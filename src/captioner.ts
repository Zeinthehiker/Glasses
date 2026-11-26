import { PacketChunker, bytesToInt16 } from './audio'
import { Segmenter, type SegmenterOptions } from './segmenter'
import { Transcript } from './transcript'
import { WisprSession, samplesPerPacket, type WisprConfig } from './wispr'

export interface CaptionerEvents {
  onCaption(text: string): void
  onStatus(status: CaptionerStatus): void
  onError(message: string): void
  onLanguage?(code: string): void
}

export type CaptionerStatus = 'idle' | 'listening' | 'hearing' | 'paused'

/**
 * Glue between the microphone, the utterance segmenter and Wispr sessions.
 * Feed it raw PCM with `pushBytes`/`pushSamples`; it emits caption text.
 */
export class Captioner {
  readonly transcript = new Transcript()
  private readonly chunker: PacketChunker
  private readonly segmenter: Segmenter
  private sessions = new Map<number, WisprSession>()
  private utteranceOf = new WeakMap<WisprSession, number>()
  private standby: WisprSession | null = null
  private running = false
  private paused = false
  private lastErrorAt = 0

  constructor(
    private readonly cfg: WisprConfig,
    private readonly events: CaptionerEvents,
    segmenterOpts: Partial<SegmenterOptions> = {},
  ) {
    this.chunker = new PacketChunker(samplesPerPacket(cfg.packetMs), (p) => this.segmenter.push(p))
    this.segmenter = new Segmenter(
      {
        start: (id) => this.startUtterance(id),
        packet: (id, packet, level) => this.sessions.get(id)?.append(packet, level),
        end: (id) => this.endUtterance(id),
      },
      { packetMs: cfg.packetMs, ...segmenterOpts },
    )
  }

  start(): void {
    this.running = true
    this.paused = false
    this.warmUp()
    this.events.onStatus('listening')
  }

  stop(): void {
    this.running = false
    this.segmenter.flush()
    this.chunker.reset()
    this.standby?.close()
    this.standby = null
    this.events.onStatus('idle')
  }

  setPaused(paused: boolean): void {
    if (!this.running || this.paused === paused) return
    this.paused = paused
    if (paused) {
      this.segmenter.flush()
      this.chunker.reset()
    }
    this.events.onStatus(paused ? 'paused' : 'listening')
  }

  get isPaused(): boolean {
    return this.paused
  }

  clear(): void {
    this.transcript.clear()
    this.events.onCaption('')
  }

  pushBytes(bytes: Uint8Array): void {
    this.pushSamples(bytesToInt16(bytes))
  }

  pushSamples(samples: Int16Array): void {
    if (!this.running || this.paused) return
    this.chunker.push(samples)
  }

  /**
   * Keep one authenticated session ready so the first words of the next
   * utterance are not delayed by the connection handshake. Recycled every
   * 45 s in case the server drops idle sockets.
   */
  private warmUp(): void {
    if (!this.running) return
    if (this.standby && this.standby.isUsable && Date.now() - this.standby.openedAt < 45_000) return
    this.standby?.close()
    this.standby = this.newSession()
  }

  private newSession(): WisprSession {
    const session: WisprSession = new WisprSession(this.cfg, {
      onText: (text, final, lang) => {
        const id = this.utteranceOf.get(session)
        if (id === undefined) return
        this.transcript.upsert(id, text, final)
        this.events.onCaption(this.transcript.text())
        if (lang) this.events.onLanguage?.(lang)
      },
      onError: (message) => {
        // Avoid flooding the UI when the network is down.
        if (Date.now() - this.lastErrorAt > 3000) this.events.onError(message)
        this.lastErrorAt = Date.now()
      },
    })
    return session
  }

  private startUtterance(id: number): void {
    let session = this.standby
    this.standby = null
    if (!session || !session.isUsable) {
      session?.close()
      session = this.newSession()
    }
    this.utteranceOf.set(session, id)
    this.sessions.set(id, session)
    this.events.onStatus('hearing')
  }

  private endUtterance(id: number): void {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    if (this.running && !this.paused) this.events.onStatus('listening')
    if (!session) return
    void session.commit().then((text) => {
      this.transcript.upsert(id, text, true)
      this.events.onCaption(this.transcript.text())
    })
    this.warmUp()
  }

  /** Called periodically so the standby connection does not go stale. */
  tick(): void {
    if (this.running && !this.paused && !this.segmenter.inSpeech) this.warmUp()
  }
}
