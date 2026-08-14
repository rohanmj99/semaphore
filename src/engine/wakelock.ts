interface WakeLockSentinel {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

/** Keeps the screen on during a transfer; no-op where unsupported. */
export function wakeLock(): () => void {
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
  };
  if (!nav.wakeLock) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let rejected = false;
  const release = () => {
    sentinel?.release().catch(() => {});
    sentinel = null;
  };
  nav.wakeLock
    .request("screen")
    .then((s) => {
      if (rejected) {
        s.release().catch(() => {});
        return;
      }
      sentinel = s;
      const onLost = () => {
        sentinel = null;
      };
      s.addEventListener("release", onLost);
    })
    .catch(() => {});
  return () => {
    rejected = true;
    release();
  };
}