# Flow Captions for Even G2

Live captions on Even Realities G2 glasses, using a stronger cloud speech-to-text engine than the Even app's built-in one, mainly for better handling of noisy audio, accents and switching between languages.

Two engines are supported:

- **ElevenLabs Scribe** (default). Self-serve API key, follows language switches mid-sentence, about $0.22 per hour of audio.
- **[Wispr Flow](https://wisprflow.ai)**. Same idea, but Wispr's API is invite-only, so it's there for if and when access is approved.

It is a personal app: one person, one phone, one API key.

## What it does

- Streams the glasses microphone (or the phone's) to the speech engine and shows live captions on the glasses, newest words at the bottom.
- Shows text as it is spoken, then replaces it with the cleaned-up final version when the sentence ends.
- Handles several languages at once. List the ones you switch between (for example `en, ar, fr`). With ElevenLabs it follows switches even mid-sentence.
- Draws scripts the glasses' built-in font can't (Arabic, Hebrew, Hindi, Thai and others) by rendering them as an image on the phone and sending that to the glasses. Latin, Cyrillic, Greek, Chinese, Japanese and Korean use the faster native text.
- Can caption only other people, only you, or everyone, using the glasses' own speaker detection.
- Can ignore background voices (TV, the next table) with ElevenLabs.
- Has a phone screen with the full transcript, Pause, Clear and Copy.

On the glasses:

| Gesture | Action |
| --- | --- |
| Tap | Start, pause or resume |
| Long press | Clear captions |
| Double tap | Exit |
| Menu | Pause/Resume, Clear captions |

## Before you start: get an API key

### ElevenLabs (recommended)

1. Sign in at [elevenlabs.io](https://elevenlabs.io) (the free plan includes a few hours of realtime transcription per month).
2. Go to **Developers > API Keys > Create API key**. If you restrict the key, it only needs **Speech to Text** access.
3. Copy the key (starts with `sk_`). You'll paste it into the app once (see "Set up your API key" below).

Realtime transcription costs about **$0.22 per hour of audio**. Adding words to "Names and words to spell right" adds about 20% to that.

### Wispr Flow (optional, invite-only)

Wispr's API is separate from the Wispr Flow app subscription and is only given to organizations Wispr approves ([docs](https://api-docs.wisprflow.ai/quickstart)). To ask, email enterprise@wisprflow.ai. If you're approved, create a key (starts with `fl-`) at [platform.wisprflow.ai](https://platform.wisprflow.ai) and choose Wispr Flow as the engine in Settings.

## Install on your phone

You need:

- G2 glasses paired with the Even app, **Even app 2.2.10 or newer**
- A computer with **Node.js 20.17+ or 22.13+**
- Phone and computer on the same Wi-Fi (for option A)

```bash
git clone https://github.com/Zeinthehiker/glasses.git
cd glasses
npm install
```

### Option A: run it from your computer (fastest, good for trying it out)

```bash
npm run dev        # starts the app on port 5173
npm run qr         # in a second terminal: prints a QR code
```

In the Even app, open the developer / Even Hub dev mode and scan the QR code. The app opens on your phone and its page appears on the glasses. It runs as long as `npm run dev` is running on your computer.

### Option B: install it properly (works without your computer)

This uploads a private build to your own Even Hub developer account and installs it through the beta channel, where you are the only tester.

```bash
npm run pack                       # builds flow-captions.ehpk
npx evenhub login                  # once, with your Even Hub developer account
npx evenhub create flow-captions.ehpk --name "Flow Captions" --tagline "Live captions on your glasses"
npx evenhub promote 0.1.0 --to beta
npx evenhub testers add you@example.com   # the email of your Even account
```

Accept the tester invite email, then install Flow Captions from the Even app. For later versions, bump `version` in `app.json`, run `npm run pack`, then `npx evenhub upload flow-captions.ehpk -m "what changed"` and promote the new version to beta.

If `create` says the package ID is taken, change `package_id` in `app.json` (for example `com.yourname.flowcaptions`).

## Set up your API key

1. Open Flow Captions on your phone.
2. Open **Settings**. Leave **Speech engine** on ElevenLabs and paste your key into **ElevenLabs API key**.
3. Set **Languages** to the languages you speak, as two-letter codes, main language first, for example `en, ar`. Leave it empty to auto-detect, which is less accurate.
4. Optional: add names and jargon to **Names and words to spell right**.
5. Tap **Save**, then **Start captions** (or tap the glasses).

### Where the key lives

- The key is saved in the Even app's storage **on your phone**. It is not in the code, not in the repo and not in the `.ehpk` package, so the repo is safe to share.
- `.env` files are git-ignored. `.env.example` documents `VITE_ELEVENLABS_API_KEY` and `VITE_WISPR_API_KEY`, which only pre-fill the keys during `npm run dev` on a computer and are ignored in production builds.
- With ElevenLabs, the phone swaps your key for a single-use token over HTTPS before each connection, so the key itself never travels in a WebSocket URL.
- The phone holds your real key either way. That's fine for a personal app. If you ever share the app, move token minting to a tiny backend so users never see your key.

## Settings reference

| Setting | What it does |
| --- | --- |
| Speech engine | ElevenLabs Scribe (default) or Wispr Flow. |
| Ignore background voices | ElevenLabs only. Filters out TV and nearby conversations. |
| Microphone | Glasses mic (default) or phone mic. |
| Whose speech | Everyone, other people only (good for conversations), or only you (good for dictation). Uses the Even app's speaker detection, so expect it to be imperfect. |
| Glasses rendering | Auto (recommended), Native text (fastest, but some scripts show as blanks), or Image (any script, slower updates). |
| Sensitivity | Wispr only. How quiet speech can be before it is captioned. |

## Try it on a computer first

Without glasses you can still check your key and languages: run `npm run dev` and open http://localhost:5173 in Chrome. It uses the computer's microphone and shows captions on the page. `npm run simulate` opens the Even Hub glasses simulator for the display side.

## Development

```bash
npm test           # unit tests (ElevenLabs + Wispr protocols, segmenting, text fitting)
npm run typecheck
npm run build      # outputs dist/
npm run pack       # build + evenhub pack -> flow-captions.ehpk
```

### How it works

```
glasses mic ─PCM 16 kHz─> phone WebView ─> speech engine (WebSocket) ─> partial + final text
                                                                              │
glasses display <──────── native text, or PNG tiles for other scripts <──────┘
```

- `src/elevenlabs.ts`: ElevenLabs Scribe realtime client. Mints a single-use token, streams 100 ms PCM chunks over one long-lived WebSocket, lets ElevenLabs' voice detection end sentences, reconnects with backoff.
- `src/wispr.ts` + `src/segmenter.ts` + `src/captioner.ts`: Wispr Flow engine. Wispr's API is built for dictation (one session per utterance), so a small local voice detector splits the stream and keeps one connection warm.
- `src/glasses/`: display layout, firmware-accurate line fitting via `@evenrealities/pretext`, image fallback for unsupported scripts.
- `src/main.ts`: phone UI, Even bridge, gestures.

## Known limits and things to verify on first run

- **Not yet tested on real glasses or against the live APIs.** The code follows ElevenLabs' and Wispr's published docs and Even's SDK 0.0.16, and unit tests cover both protocols. On the first run, the most likely problems are: the Even app blocking the token request or WebSocket (check `permissions.network.whitelist` in `app.json`), or ElevenLabs refusing the token request from the phone's WebView (CORS). The error shows on the phone screen and on the glasses.
- Wispr only: its docs are inconsistent about the `final` flag and whether `audio_encoding: "wav"` needs a WAV header.
- Image mode sends two images over Bluetooth per update, so it refreshes noticeably slower than native text.
- The Even app has to stay open on the phone (screen can be off) while captioning.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Glasses say "Add your API key" | Paste the key in Settings on the phone and Save. |
| "ElevenLabs rejected the API key" | Key is wrong, or it doesn't have Speech to Text permission. |
| "ElevenLabs: quota exceeded" | Out of credits on your ElevenLabs plan. |
| Wispr auth error | Key is wrong or API access isn't enabled on your Wispr org yet. |
| "Could not open the glasses microphone" | Make sure the glasses are connected; try Microphone: Phone to rule out the glasses. |
| Captions show blanks for some words | That script isn't in the glasses font. Set Glasses rendering to Auto or Image. |
| Captions pick up other people's conversations | Turn on "Ignore background voices", or set "Whose speech" to Only me / Other people only. |
| Nothing happens in the browser | Allow microphone access for localhost. |

## License

MIT
