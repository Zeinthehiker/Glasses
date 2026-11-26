import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { RenderMode } from './glasses/display'

export type MicSource = 'glasses' | 'phone'
export type SpeakerFilter = 'everyone' | 'others' | 'me'

export type EngineName = 'elevenlabs' | 'wispr'

export interface Settings {
  engine: EngineName
  elevenlabsKey: string
  /** Wispr Flow key (API access is invite-only). */
  apiKey: string
  isClientToken: boolean
  /** ElevenLabs: ignore background conversations and TV. */
  filterBackground: boolean
  /** ISO 639-1 codes, e.g. ["en", "ar", "fr"]. Empty = auto-detect. */
  languages: string[]
  dictionary: string[]
  mic: MicSource
  render: RenderMode
  speakers: SpeakerFilter
  /** Wispr only. Lower = picks up quieter speech (and more background noise). */
  sensitivity: number
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'elevenlabs',
  elevenlabsKey: '',
  apiKey: '',
  isClientToken: false,
  filterBackground: false,
  languages: ['en'],
  dictionary: [],
  mic: 'glasses',
  render: 'auto',
  speakers: 'everyone',
  sensitivity: 0.012,
}

const KEY = 'flow-captions.settings.v1'

/**
 * Settings live in the Even app's own storage on the phone (or the browser's
 * localStorage during desktop development). They are never part of the build,
 * so the API key never ends up in the repository or the .ehpk package.
 */
export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  let raw = ''
  try {
    raw = bridge ? await bridge.getLocalStorage(KEY) : (localStorage.getItem(KEY) ?? '')
  } catch {
    raw = ''
  }
  let parsed: Partial<Settings> = {}
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = {}
  }
  const settings = { ...DEFAULT_SETTINGS, ...parsed }
  // Desktop development convenience only, see .env.example.
  if (import.meta.env.DEV) {
    const env = import.meta.env as Record<string, string | undefined>
    if (!settings.elevenlabsKey && env.VITE_ELEVENLABS_API_KEY) settings.elevenlabsKey = env.VITE_ELEVENLABS_API_KEY
    if (!settings.apiKey && env.VITE_WISPR_API_KEY) settings.apiKey = env.VITE_WISPR_API_KEY
  }
  return settings
}

export function activeKey(s: Settings): string {
  return s.engine === 'elevenlabs' ? s.elevenlabsKey : s.apiKey
}

export async function saveSettings(bridge: EvenAppBridge | null, settings: Settings): Promise<void> {
  const raw = JSON.stringify(settings)
  if (bridge) await bridge.setLocalStorage(KEY, raw)
  else localStorage.setItem(KEY, raw)
}

export function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseLanguages(input: string): string[] {
  return parseList(input.toLowerCase()).filter((c) => /^[a-z]{2,3}$/.test(c))
}
