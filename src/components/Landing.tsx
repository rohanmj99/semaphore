import { useApp } from "../store.ts";
import { IconReceive, IconSend } from "../icons.tsx";

export function Landing() {
  const setMode = useApp((s) => s.setMode);

  return (
    <div className="screen center" style={{ justifyContent: "center" }}>
      <h1>
        Share between
        <br />
        two devices
      </h1>
      <p className="hint">
        No internet, no Wi-Fi, no Bluetooth.
        <br />
        Light, sound, or a link — your pick.
      </p>
      <div className="spacer" />
      <button type="button" className="primary giant" onClick={() => setMode("send")}>
        <IconSend className="big" />
        Send
      </button>
      <button type="button" className="giant ghost" onClick={() => setMode("receive")}>
        <IconReceive className="big" />
        Receive
      </button>
    </div>
  );
}