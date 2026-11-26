import { describe, expect, it } from 'vitest'
import { Segmenter } from '../src/segmenter'

const quiet = () => new Int16Array(1600)
const loud = () => new Int16Array(1600).fill(8000)

function run(seq: Array<'q' | 'L'>, opts = {}) {
  const log: string[] = []
  const seg = new Segmenter(
    {
      start: (id) => log.push(`start ${id}`),
      packet: (id) => log.push(`p${id}`),
      end: (id) => log.push(`end ${id}`),
    },
    { packetMs: 100, prerollMs: 200, hangoverMs: 300, maxSegmentMs: 1000, ...opts },
  )
  for (const s of seq) seg.push(s === 'q' ? quiet() : loud())
  return { log, seg }
}

describe('Segmenter', () => {
  it('sends nothing during silence', () => {
    expect(run(['q', 'q', 'q', 'q']).log).toEqual([])
  })

  it('opens with preroll and closes after the hangover', () => {
    const { log } = run(['q', 'q', 'L', 'L', 'q', 'q', 'q', 'q'])
    // preroll = 2 packets (the quiet one before + the loud trigger)
    expect(log).toEqual(['start 1', 'p1', 'p1', 'p1', 'p1', 'p1', 'p1', 'end 1'])
  })

  it('splits long speech into back-to-back utterances', () => {
    const { log } = run(Array(12).fill('L'))
    expect(log.filter((l) => l.startsWith('start') || l.startsWith('end'))).toEqual(['start 1', 'end 1', 'start 2'])
  })

  it('flush closes an open utterance', () => {
    const { log, seg } = run(['L', 'L'])
    seg.flush()
    expect(log.at(-1)).toBe('end 1')
    expect(seg.inSpeech).toBe(false)
  })
})
