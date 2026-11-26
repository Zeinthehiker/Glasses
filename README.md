# Flow Captions for Even G2

Live captions on Even Realities G2 glasses, using [Wispr Flow](https://wisprflow.ai)'s speech-to-text instead of the Even app's built-in engine. Wispr handles noisy audio, accents and switching between languages better, which is the whole point of this app.

It is a personal app: one person, one phone, one Wispr API key.

## What it does

- Streams the glasses microphone (or the phone's) to Wispr Flow and shows live captions on the glasses, newest words at the bottom.
- Shows text as it is spoken, then replaces it with Wispr's cleaned-up final version when the sentence ends.
- Handles several languages at once. List the ones you switch between (for example `en, ar, fr`) and Wispr picks per sentence.
- Draws scripts the glasses' built-in font can't (Arabic, Hebrew, Hindi, Thai and others) by rendering them as an image on the phone and sending that to the glasses. Latin, Cyrillic, Greek, Chinese, Japanese and Korean use the faster native text.
- Can caption only other people, only you, or everyone, using the glasses' own speaker detection.
- Only sends audio while someone is talking, so silence costs nothing.
- Has a phone screen with the full transcript, Pause, Clear and Copy.

On the glasses:

| Gesture | Action |
| --- | --- |
| Tap | Start, pause or resume |
| Long press | Clear captions |
| Double tap | Exit |
| Menu | Pause/Resume, Clear captions |

## Before you start: get Wispr Flow API access

The Wispr Flow API is separate from the Wispr Flow desktop/phone app subscription, and Wispr currently grants it **by request only** ("Flow API is only available by exclusive access" in [their API docs](https://api-docs.wisprflow.ai)).

1. Request API access from Wispr through the API docs site.
2. Once approved, create an API key in the Wispr dashboard. It starts with `fl-`.
3. Keep it somewhere safe. You'll paste it into the app once (see step 4 below).

Pricing is usage-based and isn't published. Check your Wispr contract.

## Install on your phone

You need:

- G2 glasses paired with the Even app, **Even app 2.2.10 or newer**
- A computer with **Node.js 20.17+ or 22.13+**
- Phone and computer on the same Wi-Fi (for option A)

```bash
git clone https://github.com/Zeinthehiker/g2-flow-captions.git
cd g2-flow-captions
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
npx evenhub create flow-captions.ehpk --name "Flow Captions" --tagline "Live captions powered by Wispr Flow"
npx evenhub promote 0.1.0 --to beta
npx evenhub testers add you@example.com   # the email of your Even account
```

Accept the tester invite email, then install Flow Captions from the Even app. For later versions, bump `version` in `app.json`, run `npm run pack`, then `npx evenhub upload flow-captions.ehpk -m "what changed"` and promote the new version to beta.

If `create` says the package ID is taken, change `package_id` in `app.json` (for example `com.yourname.flowcaptions`).

## Set up your API key

1. Open Flow Captions on your phone.
2. Open **Settings**, paste your Wispr key into **Wispr Flow API key**.
3. Set **Languages** to the languages you speak, as two-letter codes, for example `en, ar`. One code forces that language. Leave it empty to auto-detect (Wispr says this is less accurate).
4. Optional: add names and jargon to **Names and words to spell right**.
5. Tap **Save**, then **Start captions** (or tap the glasses).

### Where the key lives

- The key is saved in the Even app's storage **on your phone**. It is not in the code, not in the repo and not in the `.ehpk` package, so the repo is safe to share.
- `.env` files are git-ignored. `.env.example` documents one optional variable, `VITE_WISPR_API_KEY`, which only pre-fills the key during `npm run dev` on a computer. Never set it when running `npm run pack`.
- The app talks to Wispr directly from the phone, so the phone holds the org key. That's fine for a personal app. If you ever share the app, run a tiny backend that mints short-lived tokens with Wispr's `generate_access_token` endpoint and tick **This is a short-lived client token** in Settings. The app already supports that mode.

## Settings reference

| Setting | What it does |
| --- | --- |
| Microphone | Glasses mic (default) or phone mic. |
| Whose speech | Everyone, other people only (good for conversations), or only you (good for dictation). Uses the Even app's speaker detection, so expect it to be imperfect. |
| Glasses rendering | Auto (recommended), Native text (fastest, but some scripts show as blanks), or Image (any script, slower updates). |
| Sensitivity | How quiet speech can be before it is captioned. Use Low in loud places so background noise isn't sent to Wispr. |

## Try it on a computer first

Without glasses you can still check your key and languages: run `npm run dev` and open http://localhost:5173 in Chrome. It uses the computer's microphone and shows captions on the page. `npm run simulate` opens the Even Hub glasses simulator for the display side.

## Development

```bash
npm test           # unit tests (Wispr protocol, segmenting, text fitting)
npm run typecheck
npm run build      # outputs dist/
npm run pack       # build + evenhub pack -> flow-captions.ehpk
```

### How it works

```
glasses mic ─PCM 16 kHz─> phone WebView ─┬─> voice activity detector
                                          │     │ speech starts: open Wispr session (pre-warmed)
                                          │     │ 100 ms packets ─> wss://platform-api.wisprflow.ai
                                          │     │ ~0.9 s of silence: commit ─> final text
                                          │
glasses display <─ text or PNG tiles <────┴─ transcript (partials replaced by finals)
```

- `src/wispr.ts`: Wispr WebSocket client (`auth`, `append`, `commit`).
- `src/segmenter.ts`: splits the mic stream into utterances. Wispr's API is built for dictation (one session per utterance), so continuous captions need this. Long monologues are cut every 25 s so final text keeps coming.
- `src/captioner.ts`: wires mic, segmenter and Wispr sessions together, keeps one connection warm.
- `src/glasses/`: display layout, firmware-accurate line fitting via `@evenrealities/pretext`, image fallback for unsupported scripts.
- `src/main.ts`: phone UI, Even bridge, gestures.

## Known limits and things to verify on first run

- **Not yet tested against the live Wispr API or on real glasses.** The code follows Wispr's published WebSocket docs and Even's SDK 0.0.16, and the unit tests cover the protocol, but Wispr's docs are inconsistent in places. If captions don't appear, the first suspects are: the `final` flag on the last message, whether `audio_encoding: "wav"` needs a WAV header (Wispr's own quickstart sends raw PCM, as this app does), and the packet size (`PACKET_MS` in `src/main.ts`; Wispr suggests longer packets, we use 100 ms for lower latency).
- Wispr finalises text per utterance, so the last few words of a sentence can lag by about a second until the pause.
- Image mode sends two images over Bluetooth per update, so it refreshes noticeably slower than native text.
- The Even app has to stay open on the phone (screen can be off) while captioning.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Glasses say "Add your Wispr key" | Paste the key in Settings on the phone and Save. |
| "Wispr closed the connection (1008)" or an auth error | Key is wrong or API access isn't enabled on your Wispr org yet. |
| "Could not open the glasses microphone" | Make sure the glasses are connected; try Microphone: Phone to rule out the glasses. |
| Captions show blanks for some words | That script isn't in the glasses font. Set Glasses rendering to Auto or Image. |
| Captions trigger on background noise | Set Sensitivity to Low. |
| Nothing happens in the browser | Allow microphone access for localhost. |

## License

MIT
