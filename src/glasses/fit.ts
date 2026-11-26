import { getAdvW, measureTextWrap } from '@evenrealities/pretext'

// The glasses render text with their own firmware fonts (Latin, Cyrillic,
// Greek, CJK and emoji). @evenrealities/pretext replicates that renderer's
// metrics, so we can show exactly the last N lines that fit.

/** True when the firmware font has no glyph for some character (e.g. Arabic, Hebrew, Hindi, Thai). */
export function hasUnsupportedGlyphs(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp <= 0x20 || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff) continue
    if (getAdvW(cp) === 0) return true
  }
  return false
}

export type LineCounter = (text: string, maxWidth: number) => number

const firmwareLines: LineCounter = (text, maxWidth) => measureTextWrap(text, maxWidth).lineCount

/**
 * Longest tail of `text`, cut at a word boundary, that wraps into at most
 * `maxLines` lines of `maxWidth` pixels.
 */
export function tailThatFits(
  text: string,
  maxWidth: number,
  maxLines: number,
  countLines: LineCounter = firmwareLines,
): string {
  const t = text.trim()
  if (!t) return ''
  if (countLines(t, maxWidth) <= maxLines) return t

  // Candidate cut points: start of every word (or every char for scripts without spaces).
  const starts: number[] = []
  for (let i = 1; i < t.length; i++) {
    const prev = t[i - 1]
    if (prev === ' ' || /[぀-ヿ㐀-鿿가-힯]/.test(t[i])) starts.push(i)
  }
  if (starts.length === 0) return t.slice(-Math.max(1, Math.floor(maxWidth / 12) * maxLines))

  // Binary search for the earliest start that fits.
  let lo = 0
  let hi = starts.length - 1
  let best = starts[hi]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const candidate = t.slice(starts[mid]).trimStart()
    if (countLines(candidate, maxWidth) <= maxLines) {
      best = starts[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return t.slice(best).trimStart()
}
