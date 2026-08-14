# Semaphore — Session Continuity Log

Purpose: if a session ends (context limit), the next session reads this file to resume.
Update this file at the end of every working session. Dates below are session dates.

---

## Latest state — 2026-08-14 (session resumed: sound + light channels wired end-to-end, 104 tests green)

### Stage 4/5 (sound + light channels) fully wired — supersedes "gated coming soon" notes below
- Verification: `npm run typecheck`, `npm test` (104 tests, 13 files), `npm run build` all pass; `vercel-deploy` folder synced (incl. new `dijkstrajs` dep) and builds.
- Broadcast (noAck) engine: `StreamSender` gains per-chunk pacing — `pumpNoAck` sends header, then each chunk, `await waitIdle()` after every send; `maxPasses` cap; sent-volume stats (progress approaches 100% over pass 1). Fixed latent bug in `waitIdle`: `remote.idle` must be called with the transport as `this` (`idle.call(remote)`) — loopback transports never had `idle()` so it was invisible.
- Light transport (`core/qr/light.ts`): `LightTransport.idle()` now resolves after one full fragment rotation (`frags.length × LIGHT_FRAME_MS`) so the UI can show every QR before the next message replaces it.
- Robustness: `matchSoundSession`/`matchLightSession` treat the sender's first `hello` frame as an implicit `go` (a missed go burst no longer strands the transfer).
- `src/engine/send.ts`: `SendChannel` now `"loopback" | "online" | "sound" | "light"` + `channelSupported()`; `SendController` wires `advertiseSound` (chunk 4 KB) and `advertiseLight` (chunk 8 KB), both `noAck: true, maxPasses: 6`; exposes `display: LightTransport | null`.
- `src/engine/receive.ts`: exported `MatcherLike` + `nearbyMatcher(session, channel)`; `ReceiveController.matchDisplay` getter for the light match QR.
- `src/components/QrCard.tsx` (new): paints `LightTransport.currentFrag()` to canvas via `renderQr`/`paintQr`, advances every `LIGHT_FRAME_MS`, dynamic scale to fit ~460 px.
- `src/components/SendFlow.tsx`: channel chooser un-gates Sound/Screen flash (disabled only when unsupported: `soundSupport()`/`lightSupported()`); light waiting screen shows the animated announce QR; light transfer screen shows the chunk QR; done-screen copy differs for broadcast channels.
- `src/components/ReceiveFlow.tsx`: scans all three nearby channels simultaneously (`scanForSessions` + `scanSoundSessions` + `scanLightSessions`), sessions tagged `loopback`/`sound`/`light`; `pickSession` uses `nearbyMatcher` per channel; light waiting screen shows the receiver's match QR (`matchDisplay`); per-channel hints on waiting/transfer.
- `core/modem/sound.ts`: removed never-invoked `onState` from `SoundSenderQueue`/`SoundMatcher` (fixed `MatcherLike` type friction).
- `core/qr/light.ts`: `paintQr` return type narrowed to `Uint8ClampedArray<ArrayBuffer>` (TS 5.7 typed-array generics for `ImageData`).
- New test `core/session.test.ts` "broadcasts in noAck mode…": `RecordTransport` fake (paced broadcast, delivers to handlers, idle drains) proves: 3 passes × (hello + 5 chunks) in order, receiver completes from pass 1, sender stops after `maxPasses` with `passes` stat, echoes filtered.
- Known nits: build still warns chunk > 500 kB (libsodium); light transfer is inherently slow (~1.4 KB per 2.5 s QR) — fine for the <100 KB files the prompt scopes; broadcast sender UI relies on the receiver screen for completion confirmation.
- Remaining gaps (unchanged): >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel KV env smoke-test against real Upstash, e2e matrix / Lighthouse.

---

### Stage 3 (online WebRTC) fully wired end-to-end — supersedes the "In progress (Stage 3)" note below
- Verification: `npm run typecheck`, `npm test` (86 tests, 11 files), `npm run build` all pass.
- `api/mailbox/[...route].ts` + `api/mailbox-store.ts` — Vercel serverless mailbox (`[sessionId, kind]` routes, Memory store + Upstash KV store via `KV_REST_API_URL`/`KV_REST_API_TOKEN` env, TTL 600 s, CORS, ping probe).
- `core/mailbox.ts` — `createHttpMailbox`, `probeMailbox`, `MailboxPoller` (per-kind cursors), `putWithRetry`.
- `core/webrtc.ts` — `DataChannelTransport` (buffers until open, flushes in order, peer-close flag) + `WebRtcNegotiator` (offer/answer/ICE via mailbox, ICE restart once, connect timeout → fail).
- `core/online.ts` — `advertiseOnline` / `matchOnlineSession` / `fetchAnnouncement`; **sessionId-bound factory `MailboxForSession = (sessionId) => Mailbox`** so all announce/peer/go/ready/offer/answer/ice traffic hits `[sessionId, kind]` routes (bug: client URLs previously omitted sessionId → online mode could never reach the mailbox).
- `src/config.ts` — `mailboxForSession`, `iceServersConfig` (VITE_ICE_SERVERS or Google STUN defaults), `shareLinkFor`/`sessionIdFromLink` (#-fragment links), `probeOnlineSupported`; dev server mailbox via `scripts/dev-mailbox.ts` (vite plugin, memory store).
- `src/engine/send.ts` / `receive.ts` — online channel wired: `SendController` online path + 10-min link expiry; `ReceiveController.openOnline(sessionId, cb)` from link fragment, storage-fit check, header timeout.
- Fixes this session (test red → green):
  - `WebRtcNegotiator` shared ONE `pollSince` cursor across offer/answer/ice mailboxes → ICE entries advancing the cursor before the answer (index 1) arrived meant the answer was never read (deadlock). Per-kind cursors now (`core/webrtc.ts`).
  - FakePeerConnection in `core/online.test.ts`: channels live on the initiator's PC; `openChannels`/`failAndDrop` now open/drop the peer's channels too (they were no-ops → transport never opened).
  - DataChannel buffering test: both fake channels must be opened before delivery (fake drops messages to a non-open peer).
  - `probeMailbox` test: ping route registered before first call.
- Remaining gaps (unchanged): QR/repair/abort tests (stage 4), acoustic rate UI (stage 5), >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel deploy config (`vercel.json` absent; KV wiring in code, untested against real Upstash), libsodium > 500 kB code-split.

### Verification pass vs semaphore-prompt.md (2026-08-12, same session)
- `npm run typecheck`, `npm test` (64 tests, 8 files), `npm run build` all pass; dev server smoke-test OK (HTTP 200).
- New tests added per acceptance list: `core/chunker.test.ts` (header wire round trip, wrong-key reject, bad magic/truncated, 0-byte, exact-multiple chunk sizes, bad per-chunk CRC + tampered ciphertext dropped, reassemble missing-chunk fail, whole-file verify rejects tamper, filename sanitize), `core/compression.test.ts` (deflate/zip/none invariants, tiny + empty inputs, empty-zip fail), `core/have-bitmap.test.ts` (set/missing, bytes round trip incl. totalChunks, malformed reject, rebuild keeps bits, RLE runs).
- Spec deltas fixed:
  - Sender success screen now shows checksum (wired `StreamSender` `onHeader` crc32 through `SendController.onDone(hash)`).
  - Sender live stats grid now shows error count (spec: chunks/errors/ETA/kbps).
  - Copy tone: no "session" jargon, "crc32" label → "checksum".
  - `manifest.webmanifest` `scope` → `"/"` per spec.
  - Service worker was never registered — `src/main.tsx` now registers `./sw.js` in PROD builds (installable + offline).
- Confirmed matches: wire format (AB/version/cipher/tag, chunk index+crc32 keyed), session isolation, both-side word confirm, compression pako+fflate keep-smaller, XChaCha20-Poly1305, wake lock during transfer, storage-quota fast-fail, gating (online/light/sound "coming soon", never mocked), design tokens (#111/#FAFAF7/#E8590C, system-ui, 1.5 px round-cap icons, no emoji, 48 px targets, prefers-reduced-motion, aria-live, dark default + toggle), relative PWA paths.
- Known gaps (staged, not built yet): QR/repair-pass/abort tests (stage 4), acoustic rate UI (stage 5), online mailbox + 100 MB memory test (stage 3), >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel headers/KV (deploy stage 7). libsodium chunk > 500 kB — code-split later.

### Done (earlier this session)
- **Stage 1 (core protocol lib) complete.** 45 unit tests originally; see list below.
- **Stage 2 (app shell + real transfer engine) complete.**
  - `core/chunker.ts` — slice source, manifest builder, per-chunk seal/CRC, reassembly, header wire format
  - `core/compression.ts`, `core/crc32.ts`, `core/crc16.ts` — pako/fflate compression, CRC
  - `core/crypto.ts` — libsodium-wrappers: XChaCha20-Poly1305, sealed boxes, word pair, passphrase KDF
  - `core/frames.ts` — length-prefixed framing + `FrameParser`
  - `core/have-bitmap.ts` — chunk ownership bitmap (resume/repair)
  - `core/pairing.ts` — BroadcastChannel hub: `advertiseSender` / `scanForSessions` / `matchSession` (cross-tab loopback pairing, matching, go/ready handshake)
  - `core/session.ts` — `StreamSender` (windowed send, resend/retry, stats events), `StreamReceiver` + `ReceiverEngine`
  - `core/stats.ts` — `TransferStats` rate/ETA
  - `core/transports.ts` — `TransportEndpoint` interface, `loopbackPair`, `JsonChannel`
  - `core/modem/` — OFDM speaker/mic modem (dsp.ts + ofdm.ts), in-band test passes (stage 4 foundation)
  - `core/util.ts` — base64url, hex, u32/u64, formatting helpers
- **Stage 2 (app shell + real transfer engine) complete.** `npm run typecheck`, `npm test`, `npm run build` all pass.
  - `src/{main,App,store,icons}.tsx`, `src/styles.css` — shell, zustand store (SenderView/ReceiverView + `resetSender`/`resetReceiver`), line icons, both themes
  - `src/components/SendFlow.tsx` — pick (dropzone) → channel chooser ("This device" live; Online/Screen flash/Sound gated "coming soon", never mocked) → waiting (word chips) → matched (confirm prints peer fingerprint) → transfer (ProgressRing + speed/ETA/chunks stats) → done / error
  - `src/components/ReceiveFlow.tsx` — listen (scans hub, session list with word chips + file meta) → match (words + peer fingerprint, storage-fit check) → waiting → transfer → done (Save via blob download, crc32 shown, keep-listening) / error
  - `src/engine/{send,receive}.ts` — `SendController` / `ReceiveController` wiring pairing + StreamSender/StreamReceiver (hash = 8-hex crc32); `wakelock.ts` runs during transfer screens
  - Fixed core typecheck errors: `ChannelKind` type-only import (pairing.ts), unused `Peer`/missing transport import (pairing.test.ts), `StreamReceiver` opts signature + crc32 hash in receive.ts
- Known nit: build warns chunk > 500 kB (libsodium) — code-split later if needed.

### In progress (Stage 3)
- Online WebRTC mode: Vercel mailbox (api/mailbox), datachannels, streaming — no `api/` or `vercel.json` yet.

### Next (Stage 4+)
4. QR mode (pairing QR + burst loop + repair passes + resume bitmap) — uses qrcode/jsqr deps.
5. Acoustic modem UI integration (core modem exists and is tested).
6. Hybrid picker + polish (wake lock, battery, dark mode done in stage 2 partially, install prompt).
7. e2e matrix, Lighthouse ≥ 90, airplane-mode test.

---

## Commands
- `npm test` — vitest on `core/**/*.test.ts`
- `npm run typecheck` — tsc --noEmit
- `npm run build` — typecheck + vite build
- `npm run dev` — dev server
- `npm run icons` — regenerate PWA icons (scripts/gen-icons.mjs)

## Key API surface (for quick resume)
- Pairing: `advertiseSender({name,size}|null)` → `{sessionId, wordPair, senderFingerprint, onMatch(cb), notifyGo(), start(cb: {sessionKey, channel, receiverFingerprint}), stop()}`
- Receiving: `scanForSessions(cb(list))` → unsubscribe; `matchSession(visible)` → `{pin, confirm(), onGo(cb), postReady(), cancel()}`; `pin.sessionKey` ready after `confirm()`
- Transfer: `new StreamSender(sessionId, sessionKey, source, {onEvent, chunkSize})` then `run(channel)` (channel = pairing `channel`); `new StreamReceiver(sessionId, sessionKey, onEvent)` then `start(channel)`, `onComplete(cb)`
- `source` = `fileSource(File)` or `arraySource(Uint8Array, name, mime)` (chunker.ts)
- Stats: poll `engine.stats.snapshot()` or listen to `onEvent({type:"stats"})`; also `phase` events; `done`/`error`
- Handshake flow: sender `onMatch` → user confirm → `notifyGo()` → receiver `onGo` → `postReady()` → sender `start()` → sender runs StreamSender → receiver runs StreamReceiver (start immediately after onGo; header arrives later)
- Receiver must also handle `onClose` (sender closed) → error state ("Sending stopped")
- Sound channel: `advertiseSound({name,size}|null, {quiet?, burstMs?})` → queue (no display); `matchSoundSession(session)` → matcher; `scanSoundSessions(cb, onError)` → `{stop(), noiseFloor(), snr(), framesDecoded()}`; `soundSupport()` / `soundRxSupport()` (core/modem/sound.ts)
- Light channel: `advertiseLight(...)` → `{..., display: LightTransport}` (UI paints `display.currentFrag()`); `matchLightSession(session)` → `{..., display}`; `scanLightSessions(cb, onError)` → `{stop(), framesScanned()}`; `lightSupported()` (core/qr/light.ts)
- Broadcast mode: `StreamSender` opts `{noAck: true, chunkSize, maxPasses, gapMs}` — cycles header + all chunks per pass, `idle()`-paced per chunk; receiver de-dupes/completes on its own; sender stops after `maxPasses`
- `QrCard` component (`src/components/QrCard.tsx`): `transport: LightTransport | null` — paints + advances every `LIGHT_FRAME_MS`

## Constraints (from semaphore-prompt.md)
- Zero runtime deps beyond listed. No mock/stub UI — real bytes through real pipeline.
- Gate unfinished channels with "coming soon", never fake progress.
- Design: ink #111 / paper #FAFAF7 / accent #E8590C, system-ui, ≥48px targets, line icons, no emoji, aria-live, prefers-reduced-motion.
- Wire format/encryption is E2E on every payload; mailbox never carries bytes.