import { useEffect, useRef, useState } from "react";
import { useApp } from "../store.ts";
import { SendController, type SendChannel } from "../engine/send.ts";
import { wakeLock } from "../engine/wakelock.ts";
import { fileSource } from "@core/chunker";
import { pairingSupported } from "@core/pairing";
import { fmtBytes, fmtDuration } from "@core/util";
import { ProgressRing } from "./ProgressRing.tsx";
import {
  IconBack,
  IconCheck,
  IconCopy,
  IconDevice,
  IconFile,
  IconLight,
  IconOnline,
  IconSound,
  IconX,
} from "../icons.tsx";

const CHANNELS = [
  { kind: "loopback", title: "This device", sub: "Two tabs on this computer", icon: IconDevice, soon: false },
  { kind: "online", title: "Online link", sub: "Send a link — bytes go straight between devices", icon: IconOnline, soon: false },
  { kind: "light", title: "Screen flash", sub: "Coming soon", icon: IconLight, soon: true },
  { kind: "sound", title: "Sound", sub: "Coming soon", icon: IconSound, soon: true },
] as const;

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
              return (
                <button
                  key={c.kind}
                  type="button"
                  className="channelbtn"
                  disabled={c.soon || relayDown || checking}
                  onClick={() => chooseChannel(c.kind as SendChannel)}
                >
                  <Icon />
                  <span>
                    <span className="ctitle">{c.title}</span>
                    <br />
                    <span className="csub">
                      {relayDown ? "Live relay unavailable — try again later" : c.sub}
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
              <WordChips pair={sender.wordPair} />
              <p className="hint">
                On the other device, open Semaphore, choose <strong>Receive</strong>, and look for
                this transfer. Both devices should show the same two words.
              </p>
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
              setSender({ screen: "waiting" });
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

      {sender.screen === "transfer" && <TransferScreen />}

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
            The file is on the receiving device. Nothing was routed through a server.
          </p>
          {sender.hash && <p className="hashbox">checksum {sender.hash}</p>}
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

  function TransferScreen() {
    const stats = sender.stats;
    const total = stats?.totalBytes ?? 1;
    const sent = stats?.transferredBytes ?? 0;
    const value = total > 0 ? Math.min(1, sent / total) : 0;
    const percent = Math.round(value * 100);
    const phase = stats?.phase ? PHASE_LABEL[stats.phase] ?? "Sending" : "Connecting";
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
            <div className="name">{sender.fileName}</div>
            <div className="hint">{fmtBytes(sender.fileSize)}</div>
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
        {sender.note && (
          <p className="note" aria-live="polite">
            {sender.note}
          </p>
        )}
        <div className="spacer" />
        <button type="button" className="danger" onClick={backToLanding}>
          <IconX />
          Cancel sending
        </button>
        <p className="visually-hidden" aria-live="polite">
          {phase}
        </p>
      </>
    );
  }
}