import { describe, expect, it } from 'vitest'
import { PacketChunker, bytesToInt16, int16ToBase64, rms } from '../src/audio'

describe('audio helpers', () => {
  it('decodes little-endian int16', () => {
    expect(Array.from(bytesToInt16(new Uint8Array([0x01, 0x00, 0xff, 0xff, 0x00, 0x80])))).toEqual([1, -1, -32768])
  })

  it('handles odd byte offsets without throwing', () => {
    const buf = new Uint8Array([9, 0x02, 0x00])
    expect(Array.from(bytesToInt16(buf.subarray(1)))).toEqual([2])
  })

  it('base64 encodes raw bytes', () => {
    expect(int16ToBase64(new Int16Array([1, 2]))).toBe(btoa(String.fromCharCode(1, 0, 2, 0)))
  })

  it('computes rms', () => {
    expect(rms(new Int16Array(10))).toBe(0)
    expect(rms(new Int16Array([16384, -16384]))).toBeCloseTo(0.5)
  })

  it('re-slices frames into equal packets', () => {
    const out: number[][] = []
    const c = new PacketChunker(4, (p) => out.push(Array.from(p)))
    c.push(new Int16Array([1, 2, 3]))
    c.push(new Int16Array([4, 5, 6, 7, 8, 9]))
    expect(out).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ])
  })
})
