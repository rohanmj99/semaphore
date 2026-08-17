import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, type ReceivedFile } from "../store.ts";
import { nearbyMatcher, ReceiveController, ensureStorageFits } from "../engine/receive.ts";
import { wakeLock } from "../engine/wakelock.ts";
import { scanForSessions, pairingSupported, type VisibleSession } from "@core/pairing";
import { scanSoundSessions, soundRxSupport } from "@core/modem/sound";
import {
  scanLightSessions,
  lightSupported,
  type CameraFacing,
  type LightScanHandle,
} from "@core/qr/light";
import type { ProgressStats } from "@core/types";
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
  IconRepeat,
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

/** Live camera box: video preview, scanning animation, a "QR seen" status
 *  line and a front/back camera switcher. Used on the listen, waiting and
 *  transfer screens of the light channel. */
function CameraBox({
  previewRef,
  status,
  onSwitch,
}: {
  previewRef: React.Ref<HTMLDivElement>;
  status: { seen: boolean; facing: CameraFacing | null };
  onSwitch?: () => void;
}) {
  return (
    <div className="cambox">
      <div className="camstage">
        <div className="campreview" ref={previewRef} />
        <div className="scanline" aria-hidden="true" />
        <span className="camcorner tl" aria-hidden="true" />
        <span className="camcorner tr" aria-hidden="true" />
        <span className="camcorner bl" aria-hidden="true" />
        <span className="camcorner br" aria-hidden="true" />
      </div>
      <div className="camstatus" aria-live="polite">
        <span className={`camdot ${status.seen ? "on" : ""}`} />
        {status.seen ? "QR spotted — keep it in frame" : "Scanning for QR codes…"}
      </div>
      {onSwitch && (
        <button type="button" className="ghost small" onClick={onSwitch}>
          <IconRepeat />
          {status.facing === "user" ? "Use back camera" : "Use front camera"}
        </button>
      )}
    </div>
  );
}

type TransferChannel = "loopback" | "online" | "sound" | "light" | null;

/** Transfer progress screen. Defined at module scope: a component defined
 *  inside the parent's body is recreated on every parent render (stats update
 *  every ~250 ms), which remounts its whole subtree — including the camera
 *  preview div and the imperatively-inserted video element — leaving the
 *  camera black. A top-level component plus a stable callback ref keeps the
 *  preview box alive across stats updates. */
function TransferScreen({
  stats,
  channel,
  seen,
  facing,
  note,
  previewRef,
  onSwitchCam,
  onCancel,
}: {
  stats: ProgressStats | null;
  channel: TransferChannel;
  seen: boolean;
  facing: CameraFacing | null;
  note: string | null | undefined;
  previewRef: React.Ref<HTMLDivElement>;
  onSwitchCam: () => void;
  onCancel: () => void;
}) {
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
      {channel === "light" && (
        <>
          <CameraBox
            previewRef={previewRef}
            status={{ seen, facing }}
            onSwitch={onSwitchCam}
          />
          <p className={`hint ${seen ? "" : "warn"}`} role={seen ? undefined : "alert"}>
            {seen
              ? "Keep the phones facing each other — the QR is being read."
              : "No QR seen — point the camera back at the sending screen. The sender repeats everything until you catch it."}
          </p>
        </>
      )}
      {channel === "sound" && (
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
      {note && (
        <p className="note" aria-live="polite">
          {note}
        </p>
      )}
      <div className="spacer" />
      <button type="button" className="danger" onClick={onCancel}>
        <IconX />
        Cancel receiving
      </button>
      <p className="visually-hidden" aria-live="polite">
        {phase}
      </p>
    </>
  );
}

export function ReceiveFlow() {
  const receiver = useApp((s) => s.receiver);
  const setReceiver = useApp((s) => s.setReceiver);
  const resetReceiver = useApp((s) => s.resetReceiver);
  const setMode = useApp((s) => s.setMode);
  const controllerRef = useRef<ReceiveController | null>(null);
  const camPreviewRef = useRef<HTMLDivElement | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [opening, setOpening] = useState(false);
  const consumedLink = useRef(false);
  const chosenChannel = useRef<ScannedSession["channel"] | "online" | null>(null);
  const [scanIssue, setScanIssue] = useState("");
  const [nearbyOn, setNearbyOn] = useState(true);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [camFacing, setCamFacing] = useState<CameraFacing | null>(null);
  const [camSeen, setCamSeen] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<"mic" | "cam" | null>(null);
  const lightScanRef = useRef<LightScanHandle | null>(null);
  const waitingCamRef = useRef<HTMLDivElement | null>(null);
  const [waitingSeen, setWaitingSeen] = useState(false);
  const [waitingFacing, setWaitingFacing] = useState<CameraFacing | null>(null);
  const [transferSeen, setTransferSeen] = useState(false);
  const [transferFacing, setTransferFacing] = useState<CameraFacing | null>(null);

  // Stable identity (no deps) so React only invokes it when the transfer
  // screen's preview div actually mounts/unmounts — re-attaching the camera
  // video every time the remounted screen appears.
  const transferPreviewRef = useCallback((el: HTMLDivElement | null) => {
    if (el) controllerRef.current?.attachPreview(el);
  }, []);

  const switchCam = async () => {
    const ok = await lightScanRef.current?.switchCamera();
    if (!ok) setScanIssue("Couldn't switch the camera on this device.");
    else setCamFacing(lightScanRef.current?.cameraFacing() ?? null);
  };

  const switchMatchCam = async () => {
    const ok = await controllerRef.current?.switchCamera();
    if (!ok) {
      if (useApp.getState().receiver.screen === "transfer") {
        setReceiver({ note: "Couldn't switch the camera — using the current one." });
      } else {
        setReceiver({ screen: "error", error: "Couldn't switch the camera on this device." });
      }
      return;
    }
    setWaitingFacing(controllerRef.current?.cameraFacing() ?? null);
    setTransferFacing(controllerRef.current?.cameraFacing() ?? null);
  };

  const toggleMic = async () => {
    if (micOn) {
      setMicOn(false);
      return;
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
      setScanIssue("Microphone isn't available in this browser.");
      return;
    }
    setPendingPermission("mic");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicOn(true);
    } catch {
      setScanIssue("Microphone access was blocked. Allow mic permission in the browser to receive tones.");
    } finally {
      setPendingPermission(null);
    }
  };

  const toggleCam = async () => {
    if (camOn) {
      setCamOn(false);
      return;
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
      setScanIssue("Camera isn't available in this browser.");
      return;
    }
    setPendingPermission("cam");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camFacing ?? "environment" },
      });
      s.getTracks().forEach((t) => t.stop());
      setCamOn(true);
    } catch {
      setScanIssue("Camera access was blocked. Allow camera permission in the browser to receive screen flashes.");
    } finally {
      setPendingPermission(null);
    }
  };

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
    if (nearbyOn && pairingSupported()) stops.push(scanForSessions((l) => tag(l, "loopback")));
    if (micOn && soundRxSupport()) {
      const scan = scanSoundSessions((l) => tag(l, "sound"), note);
      stops.push(() => scan.stop());
    }
    if (camOn && lightSupported()) {
      const scan = scanLightSessions(
        (l) => tag(l, "light"),
        note,
        { preview: camPreviewRef.current ?? undefined, facing: camFacing ?? undefined },
      );
      lightScanRef.current = scan;
      setCamFacing(scan.cameraFacing());
      const poll = setInterval(() => {
        const last = lightScanRef.current?.lastDecodeMs() ?? 0;
        setCamSeen(Date.now() - last < 2500);
      }, 600);
      stops.push(() => {
        clearInterval(poll);
        scan.stop();
        lightScanRef.current = null;
        setCamSeen(false);
        if (camPreviewRef.current) camPreviewRef.current.replaceChildren();
      });
    }
    return () => {
      for (const stop of stops) stop();
    };
    // Keyed by screen + toggles so the camera + mic are only active while the
    // user is listening; they are released as soon as a session is picked and
    // the matcher's own channel camera/mic take over.
  }, [setReceiver, receiver.screen, nearbyOn, micOn, camOn]);

  useEffect(() => {
    if (receiver.screen !== "transfer") return;
    return wakeLock();
  }, [receiver.screen]);

  // Light channel: attach the matcher's live camera to the waiting + transfer
  // screens so the user can aim, and surface a "QR seen" status line. The
  // transfer screen's preview box is recreated on every stats update (see
  // TransferScreen above), so it attaches through a stable callback ref that
  // re-attaches on each mount instead of this effect.
  useEffect(() => {
    if (receiver.screen !== "waiting" && receiver.screen !== "transfer") return;
    if (chosenChannel.current !== "light") return;
    if (receiver.screen === "waiting" && waitingCamRef.current) {
      controllerRef.current?.attachPreview(waitingCamRef.current);
    }
    setWaitingFacing(controllerRef.current?.cameraFacing() ?? null);
    setTransferFacing(controllerRef.current?.cameraFacing() ?? null);
    const poll = setInterval(() => {
      const last = controllerRef.current?.lastDecodeMs() ?? 0;
      const seen = Date.now() - last < 3000;
      if (receiver.screen === "waiting") setWaitingSeen(seen);
      else setTransferSeen(seen);
    }, 600);
    return () => {
      clearInterval(poll);
      setWaitingSeen(false);
      setTransferSeen(false);
    };
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
          <p className="hint">
            Turn on a channel to start listening, then pick the same channel on the sending
            device. You'll be asked for permission the first time.
          </p>
          <div className="channeltoggles">
            {pairingSupported() && (
              <button
                type="button"
                className={`channeltoggle ${nearbyOn ? "on" : ""}`}
                aria-pressed={nearbyOn}
                onClick={() => setNearbyOn((v) => !v)}
              >
                <span className="ct-name">Nearby tabs</span>
                <span className="ct-desc">Sessions announced by this same browser</span>
                <span className="ct-state">{nearbyOn ? "listening" : "off"}</span>
              </button>
            )}
            <button
              type="button"
              className={`channeltoggle ${micOn ? "on" : ""}`}
              aria-pressed={micOn}
              disabled={pendingPermission !== null}
              onClick={() => void toggleMic()}
            >
              <span className="ct-name">Microphone · tone bursts</span>
              <span className="ct-desc">
                Hear sessions announced as sound from another device's speaker
              </span>
              <span className="ct-state">
                {micOn ? "listening" : pendingPermission === "mic" ? "asking for mic…" : "off"}
              </span>
            </button>
            <button
              type="button"
              className={`channeltoggle ${camOn ? "on" : ""}`}
              aria-pressed={camOn}
              disabled={pendingPermission !== null}
              onClick={() => void toggleCam()}
            >
              <span className="ct-name">Camera · screen flash</span>
              <span className="ct-desc">See sessions announced as flashing QR codes</span>
              <span className="ct-state">
                {camOn ? "listening" : pendingPermission === "cam" ? "asking for camera…" : "off"}
              </span>
            </button>
          </div>
          {camOn && lightSupported() && (
            <CameraBox previewRef={camPreviewRef} status={{ seen: camSeen, facing: camFacing }} onSwitch={() => void switchCam()} />
          )}
          {camOn && lightSupported() && (
            <p className="hint">
              Point the camera at the other screen's <strong>flashing QR codes</strong> — the
              sender keeps re-broadcasting until the transfer arrives, so hold steady.
            </p>
          )}
          {scanIssue ? (
            <p className="hint warn" role="alert">
              {scanIssue}
            </p>
          ) : null}
          {nearbyOn || micOn || camOn ? (
            receiver.sessions.length > 0 ? (
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
                Waiting for a sender. On the other device choose Send and pick the same channel.
                Hold the screens close together (camera to screen for flash, speaker to this
                device for sound).
              </p>
            )
          ) : (
            <p className="hint" aria-live="polite">
              Enable a channel above to start listening.
            </p>
          )}
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
            <>
              <div className="qrcard-wrap">
                <QrCard transport={controllerRef.current.matchDisplay} />
              </div>
              <CameraBox
                previewRef={waitingCamRef}
                status={{ seen: waitingSeen, facing: waitingFacing }}
                onSwitch={() => void switchMatchCam()}
              />
            </>
          )}
          <div className="live">
            <IconEar className="big pulse" />
            <div className="livelabel">Waiting for the sender to start</div>
          </div>
          <p className="hint">
            {chosenChannel.current === "light"
              ? "Hold the phones close, camera to screen. The transfer starts automatically — keep the flashing QR inside the box."
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

      {receiver.screen === "transfer" && (
        <TransferScreen
          stats={receiver.stats}
          channel={chosenChannel.current}
          seen={transferSeen}
          facing={transferFacing}
          note={receiver.note}
          previewRef={transferPreviewRef}
          onSwitchCam={() => void switchMatchCam()}
          onCancel={backToListen}
        />
      )}

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
          <p className="okbox">
            <IconCheck />
            File verified — checksum {receiver.file.hash}
          </p>
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
}