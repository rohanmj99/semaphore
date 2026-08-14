import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryMailboxStore, resolveMailbox } from "../core/mailbox-store.ts";

export function devMailbox() {
  const store = new MemoryMailboxStore();
  const middleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    if (!req.url || !req.url.startsWith("/api/mailbox")) {
      next();
      return;
    }
    const [pathname, query] = req.url.split("?");
    const route = pathname.replace(/^\/api\/mailbox/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const qs = new URLSearchParams(query ?? "");
    const sinceRaw = qs.get("since");
    const since = sinceRaw !== null && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : null;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", async () => {
      let payload: string | null = null;
      if (req.method === "POST") {
        try {
          const parsed = JSON.parse(body) as { p?: unknown };
          if (typeof parsed.p === "string") payload = parsed.p;
        } catch {
          payload = null;
        }
      }
      const resp = await resolveMailbox(store, {
        route,
        method: req.method ?? "GET",
        since,
        payload,
      });
      res.statusCode = resp.status;
      if (resp.status === 204) {
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(resp.json));
    });
  };
  return {
    name: "dev-mailbox",
    configureServer(server: { middlewares: { use: (m: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: { middlewares: { use: (m: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
  };
}