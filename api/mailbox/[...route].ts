import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createStore, resolveMailbox, type MailboxStore } from "../mailbox-store.js";

let store: MailboxStore | null = null;

function getStore(): MailboxStore {
  if (!store) store = createStore();
  return store;
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
  const routeRaw = req.query.route;
  const route = (Array.isArray(routeRaw) ? routeRaw : routeRaw ? [routeRaw] : []).map((r) => decodeURIComponent(r));
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