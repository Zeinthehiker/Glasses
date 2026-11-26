import { int16ToBase64, PacketChunker, samplesForMs } from './audio'
import type { CaptionEngine, EngineEvents } from './engine'
import { Transcript } from './transcript'

// ElevenLabs Scribe realtime speech-to-text.
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
//
// One long-lived WebSocket. We stream 16 kHz PCM in 100 ms chunks and let
// the server's voice activity detection decide where sentences end:
//   -> { message_type: "partial_transcript",   text }   while speaking
//   -> { message_type: "committed_transcript", text }   after a pause
//
// Browsers can't set the xi-api-key header on a WebSocket, so the phone
// first swaps the API key for a single-use token over HTTPS.

export const ELEVEN_API = 'https://api.elevenlabs.io'
export const ELEVEN_WS = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
export const ELEVEN_MODEL = 'scribe_v3_live'

export interface ElevenLabsConfig {
  apiKey: string
  /** ISO 639-1/3 codes. First is the main language. Several = switch between them. Empty = auto-detect. */
  languages: string[]
  /** Names and jargon to bias towards (max 100 terms; ElevenLabs adds ~20% to the price). */
  keyterms: string[]
  /** Ignore speech in the background (other conversations, TV). */
  filterBackground: boolean
  /** Silence that ends a sentence. */
  silenceSecs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
}

const CHUNK_MS = 100
const ERROR_TYPES = new Set([
  'error',
  'auth_error',
  'quota_exceeded',
  'transcriber_error',
  'input_error',
  'invalid_request',
  'commit_throttled',
  'unaccepted_terms',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'chunk_size_exceeded',
  'insufficient_audio_activity',
])
/** Errors where reconnecting will not help. */
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request'])

export function buildRealtimeUrl(cfg: ElevenLabsConfig, token: string): string {
  const p = new URLSearchParams({
    model_id: ELEVEN_MODEL,
    token,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: String(cfg.silenceSecs ?? 0.8),
    include_language_detection: 'true',
  })
  const langs = cfg.languages.map((l) => l.trim().toLowerCase()).filter(Boolean)
  if (langs.length >= 1) p.set('language_code', langs[0])
  if (langs.length > 1) {
    for (const l of langs.slice(1)) p.append('secondary_languages', l)
    // Follow switches between languages mid-conversation, each in its own script.
    p.set('multilang_mode', 'true')
  }
  const terms = cfg.keyterms.map((t) => t.trim()).filter(Boolean).slice(0, 100)
  for (const t of terms) p.append('keyterms', t)
  if (cfg.filterBackground) p.set('filter_background_audio', 'true')
  return `${ELEVEN_WS}?${p.toString()}`
}

/** Swap the API key for a single-use token (valid 15 minutes, consumed on connect). */
export async function mintToken(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${ELEVEN_API}/v1/single-use-token/realtime_scribe`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey.trim() },
  })
  if (res.status === 401 || res.status === 403) throw new FatalError('ElevenLabs rejected the API key')
  if (!res.ok) throw new Error(`ElevenLabs token request failed (${res.status})`)
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error('ElevenLabs returned no token')
  return body.token
}

class FatalError extends Error {}

export class ElevenLabsCaptioner implements CaptionEngine {
  readonly transcript = new Transcript()
  private ws: WebSocket | null = null
  private ready = false
  private running = false
  private paused = false
  private connecting = false
  private segment = 1
  private backoffMs = 500
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly chunker: PacketChunker
  private generation = 0

  constructor(
    private readonly cfg: ElevenLabsConfig,
    private readonly events: EngineEvents,
  ) {
    this.chunker = new PacketChunker(samplesForMs(CHUNK_MS), (chunk) => this.send(chunk))
  }

  get isPaused(): boolean {
    return this.paused
  }

  start(): void {
    this.running = true
    this.paused = false
    this.events.onStatus('listening')
    void this.connect()
  }

  stop(): void {
    this.running = false
    this.disconnect()
    this.events.onStatus('idle')
  }

  setPaused(paused: boolean): void {
    if (!this.running || this.paused === paused) return
    this.paused = paused
    // Close the socket while paused: nothing is billed and no idle timeout fires.
    if (paused) this.disconnect()
    else void this.connect()
    this.events.onStatus(paused ? 'paused' : 'listening')
  }

  clear(): void {
    this.transcript.clear()
    this.events.onCaption('')
  }

  pushSamples(samples: Int16Array): void {
    if (!this.running || this.paused) return
    this.chunker.push(samples)
  }

  tick(): void {
    if (this.running && !this.paused && !this.ws && !this.connecting && !this.retryTimer) void this.connect()
  }

  private send(chunk: Int16Array): void {
    // Audio that arrives while (re)connecting is dropped: captions are live,
    // replaying stale audio later would only add lag.
    if (!this.ready || !this.ws) return
    this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: int16ToBase64(chunk) }))
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.ws) return
    this.connecting = true
    const gen = ++this.generation
    let token: string
    try {
      token = await mintToken(this.cfg.apiKey, this.cfg.fetchImpl)
    } catch (err) {
      this.connecting = false
      this.fail(err instanceof Error ? err.message : String(err), err instanceof FatalError)
      return
    }
    if (gen !== this.generation || !this.running || this.paused) {
      this.connecting = false
      return
    }

    const WS = this.cfg.WebSocketImpl ?? WebSocket
    const ws = new WS(buildRealtimeUrl(this.cfg, token))
    this.ws = ws
    this.connecting = false

    ws.onmessage = (ev) => this.handle(ev.data)
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.ready = false
      this.chunker.reset()
      if (this.running && !this.paused) {
        this.fail(ev.reason ? `Connection closed: ${ev.reason}` : 'Connection lost, reconnecting', false)
      }
    }
  }

  private disconnect(): void {
    this.generation++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    this.ready = false
    this.chunker.reset()
    // Keep whatever was half-said on screen as final.
    const last = this.transcript.utterances.find((u) => u.id === this.segment)
    if (last && !last.final) {
      this.transcript.upsert(this.segment, last.text, true)
      this.segment++
    }
    try {
      ws?.close()
    } catch {
      /* already closed */
    }
  }

  private fail(message: string, fatal: boolean): void {
    this.events.onError(message)
    if (fatal) {
      this.stop()
      return
    }
    if (!this.running || this.paused || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000)
  }

  private handle(raw: unknown): void {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const type: string = msg.message_type
    if (type === 'session_started') {
      this.ready = true
      this.backoffMs = 500
      return
    }
    if (type === 'partial_transcript') {
      const text = String(msg.text ?? '')
      if (!text.trim()) return
      this.transcript.upsert(this.segment, text, false)
      this.events.onStatus('hearing')
      this.events.onCaption(this.transcript.text())
      if (msg.language_code) this.events.onLanguage?.(msg.language_code)
      return
    }
    if (type === 'committed_transcript') {
      this.transcript.upsert(this.segment, String(msg.text ?? ''), true)
      this.segment++
      this.events.onStatus('listening')
      this.events.onCaption(this.transcript.text())
      return
    }
    if (type === 'committed_transcript_with_timestamps') {
      if (msg.language_code) this.events.onLanguage?.(msg.language_code)
      return
    }
    if (ERROR_TYPES.has(type)) {
      const detail = typeof msg.error === 'string' ? msg.error : type.replace(/_/g, ' ')
      // The socket closes after an error; onclose schedules the reconnect.
      const fatal = FATAL.has(type)
      this.events.onError(`ElevenLabs: ${detail}`)
      if (fatal) this.stop()
    }
  }
}
