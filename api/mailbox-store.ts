import type { MailboxEntry } from "../core/mailbox.js";

export interface MailboxStore {
  list(key: string): Promise<MailboxEntry[]>;
  append(key: string, payload: string, ttlSeconds: number): Promise<number>;
  ttlOf(key: string): Promise<number | null>;
}

export class MemoryMailboxStore implements MailboxStore {
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

export interface KvsClient {
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
}

export class KvMailboxStore implements MailboxStore {
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

export function kvFromEnv(): KvsClient | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return {
    async zrange(_key, start, stop) {
      const res = await kvFetch(url, token, ["zrange", start, stop]);
      const members = Array.isArray(res) ? res : [];
      return members.filter((m): m is string => typeof m === "string");
    },
    async zadd(_key, score, member) {
      await kvFetch(url, token, ["zadd", score, member]);
    },
    async expire(_key, seconds) {
      await kvFetch(url, token, ["expire", seconds]).catch(() => {});
    },
    async ttl(_key) {
      const res = await kvFetch(url, token, ["ttl"]);
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
  const res = await fetch(`${baseUrl}/${path}?API_KEY=${encodeURIComponent(token)}`);
  if (!res.ok) {
    throw new Error(`KV request failed (${res.status})`);
  }
  return res.json();
}

export const MAILBOX_KINDS = ["announce", "peer", "go", "ready", "offer", "answer", "ice"] as const;
export const MAX_PAYLOAD_CHARS = 100_000;
export const SESSION_ID_RE = /^[0-9a-f]{16}$/;

export interface MailboxRequest {
  route: string[];
  method: string;
  since: number | null;
  payload: string | null;
}

export interface MailboxResponse {
  status: number;
  json: unknown;
}

function keyOf(sessionId: string, kind: string): string {
  return `mailbox:${sessionId}:${kind}`;
}

export async function resolveMailbox(store: MailboxStore, req: MailboxRequest, ttlSeconds = 600): Promise<MailboxResponse> {
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

export function createStore(): MailboxStore {
  const kv = kvFromEnv();
  return kv ? new KvMailboxStore(kv) : new MemoryMailboxStore();
}