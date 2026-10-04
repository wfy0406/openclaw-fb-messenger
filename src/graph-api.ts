import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_GRAPH_API_VERSION, MESSENGER_TEXT_LIMIT } from "./config.js";

const GRAPH_HOST = "https://graph.facebook.com";

export interface GraphSendResult {
  ok: boolean;
  messageId?: string;
  recipientId?: string;
  error?: string;
}

interface GraphCallOptions {
  pageAccessToken: string;
  graphApiVersion?: string;
}

function graphUrl(path: string, version: string, token: string): string {
  const v = version || DEFAULT_GRAPH_API_VERSION;
  const sep = path.includes("?") ? "&" : "?";
  return `${GRAPH_HOST}/${v}${path}${sep}access_token=${encodeURIComponent(token)}`;
}

/** Split a long message into Messenger-sized chunks (2000 chars), on word boundaries when possible. */
export function chunkMessengerText(text: string, limit = MESSENGER_TEXT_LIMIT): string[] {
  const trimmed = text ?? "";
  if (trimmed.length <= limit) return trimmed.length ? [trimmed] : [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

async function postSendApi(
  body: Record<string, unknown>,
  opts: GraphCallOptions,
): Promise<GraphSendResult> {
  const url = graphUrl("/me/messages", opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, opts.pageAccessToken);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    message_id?: string;
    recipient_id?: string;
    error?: { message?: string };
  };
  if (!res.ok || json.error) {
    return { ok: false, error: json.error?.message || `Graph API HTTP ${res.status}` };
  }
  return { ok: true, messageId: json.message_id, recipientId: json.recipient_id };
}

/** Send a text message, chunking automatically. Returns the last chunk's result. */
export async function sendMessengerText(
  to: string,
  text: string,
  opts: GraphCallOptions,
): Promise<GraphSendResult> {
  const chunks = chunkMessengerText(text);
  if (chunks.length === 0) return { ok: true };
  let last: GraphSendResult = { ok: true };
  for (const chunk of chunks) {
    last = await postSendApi(
      {
        messaging_type: "RESPONSE",
        recipient: { id: to },
        message: { text: chunk },
      },
      opts,
    );
    if (!last.ok) return last;
  }
  return last;
}

export type MessengerMediaType = "image" | "video" | "audio" | "file";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** Lower-cased file extension of a URL or local path ("" when none). */
function extOf(urlOrPath: string): string {
  const clean = urlOrPath.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

/** Infer the Messenger attachment type from a URL/path extension. */
export function inferMessengerMediaType(urlOrPath: string): MessengerMediaType {
  const ext = extOf(urlOrPath);
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "mov"].includes(ext)) return "video";
  if (["m4a", "mp3", "ogg", "wav"].includes(ext)) return "audio";
  return "file";
}

/** MIME type for a local file upload, by extension (octet-stream fallback). */
export function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXT[extOf(filePath)] ?? "application/octet-stream";
}

/** Send a media attachment by URL (image/file/video/audio). */
export async function sendMessengerMedia(
  to: string,
  mediaUrl: string,
  opts: GraphCallOptions & { mediaType?: "image" | "video" | "audio" | "file" },
): Promise<GraphSendResult> {
  return postSendApi(
    {
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message: {
        attachment: {
          type: opts.mediaType ?? "image",
          payload: { url: mediaUrl, is_reusable: true },
        },
      },
    },
    opts,
  );
}

/**
 * Send a local media file via multipart upload (Node 20+ native FormData/Blob):
 *   recipient={"id":...}, message={"attachment":{"type":...,"payload":{}}}, filedata=<Blob>
 */
export async function sendMessengerMediaLocal(
  to: string,
  filePath: string,
  opts: GraphCallOptions & { mediaType?: "image" | "video" | "audio" | "file" },
): Promise<GraphSendResult> {
  try {
    const buf = await fs.readFile(filePath);
    const form = new FormData();
    form.append("recipient", JSON.stringify({ id: to }));
    form.append(
      "message",
      JSON.stringify({
        attachment: { type: opts.mediaType ?? "image", payload: {} },
      }),
    );
    form.append("filedata", new Blob([buf], { type: mimeTypeForPath(filePath) }), basename(filePath));
    const url = graphUrl(
      "/me/messages",
      opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION,
      opts.pageAccessToken,
    );
    const res = await fetch(url, { method: "POST", body: form });
    const json = (await res.json().catch(() => ({}))) as {
      message_id?: string;
      recipient_id?: string;
      error?: { message?: string };
    };
    if (!res.ok || json.error) {
      return { ok: false, error: json.error?.message || `Graph API HTTP ${res.status}` };
    }
    return { ok: true, messageId: json.message_id, recipientId: json.recipient_id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Sender action: typing_on | typing_off | mark_seen. Best-effort. */
export async function sendSenderAction(
  to: string,
  action: "typing_on" | "typing_off" | "mark_seen",
  opts: GraphCallOptions,
): Promise<GraphSendResult> {
  return postSendApi({ recipient: { id: to }, sender_action: action }, opts);
}

/**
 * Resolve the effective Page context from whatever token the user supplied.
 *
 * Users frequently paste a *User* access token instead of a *Page* token, or
 * mistype the Page ID. This normalizes both: if the token can list pages
 * (`/me/accounts`), we pick the configured page (or the first) and use ITS
 * page-scoped token + id. Otherwise we assume it is already a page token and
 * read the page id from `/me`.
 */
export async function resolvePageContext(
  token: string,
  opts: { configuredPageId?: string; graphApiVersion?: string },
): Promise<{ pageId: string; pageAccessToken: string } | null> {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  try {
    const acctRes = await fetch(graphUrl("/me/accounts?fields=id,access_token,name", version, token));
    const acctJson = (await acctRes.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; access_token?: string }>;
    };
    const pages = acctJson.data ?? [];
    if (pages.length > 0) {
      const match =
        (opts.configuredPageId && pages.find((p) => p.id === opts.configuredPageId)) || pages[0];
      if (match?.id && match.access_token) {
        return { pageId: match.id, pageAccessToken: match.access_token };
      }
    }
  } catch {
    /* fall through */
  }
  // Assume the supplied token is already a page token.
  try {
    const meRes = await fetch(graphUrl("/me?fields=id", version, token));
    const me = (await meRes.json().catch(() => ({}))) as { id?: string };
    if (me.id) return { pageId: me.id, pageAccessToken: token };
  } catch {
    /* ignore */
  }
  return null;
}

/** Cheap liveness check: a token is valid if `/me` returns an id. */
export async function validateToken(token: string, graphApiVersion?: string): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(graphUrl("/me?fields=id", graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, token));
    if (!res.ok) return false;
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: unknown };
    return Boolean(json.id) && !json.error;
  } catch {
    return false;
  }
}

/**
 * Exchange a (short-lived) User token for a long-lived one. Needs the Meta App
 * credentials. Returns the long-lived user token, or null if it isn't a user
 * token / credentials are missing. A Page token derived from a long-lived user
 * token never expires — this is the key step to a permanent setup.
 */
export async function exchangeLongLivedUserToken(
  token: string,
  opts: { appId?: string; appSecret?: string; graphApiVersion?: string },
): Promise<string | null> {
  if (!token || !opts.appId || !opts.appSecret) return null;
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  try {
    const url =
      `${GRAPH_HOST}/${version}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(opts.appId)}` +
      `&client_secret=${encodeURIComponent(opts.appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (res.ok && json.access_token) return json.access_token;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve a **permanent** Page context from whatever token the user pasted
 * (typically a short-lived User token from the Graph API Explorer):
 *   short-lived user token --(App ID + Secret)--> long-lived user token
 *   long-lived user token   --/me/accounts------> never-expiring Page token
 * `permanent` is true when the Page token came from a long-lived user token (or
 * the supplied token is already a Page token); false when it was only derivable
 * from a short-lived user token (will expire — caller should not persist it).
 */
export async function resolvePermanentPageContext(
  token: string,
  opts: { appId?: string; appSecret?: string; configuredPageId?: string; graphApiVersion?: string },
): Promise<{ pageId: string; pageAccessToken: string; permanent: boolean } | null> {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  // 1) Upgrade to a long-lived user token when possible.
  const longLived = await exchangeLongLivedUserToken(token, {
    appId: opts.appId,
    appSecret: opts.appSecret,
    graphApiVersion: version,
  });
  const userToken = longLived ?? token;
  const permanentSource = Boolean(longLived);
  // 2) Trade the user token for the Page's access token.
  try {
    const res = await fetch(graphUrl("/me/accounts?fields=id,access_token,name", version, userToken));
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; access_token?: string }>;
    };
    const pages = json.data ?? [];
    if (pages.length > 0) {
      const match =
        (opts.configuredPageId && pages.find((p) => p.id === opts.configuredPageId)) || pages[0];
      if (match?.id && match.access_token) {
        return { pageId: match.id, pageAccessToken: match.access_token, permanent: permanentSource };
      }
    }
  } catch {
    /* fall through */
  }
  // 3) The supplied token is likely already a Page token — Page tokens don't expire.
  try {
    const meRes = await fetch(graphUrl("/me?fields=id", version, token));
    const me = (await meRes.json().catch(() => ({}))) as { id?: string };
    if (me.id) return { pageId: me.id, pageAccessToken: token, permanent: true };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Subscribe the Page to this app's webhook fields (idempotent). Removes the
 * manual "Edit Page Subscriptions" step — the gateway does it on startup.
 */
export async function subscribePageToApp(
  pageId: string,
  opts: GraphCallOptions & { fields?: string },
): Promise<{ ok: boolean; error?: string }> {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const fields = opts.fields ?? "messages,messaging_postbacks";
  try {
    const url = graphUrl(`/${encodeURIComponent(pageId)}/subscribed_apps`, version, opts.pageAccessToken);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: fields }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
    if (!res.ok || json.error) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: json.success !== false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Fetch a user's public profile (name) by PSID. Returns null on failure. */
export async function getUserProfile(
  psid: string,
  opts: GraphCallOptions,
): Promise<{ id: string; name?: string } | null> {
  const url = graphUrl(
    `/${encodeURIComponent(psid)}?fields=first_name,last_name`,
    opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION,
    opts.pageAccessToken,
  );
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string; first_name?: string; last_name?: string };
    const name = [json.first_name, json.last_name].filter(Boolean).join(" ").trim();
    return { id: json.id ?? psid, name: name || undefined };
  } catch {
    return null;
  }
}
