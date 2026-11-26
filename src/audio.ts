// PCM helpers. Everything here works on 16 kHz, mono, signed 16-bit
// little-endian PCM, which is what the G2 glasses microphone delivers and
// what Wispr Flow expects.

export const SAMPLE_RATE = 16_000

/** Interpret raw little-endian bytes as int16 samples (copies, so alignment is safe). */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1
  const out = new Int16Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Root-mean-square level, normalised to 0..1. */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Re-slices an arbitrary stream of samples into fixed-size packets.
 * Wispr asks for packets of equal duration, while the glasses deliver
 * frames of whatever size the host decided on.
 */
export class PacketChunker {
  private buf: Int16Array
  private fill = 0

  constructor(
    readonly packetSamples: number,
    private readonly onPacket: (packet: Int16Array) => void,
  ) {
    this.buf = new Int16Array(packetSamples)
  }

  push(samples: Int16Array): void {
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(this.packetSamples - this.fill, samples.length - offset)
      this.buf.set(samples.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      if (this.fill === this.packetSamples) {
        this.onPacket(this.buf)
        this.buf = new Int16Array(this.packetSamples)
        this.fill = 0
      }
    }
  }

  reset(): void {
    this.fill = 0
  }
}

export function samplesForMs(ms: number): number {
  return Math.round((SAMPLE_RATE * ms) / 1000)
}
