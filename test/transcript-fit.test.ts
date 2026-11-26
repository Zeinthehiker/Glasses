import { describe, expect, it } from 'vitest'
import { measureTextWrap } from '@evenrealities/pretext'
import { Transcript } from '../src/transcript'
import { hasUnsupportedGlyphs, tailThatFits } from '../src/glasses/fit'

describe('Transcript', () => {
  it('orders utterances and replaces partials with finals', () => {
    const t = new Transcript()
    t.upsert(2, 'world', false)
    t.upsert(1, 'hello', false)
    t.upsert(1, 'Hello,', true)
    t.upsert(1, 'stale partial', false)
    expect(t.text()).toBe('Hello, world')
  })

  it('drops utterances that end up empty', () => {
    const t = new Transcript()
    t.upsert(1, 'um', false)
    t.upsert(1, '', true)
    expect(t.utterances).toHaveLength(0)
  })

  it('does not add spaces between CJK utterances', () => {
    const t = new Transcript()
    t.upsert(1, '你好', true)
    t.upsert(2, '世界', true)
    expect(t.text()).toBe('你好世界')
  })
})

describe('glasses text fitting', () => {
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')

  it('keeps short text unchanged', () => {
    expect(tailThatFits('hello world', 568, 9)).toBe('hello world')
  })

  it('keeps the newest words that fit in the line budget', () => {
    const tail = tailThatFits(long, 568, 3)
    expect(long.endsWith(tail)).toBe(true)
    expect(measureTextWrap(tail, 568).lineCount).toBeLessThanOrEqual(3)
    // and it is the longest such tail: adding one more word overflows
    const words = long.split(' ')
    const n = tail.split(' ').length
    expect(measureTextWrap(words.slice(-(n + 1)).join(' '), 568).lineCount).toBeGreaterThan(3)
  })

  it('detects scripts the firmware font cannot draw', () => {
    expect(hasUnsupportedGlyphs('Hello, déjà vu, привет, こんにちは')).toBe(false)
    expect(hasUnsupportedGlyphs('مرحبا')).toBe(true)
    expect(hasUnsupportedGlyphs('שלום')).toBe(true)
  })
})
