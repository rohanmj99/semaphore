import { useEffect } from "react";
import { useApp } from "./store.ts";
import { Landing } from "./components/Landing.tsx";
import { SendFlow } from "./components/SendFlow.tsx";
import { ReceiveFlow } from "./components/ReceiveFlow.tsx";
import { probeOnlineSupported, sessionIdFromLink } from "./config.ts";

export function App() {
  const mode = useApp((s) => s.mode);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const setOnlineReady = useApp((s) => s.setOnlineReady);
  const setMode = useApp((s) => s.setMode);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    probeOnlineSupported().then((ready) => setOnlineReady(ready));
    const openLink = () => {
      if (sessionIdFromLink(location.hash)) setMode("receive");
    };
    openLink();
    window.addEventListener("hashchange", openLink);
    return () => {
      window.removeEventListener("hashchange", openLink);
    };
  }, [setMode, setOnlineReady]);

  return (
    <main className="app">
      <header className="topbar">
        <span className="faint" aria-hidden="true">
          SEMA·PHORE
        </span>
        <button
          type="button"
          className="iconbtn"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
            {theme === "dark" ? (
              <path
                className="iconstroke"
                d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"
              />
            ) : (
              <>
                <circle cx="12" cy="12" r="4.2" className="iconstroke" />
                <path
                  className="iconstroke"
                  d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"
                />
              </>
            )}
          </svg>
        </button>
      </header>

      {mode === "landing" ? <Landing /> : mode === "send" ? <SendFlow /> : <ReceiveFlow />}

      <p className="visually-hidden" aria-live="polite">
        {mode === "send" ? "Sending screen" : mode === "receive" ? "Receiving screen" : "Semaphore"}
      </p>
    </main>
  );
}