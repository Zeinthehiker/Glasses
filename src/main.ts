import {
  AudioInputSource,
  AudioSpeakerRole,
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { bytesToInt16, rms } from './audio'
import { Captioner, type CaptionerStatus } from './captioner'
import { GlassesDisplay, MENU } from './glasses/display'
import { startBrowserMic } from './mic-browser'
import { loadSettings, parseLanguages, parseList, saveSettings, type Settings } from './settings'

const PACKET_MS = 100

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  toggle: $<HTMLButtonElement>('toggle'),
  pause: $<HTMLButtonElement>('pause'),
  clear: $<HTMLButtonElement>('clear'),
  copy: $<HTMLButtonElement>('copy'),
  badge: $('badge'),
  live: $('live'),
  level: $('level'),
  error: $('error'),
  form: $<HTMLFormElement>('settings'),
  saved: $('saved'),
  settingsCard: $<HTMLDetailsElement>('settings-card'),
}

let bridge: EvenAppBridge | null = null
let glasses: GlassesDisplay | null = null
let settings: Settings
let captioner: Captioner | null = null
let stopMic: (() => void) | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let lastStatus: CaptionerStatus = 'idle'
let lastRun: Captioner | null = null

/**
 * The Even app injects `window.flutter_inappwebview` into its WebView. In a
 * desktop browser it never appears, and the SDK would hand back a bridge
 * whose calls all fail, so check for the host before trusting the bridge.
 */
async function detectBridge(): Promise<EvenAppBridge | null> {
  const hasHost = () => typeof (window as any).flutter_inappwebview?.callHandler === 'function'
  for (let waited = 0; !hasHost() && waited < 1500; waited += 100) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!hasHost()) return null
  return waitForEvenAppBridge()
}

function langLabel(): string {
  return settings.languages.length ? settings.languages.map((l) => l.toUpperCase()).join(' ') : 'AUTO'
}

function glassesStatus(): string {
  if (!settings.apiKey) return '! Add your Wispr key in the phone app'
  switch (lastStatus) {
    case 'idle':
      return '○ Ready · tap to start'
    case 'paused':
      return '■ Paused · tap to resume'
    case 'hearing':
      return `● Live · ${langLabel()} · hearing`
    default:
      return `● Live · ${langLabel()}`
  }
}

function setStatus(status: CaptionerStatus): void {
  lastStatus = status
  const labels: Record<CaptionerStatus, string> = {
    idle: 'Idle',
    listening: 'Listening',
    hearing: 'Hearing speech',
    paused: 'Paused',
  }
  ui.badge.textContent = labels[status]
  ui.badge.className = `badge ${status === 'hearing' ? 'hearing' : status === 'idle' ? '' : 'on'}`
  ui.toggle.textContent = status === 'idle' ? 'Start captions' : 'Stop captions'
  ui.toggle.classList.toggle('stop', status !== 'idle')
  ui.pause.disabled = status === 'idle'
  ui.pause.textContent = status === 'paused' ? 'Resume' : 'Pause'
  glasses?.setPaused(status === 'paused')
  glasses?.setStatus(glassesStatus())
}

function showError(message: string | null): void {
  ui.error.hidden = !message
  ui.error.textContent = message ?? ''
  if (message) glasses?.setStatus(`! ${message}`.slice(0, 80))
}

function renderLive(): void {
  if (!captioner) return
  const items = captioner.transcript.utterances
  if (!items.length) {
    ui.live.innerHTML = '<span class="muted">Captions show up here and on your glasses.</span>'
    return
  }
  ui.live.replaceChildren(
    ...items.map((u) => {
      const span = document.createElement('span')
      span.textContent = `${u.text} `
      if (!u.final) span.className = 'partial'
      return span
    }),
  )
  ui.live.scrollTop = ui.live.scrollHeight
}

function speakerAllowed(role: AudioSpeakerRole | undefined): boolean {
  if (settings.speakers === 'everyone' || !role || role === AudioSpeakerRole.Unknown) return true
  return settings.speakers === 'me' ? role === AudioSpeakerRole.Self : role === AudioSpeakerRole.Other
}

function onAudio(event: EvenHubEvent): void {
  const audio = event.audioEvent
  if (!audio || !captioner || !audio.audioPcm?.length) return
  let samples = bytesToInt16(audio.audioPcm)
  // Frames from the filtered-out speaker become silence, so the segmenter
  // ends the utterance naturally instead of stitching two voices together.
  if (!speakerAllowed(audio.speakerRole)) samples = new Int16Array(samples.length)
  meter(samples)
  captioner.pushSamples(samples)
}

let meterAt = 0
function meter(samples: Int16Array): void {
  const now = performance.now()
  if (now - meterAt < 80) return
  meterAt = now
  ui.level.style.width = `${Math.min(100, Math.round(rms(samples) * 600))}%`
}

async function start(): Promise<void> {
  if (captioner) return
  showError(null)
  if (!settings.apiKey) {
    showError('Add your Wispr Flow API key in Settings first.')
    ui.settingsCard.open = true
    glasses?.setStatus(glassesStatus())
    return
  }

  captioner = new Captioner(
    {
      apiKey: settings.apiKey,
      isClientToken: settings.isClientToken,
      languages: settings.languages,
      dictionary: settings.dictionary,
      packetMs: PACKET_MS,
    },
    {
      onCaption: (text) => {
        glasses?.setCaption(text)
        renderLive()
      },
      onStatus: setStatus,
      onError: showError,
    },
    { minLevel: settings.sensitivity },
  )
  captioner.start()
  tickTimer = setInterval(() => captioner?.tick(), 5000)

  try {
    if (bridge) {
      const source = settings.mic === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses
      const ok = await bridge.audioControl(true, source)
      if (!ok) throw new Error(`Could not open the ${settings.mic} microphone`)
      stopMic = () => void bridge?.audioControl(false)
    } else {
      stopMic = await startBrowserMic((s) => {
        meter(s)
        captioner?.pushSamples(s)
      })
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    stop()
  }
}

function stop(): void {
  stopMic?.()
  stopMic = null
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  if (captioner) {
    captioner.stop()
    // Keep the transcript around for Copy / Clear after stopping.
    lastRun = captioner
    captioner = null
  }
  ui.level.style.width = '0'
  setStatus('idle')
}

function togglePause(): void {
  if (!captioner) return void start()
  captioner.setPaused(!captioner.isPaused)
}

function clearCaptions(): void {
  ;(captioner ?? lastRun)?.clear()
  glasses?.setCaption('')
  ui.live.innerHTML = '<span class="muted">Cleared.</span>'
}

function onGlassesEvent(event: EvenHubEvent): void {
  if (event.audioEvent) return onAudio(event)

  if (event.menuItemClickEvent) {
    const id = event.menuItemClickEvent.itemID
    if (id === MENU.togglePause) togglePause()
    if (id === MENU.clear) clearCaptions()
    return
  }

  // CLICK_EVENT is 0 and protobuf drops zero values, so a bare envelope is a tap.
  const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? (e.eventType ?? OsEventTypeList.CLICK_EVENT) : null)
  const t = typeOf(event.sysEvent) ?? typeOf(event.textEvent)
  switch (t) {
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      stop()
      void bridge?.shutDownPageContainer(1)
      break
    case OsEventTypeList.CLICK_EVENT:
      togglePause()
      break
    case OsEventTypeList.LONG_PRESS_EVENT:
      clearCaptions()
      break
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      stop()
      break
    default:
      break
  }
}

function fillForm(s: Settings): void {
  const f = ui.form.elements as any
  f.apiKey.value = s.apiKey
  f.isClientToken.checked = s.isClientToken
  f.languages.value = s.languages.join(', ')
  f.dictionary.value = s.dictionary.join(', ')
  f.mic.value = s.mic
  f.speakers.value = s.speakers
  f.render.value = s.render
  f.sensitivity.value = String(s.sensitivity)
}

function readForm(): Settings {
  const f = ui.form.elements as any
  return {
    apiKey: f.apiKey.value.trim(),
    isClientToken: f.isClientToken.checked,
    languages: parseLanguages(f.languages.value),
    dictionary: parseList(f.dictionary.value),
    mic: f.mic.value,
    speakers: f.speakers.value,
    render: f.render.value,
    sensitivity: Number(f.sensitivity.value) || 0.012,
  }
}

async function main(): Promise<void> {
  bridge = await detectBridge()
  settings = await loadSettings(bridge)
  fillForm(settings)
  if (!settings.apiKey) ui.settingsCard.open = true

  if (bridge) {
    glasses = new GlassesDisplay(bridge, settings.render)
    await glasses.init(glassesStatus())
    bridge.onEvenHubEvent(onGlassesEvent)
    // Opened from the glasses menu: start right away, no phone needed.
    bridge.onLaunchSource((source) => {
      if (source === 'glassesMenu' && settings.apiKey) void start()
    })
  } else {
    // Desktop browser: the "Microphone" setting is ignored, the computer mic is used.
    const opt = ui.form.querySelector('select[name=mic]')
    opt?.setAttribute('disabled', '')
    opt?.parentElement?.append(Object.assign(document.createElement('small'), { textContent: 'Browser mode: uses this computer\'s mic.' }))
  }

  ui.toggle.onclick = () => (captioner ? stop() : void start())
  ui.pause.onclick = togglePause
  ui.clear.onclick = clearCaptions
  ui.copy.onclick = async () => {
    const text = (captioner ?? lastRun)?.transcript.text() ?? ''
    try {
      await navigator.clipboard.writeText(text)
      ui.copy.textContent = 'Copied'
    } catch {
      ui.copy.textContent = 'Copy failed'
    }
    setTimeout(() => (ui.copy.textContent = 'Copy'), 1500)
  }
  ui.form.onsubmit = async (e) => {
    e.preventDefault()
    const wasRunning = !!captioner
    settings = readForm()
    await saveSettings(bridge, settings)
    glasses?.setMode(settings.render)
    ui.saved.hidden = false
    setTimeout(() => (ui.saved.hidden = true), 1500)
    // Language, key and mic changes need a fresh session.
    if (wasRunning) {
      stop()
      await start()
    } else {
      glasses?.setStatus(glassesStatus())
    }
  }
}

void main()
