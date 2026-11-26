import { describe, expect, it, vi } from 'vitest'
import { WisprSession, buildAuthMessage, buildUrl, type WisprConfig } from '../src/wispr'

class FakeWS {
  static last: FakeWS
  sent: any[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeWS.last = this
  }
  send(data: string) {
    if (this.closed) throw new Error('send after close')
    this.sent.push(JSON.parse(data))
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.({ code: 1000, reason: '' })
  }
  server(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const cfg = (over: Partial<WisprConfig> = {}): WisprConfig => ({
  apiKey: 'fl-secret',
  languages: ['en', 'ar'],
  dictionary: ['Zein'],
  packetMs: 100,
  WebSocketImpl: FakeWS as unknown as typeof WebSocket,
  ...over,
})

describe('Wispr protocol', () => {
  it('builds the documented URLs', () => {
    expect(buildUrl({ apiKey: 'fl-x' })).toBe(
      'wss://platform-api.wisprflow.ai/api/v1/dash/ws?api_key=Bearer%20fl-x',
    )
    expect(buildUrl({ apiKey: 'jwt', isClientToken: true })).toBe(
      'wss://platform-api.wisprflow.ai/api/v1/dash/client_ws?client_key=Bearer%20jwt',
    )
  })

  it('auth message carries languages and dictionary, and never the org key', () => {
    const m = buildAuthMessage(cfg())
    expect(m).toMatchObject({ type: 'auth', language: ['en', 'ar'], context: { dictionary_context: ['Zein'] } })
    expect(JSON.stringify(m)).not.toContain('fl-secret')
  })

  it('omits language for auto-detect', () => {
    expect(buildAuthMessage(cfg({ languages: [] }))).not.toHaveProperty('language')
  })

  it('queues audio until authenticated, then streams, commits and resolves the final text', async () => {
    const onText = vi.fn()
    const s = new WisprSession(cfg(), { onText, onError: vi.fn() })
    const ws = FakeWS.last
    s.append(new Int16Array(1600), 0.1)
    s.append(new Int16Array(1600), 0.2)
    ws.onopen?.()
    expect(ws.sent.map((m) => m.type)).toEqual(['auth'])

    ws.server({ status: 'auth' })
    expect(ws.sent.map((m) => m.type)).toEqual(['auth', 'append', 'append'])
    expect(ws.sent[1]).toMatchObject({
      position: 0,
      audio_packets: { volumes: [0.1], packet_duration: 0.1, audio_encoding: 'wav', byte_encoding: 'base64' },
    })
    expect(ws.sent[2].position).toBe(1)
    expect(ws.sent[1].audio_packets.packets[0]).toHaveLength(Math.ceil((1600 * 2) / 3) * 4)

    ws.server({ status: 'text', final: false, body: { text: 'hello' } })
    const final = s.commit()
    expect(ws.sent.at(-1)).toEqual({ type: 'commit', total_packets: 2 })
    ws.server({ status: 'text', final: true, body: { text: 'Hello there.', detected_language: 'en' } })
    await expect(final).resolves.toBe('Hello there.')
    expect(onText).toHaveBeenLastCalledWith('Hello there.', true, 'en')
    expect(ws.closed).toBe(true)
  })

  it('falls back to the last partial if the final never arrives', async () => {
    vi.useFakeTimers()
    const s = new WisprSession(cfg({ finalTimeoutMs: 500 }), { onText: vi.fn(), onError: vi.fn() })
    const ws = FakeWS.last
    ws.onopen?.()
    ws.server({ status: 'auth' })
    s.append(new Int16Array(1600), 0.1)
    ws.server({ status: 'text', final: false, body: { text: 'partial words' } })
    const final = s.commit()
    vi.advanceTimersByTime(600)
    await expect(final).resolves.toBe('partial words')
    vi.useRealTimers()
  })

  it('reports server errors', () => {
    const onError = vi.fn()
    new WisprSession(cfg(), { onText: vi.fn(), onError })
    FakeWS.last.onopen?.()
    FakeWS.last.server({ status: 'error', message: 'invalid api key' })
    expect(onError).toHaveBeenCalledWith('Wispr error: invalid api key')
  })
})
