import { int16ToBase64, SAMPLE_RATE } from './audio'

// Client for the Wispr Flow WebSocket API.
// Docs: https://api-docs.wisprflow.ai/websocket_api
//
// Protocol, per the docs:
//   1. connect to  wss://platform-api.wisprflow.ai/api/v1/dash/ws?api_key=Bearer%20<key>
//   2. send        { type: "auth", language: [...], context: {...} }      -> { status: "auth" }
//   3. send        { type: "append", position, audio_packets: {...} }     -> { status: "text", final: false, body: { text } }
//   4. send        { type: "commit", total_packets }                      -> { status: "text", final: true,  body: { text } }

export const WISPR_WS_URL = 'wss://platform-api.wisprflow.ai/api/v1/dash/ws'
export const WISPR_CLIENT_WS_URL = 'wss://platform-api.wisprflow.ai/api/v1/dash/client_ws'

export interface WisprConfig {
  /** Org API key (starts with "fl-") or a client access token. */
  apiKey: string
  /** Set when `apiKey` is a short-lived client token instead of the org key. */
  isClientToken?: boolean
  /** ISO 639-1 codes. One code forces that language; several are a hint; empty means auto-detect. */
  languages: string[]
  /** Names and jargon Wispr should spell correctly. */
  dictionary: string[]
  packetMs: number
  /** Give up waiting for the final transcript this long after commit. */
  finalTimeoutMs?: number
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket
}

export interface WisprCallbacks {
  onText(text: string, final: boolean, detectedLanguage?: string): void
  onError(message: string): void
}

type State = 'connecting' | 'ready' | 'committed' | 'closed'

export function buildUrl(cfg: Pick<WisprConfig, 'apiKey' | 'isClientToken'>): string {
  const auth = encodeURIComponent(`Bearer ${cfg.apiKey.trim()}`)
  return cfg.isClientToken
    ? `${WISPR_CLIENT_WS_URL}?client_key=${auth}`
    : `${WISPR_WS_URL}?api_key=${auth}`
}

export function buildAuthMessage(cfg: WisprConfig): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: 'auth',
    context: {
      app: { name: 'Even G2 live captions', type: 'other' },
      ...(cfg.dictionary.length ? { dictionary_context: cfg.dictionary } : {}),
    },
  }
  if (cfg.languages.length) msg.language = cfg.languages
  if (cfg.isClientToken) msg.access_token = cfg.apiKey.trim()
  return msg
}

/** One Wispr session = one utterance. */
export class WisprSession {
  private ws: WebSocket
  private state: State = 'connecting'
  private queue: string[] = []
  private position = 0
  private lastText = ''
  private finalTimer: ReturnType<typeof setTimeout> | null = null
  private finished = false
  private resolveFinal!: (text: string) => void
  /** Resolves with the final text once the session has ended, whatever the reason. */
  readonly final: Promise<string>
  readonly openedAt = Date.now()

  constructor(
    private readonly cfg: WisprConfig,
    private readonly cb: WisprCallbacks,
  ) {
    this.final = new Promise((r) => (this.resolveFinal = r))
    const WS = cfg.WebSocketImpl ?? WebSocket
    this.ws = new WS(buildUrl(cfg))
    this.ws.onopen = () => this.ws.send(JSON.stringify(buildAuthMessage(cfg)))
    this.ws.onmessage = (ev) => this.handle(ev.data)
    this.ws.onerror = () => {
      if (this.state === 'connecting') this.cb.onError('Could not connect to Wispr Flow')
    }
    this.ws.onclose = (ev) => {
      if (this.state === 'connecting' && !this.finished) {
        this.cb.onError(ev.reason ? `Wispr closed: ${ev.reason}` : `Wispr closed the connection (${ev.code})`)
      }
      this.state = 'closed'
      this.finish()
    }
  }

  get isUsable(): boolean {
    return this.state === 'connecting' || this.state === 'ready'
  }

  get packetsSent(): number {
    return this.position
  }

  append(packet: Int16Array, level: number): void {
    if (!this.isUsable) return
    const msg = JSON.stringify({
      type: 'append',
      position: this.position++,
      audio_packets: {
        packets: [int16ToBase64(packet)],
        volumes: [Number(level.toFixed(4))],
        packet_duration: this.cfg.packetMs / 1000,
        audio_encoding: 'wav',
        byte_encoding: 'base64',
      },
    })
    this.sendOrQueue(msg)
  }

  /** End of audio. Wispr answers with the final transcript. */
  commit(): Promise<string> {
    if (!this.isUsable) return this.final
    if (this.position === 0) {
      this.close()
      return this.final
    }
    this.sendOrQueue(JSON.stringify({ type: 'commit', total_packets: this.position }))
    this.state = 'committed'
    this.finalTimer = setTimeout(() => this.close(), this.cfg.finalTimeoutMs ?? 10_000)
    return this.final
  }

  close(): void {
    this.state = 'closed'
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
    this.finish()
  }

  private sendOrQueue(msg: string): void {
    if (this.state === 'ready' || (this.state === 'committed' && this.queue.length === 0)) {
      this.ws.send(msg)
    } else {
      this.queue.push(msg)
    }
  }

  private handle(raw: unknown): void {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    switch (msg.status) {
      case 'auth': {
        const committed = this.state === 'committed'
        if (!committed) this.state = 'ready'
        for (const q of this.queue) this.ws.send(q)
        this.queue = []
        break
      }
      case 'text': {
        const text: string = msg.body?.text ?? ''
        const isFinal = msg.final === true
        if (text || isFinal) {
          this.lastText = text || this.lastText
          this.cb.onText(this.lastText, isFinal, msg.body?.detected_language)
        }
        if (isFinal) this.close()
        break
      }
      case 'error': {
        const detail = typeof msg.message === 'string' ? msg.message : msg.detail ?? msg.error ?? 'unknown error'
        this.cb.onError(`Wispr error: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
        this.close()
        break
      }
      default:
        break
    }
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.finalTimer) clearTimeout(this.finalTimer)
    this.resolveFinal(this.lastText)
  }
}

/** Expected samples per packet for a given packet length. */
export function samplesPerPacket(packetMs: number): number {
  return Math.round((SAMPLE_RATE * packetMs) / 1000)
}
