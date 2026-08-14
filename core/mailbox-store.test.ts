import { describe, expect, it } from "vitest";
import { MemoryMailboxStore, resolveMailbox, type MailboxRequest, type MailboxStore } from "./mailbox-store.ts";

const SID = "0123456789abcdef";

function req(partial: Partial<MailboxRequest> = {}): MailboxRequest {
  return { route: [SID, "ice"], method: "GET", since: null, payload: null, ...partial };
}

async function get(store: MailboxStore, route: string[], since: number | null = null) {
  return resolveMailbox(store, req({ route, since }));
}

async function post(store: MailboxStore, route: string[], payload: string) {
  return resolveMailbox(store, req({ route, method: "POST", payload }));
}

describe("resolveMailbox", () => {
  it("append and read round trip with cursor semantics", async () => {
    const store = new MemoryMailboxStore();
    const a = await post(store, [SID, "ice"], "one");
    await post(store, [SID, "ice"], "two");
    expect(a.json).toEqual({ i: 1 });

    const page = await get(store, [SID, "ice"]);
    expect(page.status).toBe(200);
    const { entries, now } = page.json as { entries: { i: number; p: string }[]; now: number };
    expect(entries.map((e) => e.p)).toEqual(["one", "two"]);
    expect(now).toBe(2);

    const page2 = await get(store, [SID, "ice"], 1);
    const entries2 = (page2.json as { entries: { i: number; p: string }[] }).entries;
    expect(entries2.map((e) => e.p)).toEqual(["two"]);
  });

  it("isolates mailboxes by session id and kind", async () => {
    const store = new MemoryMailboxStore();
    await post(store, [SID, "go"], "x");
    const other = await get(store, ["ffffffffffffffff", "go"]);
    expect((other.json as { entries: unknown[] }).entries).toEqual([]);
    const announce = await get(store, [SID, "announce"]);
    expect((announce.json as { entries: unknown[] }).entries).toEqual([]);
  });

  it("expires after TTL", async () => {
    const store = new MemoryMailboxStore();
    await resolveMailbox(store, req({ route: [SID, "go"], method: "POST", payload: "x" }), 1);
    await new Promise((r) => setTimeout(r, 1100));
    const page = await get(store, [SID, "go"]);
    expect((page.json as { entries: unknown[] }).entries).toEqual([]);
    expect((page.json as { now: number }).now).toBe(0);
  });

  it("rejects invalid session ids and unknown kinds", async () => {
    const store = new MemoryMailboxStore();
    const badId = await get(store, ["nope", "go"]);
    expect(badId.status).toBe(400);
    const badKind = await get(store, [SID, "carrier_pigeon"]);
    expect(badKind.status).toBe(400);
  });

  it("rejects malformed requests", async () => {
    const store = new MemoryMailboxStore();
    expect((await get(store, [SID])).status).toBe(404);
    expect((await get(store, [SID, "go", "extra"])).status).toBe(404);
    const noPayload = await post(store, [SID, "go"], "");
    expect(noPayload.status).toBe(400);
    const big = await post(store, [SID, "go"], "x".repeat(100_001));
    expect(big.status).toBe(413);
    const badSince = await get(store, [SID, "go"], -5);
    expect(badSince.status).toBe(400);
    const badSince2 = await get(store, [SID, "go"], 1.5);
    expect(badSince2.status).toBe(400);
    const put = await resolveMailbox(store, req({ method: "PUT", payload: "x" }));
    expect(put.status).toBe(405);
  });

  it("serves the ping probe", async () => {
    const store = new MemoryMailboxStore();
    const ping = await get(store, ["ping"]);
    expect(ping.status).toBe(200);
    expect(ping.json).toEqual({ ok: true });
    expect((await resolveMailbox(store, req({ route: ["ping"], method: "DELETE" }))).status).toBe(405);
  });

  it("keep-alive writes refresh the TTL", async () => {
    const store = new MemoryMailboxStore();
    await resolveMailbox(store, req({ route: [SID, "ice"], method: "POST", payload: "a" }), 1);
    const ttl1 = (await get(store, [SID, "ice"])).json as { ttlSeconds: number | null };
    await new Promise((r) => setTimeout(r, 600));
    await resolveMailbox(store, req({ route: [SID, "ice"], method: "POST", payload: "b" }), 1);
    const after = await get(store, [SID, "ice"]);
    expect((after.json as { entries: unknown[] }).entries).toHaveLength(2);
    expect((after.json as { ttlSeconds: number | null }).ttlSeconds).toBeTruthy();
    expect(ttl1.ttlSeconds).toBeTruthy();
  });
});