# Semaphore — Network-Free P2P File Sharing (Prompt)

Copy the whole thing below into any AI coding assistant:

---

## Project Overview

Build **Semaphore**, a progressive web app (PWA) that shares files, text, and clipboard data between two devices **with zero connectivity — no internet, Wi-Fi, Bluetooth, NFC, or hotspot**. Transfer happens over *physical channels*: modulated sound through speakers/mics, and screen-to-camera QR bursts. As a bonus, an **online mode** uses WebRTC data channels for long-range transfers. (Named for flag-and-light signaling: one device *signals*, the other *reads*.)

## User Stories

1. As a user on a phone, I point my camera at another phone's screen and receive a file with no setup.
2. As a user, I play a sound from one device and the other device "listens" and receives the data.
3. As a user, I can verify data integrity (checksums) and see live transfer stats (rate, chunks, errors, retries, ETA).
4. As a user, I can send text/code snippets super-fast as a pastebin-style quick mode.

## Non-Goals

- Networking of any kind (LAN/mesh/hotspot) — physically impossible scenarios are the point.
- Support for files > 100 MB in offline modes (warn with ETA and suggest the online mode).
- Multi-peer broadcast — one sender, one receiver.

## Tech Stack

- TypeScript + React (Vite), mobile-first, PWA with service worker (works fully offline once installed). Deployed as a **static site on Vercel** (free Hobby plan) — the app itself has no servers.
- **UI-agnostic protocol core in pure TypeScript** (no framework deps) — separate `core/` package so it's testable: compression, chunking, framing, CRC, FEC interleaving, codecs.
- Compression: `pako` (deflate) and `fflate` (zip) — try both, keep smaller.
- Crypto: `libsodium-wrappers` (XChaCha20-Poly1305, sealed boxes). E2E-encrypt every payload.
- QR encode: `qrcode` (sender). QR decode: `jsQR` (camera) — WASM/scan loop, process at ~10–20 fps to save battery.
- Audio: pure Web Audio API — `AudioWorklet` (sender), `AnalyserNode`/`AudioWorkletNode` with `getFloatTimeDomainData` (receiver). No external modem libs allowed — implement modulation yourself.
- State: Zustand. Tests: Vitest for `core/`.

## Architecture & Transfer Protocol (core spec)

### 1. Universal wire format (all modes)

```
[magic "AB"] [version u8] [cipher u8] [auth tag 16B] ...
Header (plaintext + signed):
  filename, mime, originalSize, compressedSize, crc32(original),
  totalChunks, chunkSize, senderPubKey fingerprint
Each chunk (encrypted, keyed by chunk index):
  index u32 | payload | poly1305 tag | per-chunk crc32
```

### 2. Handshake / pairing (all modes)

- Sender generates ephemeral keypair; shows **pairing frame**: QR or a tone sequence encoding `sessionId || senderPubKey || freshNonce`.
- Receiver captures it, replies with its own pubkey (piggybacked on first data chunk or via acoustic/QR ping-pong).
- **Session isolation (anti cross-talk):** every frame and every chunk carries `sessionId`; receiver filters out anything not matching its paired session. After pairing, both screens show a confirmation: "Matched: iPhone (pubkey ab12…)" — user must confirm before data chunks flow.
- Optional passphrase mode: derive session key via `Argon2id(passphrase, sessionId)` instead of key exchange — user matches a 6-char "word pair" shown on both screens.

### 3. Online mode (bonus feature)

- Signaling runs on **Vercel** — free Hobby plan, requires no sticky WebSocket state. Use the **mailbox pattern**: a single serverless Function exposing two endpoints (WebSocket upgrade optional; HTTP POST + SSE/SSE-lite is enough):
  - `POST /api/mailbox/<sessionId>/offer` and `/answer` — peers read/write SDP + ICE candidates.
  - Responses are stored in **Vercel KV** (free tier) with a 10-minute TTL; auto-expiry handles dead sessions.
  - Share link = `app.domain/#<sessionId>`. The receiver polls (1 s interval) or opens an SSE stream until the mailbox is full, then negotiation completes and the data moves over **direct WebRTC P2P channels** — the mailbox never carries file bytes.
- ICE servers: Google's public STUN (`stun.l.google.com:19302`) as primary; TURN fallback required only if ICE fails (symmetric NAT) — if no TURN is configured, surface an explicit "direct connection failed" message instead of failing silently.
- WebRTC datachannels are already DTLS-encrypted; still apply the layer above (E2E, chunking, CRC) for uniformity and auditability.
- Stream file slices from disk (batch `readAsArrayBuffer` per chunk window, ~4 MB in flight); never load the whole file into memory.
- On datachannel close mid-transfer: show forced resume/re-pair screen — connection state machine with explicit `closed`, `failed` → `reconnecting` states.

### 4. Offline mode A — QR burst transfer (visual channel)

- After pairing, payload is compressed + encrypted, then sliced into chunks of **≤ 1,500 bytes** (QR v40-L, byte mode).
- Sender displays one QR per chunk at **fixed pacing**: default 2.5 s/chunk, user-adjustable (fast/normal/slow). Brightness forced to 100%, pure black/white.
- Receiver decodes with jsQR, validates per-chunk CRC, stores out-of-order in an IndexedDB buffer.
- **Loss repair:** after the first pass of all chunks, sender starts a **repair pass** — re-shows only chunk indices the receiver reported missing... but there's no return channel. Solution: round-robin re-broadcast of the *entire* sequence at 2× pacing; receiver de-dupes by index+CRC (immutable chunks). Two passes give effective delivery > 99.9% for small files. **Hard cap: maximum 3 repair passes** — after that show a guidance screen ("move closer, clean screen, reduce glare") and offer restart or abort; never loop forever.
- **Resume after interruption:** sender persists the same chunk manifest + `sessionId`. If a transfer is interrupted (battery, tab close) and devices re-pair, receiver sends a tiny `haveChunks` bitmap (one small QR burst or tone sequence) and the sender skips straight to missing chunks only.
- **Sender timeout:** if the receiver signals nothing for > 60 s of repair passes (no activity detected), auto-abort with a "receiver unavailable" message.
- Auto-advance pacing heuristics: receiver shows live "decoded ✓" count — the *sending* phone's camera can watch the receiving phone's screen reflect the count, or GPS-free fallback: fixed pacing + a "skip until new data" fast-forward when CRC repeats (sender detects receiver is already caught up if a chunk's decode time was shorter than display time... keep simple: fixed pacing + manual "done" button; receiver auto-completes when 100% + hash matched).

### 5. Offline mode B — acoustic modem (sound channel)

- **Modulation:** OFDM, 16 subcarriers, QPSK, ~4 kHz band (1.5–5.5 kHz passband — audible but tolerable; provide a **quiet mode at 1.5–2 kHz, low amplitude (~30% gain), 1/4 rate** — 400 Hz is below the cutoff of small phone speakers and must not be used).
- Symbol rate 100 baud → ~1.6 kbps base; 3× redundancy FEC (Reed-Solomon or turbo-ish repetition + interleaving) → **~500 bps useful**.
- **Framing:** chirp preamble (800 Hz→2 kHz sweep, 150 ms) → 13-bit Barker sync → length header → interleaved payload → trailing silence. Errors → drop frame, scale back rate next frame (adaptive rate control feedback-less: sender uses fixed, receiver reports "quality score" on screen, user manually shifts rate).
- Receiver: `AnalyserNode` bandpass 0.5–6 kHz, sliding-window correlation for sync, carrier recovery via phase-locked loop on pilot tones, per-subcarrier SNR display.
- **"Noise floor" meter** on receiver: red when dirty audio; guides users to quiet rooms.
- Text snippets use a special ultra-short mode: append the text directly into the pairing sound (no handshake needed) — "insert this text at cursor".

### 6. Hybrid flow

- Pair via QR (camera), receive *bulk* via sound, or vice versa; metadata + first chunks travel over whichever channel is faster, remaining via the other. Auto-try: receiver starts both cam & mic simultaneously, uses whichever locks first.

## Design Language (Minimalist & Elegant)

The UI must feel like an instrument, not a dashboard. Every screen has exactly **one primary action**. Restraint over decoration.

- **Typography:** one system font stack (e.g. `system-ui` / `SF Pro`), max 2 weights per screen. Large, calm titles; tiny muted labels for stats. No display fonts, no italics for body.
- **Color:** near-monochrome palette (ink `#111` + paper `#FAFAF7` + one accent, e.g. warm signal orange `#E8590C` used only for active states, progress, and the single primary button). Surface hierarchy via opacity, not borders.
- **Spacing & size:** generous whitespace, content centered on a max-width column; hit targets ≥ 48 px. No chrome — no header bars, no cards with drop shadows (flat, hairline-free).
- **Motion:** micro-interactions only where they inform — button press states, chunk-delivered tick, progress ring sweep, waveform breathing. Durations 150–250 ms, ease-out, no bounce; respect `prefers-reduced-motion` (disable all motion).
- **Visuals:** custom line icon set (consistent 1.5 px stroke, rounded caps), never emoji in the UI. QR shown as pure black on white in a thick-bordered card; pairing "fingerprint" shown as the 6-char word pair, not a hex dump.
- **States:** every async screen shows a quiet progress ring + one line of status text (e.g. "Chunk 14 of 33" / "Listening…"); errors are one short sentence + the single recovery action. Empty states teach with one line ("Point your camera at the other device's screen").
- **Accessibility:** dark mode default with light toggle, ≥ 4.5:1 contrast, full keyboard/tab order, `aria-live` for progress announcements, no color-only status (icons + text accompany every color signal).
- **Copy tone:** two or three words per control ("Send", "Listen", "Done"). Never jargon ("sync", "session", "repair pass" — say "Catching up on missed parts").

## UI/UX Spec

- **Landing:** two giant buttons — *SEND* / *RECEIVE*.
- **Send flow:** file picker (drag-drop + input) → channel chooser (link / screen / sound) → live progress: `chunks delivered / total`, error count, ETA, speed (`kbps`), big "cancel" → success screen with hash to verify.
- **Receive flow:** "Point camera at sender's screen" (full-screen viewfinder, brackets overlay, auto-detect + auto-zoom via `track.applyConstraints` where supported) / "Listen" (screen shows live waveform + noise meter) → progress → files list with "Save / Copy as text / Re-send".
- Dark mode default, high contrast (QR on black background reads worse — white card with thick black border for framing).
- Second screen unnecessary: receiver phone shows progress; sender phone also shows its own mirror progress (paced countdown).

## Edge Cases & Constraints

- Screen moiré/flicker: camera auto-exposure racing with display refresh/backlight PWM — mitigate with static frame durations, no animations over the QR, 60 Hz display, and a "tilt helper" showing misalignment.
- Phone camera autofocus hunting on screen: lock focus/aperture where API allows.
- Standby/lock: `wakeLock` API during transfer; warning if battery saver mode (throttles JS timer pacing).
- Acoustic: background noise, echo, speaker clipping at max volume — normalize gain to 80%, add compressor.
- **Storage quota:** check `navigator.storage.estimate()` before starting; fail fast with a clear message if the file won't fit; offer "save directly to disk via File System Access API" where supported.
- Offline ETA warnings: show "this will take ~N min" before starting; block > 10 MB offline unless user confirms.
- iOS Safari quirks: AudioWorklet + getUserMedia permissions, idb transact limits — if AudioWorklet is unavailable, fall back to `AnalyserNode`-based demod; if both audio paths fail, force QR-only mode with a banner.
- **Permissions revoked mid-transfer** (mic/cam denied or track ended): explicit abort + "permission lost" message; never a silent hang.
- **Edge files:** 0-byte files (send header + zero chunks; guard against divide-by-zero ETA), files whose size is an exact multiple of chunkSize (empty remainder chunk must be a supported protocol case), > 4 GB via `bigint` sizes in the header.
- **Filename safety:** sanitize received filenames (strip path separators, control chars, `..`), preserve unicode; never echo raw into save paths.

## Performance Targets

- 10 KB text, QR mode: < 40 s total (pairing + ~7 chunks @2.5 s + repair pass).
- 50 KB file, quiet room, sound mode: < 4 min.
- 100 MB file, online mode: saturate residential uplink, p99 chunk latency < 1 s.
- Battery: receiver scan loop < 15% drain per 10 min transfer (throttle jsQR to 12 fps).

## Deployment (Vercel — free tier)

- **Stack:** Vite static build (`outDir: dist`) + one serverless Function `api/mailbox/[...route].ts` handled through Vercel's build pipeline. No other backend.
- **`vercel.json`:** SPA rewrite (`"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`), function routes for `/api/mailbox/*`, cache headers (`index.html` `no-cache`, hashed assets `immutable, max-age=31536000`), and a strict CSP + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` header set.
- **PWA correctness:** manifest + service worker must use **relative paths** (no absolute origin), `scope: "/"`, `start_url: "./"`; install prompt on iOS Safari only (`BeforeInstallPromptEvent` where available). Verify the deployed HTTPS origin, not localhost.
- **Vercel KV:** one free database; keys `mailbox:<sessionId>:<kind>` with `EXPIRE 600`; no PII, no file content — session data only; cleanup job unnecessary (TTL does it).
- **Env/config:** all config (STUN URLs, KV binding) via Vercel environment variables with sane defaults; the app must degrade to offline-only if signaling config is missing (never crash).
- **Workflow:** `vercel build && vercel deploy --prod` or Git push → Vercel auto-deploy; preview deploys per PR. After first deploy, re-run Lighthouse on the production URL (QA checks above) — `npm run preview` on localhost is not the acceptance target.
- **Signaling outage behavior:** online mode shows "live relay unavailable — use Light or Sound mode" banner; the offline modes remain 100% functional with no network at all.

## Testing & Acceptance

- `core/` unit tests: chunk round-trips, CRC, compression invariants, crypto (decrypt with wrong key fails), modem encode→decode in-band (sender synth audio → receiver decode in the same test). Include failure-mode tests: 0-byte and exact-multiple file sizes, chunk with bad CRC dropped, > 3 repair passes aborts, session mismatch rejected, `haveChunks` bitmap resume round-trip, 100% memory-free streaming in online mode (assert peak RSS bounded for a 100 MB file).
- End-to-end: two real phones, no network (airplane mode), QR 10 KB pass → audio 50 KB pass → hash match.
- WebRTC online: two browsers on different machines, 100 MB transfer, hash match after E2E decrypt.
- Lighthouse PWA score ≥ 90; installable; works from airplane-mode browser cache after first install.

## Build Order (deliver stages)

Every stage ships **real, production code** — no mock components, no fake progress, no placeholder channels. If a transport isn't ready, the feature is gated off rather than demoed with fake data.

1. `core/` protocol lib + tests (framing, chunking, crypto, CRC).
2. Full app shell + **real transfer engine**: SEND/RECEIVE flows wired to a loopback transport (bridge that pipes chunks between two in-app peers via a MessageChannel/worker) — real compression, real crypto, real progress, real stats, real error states. Anything that works on loopback works on every real channel.
3. Online WebRTC mode: Vercel mailbox signaling + datachannels + streaming, e2e two-browser 100 MB test.
4. QR mode: pairing QR → burst loop → repair passes → resume bitmap.
5. Acoustic modem: modulator, sync, demodulator, adaptive rate UI.
6. Hybrid channel picker + polish: wake lock, battery awareness, stats, dark mode, install prompts.
7. e2e matrix on Android Chrome + iOS Safari + desktop Chromium; Lighthouse on the deployed Vercel URL; airplane-mode test on installed PWA.

## Constraints for the AI

- Zero runtime dependencies beyond those listed; the only backend is the Vercel mailbox Function (optional).
- Keep everything P2P-first: ALL file bytes travel device-to-device; the mailbox carries only SDP/ICE session data and never payload content.
- **No shallow implementations.** This is a from-scratch, production-grade app: every screen has real empty/error/edge states; every transfer moves real bytes through the real pipeline (compression → crypto → framing → channel → demod → verify); no placeholder UI, no stubbed handlers, no fake progress, no lorem ipsum copy, no commented-out features, no `TODO` scaffolding shipped.
- When a sub-feature isn't ready, disable it with a real "coming soon" gate — never mock it.
- Do not comment code unless asked; write tests alongside features.