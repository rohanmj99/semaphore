export interface MailboxEntry {
  i: number;
  p: string;
  ts: number;
}

export interface MailboxPage {
  entries: MailboxEntry[];
  now: number;
  ttlSeconds: number | null;
}

export interface Mailbox {
  put(kind: string, payload: string): Promise<number>;
  get(kind: string, since?: number): Promise<MailboxPage>;
}

export class MailboxHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MailboxHttpError";
  }
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export function createHttpMailbox(
  apiBase: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  timeoutMs = 5000,
  routePrefix: string[] = [],
): Mailbox {
  // Route segments travel in the query string: the deployed function lives at
  // the exact path /api/mailbox (catch-all routes compile to single segments
  // on this project), and vercel.json additionally rewrites /api/mailbox/<...>
  // onto the same ?path=<...> query. A session-scoped mailbox prefixes every
  // request with ?route=<sessionId>.
  const baseQuery = routePrefix.length > 0 ? `${apiBase}?route=${routePrefix.map(encodeURIComponent).join("&route=")}` : apiBase;
  const routeUrl = (kind: string, tail: string) =>
    `${baseQuery}${baseQuery.includes("?") ? "&" : "?"}route=${encodeURIComponent(kind)}${tail}`;
  async function request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ac.signal });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async put(kind, payload) {
      const url = routeUrl(kind, "");
      const res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p: payload }),
      });
      if (!res.ok) {
        throw new MailboxHttpError(res.status, `mailbox write failed (${res.status})`);
      }
      const { i } = res.body as { i: number };
      if (typeof i !== "number") throw new MailboxHttpError(502, "mailbox returned no index");
      return i;
    },
    async get(kind, since = 0) {
      const tail = since > 0 ? `&since=${since}` : "";
      const res = await request(routeUrl(kind, tail), { method: "GET" });
      if (!res.ok) {
        if (res.status === 404) return { entries: [], now: 0, ttlSeconds: null };
        throw new MailboxHttpError(res.status, `mailbox read failed (${res.status})`);
      }
      const page = res.body as Partial<MailboxPage>;
      return {
        entries: Array.isArray(page.entries) ? page.entries : [],
        now: typeof page.now === "number" ? page.now : 0,
        ttlSeconds: typeof page.ttlSeconds === "number" ? page.ttlSeconds : null,
      };
    },
  };
}

export async function probeMailbox(apiBase: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis), timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetchImpl(`${apiBase}?route=ping`, { method: "GET", signal: abortAfter(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function abortAfter(ms: number): AbortSignal {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

export type PollCallback = (entries: MailboxEntry[]) => void;

export class MailboxPoller {
  private watches = new Map<string, { since: number; cbs: Set<PollCallback> }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly mailbox: Mailbox,
    private readonly intervalMs = 900,
  ) {}

  subscribe(kind: string, cb: PollCallback): () => void {
    let w = this.watches.get(kind);
    if (!w) {
      w = { since: 0, cbs: new Set() };
      this.watches.set(kind, w);
    }
    w.cbs.add(cb);
    return () => {
      w?.cbs.delete(cb);
    };
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => void this.runLoop(), 1);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async flushFor(kind: string): Promise<void> {
    await this.tickKind(kind);
  }

  private async runLoop(): Promise<void> {
    if (this.stopped) return;
    if (!this.ticking) {
      this.ticking = true;
      try {
        await this.tickAll();
      } finally {
        this.ticking = false;
      }
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.runLoop(), this.intervalMs);
    }
  }

  private async tickAll(): Promise<void> {
    for (const kind of [...this.watches.keys()]) {
      await this.tickKind(kind);
    }
  }

  private async tickKind(kind: string): Promise<void> {
    const w = this.watches.get(kind);
    if (!w || this.stopped) return;
    try {
      const page = await this.mailbox.get(kind, w.since);
      if (page.now > w.since) {
        w.since = page.now;
        for (const cb of [...w.cbs]) cb(page.entries);
      }
    } catch {
      /* transport hiccup; next tick retries */
    }
  }
}

export function parseMailboxJson<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

export async function putWithRetry(mailbox: Mailbox, kind: string, payload: string, tries = 3): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await mailbox.put(kind, payload);
      return true;
    } catch {
      await sleepMs(300 * (attempt + 1));
    }
  }
  return false;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}