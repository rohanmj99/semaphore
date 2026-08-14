import { useEffect, useRef, useState } from "react";
import { useApp, type ReceivedFile } from "../store.ts";
import { nearbyMatcher, ReceiveController, ensureStorageFits } from "../engine/receive.ts";
import { wakeLock } from "../engine/wakelock.ts";
import { scanForSessions, pairingSupported, type VisibleSession } from "@core/pairing";
import { scanSoundSessions, soundRxSupport } from "@core/modem/sound";
import { scanLightSessions, lightSupported } from "@core/qr/light";
import { fmtBytes, fmtDuration } from "@core/util";
import { ProgressRing } from "./ProgressRing.tsx";
import { QrCard } from "./QrCard.tsx";
import { sessionIdFromLink } from "../config.ts";
import {
  IconBack,
  IconCheck,
  IconCopy,
  IconDownload,
  IconEar,
  IconFile,
  IconX,
} from "../icons.tsx";

type ScannedSession = VisibleSession & { channel: "loopback" | "sound" | "light" };

const CHANNEL_TAG: Record<ScannedSession["channel"], string> = {
  loopback: "nearby",
  sound: "sound",
  light: "screen flash",
};

const PHASE_LABEL: Record<string, string> = {
  connecting: "Connecting",
  manifest: "Preparing",
  running: "Receiving",
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

function downloadFile(entry: ReceivedFile) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(entry.bytes)], { type: entry.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ReceiveFlow() {
  const receiver = useApp((s) => s.receiver);
  const setReceiver = useApp((s) => s.setReceiver);
  const resetReceiver = useApp((s) => s.resetReceiver);
  const setMode = useApp((s) => s.setMode);
  const controllerRef = useRef<ReceiveController | null>(null);
  const [unsupported] = useState(() => !pairingSupported());
  const [linkInput, setLinkInput] = useState("");
  const [opening, setOpening] = useState(false);
  const consumedLink = useRef(false);
  const chosenChannel = useRef<ScannedSession["channel"] | "online" | null>(null);
  const [scanIssue, setScanIssue] = useState("");

  useEffect(() => {
    if (consumedLink.current) return;
    const hashId = sessionIdFromLink(location.hash);
    if (!hashId) return;
    consumedLink.current = true;
    history.replaceState(null, "", location.pathname + location.search);
    setReceiver({ screen: "waiting", error: "" });
    startOnline(hashId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (unsupported) return;
    if (useApp.getState().receiver.screen !== "listen") return;
    setScanIssue("");
    const byId = new Map<string, ScannedSession>();
    const commit = () => {
      if (useApp.getState().receiver.screen !== "listen") return;
      setReceiver({
        sessions: [...byId.values()].sort((a, b) => a.seenAt - b.seenAt),
      });
    };
    const tag = (list: VisibleSession[], channel: ScannedSession["channel"]) => {
      for (const s of list) {
        if (!byId.has(s.sessionId)) byId.set(s.sessionId, { ...s, channel });
      }
      commit();
    };
    const note = (msg: string) =>
      setScanIssue((prev) => (prev.includes(msg) ? prev : `${prev ? `${prev} ` : ""}${msg}`));
    const stops: Array<() => void> = [];
    if (pairingSupported()) stops.push(scanForSessions((l) => tag(l, "loopback")));
    if (soundRxSupport()) {
      stops.push(() =>
        scanSoundSessions((l) => tag(l, "sound"), note).stop(),
      );
    }
    if (lightSupported()) {
      stops.push(() =>
        scanLightSessions((l) => tag(l, "light"), note).stop(),
      );
    }
    return () => {
      for (const stop of stops) stop();
      chosenChannel.current = null;
    };
    // Keyed by screen so the camera + mic are only active while the user is
    // actually on the listen screen (they are released as soon as a session
    // is picked and the matcher's own channel camera/mic take over).
  }, [unsupported, setReceiver, receiver.screen]);

  useEffect(() => {
    if (receiver.screen !== "transfer") return;
    return wakeLock();
  }, [receiver.screen]);

  const pickSession = async (session: ScannedSession) => {
    if (session.file) {
      const problem = await ensureStorageFits(session.file.size);
      if (problem) {
        setReceiver({ screen: "error", error: problem });
        return;
      }
    }
    chosenChannel.current = session.channel;
    const controller = new ReceiveController(
      session,
      {
        onTransferring: () => setReceiver({ screen: "transfer" }),
        onStats: (stats) => setReceiver({ stats }),
        onError: (message) => setReceiver({ screen: "error", error: message }),
        onDone: ({ data, header, hash }) => {
          const entry: ReceivedFile = {
            id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            name: header.filename,
            mime: header.mime,
            size: header.originalSize,
            hash,
            receivedAt: Date.now(),
            bytes: data,
          };
          const state = useApp.getState();
          controllerRef.current?.cancel();
          controllerRef.current = null;
          setReceiver({
            screen: "done",
            file: entry,
            received: [...state.receiver.received, entry],
            stats: null,
          });
        },
      },
      nearbyMatcher(session, session.channel),
    );
    controllerRef.current = controller;
    setReceiver({ screen: "match", chosen: session, stats: null, error: "" });
  };

  const startOnline = async (sessionId: string) => {
    if (opening) return;
    setOpening(true);
    try {
      const controller = await ReceiveController.openOnline(sessionId, {
        onTransferring: () => setReceiver({ screen: "transfer", note: null }),
        onStats: (stats) => setReceiver({ stats }),
        onError: (message) => setReceiver({ screen: "error", error: message }),
        onNote: (note) => setReceiver({ note }),
        onDone: ({ data, header, hash }) => {
          const entry: ReceivedFile = {
            id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            name: header.filename,
            mime: header.mime,
            size: header.originalSize,
            hash,
            receivedAt: Date.now(),
            bytes: data,
          };
          const state = useApp.getState();
          controllerRef.current?.cancel();
          controllerRef.current = null;
          setReceiver({
            screen: "done",
            file: entry,
            received: [...state.receiver.received, entry],
            stats: null,
            note: null,
          });
        },
      });
      controllerRef.current = controller;
      chosenChannel.current = "online";
      setReceiver({ screen: "match", chosen: controller.session, stats: null, error: "" });
    } catch (e) {
      controllerRef.current?.cancel();
      controllerRef.current = null;
      setReceiver({ screen: "error", error: e instanceof Error ? e.message : "Couldn't open this link." });
    } finally {
      setOpening(false);
    }
  };

  const backToLanding = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    resetReceiver();
    setMode("landing");
  };

  const backToListen = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    chosenChannel.current = null;
    setReceiver({ screen: "listen", chosen: null, stats: null, error: "" });
  };

  return (
    <div className="screen">
      {receiver.screen === "listen" && (
        <>
          <h2>Receive</h2>
          {unsupported ? (
            <div className="errorbox" role="alert">
              Nearby pairing isn't available in this browser.
            </div>
          ) : (
            <>
              <div className="live">
                <IconEar className="big pulse" />
                <div className="livelabel">Listening for a nearby sender</div>
              </div>
              {receiver.sessions.length > 0 ? (
                <div className="sessions">
                  {receiver.sessions.map((s) => (
                    <button
                      key={s.sessionId}
                      type="button"
                      className="sessionbtn card"
                      onClick={() => void pickSession(s as ScannedSession)}
                    >
                      <WordChips pair={s.wordPair} />
                      <span className="sessiontag">{CHANNEL_TAG[(s as ScannedSession).channel] ?? "nearby"}</span>
                      <span className="hint">
                        {s.file ? `${s.file.name} · ${fmtBytes(s.file.size)}` : "Spot the session"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="hint" aria-live="polite">
                  Waiting for a sender. This device is listening with your camera (screen-flash
                  QR), your microphone (sound tones), and nearby open tabs. On the other device
                  choose Send and pick the same channel.
                </p>
              )}
              {scanIssue ? (
                <p className="hint warn" role="alert">
                  {scanIssue}
                </p>
              ) : null}
              <div className="linkentry">
                <label htmlFor="link-input" className="visually-hidden">
                  Paste a Semaphore link
                </label>
                <input
                  id="link-input"
                  type="text"
                  placeholder="Or paste an online link"
                  value={linkInput}
                  disabled={opening}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && sessionIdFromLink(linkInput)) {
                      void startOnline(sessionIdFromLink(linkInput) as string);
                    }
                  }}
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={opening || !sessionIdFromLink(linkInput)}
                  onClick={() => {
                    const id = sessionIdFromLink(linkInput);
                    if (id) void startOnline(id);
                  }}
                >
                  <IconCopy />
                  Open link
                </button>
              </div>
            </>
          )}
          <div className="spacer" />
          <button type="button" className="ghost" onClick={backToLanding}>
            <IconBack />
            Back
          </button>
        </>
      )}

      {receiver.screen === "match" && receiver.chosen && (
        <>
          <h2>Check the words</h2>
          <WordChips pair={receiver.chosen.wordPair} />
          <p className="hint">
            These words also appear on the sending device — nothing is sent unless both confirm.
          </p>
          {receiver.chosen.senderFingerprint && (
            <p className="hashbox">peer {receiver.chosen.senderFingerprint}</p>
          )}
          <div className="spacer" />
          <button
            type="button"
            className="primary big"
            onClick={() => {
              controllerRef.current?.confirm();
              setReceiver({ screen: "waiting" });
            }}
          >
            <IconCheck />
            These words match
          </button>
          <button type="button" className="ghost" onClick={backToListen}>
            Cancel
          </button>
        </>
      )}

      {receiver.screen === "waiting" && (
        <>
          <h2>Waiting</h2>
          {chosenChannel.current === "light" && controllerRef.current?.matchDisplay && (
            <div className="qrcard-wrap">
              <QrCard transport={controllerRef.current.matchDisplay} />
            </div>
          )}
          <div className="live">
            <IconEar className="big pulse" />
            <div className="livelabel">Waiting for the sender to start</div>
          </div>
          <p className="hint">
            {chosenChannel.current === "light"
              ? "Hold the phones close, camera to screen. The transfer starts automatically."
              : chosenChannel.current === "sound"
                ? "Keep this screen open near the sending device. The transfer starts automatically."
                : "Keep this screen open. The transfer starts automatically."}
          </p>
          <div className="spacer" />
          <button type="button" className="danger" onClick={backToListen}>
            <IconX />
            Cancel
          </button>
        </>
      )}

      {receiver.screen === "transfer" && <TransferScreen />}

      {receiver.screen === "done" && receiver.file && (
        <>
          <ProgressRing value={1}>
            <div>
              <div className="livenumber">100%</div>
            </div>
          </ProgressRing>
          <h2>Received</h2>
          <div className="filecard card">
            <IconFile />
            <div className="meta">
              <div className="name">{receiver.file.name}</div>
              <div className="hint">{fmtBytes(receiver.file.size)}</div>
            </div>
          </div>
          <p className="hashbox">checksum {receiver.file.hash}</p>
          <div className="spacer" />
          <button
            type="button"
            className="primary big"
            onClick={() => downloadFile(receiver.file!)}
          >
            <IconDownload />
            Save file
          </button>
          <button type="button" className="ghost" onClick={backToListen}>
            Keep listening
          </button>
          <button type="button" className="quiet" onClick={backToLanding}>
            Back
          </button>
        </>
      )}

      {receiver.screen === "error" && (
        <>
          <h2>Couldn't receive</h2>
          <div className="errorbox" role="alert">
            {receiver.error}
          </div>
          <div className="spacer" />
          <button type="button" className="primary big" onClick={backToListen}>
            Try again
          </button>
          <button type="button" className="ghost" onClick={backToLanding}>
            Back
          </button>
        </>
      )}
    </div>
  );

  function TransferScreen() {
    const stats = receiver.stats;
    const total = stats?.totalBytes ?? 1;
    const got = stats?.transferredBytes ?? 0;
    const value = total > 0 ? Math.min(1, got / total) : 0;
    const percent = Math.round(value * 100);
    const phase = stats?.phase ? PHASE_LABEL[stats.phase] ?? "Receiving" : "Connecting";
    return (
      <>
        <ProgressRing value={value}>
          <div>
            <div className="livenumber">{percent}%</div>
            <div className="livelabel">{phase}</div>
          </div>
        </ProgressRing>
        <div className="filecard card">
          <IconFile />
          <div className="meta">
            <div className="name">Receiving a file</div>
            <div className="hint">{stats ? `${fmtBytes(stats.transferredBytes)} / ${fmtBytes(stats.totalBytes)}` : "Connecting…"}</div>
          </div>
        </div>
        {chosenChannel.current === "light" && (
          <p className="hint">Keep the phones facing each other until it finishes.</p>
        )}
        {chosenChannel.current === "sound" && (
          <p className="hint">Keep the phones close until it finishes.</p>
        )}
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
            <span className="label">Errors</span>
            <span className="value">{stats?.errors ?? 0}</span>
          </div>
          <div className="statcell">
            <span className="label">Chunks</span>
            <span className="value">
              {stats ? `${stats.chunksDelivered} / ${stats.totalChunks}` : "—"}
            </span>
          </div>
        </div>
        {receiver.note && (
          <p className="note" aria-live="polite">
            {receiver.note}
          </p>
        )}
        <div className="spacer" />
        <button type="button" className="danger" onClick={backToListen}>
          <IconX />
          Cancel receiving
        </button>
        <p className="visually-hidden" aria-live="polite">
          {phase}
        </p>
      </>
    );
  }
}