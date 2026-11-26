import { describe, expect, it, vi } from 'vitest'
import { ElevenLabsCaptioner, buildRealtimeUrl, mintToken, type ElevenLabsConfig } from '../src/elevenlabs'

class FakeWS {
  static all: FakeWS[] = []
  sent: any[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeWS.all.push(this)
  }
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.({ code: 1000, reason: '' })
  }
  server(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

const okFetch = vi.fn(async () => new Response(JSON.stringify({ token: 'sutkn_abc' }), { status: 200 }))

const cfg = (over: Partial<ElevenLabsConfig> = {}): ElevenLabsConfig => ({
  apiKey: 'sk_secret',
  languages: ['en', 'ar'],
  keyterms: ['Zein'],
  filterBackground: false,
  fetchImpl: okFetch as unknown as typeof fetch,
  WebSocketImpl: FakeWS as unknown as typeof WebSocket,
  ...over,
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ElevenLabs realtime', () => {
  it('builds the URL with languages, keyterms and VAD commits, never the API key', () => {
    const url = new URL(buildRealtimeUrl(cfg(), 'sutkn_abc'))
    expect(url.origin + url.pathname).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime')
    const q = url.searchParams
    expect(q.get('model_id')).toBe('scribe_v3_live')
    expect(q.get('token')).toBe('sutkn_abc')
    expect(q.get('audio_format')).toBe('pcm_16000')
    expect(q.get('commit_strategy')).toBe('vad')
    expect(q.get('language_code')).toBe('en')
    expect(q.getAll('secondary_languages')).toEqual(['ar'])
    expect(q.get('multilang_mode')).toBe('true')
    expect(q.getAll('keyterms')).toEqual(['Zein'])
    expect(url.toString()).not.toContain('sk_secret')
  })

  it('auto-detects when no language is set', () => {
    const q = new URL(buildRealtimeUrl(cfg({ languages: [], keyterms: [] }), 't')).searchParams
    expect(q.has('language_code')).toBe(false)
    expect(q.has('multilang_mode')).toBe(false)
    expect(q.has('keyterms')).toBe(false)
  })

  it('mints a single-use token with the key in a header', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ token: 'sutkn_1' })))
    await expect(mintToken(' sk_x ', f as unknown as typeof fetch)).resolves.toBe('sutkn_1')
    expect(f).toHaveBeenCalledWith('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: { 'xi-api-key': 'sk_x' },
    })
  })

  it('streams audio after session_started and turns partials into final captions', async () => {
    const captions: string[] = []
    const c = new ElevenLabsCaptioner(cfg(), {
      onCaption: (t) => captions.push(t),
      onStatus: () => {},
      onError: () => {},
    })
    c.start()
    await flush()
    const ws = FakeWS.all.at(-1)!
    c.pushSamples(new Int16Array(1600)) // before session_started: dropped
    expect(ws.sent).toHaveLength(0)

    ws.server({ message_type: 'session_started', session_id: 's1' })
    c.pushSamples(new Int16Array(2400)) // 1.5 chunks of 100 ms
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0].message_type).toBe('input_audio_chunk')
    expect(ws.sent[0].audio_base_64).toHaveLength(Math.ceil(3200 / 3) * 4)

    ws.server({ message_type: 'partial_transcript', text: 'hello wor' })
    ws.server({ message_type: 'committed_transcript', text: 'Hello world.' })
    ws.server({ message_type: 'partial_transcript', text: 'مرحبا' })
    expect(captions.at(-1)).toBe('Hello world. مرحبا')
    expect(c.transcript.utterances.map((u) => u.final)).toEqual([true, false])
    c.stop()
  })

  it('stops for good on auth errors', async () => {
    const statuses: string[] = []
    const errors: string[] = []
    const c = new ElevenLabsCaptioner(cfg(), {
      onCaption: () => {},
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
    })
    c.start()
    await flush()
    FakeWS.all.at(-1)!.server({ message_type: 'auth_error', error: 'Invalid token' })
    expect(errors).toContain('ElevenLabs: Invalid token')
    expect(statuses.at(-1)).toBe('idle')
  })

  it('reports a rejected API key without opening a socket', async () => {
    const before = FakeWS.all.length
    const errors: string[] = []
    const c = new ElevenLabsCaptioner(
      cfg({ fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch }),
      { onCaption: () => {}, onStatus: () => {}, onError: (e) => errors.push(e) },
    )
    c.start()
    await flush()
    expect(errors).toEqual(['ElevenLabs rejected the API key'])
    expect(FakeWS.all.length).toBe(before)
  })
})
