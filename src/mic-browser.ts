import { floatToInt16, SAMPLE_RATE } from './audio'

// Desktop-browser microphone, for testing the Wispr side without the
// glasses. The AudioContext runs at 16 kHz so the browser does the
// resampling for us.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('tap', Tap)
`

export async function startBrowserMic(onSamples: (s: Int16Array) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'tap')
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(floatToInt16(e.data))
  src.connect(node)
  return () => {
    node.port.onmessage = null
    src.disconnect()
    node.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
}
