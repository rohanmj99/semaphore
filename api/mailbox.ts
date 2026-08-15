import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { MailboxEntry } from "../core/mailbox.ts";

// Self-contained mailbox function. Vercel deploys each api file compiled on
// its own, so this entry must not import any sibling .ts module at runtime —
// only type imports (stripped at compile) are allowed. The store logic below
// is kept in sync with core/mailbox-store.ts, which the tests and the dev
// server (scripts/dev-mailbox.ts) import directly.
//
// Routing: catch-all files (api/[...route].ts) deploy as single-segment
// routes on this project, so the mailbox lives at the exact path /api/mailbox
// and receives its segments through the query string:
//   - vercel.json rewrites /api/mailbox/<...> to /api/mailbox?path=<...>
//   - the client also speaks query style directly (?route=a&route=b)
// Both are parsed below, so the function works with or without the rewrite.

interface MailboxStore {
  list(key: string): Promise<MailboxEntry[]>;
  append(key: string, payload: string, ttlSeconds: number): Promise<number>;
  ttlOf(key: string): Promise<number | null>;
}

class MemoryMailboxStore implements MailboxStore {
  private map = new Map<string, { entries: MailboxEntry[]; expiresAt: number }>();

  async list(key: string): Promise<MailboxEntry[]> {
    const box = this.map.get(key);
    if (!box) return [];
    if (Date.now() > box.expiresAt) {
      this.map.delete(key);
      return [];
    }
    return box.entries;
  }

  async append(key: string, payload: string, ttlSeconds: number): Promise<number> {
    let box = this.map.get(key);
    if (!box || Date.now() > box.expiresAt) {
      box = { entries: [], expiresAt: 0 };
      this.map.set(key, box);
    }
    const i = box.entries.length > 0 ? box.entries[box.entries.length - 1].i + 1 : 1;
    box.entries.push({ i, p: payload, ts: Date.now() });
    box.expiresAt = Date.now() + ttlSeconds * 1000;
    return i;
  }

  async ttlOf(key: string): Promise<number | null> {
    const box = this.map.get(key);
    if (!box) return null;
    return Math.max(1, Math.ceil((box.expiresAt - Date.now()) / 1000));
  }
}

interface KvsClient {
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
}

class KvMailboxStore implements MailboxStore {
  constructor(private readonly kv: KvsClient) {}

  async list(key: string): Promise<MailboxEntry[]> {
    const members = await this.kv.zrange(key, 0, -1);
    const entries: MailboxEntry[] = [];
    for (const member of members) {
      try {
        const entry = JSON.parse(member) as MailboxEntry;
        if (entry && typeof entry.i === "number" && typeof entry.p === "string") entries.push(entry);
      } catch {
        /* skip malformed member */
      }
    }
    entries.sort((a, b) => a.i - b.i);
    return entries;
  }

  async append(key: string, payload: string, ttlSeconds: number): Promise<number> {
    const entries = await this.list(key);
    const i = entries.length > 0 ? entries[entries.length - 1].i + 1 : 1;
    await this.kv.zadd(key, i, JSON.stringify({ i, p: payload, ts: Date.now() }));
    await this.kv.expire(key, ttlSeconds);
    return i;
  }

  async ttlOf(key: string): Promise<number | null> {
    const ttl = await this.kv.ttl(key);
    if (ttl === -1 || ttl === -2) return null;
    return Math.max(1, ttl);
  }
}

function kvFromEnv(): KvsClient | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return {
    async zrange(key, start, stop) {
      const res = await kvFetch(url, token, ["zrange", key, start, stop]);
      const members = Array.isArray(res) ? res : [];
      return members.filter((m): m is string => typeof m === "string");
    },
    async zadd(key, score, member) {
      await kvFetch(url, token, ["zadd", key, score, member]);
    },
    async expire(key, seconds) {
      await kvFetch(url, token, ["expire", key, seconds]).catch(() => {});
    },
    async ttl(key) {
      const res = await kvFetch(url, token, ["ttl", key]);
      const n = typeof res === "number" ? res : Number(String(res));
      return Number.isFinite(n) ? n : -2;
    },
  };
}

async function kvFetch(baseUrl: string, token: string, args: unknown[]): Promise<unknown> {
  const path = args
    .map((a) => {
      if (typeof a === "number") return String(a);
      if (typeof a === "string") return encodeURIComponent(a);
      return encodeURIComponent(JSON.stringify(a));
    })
    .join("/");
  const res = await fetch(`${baseUrl}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`KV request failed (${res.status})`);
  }
  return res.json();
}

const MAILBOX_KINDS = ["announce", "peer", "go", "ready", "offer", "answer", "ice"] as const;
const MAX_PAYLOAD_CHARS = 100_000;
const SESSION_ID_RE = /^[0-9a-f]{16}$/;

interface MailboxRequest {
  route: string[];
  method: string;
  since: number | null;
  payload: string | null;
}

interface MailboxResponse {
  status: number;
  json: unknown;
}

function keyOf(sessionId: string, kind: string): string {
  return `mailbox:${sessionId}:${kind}`;
}

async function resolveMailbox(store: MailboxStore, req: MailboxRequest, ttlSeconds = 600): Promise<MailboxResponse> {
  const { route, method } = req;
  if (method === "OPTIONS") {
    return { status: 204, json: null };
  }
  if (route.length === 1 && route[0] === "ping") {
    if (method === "GET" || method === "POST") return { status: 200, json: { ok: true } };
    return { status: 405, json: { error: "method not allowed" } };
  }
  if (route.length !== 2) {
    return { status: 404, json: { error: "not found" } };
  }
  const [sessionId, kind] = route;
  if (!SESSION_ID_RE.test(sessionId)) {
    return { status: 400, json: { error: "invalid session id" } };
  }
  if (!(MAILBOX_KINDS as readonly string[]).includes(kind)) {
    return { status: 400, json: { error: "unknown mailbox" } };
  }
  if (method === "GET") {
    let since = 0;
    if (req.since !== null) {
      if (!Number.isInteger(req.since) || req.since < 0 || req.since > Number.MAX_SAFE_INTEGER) {
        return { status: 400, json: { error: "invalid since" } };
      }
      since = req.since;
    }
    const entries = await store.list(keyOf(sessionId, kind));
    const fresh = entries.filter((e) => e.i > since);
    const now = entries.length > 0 ? entries[entries.length - 1].i : 0;
    const ttlSeconds = await store.ttlOf(keyOf(sessionId, kind));
    return { status: 200, json: { entries: fresh, now, ttlSeconds } };
  }
  if (method === "POST") {
    if (typeof req.payload !== "string" || req.payload.length === 0) {
      return { status: 400, json: { error: "missing payload" } };
    }
    if (req.payload.length > MAX_PAYLOAD_CHARS) {
      return { status: 413, json: { error: "payload too large" } };
    }
    const i = await store.append(keyOf(sessionId, kind), req.payload, ttlSeconds);
    return { status: 200, json: { i } };
  }
  return { status: 405, json: { error: "method not allowed" } };
}

function createStore(): MailboxStore {
  const kv = kvFromEnv();
  if (!kv) return new MemoryMailboxStore();
  const kvStore = new KvMailboxStore(kv);
  const memory = new MemoryMailboxStore();
  let warned = false;
  const via = async <R>(use: () => Promise<R>, alt: () => Promise<R>): Promise<R> => {
    try {
      return await use();
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(`[mailbox] KV store failed (${err instanceof Error ? err.message : String(err)}); falling back to per-instance memory`);
      }
      return alt();
    }
  };
  return {
    list: (key) => via(() => kvStore.list(key), () => memory.list(key)),
    append: (key, payload, ttlSeconds) =>
      via(() => kvStore.append(key, payload, ttlSeconds), () => memory.append(key, payload, ttlSeconds)),
    ttlOf: (key) => via(() => kvStore.ttlOf(key), () => memory.ttlOf(key)),
  };
}

let store: MailboxStore | null = null;

function getStore(): MailboxStore {
  if (!store) store = createStore();
  return store;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Route segments from the rewrite (?path=a/b) or the client (?route=a&route=b). */
function routeFromQuery(query: VercelRequest["query"]): string[] {
  const pathRaw = typeof query.path === "string" ? query.path : null;
  if (pathRaw !== null) {
    return pathRaw.split("/").filter(Boolean).map(decodeSeg);
  }
  const routeRaw = query.route;
  return (Array.isArray(routeRaw) ? routeRaw : routeRaw ? [routeRaw] : []).map(decodeSeg);
}

function corsHeaders(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  corsHeaders(res);
  const route = routeFromQuery(req.query);
  const sinceRaw = typeof req.query.since === "string" ? Number(req.query.since) : null;
  const since = sinceRaw !== null && Number.isFinite(sinceRaw) ? sinceRaw : null;

  let payload: string | null = null;
  if (req.method === "POST") {
    let body: unknown = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    if (body && typeof body === "object") {
      const p = (body as { p?: unknown }).p;
      if (typeof p === "string") payload = p;
    }
  }

  const resp = await resolveMailbox(getStore(), {
    route,
    method: req.method ?? "GET",
    since,
    payload,
  });

  res.status(resp.status);
  if (resp.status === 204) {
    res.end();
    return;
  }
  res.json(resp.json);
}