import { createHttpMailbox, probeMailbox, type Mailbox } from "@core/mailbox";
import type { MailboxForSession } from "@core/online";

export const API_BASE = "/api/mailbox";

export function iceServersConfig(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* fall back to defaults */
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
}

export function mailboxClient(): Mailbox {
  return createHttpMailbox(API_BASE);
}

export const mailboxForSession: MailboxForSession = (sessionId) => createHttpMailbox(API_BASE, undefined, undefined, [sessionId]);

export function shareLinkFor(sessionId: string): string {
  return `${location.origin}${location.pathname}#${sessionId}`;
}

export function sessionIdFromLink(text: string): string | null {
  const match = text.match(/([0-9a-f]{16})/);
  return match ? match[1] : null;
}

let probePromise: Promise<boolean> | null = null;

export function probeOnlineSupported(): Promise<boolean> {
  if (!probePromise) {
    probePromise = (async () => {
      if (typeof RTCPeerConnection === "undefined") return false;
      return probeMailbox(API_BASE);
    })();
  }
  return probePromise;
}