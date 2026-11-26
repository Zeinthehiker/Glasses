// Fallback renderer for scripts the glasses firmware cannot draw (Arabic,
// Hebrew, Devanagari, Thai...). The phone's own fonts draw the caption into a
// canvas, which is sent to the glasses as PNG tiles. Image containers are at
// most 288x144, so a 576x144 caption band is two tiles side by side.

export const BAND_W = 576
export const BAND_H = 144
export const TILE_W = 288

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/
const STRONG_LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-鿿]/

export interface ImageStyle {
  fontPx: number
  lineHeight: number
  padding: number
}

export const DEFAULT_IMAGE_STYLE: ImageStyle = { fontPx: 27, lineHeight: 34, padding: 4 }

function isRtlLine(line: string): boolean {
  for (const ch of line) {
    if (RTL.test(ch)) return true
    if (STRONG_LTR.test(ch)) return false
  }
  return false
}

export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Renders the last lines of `text` and returns two PNG tiles (left, right). */
export async function renderCaptionTiles(
  text: string,
  style: ImageStyle = DEFAULT_IMAGE_STYLE,
): Promise<[Uint8Array, Uint8Array]> {
  const canvas = document.createElement('canvas')
  canvas.width = BAND_W
  canvas.height = BAND_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas unavailable')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, BAND_W, BAND_H)
  ctx.fillStyle = '#fff'
  ctx.font = `500 ${style.fontPx}px system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Arabic", sans-serif`
  ctx.textBaseline = 'top'

  const maxLines = Math.floor((BAND_H - style.padding * 2) / style.lineHeight)
  const inner = BAND_W - style.padding * 2
  const lines = wrapLines(ctx, text, inner).slice(-maxLines)

  // Bottom-align, like subtitles.
  let y = BAND_H - style.padding - lines.length * style.lineHeight
  for (const line of lines) {
    const rtl = isRtlLine(line)
    ctx.direction = rtl ? 'rtl' : 'ltr'
    ctx.textAlign = rtl ? 'right' : 'left'
    ctx.fillText(line, rtl ? BAND_W - style.padding : style.padding, y + (style.lineHeight - style.fontPx) / 2)
    y += style.lineHeight
  }

  return [await tile(canvas, 0), await tile(canvas, TILE_W)]
}

async function tile(src: HTMLCanvasElement, x: number): Promise<Uint8Array> {
  const c = document.createElement('canvas')
  c.width = TILE_W
  c.height = BAND_H
  c.getContext('2d')!.drawImage(src, x, 0, TILE_W, BAND_H, 0, 0, TILE_W, BAND_H)
  const blob: Blob = await new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return new Uint8Array(await blob.arrayBuffer())
}
