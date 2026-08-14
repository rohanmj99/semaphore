import { describe, expect, it } from "vitest";
import handler from "./mailbox.ts";

// Vercel ignores *.test.* files when building api functions, so this file
// never deploys — it locks in the query-based routing contract instead.

interface MockRes {
  statusCode: number;
  body: unknown;
  ended: boolean;
  headers: Record<string, string>;
}

function call(
  query: Record<string, string | string[] | undefined>,
  opts: { method?: string; body?: unknown } = {},
): Promise<MockRes> {
  const res: MockRes = {
    statusCode: 0,
    body: null,
    ended: false,
    headers: {},
  };
  const mockRes = {
    setHeader: (k: string, v: string) => {
      res.headers[k] = v;
    },
    status: (c: number) => {
      res.statusCode = c;
      return mockRes;
    },
    json: (o: unknown) => {
      res.body = o;
      return mockRes;
    },
    end: () => {
      res.ended = true;
      return mockRes;
    },
  };
  const req = { method: opts.method ?? "GET", query, body: opts.body };
  return handler(req as never, mockRes as never).then(() => res);
}

const SID = "0123456789abcdef";

describe("mailbox function routing", () => {
  it("answers ping via the rewrite path query", async () => {
    const res = await call({ path: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("answers ping via the client's route query", async () => {
    const res = await call({ route: "ping" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("reads and writes a session mailbox through the rewrite path", async () => {
    const write = await call({ path: `/${SID}/go` }, { method: "POST", body: { p: "hello" } });
    expect(write.statusCode).toBe(200);
    expect(write.body).toEqual({ i: 1 });
    const read = await call({ path: `/${SID}/go` });
    expect(read.statusCode).toBe(200);
    expect(read.body).toEqual({ entries: [{ i: 1, p: "hello", ts: expect.any(Number) }], now: 1, ttlSeconds: expect.any(Number) });
  });

  it("reads with a since cursor through the route query", async () => {
    const write = await call({ route: [SID, "ice"] }, { method: "POST", body: { p: "a" } });
    expect(write.statusCode).toBe(200);
    const page = await call({ route: [SID, "ice"], since: "1" });
    expect(page.statusCode).toBe(200);
    const body = page.body as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
  });

  it("rejects a bad session id and unknown kinds", async () => {
    const bad = await call({ path: "/nope/announce" });
    expect(bad.statusCode).toBe(400);
    const unknown = await call({ path: `/${SID}/carrier` });
    expect(unknown.statusCode).toBe(400);
  });

  it("404s when no route segments arrive", async () => {
    const empty = await call({});
    expect(empty.statusCode).toBe(404);
    const bare = await call({ path: "" });
    expect(bare.statusCode).toBe(404);
  });

  it("answers OPTIONS preflight with CORS headers", async () => {
    const res = await call({ path: "/ping" }, { method: "OPTIONS" });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("rejects unsupported methods on ping", async () => {
    const res = await call({ path: "/ping" }, { method: "DELETE" });
    expect(res.statusCode).toBe(405);
  });
});