// Ordered list of utterances. A Wispr session keeps sending a growing
// partial for its utterance and then a final one, and the next utterance
// can start before the previous one is final, so each is keyed by id.

export interface Utterance {
  id: number
  text: string
  final: boolean
  at: number
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/

export class Transcript {
  private items: Utterance[] = []
  private readonly maxItems: number

  constructor(maxItems = 200) {
    this.maxItems = maxItems
  }

  upsert(id: number, text: string, final: boolean): void {
    const clean = text.replace(/\s+/g, ' ').trim()
    const existing = this.items.find((u) => u.id === id)
    if (existing) {
      if (existing.final && !final) return
      existing.text = clean
      existing.final = final
    } else {
      this.items.push({ id, text: clean, final, at: Date.now() })
      this.items.sort((a, b) => a.id - b.id)
      if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems)
    }
    if (final && !clean) this.items = this.items.filter((u) => u.id !== id)
  }

  clear(): void {
    this.items = []
  }

  get utterances(): readonly Utterance[] {
    return this.items
  }

  /** Everything as one running caption string. */
  text(): string {
    let out = ''
    for (const u of this.items) {
      if (!u.text) continue
      if (out && !(CJK.test(out.slice(-1)) && CJK.test(u.text[0]))) out += ' '
      out += u.text
    }
    return out
  }
}
