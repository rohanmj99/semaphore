# Semaphore

Share files between two devices using **light**, **sound**, or a **link** — end-to-end encrypted, works fully offline, no accounts required.

> No internet, no Wi-Fi, no Bluetooth. Light, sound, or a link — your pick.

Semaphore is a privacy-first file-transfer web app. It turns your phone or laptop into a secure point-to-point pipe: pick a channel, establish a short-lived session, and transfer a file straight from one device to the other.

## Features

- **Three transfer channels**
  - **Sound** — a built-in **OFDM audio modem** transmits data through the speaker/mic (16 orthogonal carriers, chirp preamble + Barker-code sync, error-corrected frames).
  - **Light** — transfers over the screen and camera.
  - **Link (online)** — a shareable `#session` link pairs two devices over **WebRTC**, relayed through a lightweight serverless mailbox.
- **End-to-end encrypted** — X25519 key exchange (libsodium), XChaCha20-Poly1305 per-chunk AEAD, no server ever sees plaintext.
- **Human-verifiable pairing** — a `word-pair` (e.g. `amber-beacon`) derived from each peer's key fingerprint, so both sides can confirm they're talking to the right person.
- **No accounts, no uploads to S3/no storage** — the mailbox relay only holds short-lived ciphertext while a transfer is live; nothing persists.
- **Resilient transfers** — files are cut into 256 KB chunks, compressed (best-of deflate/zip), CRC32-checked, windowed with automatic retransmission and a "have" bitmap so the two peers chase down gaps.
- **Passphrase mode** — optional PBKDF2-SHA256 (120k iterations) key derivation bound to the session.
- **Progressive Web App** — installable, with an offline service worker and dark/light theme.

## How it works

```
Device A ──(sound / light / WebRTC link)──▶ Device B
     │                                        │
     │  X25519 key exchange                   │
     ▼                                        ▼
   sessionKey ── XChaCha20-Poly1305 ──▶ ciphertext chunks
     │                                        │
     └── deflate/zip ── 256 KB chunks ── CRC32 ─▶ reassemble & verify
```

1. **Pair** — the sender announces a session; the receiver confirms a matching `word-pair`.
2. **Synchronize** — chunks flow over the chosen channel; both peers track received chunks with have-bitmaps.
3. **Verify** — whole-file CRC32 + per-chunk AEAD tags guarantee integrity before the file is saved.

## Tech stack

- **React 18 + TypeScript + Vite** (frontend)
- **Zustand** (state)
- **libsodium-wrappers** (crypto)
- **pako / fflate** (compression)
- **jsqr + qrcode** (light channel / QR pairing)
- **Vercel serverless functions** (mailbox relay; optional Vercel KV persistence)

## Project layout

```
api/                  Vercel serverless mailbox relay
  mailbox/[...route].ts   POST/GET /api/mailbox/:kind
  mailbox-store.ts        Memory + KV (Vercel KV) stores
core/                 Framework-agnostic transfer engine (no React)
  modem/              OFDM audio modem (ofdm.ts, dsp.ts)
  crypto.ts           key exchange, AEAD, fingerprints, word-pairs
  chunker.ts          chunking, compression, manifest/CRC
  session.ts          transfer state machine
  pairing.ts          session announcements + pairing
  webrtc.ts           WebRTC + mailbox ICE relay
  transports.ts       transport endpoint abstraction
  online.ts / mailbox.ts   online channel + mailbox client/poller
src/                  React UI
  components/         Landing, SendFlow, ReceiveFlow
  engine/             send/receive orchestration, wakelock
public/               PWA manifest, service worker, icons
vercel.json           rewrite + security-header rules
```

## Getting started

### Prerequisites

- Node.js 18+
- npm

### Install & run locally

```bash
npm install
npm run dev        # start the Vite dev server
```

Open the printed URL (default `http://localhost:5173`).

The local (memory) mailbox is used by default. To exercise the online channel locally, run the dev mailbox:

```bash
npm run dev:mailbox
```

### Scripts

| Command          | Description                          |
| ---------------- | ------------------------------------ |
| `npm run dev`    | Start the dev server                 |
| `npm run build`  | Typecheck + production build (`dist`)|
| `npm run preview`| Preview the production build         |
| `npm run test`   | Run unit tests (Vitest)              |
| `npm run typecheck` | Type-only check (tsc)             |
| `npm run icons`  | Regenerate PWA icons                 |

## Deploying to Vercel

1. Push this folder to a GitHub repository.
2. Import the repo at [vercel.com](https://vercel.com) — the Vite preset is detected automatically (build `npm run build`, output `dist`).
3. Deploy. The `vercel.json` rewrites `/api/*` to the serverless functions and applies security headers (CSP, nosniff, immutable asset cache).

### Optional: full-duplex relay persistence

By default the mailbox relay keeps state in memory (fine for a single transfer). To survive restarts and scale across instances, connect **Vercel KV** and set the environment variables:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

The relay will automatically use KV instead of memory. You can also override the default STUN servers for WebRTC via `VITE_ICE_SERVERS` (JSON array of `RTCIceServer`).

## Security notes

- The server (mailbox) only sees **ciphertext** — keys are exchanged directly between peers and never leave the device (WebRTC data channels are end-to-end encrypted).
- The `word-pair` + fingerprint verification guards against man-in-the-middle pairing.
- Mailbox entries expire after a short TTL (default 10 minutes) and are wiped when a session ends.

## License

Private/unreleased — no license yet. Reach out before reusing.