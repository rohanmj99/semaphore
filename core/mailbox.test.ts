import { describe, expect, it, vi } from "vitest";
import {
  createHttpMailbox,
  MailboxPoller,
  probeMailbox,
  putWithRetry,
  type FetchLike,
  type Mailbox,
} from "./mailbox.ts";

function fakeFetch(routes: Map<string, unknown>, behavior?: { failNext?: number }): FetchLike {
  return (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (behavior?.failNext && behavior.failNext > 0) {
      behavior.failNext--;
      return Promise.reject(new Error("network down"));
    }
    const hit = routes.get(key);
    if (hit === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(hit),
    });
  };
}

describe("createHttpMailbox", () => {
  it("POSTs payloads and returns the index", async () => {
    const routes = new Map<string, unknown>([["POST /api/mailbox/go", { i: 7 }]]);
    const mailbox = createHttpMailbox("/api/mailbox", fakeFetch(routes));
    await expect(mailbox.put("go", "hello")).resolves.toBe(7);
  });

  it("GETs pages with the since cursor", async () => {
    const routes = new Map<string, unknown>([["GET /api/mailbox/ice?since=3", { entries: [{ i: 4, p: "x", ts: 1 }], now: 4, ttlSeconds: 599 }]]);
    const mailbox = createHttpMailbox("/api/mailbox", fakeFetch(routes));
    const page = await mailbox.get("ice", 3);
    expect(page.entries).toHaveLength(1);
    expect(page.now).toBe(4);
  });

  it("treats 404 as an empty page", async () => {
    const mailbox = createHttpMailbox("/api/mailbox", fakeFetch(new Map()));
    const page = await mailbox.get("announce");
    expect(page.entries).toEqual([]);
  });

  it("surfaces write errors", async () => {
    const mailbox = createHttpMailbox("/api/mailbox", fakeFetch(new Map()));
    await expect(mailbox.put("go", "x")).rejects.toThrow("mailbox write failed");
  });

  it("probe returns false on failure and true on ok", async () => {
    const routes = new Map<string, unknown>([["GET /api/mailbox/ping", { ok: true }]]);
    await expect(probeMailbox("/api/mailbox", fakeFetch(routes))).resolves.toBe(true);
    await expect(probeMailbox("/api/mailbox", fakeFetch(new Map()))).resolves.toBe(false);
  });
});

function delayedMailbox(initial: Record<string, { i: number; p: string }[]>): Mailbox {
  const buckets = new Map<string, { i: number; p: string; ts: number }[]>(Object.entries(initial).map(([k, v]) => [k, v.map((e) => ({ ...e, ts: 1 }))]));
  const cursors = new Map<string, number>();
  let next = 100;
  return {
    async put(kind, payload) {
      const i = ++next;
      const list = buckets.get(kind) ?? [];
      list.push({ i, p: payload, ts: Date.now() });
      buckets.set(kind, list);
      return i;
    },
    async get(kind, since = 0) {
      const list = (buckets.get(kind) ?? []).filter((e) => e.i > since);
      const now = list.length > 0 ? list[list.length - 1].i : cursors.get(kind) ?? 0;
      cursors.set(kind, now);
      return { entries: list, now, ttlSeconds: null };
    },
  };
}

describe("MailboxPoller", () => {
  it("delivers new entries per kind and advances cursors", async () => {
    const mailbox = delayedMailbox({ go: [{ i: 1, p: "first" }] });
    const poller = new MailboxPoller(mailbox, 25);
    const seen: string[] = [];
    const unsub = poller.subscribe("go", (entries) => {
      for (const e of entries) seen.push(e.p);
    });
    poller.start();
    await poller.flushFor("go");
    await mailbox.put("go", "second");
    await poller.flushFor("go");
    expect(seen).toEqual(["first", "second"]);
    unsub();
    await mailbox.put("go", "third");
    await poller.flushFor("go");
    expect(seen).toEqual(["first", "second"]);
    poller.stop();
  });

  it("keeps polling after temporary failures", async () => {
    const mailbox = delayedMailbox({});
    let calls = 0;
    const failing = {
      get: () => Promise.reject(new Error("503")),
    } as unknown as Mailbox;
    const hardPoller = new MailboxPoller(failing, 25);
    const seen: string[] = [];
    hardPoller.subscribe("go", (entries) => {
      calls++;
      for (const e of entries) seen.push(e.p);
    });
    hardPoller.start();
    await hardPoller.flushFor("go").catch(() => {});
    expect(seen).toEqual([]);
    hardPoller.stop();
    expect(calls).toBe(0);
    const soft = new MailboxPoller(mailbox, 25);
    const seen2: string[] = [];
    soft.subscribe("go", (entries) => {
      for (const e of entries) seen2.push(e.p);
    });
    soft.start();
    await soft.flushFor("go");
    expect(seen2).toEqual([]);
    soft.stop();
  });

  it("retries failed puts", async () => {
    const routes = new Map<string, unknown>();
    const behavior = { failNext: 2 };
    const fetchImpl = fakeFetch(routes, behavior);
    const mailbox = createHttpMailbox("/api/mailbox", fetchImpl);
    const p = putWithRetry(mailbox, "go", "x");
    routes.set("POST /api/mailbox/go", { i: 1 });
    await expect(p).resolves.toBe(true);
  });

  it("gives up after retries when the relay stays down", async () => {
    const mailbox = createHttpMailbox("/api/mailbox", fakeFetch(new Map()));
    await expect(putWithRetry(mailbox, "go", "x", 2)).resolves.toBe(false);
  });

  it("aborts an inflight request on timeout", async () => {
    const t = vi.fn();
    let called = false;
    const mailbox = createHttpMailbox("/api/mailbox", (_url, init) => {
      called = true;
      return new Promise((_r, rej) => {
        init?.signal?.addEventListener("abort", () => {
          t();
          rej(new Error("aborted"));
        });
      });
    }, 20);
    await expect(mailbox.get("go")).rejects.toThrow("aborted");
    expect(called).toBe(true);
    expect(t).toHaveBeenCalled();
  });
});