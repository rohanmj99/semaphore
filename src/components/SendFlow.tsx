import { useEffect, useRef, useState } from "react";
import { useApp } from "../store.ts";
import { SendController, type SendChannel } from "../engine/send.ts";
import { wakeLock } from "../engine/wakelock.ts";
import { fileSource } from "@core/chunker";
import { pairingSupported } from "@core/pairing";
import { lightSupported, type LightTransport } from "@core/qr/light";
import { soundSupport } from "@core/modem/sound";
import type { ProgressStats } from "@core/types";
import { fmtBytes, fmtDuration } from "@core/util";
import { ProgressRing } from "./ProgressRing.tsx";
import { QrCard } from "./QrCard.tsx";
import {
  IconBack,
  IconCheck,
  IconCopy,
  IconDevice,
  IconFile,
  IconLight,
  IconOnline,
  IconRepeat,
  IconSound,
  IconX,
} from "../icons.tsx";

const CHANNELS = [
  { kind: "loopback", title: "This device", sub: "Two tabs on this computer", icon: IconDevice },
  { kind: "online", title: "Online link", sub: "Send a link — bytes go straight between devices", icon: IconOnline },
  { kind: "light", title: "Screen flash", sub: "Two cameras, phone to screen", icon: IconLight },
  { kind: "sound", title: "Sound", sub: "Tones through your speaker", icon: IconSound },
] as const;

function channelUnsupported(kind: string): boolean {
  if (kind === "loopback") return !pairingSupported();
  if (kind === "sound") return !soundSupport();
  if (kind === "light") return !lightSupported();
  return false;
}

const PHASE_LABEL: Record<string, string> = {
  connecting: "Connecting",
  manifest: "Preparing",
  running: "Sending",
  repair: "Repairing",
  verifying: "Verifying",
  done: "Done",
};

function WordChips({ pair }: { pair: string }) {
  return (
    <div className="pairdisplay">
      {pair.split("-").map((w) => (
        <span key={w} className="pairchip">
          {w}
        </span>
      ))}
    </div>
  );
}

/** Light channel default display pace: long enough for a phone camera to
 *  read a full QR between flashes. */
const DEFAULT_QR_FRAME_MS = 500;

/** Light channel: QR display rate. 1–10 fps (100–1000 ms per frame). */
function FrameRateSlider({ frameMs, onChange }: { frameMs: number; onChange: (ms: number) => void }) {
  const fps = Math.round(1000 / frameMs);
  return (
    <label className="framerate">
      <span className="framerate-label">
        QR speed <strong>{fps} fps</strong>
      </span>
      <input
        type="range"
        min={100}
        max={1000}
        step={100}
        value={frameMs}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="QR frame rate"
      />
      <span className="hint">
        {fps >= 8
          ? "Fast — the camera needs a steady hold to keep up."
          : fps <= 3
            ? "Slow — easier for the camera, takes longer."
            : "A good balance of speed and reliability."}
      </span>
    </label>
  );
}

/** Sender progress screen. Module-scope like the receiver's: a nested
 *  component would be remounted on every stats update, flickering the
 *  animated flash and the progress ring. */
function TransferScreen({
  stats,
  channel,
  frameMs,
  note,
  display,
  fileName,
  fileSize,
  onFrameMs,
  onCancel,
}: {
  stats: ProgressStats | null;
  channel: SendChannel;
  frameMs: number | null | undefined;
  note: string | null | undefined;
  display: LightTransport | null;
  fileName: string;
  fileSize: number;
  onFrameMs: (ms: number) => void;
  onCancel: () => void;
}) {
  const total = stats?.totalBytes ?? 1;
  const sent = stats?.transferredBytes ?? 0;
  const value = total > 0 ? Math.min(1, sent / total) : 0;
  const percent = Math.round(value * 100);
  const phase = stats?.phase ? PHASE_LABEL[stats.phase] ?? "Sending" : "Connecting";
  return (
    <>
      {channel === "light" && display && (
        <div className="qrcard-wrap">
          <QrCard transport={display} frameMs={frameMs ?? undefined} />
        </div>
      )}
      {channel === "light" && (
        <>
          <FrameRateSlider frameMs={frameMs ?? DEFAULT_QR_FRAME_MS} onChange={onFrameMs} />
          <p className="hint">
            The flashes keep repeating until you cancel — the other phone picks up whatever
            it missed on the next pass.
          </p>
        </>
      )}
      <ProgressRing value={value}>
        <div>
          <div className="livenumber">{percent}%</div>
          <div className="livelabel">{phase}</div>
        </div>
      </ProgressRing>
      <div className="filecard card">
        <IconFile />
        <div className="meta">
          <div className="name">{fileName}</div>
          <div className="hint">{fmtBytes(fileSize)}</div>
        </div>
      </div>
      <div className="statgrid">
        <div className="statcell">
          <span className="label">Speed</span>
          <span className="value">{stats ? `${Math.round(stats.kbps)} kb/s` : "—"}</span>
        </div>
        <div className="statcell">
          <span className="label">Left</span>
          <span className="value">{stats?.etaMs != null ? fmtDuration(stats.etaMs) : "—"}</span>
        </div>
        <div className="statcell">
          <span className="label">Chunks</span>
          <span className="value">
            {stats ? `${stats.chunksDelivered} / ${stats.totalChunks}` : "—"}
          </span>
        </div>
        <div className="statcell">
          <span className="label">Errors</span>
          <span className="value">{stats?.errors ?? 0}</span>
        </div>
      </div>
      {note && (
        <p className="note" aria-live="polite">
          {note}
        </p>
      )}
      <div className="spacer" />
      <button type="button" className="danger" onClick={onCancel}>
        <IconX />
        Cancel sending
      </button>
      <p className="visually-hidden" aria-live="polite">
        {phase}
      </p>
    </>
  );
}

export function SendFlow() {
  const sender = useApp((s) => s.sender);
  const setSender = useApp((s) => s.setSender);
  const resetSender = useApp((s) => s.resetSender);
  const setMode = useApp((s) => s.setMode);
  const onlineReady = useApp((s) => s.onlineReady);
  const fileRef = useRef<File | null>(null);
  const controllerRef = useRef<SendController | null>(null);
  const [drag, setDrag] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return () => {
      controllerRef.current?.cancel();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (sender.screen !== "transfer") return;
    return wakeLock();
  }, [sender.screen]);

  const pickFile = (file: File | null | undefined) => {
    if (!file) return;
    fileRef.current = file;
    setSender({
      screen: "channel",
      fileName: file.name,
      fileSize: file.size,
      mime: file.type || "application/octet-stream",
      error: "",
      hash: null,
    });
  };

  const startSend = (channel: SendChannel) => {
    const file = fileRef.current;
    if (!file) {
      setSender({ screen: "pick" });
      return;
    }
    if (channel === "loopback" && !pairingSupported()) {
      setSender({ screen: "error", error: "Nearby pairing isn't available in this browser." });
      return;
    }
    try {
      const controller = new SendController(
        fileSource(file),
        {
          onMatched: (peerFingerprint) => setSender({ screen: "matched", peerFingerprint }),
          onTransferring: () => setSender({ screen: "transfer" }),
          onStats: (stats) => setSender({ stats }),
          onDone: (hash) => setSender({ screen: "done", hash }),
          onError: (message) => setSender({ screen: "error", error: message }),
          onNote: (note) => setSender({ note }),
        },
        channel,
      );
      controllerRef.current = controller;
      if (channel === "light") controller.setFrameMs(sender.frameMs ?? DEFAULT_QR_FRAME_MS);
      setSender({
        screen: "waiting",
        wordPair: controller.wordPair,
        channel,
        link: controller.link,
        peerFingerprint: null,
        stats: null,
        note: null,
        error: "",
      });
    } catch (e) {
      setSender({ screen: "error", error: e instanceof Error ? e.message : "Couldn't start sending." });
    }
  };

  const chooseChannel = (channel: SendChannel) => {
    if (sender.channel !== channel) setSender({ channel });
    startSend(channel);
  };

  const copyLink = async () => {
    if (!sender.link) return;
    try {
      await navigator.clipboard.writeText(sender.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const backToLanding = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    resetSender();
    setMode("landing");
  };

  return (
    <div className="screen">
      {sender.screen === "pick" && (
        <>
          <h2>Send a file</h2>
          <label
            className={`dropzone ${drag ? "drag" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              pickFile(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              type="file"
              onChange={(e) => pickFile(e.target.files?.[0])}
              aria-label="Pick a file to send"
            />
            <IconFile />
            <strong>Pick a file</strong>
            <span className="hint">
              Or drag it here.
              <br />
              It stays on this device until you send it.
            </span>
          </label>
          <button type="button" className="ghost" onClick={backToLanding}>
            <IconBack />
            Back
          </button>
        </>
      )}

      {sender.screen === "channel" && (
        <>
          <h2>Choose a channel</h2>
          <div className="filecard card">
            <IconFile />
            <div className="meta">
              <div className="name">{sender.fileName}</div>
              <div className="hint">{fmtBytes(sender.fileSize)}</div>
            </div>
          </div>
          <div className="channels">
            {CHANNELS.map((c) => {
              const Icon = c.icon;
              const relayDown = c.kind === "online" && onlineReady === false;
              const checking = c.kind === "online" && onlineReady === null;
              const unsupported = channelUnsupported(c.kind);
              return (
                <button
                  key={c.kind}
                  type="button"
                  className="channelbtn"
                  disabled={relayDown || checking || unsupported}
                  onClick={() => chooseChannel(c.kind as SendChannel)}
                >
                  <Icon />
                  <span>
                    <span className="ctitle">{c.title}</span>
                    <br />
                    <span className="csub">
                      {relayDown
                        ? "Live relay unavailable — try again later"
                        : unsupported
                          ? "Not available in this browser"
                          : c.sub}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <button type="button" className="ghost" onClick={() => setSender({ screen: "pick" })}>
            <IconBack />
            Back
          </button>
        </>
      )}

      {sender.screen === "waiting" && (
        <>
          <h2>Waiting</h2>
          {sender.channel === "online" ? (
            <>
              <p className="hint">Send this link to the other device:</p>
              <div className="linkcard card">
                <IconOnline />
                <div className="linktext">{sender.link}</div>
                <button type="button" className="ghost" onClick={() => void copyLink()}>
                  <IconCopy />
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              <WordChips pair={sender.wordPair} />
              <p className="hint">
                Open the link on the other device, then check the same two words on both screens.
                The file travels device to device — the link only carries connection details.
              </p>
            </>
          ) : (
            <>
              {sender.channel === "light" && controllerRef.current?.display && (
                <div className="qrcard-wrap">
                  <QrCard transport={controllerRef.current.display} frameMs={sender.frameMs ?? DEFAULT_QR_FRAME_MS} />
                </div>
              )}
              <WordChips pair={sender.wordPair} />
              {sender.channel === "light" && (
                <>
                  <p className="hint">
                    Hold the phones close, camera to screen. On the other device choose{" "}
                    <strong>Receive</strong> — it should spot this transfer.
                  </p>
                  <FrameRateSlider
                    frameMs={sender.frameMs ?? DEFAULT_QR_FRAME_MS}
                    onChange={(ms) => {
                      setSender({ frameMs: ms });
                      controllerRef.current?.setFrameMs(ms);
                    }}
                  />
                </>
              )}
              {sender.channel === "sound" && (
                <p className="hint">
                  Tones are playing from this speaker — keep it near the other device. On the
                  other device choose <strong>Receive</strong> — it should hear this transfer.
                </p>
              )}
              {sender.channel !== "light" && sender.channel !== "sound" && (
                <p className="hint">
                  On the other device, open Semaphore, choose <strong>Receive</strong>, and look
                  for this transfer. Both devices should show the same two words.
                </p>
              )}
            </>
          )}
          <div className="spacer" />
          <button type="button" className="danger" onClick={backToLanding}>
            <IconX />
            Cancel
          </button>
        </>
      )}

      {sender.screen === "matched" && (
        <>
          <h2>It's a match</h2>
          <WordChips pair={sender.wordPair} />
          <p className="hint">
            The other device shows these same words. Confirm before anything is sent.
          </p>
          {sender.peerFingerprint && (
            <p className="hashbox">peer {sender.peerFingerprint}</p>
          )}
          <div className="spacer" />
          <button
            type="button"
            className="primary big"
            onClick={() => {
              controllerRef.current?.confirmMatch();
              // For broadcast channels the stream starts synchronously, so the
              // transfer screen (with its animated QR) is already live; the
              // `waiting` screen is only a placeholder while a network peer
              // finishes connecting.
              setSender({
                screen: sender.channel === "light" || sender.channel === "sound" ? "transfer" : "waiting",
              });
            }}
          >
            <IconCheck />
            Start sending
          </button>
          <button type="button" className="ghost" onClick={backToLanding}>
            Cancel
          </button>
        </>
      )}

      {sender.screen === "transfer" && (
        <TransferScreen
          stats={sender.stats}
          channel={sender.channel ?? "light"}
          frameMs={sender.frameMs}
          note={sender.note}
          display={controllerRef.current?.display ?? null}
          fileName={sender.fileName}
          fileSize={sender.fileSize}
          onFrameMs={(ms) => {
            setSender({ frameMs: ms });
            controllerRef.current?.setFrameMs(ms);
          }}
          onCancel={backToLanding}
        />
      )}

      {sender.screen === "done" && (
        <>
          <ProgressRing value={1}>
            <div>
              <div className="livenumber">100%</div>
            </div>
          </ProgressRing>
          <h2>Sent</h2>
          <div className="filecard card">
            <IconFile />
            <div className="meta">
              <div className="name">{sender.fileName}</div>
              <div className="hint">{fmtBytes(sender.fileSize)}</div>
            </div>
          </div>
          <p className="hint">
            {sender.channel === "light" || sender.channel === "sound"
              ? "The transfer finished broadcasting. Check the receiving device to confirm it arrived."
              : "The file is on the receiving device. Nothing was routed through a server."}
          </p>
          {sender.hash && <p className="hashbox">checksum {sender.hash}</p>}
          {(sender.channel === "light" || sender.channel === "sound") && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                controllerRef.current?.resend();
                setSender({
                  screen: "waiting",
                  wordPair: controllerRef.current?.wordPair ?? sender.wordPair,
                  channel: sender.channel,
                  link: sender.link,
                  peerFingerprint: null,
                  stats: null,
                  note: "Re-announcing — pick up the receive screen on the other device.",
                });
              }}
            >
              <IconRepeat />
              Broadcast again
            </button>
          )}
          <div className="spacer" />
          <button
            type="button"
            className="primary big"
            onClick={() => {
              controllerRef.current?.cancel();
              controllerRef.current = null;
              resetSender();
            }}
          >
            Send another file
          </button>
          <button type="button" className="ghost" onClick={backToLanding}>
            Back
          </button>
        </>
      )}

      {sender.screen === "error" && (
        <>
          <h2>Couldn't send</h2>
          <div className="errorbox" role="alert">
            {sender.error}
          </div>
          <div className="spacer" />
          <button
            type="button"
            className="primary big"
            onClick={() => {
              controllerRef.current?.cancel();
              controllerRef.current = null;
              setSender({ screen: "pick", error: "" });
            }}
          >
            Try again
          </button>
          <button type="button" className="ghost" onClick={backToLanding}>
            Back
          </button>
        </>
      )}
    </div>
  );
}