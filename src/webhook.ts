import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchMessengerEvent } from "./inbound.js";
import {
  findContextByVerifyToken,
  getDispatchContextForPage,
  getSoleContext,
  hasRegisteredAccounts,
} from "./registry.js";
import type { MessengerWebhookBody } from "./types.js";

export const WEBHOOK_PATH = "/webhooks/messenger";

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Constant-time check of Meta's `X-Hub-Signature-256: sha256=<hex>` header. */
function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) return true; // no secret configured → skip (dev only)
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body = ""): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/**
 * Single HTTP handler for the Messenger webhook. Returns `true` when it owns the
 * request (so the host stops further routing).
 */
export async function handleMessengerWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://localhost");

  // --- GET: subscription verification handshake ---
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && findContextByVerifyToken(token)) {
      send(res, 200, challenge);
    } else {
      send(res, 403, "Forbidden");
    }
    return true;
  }

  // --- POST: inbound events ---
  if (req.method === "POST") {
    const rawBody = await readRawBody(req).catch(() => Buffer.alloc(0));

    let body: MessengerWebhookBody;
    try {
      body = JSON.parse(rawBody.toString("utf8") || "{}") as MessengerWebhookBody;
    } catch {
      send(res, 400, "Bad Request");
      return true;
    }

    if (body.object !== "page" || !Array.isArray(body.entry)) {
      // Acknowledge non-page payloads so Meta doesn't retry forever.
      send(res, 200, "EVENT_RECEIVED");
      return true;
    }

    // Always 200 quickly; process events after acking (Meta retries on non-200).
    send(res, 200, "EVENT_RECEIVED");

    if (!hasRegisteredAccounts()) return true;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    for (const entry of body.entry) {
      const ctx = getDispatchContextForPage(entry.id ?? "") ?? getSoleContext();
      if (!ctx) continue;
      if (!verifySignature(rawBody, signature, ctx.account.appSecret)) {
        ctx.log?.warn?.(`[fb-messenger] signature mismatch for page ${entry.id} — dropping`);
        continue;
      }
      for (const event of entry.messaging ?? []) {
        void dispatchMessengerEvent(ctx, event).catch((err) => {
          ctx.log?.error?.(`[fb-messenger] event handling error: ${String(err)}`);
        });
      }
    }
    return true;
  }

  send(res, 405, "Method Not Allowed");
  return true;
}
