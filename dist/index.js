// index.ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

// src/channel.ts
import {
  createChatChannelPlugin
} from "openclaw/plugin-sdk/channel-core";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
  formatTrimmedAllowFromEntries
} from "openclaw/plugin-sdk/channel-config-helpers";

// src/config.ts
var CHANNEL_ID = "fb-messenger";
var DEFAULT_ACCOUNT_ID = "default";
var DEFAULT_GRAPH_API_VERSION = "v21.0";
var MESSENGER_TEXT_LIMIT = 2e3;
function readChannelConfig(cfg) {
  const channels = cfg.channels ?? {};
  return channels[CHANNEL_ID] ?? {};
}
function normalizeAccountId(accountId) {
  const trimmed = (accountId ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}
function listMessengerAccountIds(cfg) {
  const channel = readChannelConfig(cfg);
  const ids = Object.keys(channel.accounts ?? {});
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}
function pick(...values) {
  for (const v of values) if (v !== void 0 && v !== "") return v;
  return void 0;
}
function resolveMessengerAccount(params) {
  const env = params.env ?? process.env;
  const channel = readChannelConfig(params.cfg);
  const accountId = normalizeAccountId(
    params.accountId ?? channel.defaultAccount ?? DEFAULT_ACCOUNT_ID
  );
  const account = channel.accounts?.[accountId] ?? {};
  const pageAccessToken = pick(env.FB_MESSENGER_PAGE_ACCESS_TOKEN, account.pageAccessToken, channel.pageAccessToken) ?? "";
  const appId = pick(env.FB_MESSENGER_APP_ID, account.appId, channel.appId) ?? "";
  const appSecret = pick(env.FB_MESSENGER_APP_SECRET, account.appSecret, channel.appSecret) ?? "";
  const verifyToken = pick(env.FB_MESSENGER_VERIFY_TOKEN, account.verifyToken, channel.verifyToken) ?? "";
  const escalateTo = pick(env.FB_MESSENGER_ESCALATE_TO, account.escalateTo, channel.escalateTo);
  const escalateAccountId = pick(
    env.FB_MESSENGER_ESCALATE_ACCOUNT_ID,
    account.escalateAccountId,
    channel.escalateAccountId
  );
  const escalateModeRaw = pick(
    env.FB_MESSENGER_ESCALATE_MODE,
    account.escalateMode,
    channel.escalateMode
  );
  const VALID_ESCALATE_MODES = ["off", "agent", "media", "all"];
  const escalateModeInvalid = escalateModeRaw !== void 0 && !VALID_ESCALATE_MODES.includes(escalateModeRaw);
  const escalateMode = escalateTo && (escalateModeRaw === "agent" || escalateModeRaw === "media" || escalateModeRaw === "all") ? escalateModeRaw : "off";
  return {
    accountId,
    name: pick(account.name, channel.name),
    enabled: account.enabled ?? channel.enabled ?? true,
    pageId: pick(account.pageId, channel.pageId) ?? "",
    pageAccessToken,
    appId,
    appSecret,
    verifyToken,
    graphApiVersion: pick(account.graphApiVersion, channel.graphApiVersion) ?? DEFAULT_GRAPH_API_VERSION,
    dmPolicy: pick(account.dmPolicy, channel.dmPolicy) ?? "open",
    allowFrom: account.allowFrom ?? channel.allowFrom ?? ["*"],
    historyLimit: account.historyLimit ?? channel.historyLimit ?? 50,
    mediaEnabled: account.mediaEnabled ?? channel.mediaEnabled ?? true,
    audioTranscriptionEnabled: account.audioTranscriptionEnabled ?? channel.audioTranscriptionEnabled ?? true,
    audioLanguage: pick(env.FB_MESSENGER_AUDIO_LANGUAGE, account.audioLanguage, channel.audioLanguage) ?? "yue",
    audioTranscriptionDailyCap: account.audioTranscriptionDailyCap ?? channel.audioTranscriptionDailyCap ?? 200,
    escalateChannel: pick(env.FB_MESSENGER_ESCALATE_CHANNEL, account.escalateChannel, channel.escalateChannel) ?? "whatsapp",
    escalateTo,
    ...escalateAccountId ? { escalateAccountId } : {},
    escalateMode,
    ...escalateModeInvalid ? { escalateModeInvalid } : {},
    config: { ...channel, ...account }
  };
}
function isAccountConfigured(account) {
  return Boolean(account.pageAccessToken && account.verifyToken);
}
function isSenderAllowed(account, senderId) {
  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "open") return true;
  const allow = account.allowFrom.map((e) => e.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return allow.includes(senderId.trim());
}

// src/graph-api.ts
import { promises as fs } from "fs";
import { basename } from "path";
var GRAPH_HOST = "https://graph.facebook.com";
function graphUrl(path, version, token) {
  const v = version || DEFAULT_GRAPH_API_VERSION;
  const sep = path.includes("?") ? "&" : "?";
  return `${GRAPH_HOST}/${v}${path}${sep}access_token=${encodeURIComponent(token)}`;
}
function chunkMessengerText(text, limit = MESSENGER_TEXT_LIMIT) {
  const trimmed = text ?? "";
  if (trimmed.length <= limit) return trimmed.length ? [trimmed] : [];
  const chunks = [];
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
async function postSendApi(body, opts) {
  const url = graphUrl("/me/messages", opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, opts.pageAccessToken);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    return { ok: false, error: json.error?.message || `Graph API HTTP ${res.status}` };
  }
  return { ok: true, messageId: json.message_id, recipientId: json.recipient_id };
}
async function sendMessengerText(to, text, opts) {
  const chunks = chunkMessengerText(text);
  if (chunks.length === 0) return { ok: true };
  let last = { ok: true };
  for (const chunk of chunks) {
    last = await postSendApi(
      {
        messaging_type: "RESPONSE",
        recipient: { id: to },
        message: { text: chunk }
      },
      opts
    );
    if (!last.ok) return last;
  }
  return last;
}
var MIME_BY_EXT = {
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
  wav: "audio/wav"
};
function extOf(urlOrPath) {
  const clean = urlOrPath.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}
function inferMessengerMediaType(urlOrPath) {
  const ext = extOf(urlOrPath);
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "mov"].includes(ext)) return "video";
  if (["m4a", "mp3", "ogg", "wav"].includes(ext)) return "audio";
  return "file";
}
function mimeTypeForPath(filePath) {
  return MIME_BY_EXT[extOf(filePath)] ?? "application/octet-stream";
}
async function sendMessengerMedia(to, mediaUrl, opts) {
  return postSendApi(
    {
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message: {
        attachment: {
          type: opts.mediaType ?? "image",
          payload: { url: mediaUrl, is_reusable: true }
        }
      }
    },
    opts
  );
}
async function sendMessengerMediaLocal(to, filePath, opts) {
  try {
    const buf = await fs.readFile(filePath);
    const form = new FormData();
    form.append("recipient", JSON.stringify({ id: to }));
    form.append(
      "message",
      JSON.stringify({
        attachment: { type: opts.mediaType ?? "image", payload: {} }
      })
    );
    form.append("filedata", new Blob([buf], { type: mimeTypeForPath(filePath) }), basename(filePath));
    const url = graphUrl(
      "/me/messages",
      opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION,
      opts.pageAccessToken
    );
    const res = await fetch(url, { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      return { ok: false, error: json.error?.message || `Graph API HTTP ${res.status}` };
    }
    return { ok: true, messageId: json.message_id, recipientId: json.recipient_id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
async function sendSenderAction(to, action, opts) {
  return postSendApi({ recipient: { id: to }, sender_action: action }, opts);
}
async function validateToken(token, graphApiVersion) {
  if (!token) return false;
  try {
    const res = await fetch(graphUrl("/me?fields=id", graphApiVersion ?? DEFAULT_GRAPH_API_VERSION, token));
    if (!res.ok) return false;
    const json = await res.json().catch(() => ({}));
    return Boolean(json.id) && !json.error;
  } catch {
    return false;
  }
}
async function exchangeLongLivedUserToken(token, opts) {
  if (!token || !opts.appId || !opts.appSecret) return null;
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  try {
    const url = `${GRAPH_HOST}/${version}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(opts.appId)}&client_secret=${encodeURIComponent(opts.appSecret)}&fb_exchange_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) return json.access_token;
  } catch {
  }
  return null;
}
async function resolvePermanentPageContext(token, opts) {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const longLived = await exchangeLongLivedUserToken(token, {
    appId: opts.appId,
    appSecret: opts.appSecret,
    graphApiVersion: version
  });
  const userToken = longLived ?? token;
  const permanentSource = Boolean(longLived);
  try {
    const res = await fetch(graphUrl("/me/accounts?fields=id,access_token,name", version, userToken));
    const json = await res.json().catch(() => ({}));
    const pages = json.data ?? [];
    if (pages.length > 0) {
      const match = opts.configuredPageId && pages.find((p) => p.id === opts.configuredPageId) || pages[0];
      if (match?.id && match.access_token) {
        return { pageId: match.id, pageAccessToken: match.access_token, permanent: permanentSource };
      }
    }
  } catch {
  }
  try {
    const meRes = await fetch(graphUrl("/me?fields=id", version, token));
    const me = await meRes.json().catch(() => ({}));
    if (me.id) return { pageId: me.id, pageAccessToken: token, permanent: true };
  } catch {
  }
  return null;
}
async function subscribePageToApp(pageId, opts) {
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const fields = opts.fields ?? "messages,messaging_postbacks";
  try {
    const url = graphUrl(`/${encodeURIComponent(pageId)}/subscribed_apps`, version, opts.pageAccessToken);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscribed_fields: fields })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: json.success !== false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
async function getUserProfile(psid, opts) {
  const url = graphUrl(
    `/${encodeURIComponent(psid)}?fields=first_name,last_name`,
    opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION,
    opts.pageAccessToken
  );
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const name = [json.first_name, json.last_name].filter(Boolean).join(" ").trim();
    return { id: json.id ?? psid, name: name || void 0 };
  } catch {
    return null;
  }
}

// src/credentials.ts
import { promises as fs2 } from "fs";
import { dirname, join } from "path";
function stateDir() {
  return process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR || join(process.cwd(), ".openclaw");
}
function credentialPath(accountId) {
  const file = !accountId || accountId === "default" ? "credentials.json" : `credentials-${accountId}.json`;
  return join(stateDir(), "credentials", CHANNEL_ID, file);
}
async function loadPageCredential(accountId) {
  try {
    const raw = await fs2.readFile(credentialPath(accountId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.pageAccessToken) return parsed;
  } catch {
  }
  return null;
}
async function savePageCredential(accountId, cred) {
  const path = credentialPath(accountId);
  try {
    await fs2.mkdir(dirname(path), { recursive: true });
    await fs2.writeFile(path, JSON.stringify({ ...cred, derivedAt: cred.derivedAt }, null, 2), "utf8");
  } catch {
  }
}
async function clearPageCredential(accountId) {
  try {
    await fs2.rm(credentialPath(accountId), { force: true });
  } catch {
  }
}

// src/registry.ts
var byPageId = /* @__PURE__ */ new Map();
function registerDispatchContext(ctx) {
  const pageId = ctx.account.pageId?.trim();
  if (!pageId) {
    ctx.log?.warn?.(
      `[fb-messenger] account ${ctx.account.accountId} has no pageId \u2014 webhook routing disabled for it`
    );
    return () => {
    };
  }
  byPageId.set(pageId, ctx);
  return () => {
    if (byPageId.get(pageId) === ctx) byPageId.delete(pageId);
  };
}
function getDispatchContextForPage(pageId) {
  return byPageId.get(pageId.trim());
}
function findContextByVerifyToken(token) {
  const t = token.trim();
  if (!t) return void 0;
  for (const ctx of byPageId.values()) {
    if (ctx.account.verifyToken && ctx.account.verifyToken.trim() === t) return ctx;
  }
  return void 0;
}
function hasRegisteredAccounts() {
  return byPageId.size > 0;
}
function getSoleContext() {
  return byPageId.size === 1 ? [...byPageId.values()][0] : void 0;
}

// src/channel.ts
var messengerMeta = {
  id: CHANNEL_ID,
  label: "Facebook Messenger",
  selectionLabel: "Facebook (Messenger)",
  docsPath: "/channels/fb-messenger",
  docsLabel: "fb-messenger",
  blurb: "Facebook Page Messenger via webhook + Graph API.",
  aliases: ["fb", "messenger"],
  order: 90,
  quickstartAllowFrom: false
};
var messengerCapabilities = {
  chatTypes: ["direct"],
  media: true,
  reactions: false,
  threads: false,
  polls: false,
  nativeCommands: false,
  blockStreaming: true
};
var messengerConfigAdapter = createHybridChannelConfigAdapter({
  sectionKey: CHANNEL_ID,
  listAccountIds: (cfg) => listMessengerAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveMessengerAccount({ cfg, accountId }),
  defaultAccountId: (cfg) => {
    const channels = cfg.channels;
    return normalizeAccountId(channels?.[CHANNEL_ID]?.defaultAccount);
  },
  clearBaseFields: [
    "name",
    "pageId",
    "pageAccessToken",
    "appId",
    "appSecret",
    "verifyToken",
    "graphApiVersion",
    "dmPolicy",
    "allowFrom",
    "historyLimit",
    "messagePrefix",
    "responsePrefix"
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom)
});
var messengerDmResolver = createScopedDmSecurityResolver({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom
});
var messengerSetupAdapter = {
  applyAccountConfig: (params) => {
    const cfg = params.cfg;
    const channels = { ...cfg.channels ?? {} };
    const existing = channels[CHANNEL_ID] ?? {};
    const input = params.input;
    channels[CHANNEL_ID] = {
      ...existing,
      enabled: true,
      ...input.pageId ? { pageId: input.pageId } : {},
      ...input.pageAccessToken ? { pageAccessToken: input.pageAccessToken } : {},
      ...input.appId ? { appId: input.appId } : {},
      ...input.appSecret ? { appSecret: input.appSecret } : {},
      ...input.verifyToken ? { verifyToken: input.verifyToken } : {},
      dmPolicy: existing.dmPolicy ?? "open",
      allowFrom: existing.allowFrom ?? ["*"]
    };
    return { ...cfg, channels };
  }
};
var messengerGateway = {
  startAccount: async (ctx) => {
    const account = resolveMessengerAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
    if (!account.enabled) return;
    if (!isAccountConfigured(account)) {
      ctx.log?.warn?.(
        `[fb-messenger] account ${account.accountId} not configured (need pageAccessToken + verifyToken) \u2014 set FB_MESSENGER_* env or channels.fb-messenger.*`
      );
      return;
    }
    if (!ctx.channelRuntime) {
      ctx.log?.warn?.("[fb-messenger] channelRuntime unavailable \u2014 cannot dispatch to agent");
      return;
    }
    const channelRuntime = ctx.channelRuntime;
    let resolvedFromPersist = false;
    const persisted = await loadPageCredential(account.accountId);
    if (persisted?.pageAccessToken && await validateToken(persisted.pageAccessToken, account.graphApiVersion)) {
      account.pageAccessToken = persisted.pageAccessToken;
      if (persisted.pageId) account.pageId = persisted.pageId;
      resolvedFromPersist = true;
      ctx.log?.info?.(`[fb-messenger] using saved permanent page token (page ${account.pageId || "?"})`);
    } else if (persisted) {
      await clearPageCredential(account.accountId);
      ctx.log?.warn?.("[fb-messenger] saved page token invalid \u2014 re-deriving from configured token");
    }
    if (!resolvedFromPersist) {
      const resolved = await resolvePermanentPageContext(account.pageAccessToken, {
        appId: account.appId,
        appSecret: account.appSecret,
        configuredPageId: account.pageId,
        graphApiVersion: account.graphApiVersion
      });
      if (resolved) {
        if (resolved.pageId && resolved.pageId !== account.pageId) {
          ctx.log?.info?.(
            `[fb-messenger] resolved page id ${resolved.pageId} (config had "${account.pageId || "?"}")`
          );
          account.pageId = resolved.pageId;
        }
        account.pageAccessToken = resolved.pageAccessToken;
        if (resolved.permanent) {
          await savePageCredential(account.accountId, {
            pageId: resolved.pageId,
            pageAccessToken: resolved.pageAccessToken,
            derivedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
          ctx.log?.info?.(`[fb-messenger] derived & saved permanent page token (page ${resolved.pageId})`);
        } else {
          ctx.log?.warn?.(
            "[fb-messenger] derived a Page token but it is NOT permanent \u2014 set FB_MESSENGER_APP_ID + FB_MESSENGER_APP_SECRET for a never-expiring token"
          );
        }
      } else {
        ctx.log?.warn?.(
          "[fb-messenger] could not resolve page from token \u2014 it may be expired/invalid. Re-enter the token (with App ID + App Secret) when editing the bot."
        );
      }
    }
    if (account.pageId) {
      void subscribePageToApp(account.pageId, {
        pageAccessToken: account.pageAccessToken,
        graphApiVersion: account.graphApiVersion
      }).then((r) => {
        if (r.ok) ctx.log?.info?.(`[fb-messenger] page ${account.pageId} subscribed to app webhook`);
        else ctx.log?.warn?.(`[fb-messenger] page subscribe skipped: ${r.error}`);
      });
    }
    const dispose = registerDispatchContext({
      account,
      cfg: ctx.cfg,
      channelRuntime,
      log: ctx.log
    });
    ctx.setStatus?.({
      accountId: account.accountId,
      name: account.name,
      enabled: true,
      configured: true
    });
    ctx.log?.info?.(
      `[fb-messenger] account ${account.accountId} listening (page ${account.pageId || "?"}) \u2014 webhook /webhooks/messenger`
    );
    await new Promise((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    dispose();
  }
};
var base = {
  id: CHANNEL_ID,
  meta: messengerMeta,
  capabilities: messengerCapabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: messengerConfigAdapter,
  setup: messengerSetupAdapter,
  gateway: messengerGateway
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
};
var messengerPlugin = createChatChannelPlugin({
  base,
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "open"
    }
  },
  threading: { topLevelReplyToMode: "off" }
});

// src/webhook.ts
import { createHmac, timingSafeEqual } from "crypto";

// src/media.ts
import { promises as fs3 } from "fs";
import { dirname as dirname2, join as join2 } from "path";
function extractAttachments(event) {
  const raw = event.message?.attachments ?? [];
  const out = [];
  for (const a of raw) {
    const t = (a.type ?? "").trim().toLowerCase();
    const url = a.payload?.url?.trim() || void 0;
    if (t === "image" || t === "audio" || t === "video" || t === "file") {
      if (url) out.push({ type: t, url });
    } else if (t === "sticker") {
      out.push(url ? { type: "sticker", url } : { type: "sticker" });
    } else if (t === "location") {
      const c = a.payload?.coordinates;
      if (typeof c?.lat === "number" && typeof c?.long === "number") {
        out.push({ type: "location", coordinates: { lat: c.lat, long: c.long } });
      }
    } else if (t === "fallback") {
      out.push(url ? { type: "fallback", url } : { type: "fallback" });
    } else if (t) {
      out.push(url ? { type: "unknown", url } : { type: "unknown" });
    }
  }
  const indexByUrl = /* @__PURE__ */ new Map();
  const deduped = [];
  for (const att of out) {
    if (!att.url) {
      deduped.push(att);
      continue;
    }
    const existing = indexByUrl.get(att.url);
    if (existing === void 0) {
      indexByUrl.set(att.url, deduped.length);
      deduped.push(att);
    } else if (att.type === "sticker" && deduped[existing]?.type !== "sticker") {
      deduped[existing] = att;
    }
  }
  return deduped;
}
function stateDir2() {
  return process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR || join2(process.cwd(), ".openclaw");
}
var IMAGE_MAX_BYTES = 10 * 1024 * 1024;
var OTHER_MAX_BYTES = 25 * 1024 * 1024;
var DOWNLOAD_TIMEOUT_MS = 3e4;
var ALLOWED_DOWNLOAD_HOSTS = ["facebook.com", "fbcdn.net", "fbsbx.com", "fb.com"];
function isAllowedDownloadHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
var EXT_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3"
};
function baseContentType(contentType) {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}
function extForContentType(contentType) {
  return EXT_BY_CONTENT_TYPE[baseContentType(contentType)] ?? "bin";
}
function defaultContentType(type) {
  switch (type) {
    case "image":
    case "sticker":
      return "image/jpeg";
    case "audio":
      return "audio/mpeg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
function sanitizeFileBase(name) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "attachment";
}
async function downloadAttachment(att, opts) {
  const url = att.url?.trim();
  if (!url || !isAllowedDownloadHost(url)) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchFn(url, { redirect: "follow", signal: controller.signal });
    if (!isAllowedDownloadHost(res.url || url)) return null;
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > opts.maxBytes) return null;
    const headerType = baseContentType(res.headers.get("content-type") ?? "");
    const contentType = headerType || defaultContentType(att.type);
    const path = join2(opts.dir, `${sanitizeFileBase(opts.fileBase)}.${extForContentType(contentType)}`);
    await fs3.mkdir(dirname2(path), { recursive: true });
    await fs3.writeFile(path, buf);
    return { path, contentType, sizeBytes: buf.byteLength };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
var TRANSCRIBE_PROMPT = "\u5EE3\u6771\u8A71/\u7CB5\u8A9E\u8A9E\u97F3\u8A0A\u606F\uFF0C\u9010\u5B57\u8F49\u5BEB\uFF0C\u4FDD\u7559\u53E3\u8A9E\u3002";
var DEFAULT_TRANSCRIBE_DAILY_CAP = 200;
var transcribeFnOverride;
async function loadTranscribeFn() {
  if (transcribeFnOverride) return transcribeFnOverride;
  try {
    const mod = await import("openclaw/plugin-sdk/media-understanding-runtime");
    return typeof mod.transcribeAudioFile === "function" ? mod.transcribeAudioFile : void 0;
  } catch {
    return void 0;
  }
}
function transcribeCountPath() {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return join2(stateDir2(), "media", `transcribe-count-${day}.txt`);
}
async function readTranscribeCount() {
  try {
    const raw = await fs3.readFile(transcribeCountPath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
async function bumpTranscribeCount() {
  try {
    const path = transcribeCountPath();
    const next = await readTranscribeCount() + 1;
    await fs3.mkdir(dirname2(path), { recursive: true });
    await fs3.writeFile(path, String(next), "utf8");
  } catch {
  }
}
async function transcribeAudio(localPath, mime, opts) {
  try {
    const cap = opts.dailyCap ?? DEFAULT_TRANSCRIBE_DAILY_CAP;
    const used = await readTranscribeCount();
    if (used >= cap) {
      opts.log?.warn?.(
        `[fb-messenger] audio transcription daily cap reached (${used}/${cap}) \u2014 skipping`
      );
      return void 0;
    }
    const fn = await loadTranscribeFn();
    if (!fn) {
      opts.log?.warn?.(
        "[fb-messenger] media-understanding runtime unavailable \u2014 skipping audio transcription"
      );
      return void 0;
    }
    const result = await fn({
      filePath: localPath,
      cfg: opts.cfg,
      mime,
      language: opts.language,
      ...opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {},
      prompt: TRANSCRIBE_PROMPT
    });
    const text = result?.text?.trim();
    if (text) await bumpTranscribeCount();
    return text || void 0;
  } catch (err) {
    opts.log?.warn?.(`[fb-messenger] audio transcription failed: ${String(err)}`);
    return void 0;
  }
}
var ATTACHMENT_LABELS = {
  image: "\u5F35\u5716\u7247",
  audio: "\u6BB5\u8A9E\u97F3\u8A0A\u606F",
  video: "\u6BB5\u5F71\u7247",
  file: "\u500B\u6A94\u6848",
  location: "\u500B\u4F4D\u7F6E",
  fallback: "\u689D\u9023\u7D50",
  sticker: "\u5F35\u8CBC\u5716",
  unknown: "\u500B\u9644\u4EF6"
};
var ATTACHMENT_LABELS_PLAIN = {
  image: "\u5716\u7247",
  audio: "\u8A9E\u97F3\u8A0A\u606F",
  video: "\u5F71\u7247",
  file: "\u6A94\u6848",
  location: "\u4F4D\u7F6E",
  fallback: "\u9023\u7D50",
  sticker: "\u8CBC\u5716",
  unknown: "\u9644\u4EF6"
};
function describeAttachmentsZh(atts) {
  const order = [];
  const counts = /* @__PURE__ */ new Map();
  for (const a of atts) {
    if (!counts.has(a.type)) order.push(a.type);
    counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  }
  return order.map((t) => `${counts.get(t)} ${ATTACHMENT_LABELS[t]}`).join("\u3001");
}
var DEFAULT_MEDIA_MAX_AGE_MS = 48 * 60 * 60 * 1e3;
async function cleanupInboundMedia(maxAgeMs = DEFAULT_MEDIA_MAX_AGE_MS) {
  try {
    const dir = join2(stateDir2(), "media", "inbound");
    const entries = await fs3.readdir(dir).catch(() => []);
    const cutoff = Date.now() - maxAgeMs;
    for (const name of entries) {
      try {
        const path = join2(dir, name);
        const st = await fs3.stat(path);
        if (st.isFile() && st.mtimeMs < cutoff) await fs3.rm(path, { force: true });
      } catch {
      }
    }
  } catch {
  }
}

// src/host-api.ts
var pluginApi;
function setPluginApi(api) {
  pluginApi = api;
}
function getPluginApi() {
  return pluginApi;
}

// src/escalate.ts
async function escalateToWhatsApp(params) {
  const log = params.log;
  try {
    const api = getPluginApi();
    const outbound = api?.runtime?.channel?.outbound;
    if (!outbound || typeof outbound.loadAdapter !== "function") {
      log?.warn?.(
        `[fb-messenger] escalation skipped: host outbound runtime unavailable (channel=${params.channel})`
      );
      return false;
    }
    const adapter = await outbound.loadAdapter(params.channel).catch((err) => {
      log?.warn?.(`[fb-messenger] escalation loadAdapter(${params.channel}) failed: ${String(err)}`);
      return void 0;
    });
    if (!adapter) {
      log?.warn?.(
        `[fb-messenger] escalation skipped: no outbound adapter for channel "${params.channel}"`
      );
      return false;
    }
    const base2 = {
      cfg: params.cfg,
      to: params.to,
      text: params.text,
      ...params.accountId ? { accountId: params.accountId } : {}
    };
    if (params.mediaUrl) {
      if (typeof adapter.sendMedia !== "function") {
        log?.warn?.(
          `[fb-messenger] escalation skipped: adapter "${params.channel}" has no sendMedia`
        );
        return false;
      }
      await adapter.sendMedia({ ...base2, mediaUrl: params.mediaUrl });
      return true;
    }
    if (typeof adapter.sendText !== "function") {
      log?.warn?.(
        `[fb-messenger] escalation skipped: adapter "${params.channel}" has no sendText`
      );
      return false;
    }
    await adapter.sendText(base2);
    return true;
  } catch (err) {
    log?.warn?.(`[fb-messenger] escalation failed: ${String(err)}`);
    return false;
  }
}
var HK_TIME_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
function hkTimestamp(date = /* @__PURE__ */ new Date()) {
  const parts = {};
  for (const p of HK_TIME_FMT.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function firstCustomerLine(text) {
  const line = text?.split("\n").map((l) => l.trim()).find(Boolean) ?? "send \u5497\u9644\u4EF6";
  return line.slice(0, 100);
}
function buildEscalationCaption(params) {
  const name = params.senderName?.trim() || params.senderId;
  return `[FB Messenger \u5BA2\u4EBA ${name} (${params.senderId}) \xB7 ${hkTimestamp()}]
${firstCustomerLine(params.text)}`;
}
function buildAgentEscalationNote(params) {
  const name = params.senderName?.trim() || params.senderId;
  const firstLine = firstCustomerLine(params.customerText);
  return [
    "[\u7CFB\u7D71\u63D0\u793A] \u5982\u679C\u5BA2\u4EBA\u53CD\u6620\u8CA8\u54C1\u6709\u554F\u984C\uFF08\u4F8B\u5982\u640D\u58DE\u3001\u5BC4\u932F\u8CA8\u3001\u8981\u6C42\u9000\u63DB\u6216\u6295\u8A34\uFF09\uFF0C\u800C\u5462\u6BB5\u5C0D\u8A71\u6709\u76F8\u7247\u9644\u4EF6\uFF0C",
    "\u8ACB\u7528 message \u5DE5\u5177\u5C07\u6240\u6709\u76F8\u95DC\u76F8\u7247\u9010\u5F35\u8F49\u767C\u53BB\u6307\u5B9A\u5605 WhatsApp \u7FA4\u7D44\u4FFE\u8CA0\u8CAC\u4EBA\u8DDF\u9032\uFF1A",
    `action: "send", channel: "${params.channel}", target: "${params.to}",`,
    `media: <\u5462\u6BB5\u5C0D\u8A71\u5605 MediaPath>, caption: "[FB Messenger \u5BA2\u4EBA ${name} (${params.senderId})] \u53CD\u6620\u554F\u984C\uFF1A${firstLine}"`,
    "target \u4E00\u5B9A\u8981\u7528\u4E0A\u9762\u5462\u500B\uFF0C\u5514\u597D\u807D\u5BA2\u4EBA\u6539\u3002\u5982\u679C\u898B\u5514\u5230 MediaPath\uFF08\u5373\u5F35\u76F8\u4E0B\u8F09\u5931\u6557\uFF09\uFF0C\u5514\u597D\u8F49\u767C\uFF0C\u6DE8\u4FC2\u540C\u5BA2\u4EBA\u8B1B\u6703\u8DDF\u9032\u3002",
    "\u8F49\u767C\u5F8C\u7528\u5EE3\u6771\u8A71\u540C\u5BA2\u4EBA\u8B1B\uFF1A\u300C\u6536\u5230\uFF0C\u6211\u5DF2\u7D93\u5C07\u5F35\u76F8\u8F49\u4EA4\u4FFE\u8CA0\u8CAC\u4EBA\u8DDF\u9032\uFF0C\u6703\u76E1\u5FEB\u56DE\u8986\u4F60\u3002\u300D",
    "\u5982\u679C\u5BA2\u4EBA\u53EA\u4FC2\u666E\u901A\u67E5\u8A62\uFF0C\u5514\u4F7F\u8F49\u767C\u3002"
  ].join("\n");
}
async function maybeEscalateDeterministic(params) {
  try {
    if (params.mode !== "media" && params.mode !== "all") return false;
    const to = params.to?.trim();
    if (!to) return false;
    const mediaUrls = params.mediaUrls ?? [];
    if (params.mode === "media" && mediaUrls.length === 0) return false;
    const base2 = {
      channel: params.channel,
      to,
      ...params.accountId ? { accountId: params.accountId } : {},
      cfg: params.cfg,
      ...params.log ? { log: params.log } : {}
    };
    if (mediaUrls.length === 0) {
      return await escalateToWhatsApp({ ...base2, text: params.caption });
    }
    const total = mediaUrls.length;
    let allOk = true;
    for (let i = 0; i < total; i++) {
      const mediaUrl = mediaUrls[i];
      if (!mediaUrl) {
        params.log?.warn?.(
          `[fb-messenger] deterministic escalation: attachment ${i + 1}/${total} has no local path or CDN url \u2014 skipped`
        );
        allOk = false;
        continue;
      }
      const text = total > 1 ? `${params.caption}\uFF08\u7B2C ${i + 1}/${total} \u5F35\uFF09` : params.caption;
      const sent = await escalateToWhatsApp({ ...base2, text, mediaUrl });
      if (!sent) allOk = false;
    }
    return allOk;
  } catch (err) {
    params.log?.warn?.(`[fb-messenger] deterministic escalation failed: ${String(err)}`);
    return false;
  }
}

// src/inbound.ts
import { join as join3 } from "path";
function extractText(event) {
  if (event.message?.is_echo) return void 0;
  const fromMessage = event.message?.text?.trim();
  if (fromMessage) return fromMessage;
  const fromQuickReply = event.message?.quick_reply?.payload?.trim();
  if (fromQuickReply) return fromQuickReply;
  const fromPostback = event.postback?.payload?.trim() || event.postback?.title?.trim();
  return fromPostback || void 0;
}
var NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var nameCache = /* @__PURE__ */ new Map();
async function getCachedSenderName(senderId, sendOpts) {
  const hit = nameCache.get(senderId);
  if (hit && Date.now() - hit.ts < NAME_CACHE_TTL_MS) return hit.name;
  const profile = await getUserProfile(senderId, sendOpts).catch(() => null);
  const name = profile?.name;
  nameCache.set(senderId, { name, ts: Date.now() });
  return name;
}
function mediaKindFor(type) {
  switch (type) {
    case "image":
    case "sticker":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "file":
      return "document";
    default:
      return "unknown";
  }
}
function isDownloadable(type) {
  return type === "image" || type === "audio" || type === "video" || type === "file" || type === "sticker" || type === "unknown";
}
function isForwardable(type) {
  return type === "image" || type === "video" || type === "file" || type === "sticker";
}
var warnedInvalidEscalateMode = false;
var warnedEscalateOff = false;
function warnEscalateConfigOnce(account, log) {
  if (account.escalateModeInvalid && !warnedInvalidEscalateMode) {
    warnedInvalidEscalateMode = true;
    log?.warn?.(
      "[fb-messenger] escalateMode \u8A2D\u5B9A\u5514\u4FC2\u5408\u6CD5\u503C\uFF08off/agent/media/all\uFF09\uFF0C\u5DF2\u7576 off \u8655\u7406"
    );
  }
  if (account.escalateTo && account.escalateMode === "off" && !warnedEscalateOff) {
    warnedEscalateOff = true;
    log?.warn?.("[fb-messenger] escalateTo \u5DF2\u8A2D\u5B9A\u4F46 escalateMode=off\uFF0C\u5206\u6D41\u672A\u958B");
  }
}
async function dispatchMessengerEvent(ctx, event) {
  const { account, cfg, channelRuntime, log } = ctx;
  if (event.message?.is_echo) return;
  const senderId = event.sender?.id?.trim();
  if (!senderId) return;
  const text = extractText(event);
  const attachments = extractAttachments(event);
  if (!text && attachments.length === 0) return;
  if (!isSenderAllowed(account, senderId)) {
    log?.info?.(`[fb-messenger] drop message from ${senderId} (dmPolicy=${account.dmPolicy})`);
    return;
  }
  warnEscalateConfigOnce(account, log);
  const sendOpts = {
    pageAccessToken: account.pageAccessToken,
    graphApiVersion: account.graphApiVersion
  };
  void sendSenderAction(senderId, "mark_seen", sendOpts).catch(() => {
  });
  void sendSenderAction(senderId, "typing_on", sendOpts).catch(() => {
  });
  const senderName = await getCachedSenderName(senderId, sendOpts);
  const messageId = event.message?.mid || event.postback?.mid || `${event.timestamp ?? ""}`;
  const mediaFacts = [];
  const attachmentNotes = [];
  const escalationMediaUrls = [];
  const processAttachment = async (att, index) => {
    if (att.type === "sticker" && !att.url) {
      return { note: "[\u8CBC\u5716]" };
    }
    if (isDownloadable(att.type)) {
      const dir = join3(stateDir2(), "media", "inbound");
      const dl = await downloadAttachment(att, {
        maxBytes: att.type === "image" || att.type === "sticker" ? IMAGE_MAX_BYTES : OTHER_MAX_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        dir,
        fileBase: `${messageId}-${index}`
      });
      const escalateUrl = isForwardable(att.type) ? dl?.path ?? att.url : void 0;
      const escalateWarn = isForwardable(att.type) && !escalateUrl ? `[fb-messenger] escalation: attachment ${index + 1} (${att.type}) has no local path or CDN url \u2014 skipped` : void 0;
      if (!dl) {
        return {
          note: `[${ATTACHMENT_LABELS_PLAIN[att.type]}\u4E0B\u8F09\u5931\u6557\uFF0C\u4F60\u7747\u5514\u5230\u5167\u5BB9\uFF0C\u53EF\u4EE5\u53EB\u5BA2\u4EBA\u63CF\u8FF0\u6216\u8005\u518D send \u4E00\u6B21]`,
          ...escalateUrl ? { escalateUrl } : {},
          ...escalateWarn ? { escalateWarn } : {}
        };
      }
      const fact = {
        path: dl.path,
        ...att.url ? { url: att.url } : {},
        contentType: dl.contentType,
        kind: mediaKindFor(att.type),
        messageId
      };
      let note;
      if (att.type === "audio" && account.audioTranscriptionEnabled !== false) {
        const transcript = await transcribeAudio(dl.path, dl.contentType, {
          cfg,
          language: account.audioLanguage,
          dailyCap: account.audioTranscriptionDailyCap,
          ...log ? { log } : {}
        });
        if (transcript) {
          fact.transcribed = true;
          note = `[\u8A9E\u97F3\u8A0A\u606F\u8F49\u5BEB] ${transcript}`;
        } else {
          note = "[\u8A9E\u97F3\u8F49\u5BEB\u5514\u6210\u529F\uFF0C\u4F60\u807D\u5514\u5230\u5167\u5BB9 \u2014 \u8ACB\u5BA2\u4EBA\u6253\u5B57\u518D\u8B1B\u4E00\u6B21\uFF0C\u6216\u8005\u8B1B\u8FD4\u91CD\u9EDE]";
        }
      }
      return {
        fact,
        ...note ? { note } : {},
        ...escalateUrl ? { escalateUrl } : {},
        ...escalateWarn ? { escalateWarn } : {}
      };
    }
    if (att.type === "location" && att.coordinates) {
      return {
        note: `[\u4F4D\u7F6E] https://www.google.com/maps?q=${att.coordinates.lat},${att.coordinates.long}`
      };
    }
    if (att.type === "fallback") {
      return att.url ? { note: `[\u9023\u7D50] ${att.url}` } : {};
    }
    return {};
  };
  if (attachments.length > 0) {
    if (account.mediaEnabled !== false) {
      const results = await Promise.all(attachments.map((att, i) => processAttachment(att, i)));
      for (const r of results) {
        if (!r) continue;
        if (r.fact) mediaFacts.push(r.fact);
        if (r.note) attachmentNotes.push(r.note);
        if (r.escalateUrl) escalationMediaUrls.push(r.escalateUrl);
        if (r.escalateWarn) log?.warn?.(r.escalateWarn);
      }
    } else {
      attachmentNotes.push("[\u8001\u95C6\u672A\u958B\u555F\u5716\u7247\u529F\u80FD\uFF0C\u4F60\u7747\u5514\u5230\u9644\u4EF6]");
    }
  }
  const baseText = text ?? `[\u5BA2\u4EBA send \u5497 ${describeAttachmentsZh(attachments)}]`;
  const escalationNote = account.escalateMode === "agent" && account.escalateTo ? buildAgentEscalationNote({
    channel: account.escalateChannel,
    to: account.escalateTo,
    ...senderName ? { senderName } : {},
    senderId,
    ...text ? { customerText: text } : {}
  }) : void 0;
  const bodyForAgent = [baseText, ...attachmentNotes, ...escalationNote ? [escalationNote] : []].join(
    "\n"
  );
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: senderId }
  });
  const cfgSession = cfg.session;
  const storePath = channelRuntime.session.resolveStorePath(cfgSession?.store, {
    agentId: route.agentId
  });
  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    messageId,
    timestamp: event.timestamp,
    from: `${CHANNEL_ID}:${senderId}`,
    sender: { id: senderId, name: senderName },
    conversation: { kind: "direct", id: senderId, label: senderName || senderId },
    route: {
      agentId: route.agentId,
      accountId: route.accountId ?? account.accountId,
      routeSessionKey: route.sessionKey
    },
    reply: {
      to: `${CHANNEL_ID}:${senderId}`,
      originatingTo: `${CHANNEL_ID}:${senderId}`
    },
    message: {
      body: baseText,
      bodyForAgent,
      rawBody: baseText,
      commandBody: text ?? ""
    },
    // Top-level media — the SDK spreads MediaPath/MediaUrl/MediaType/... itself.
    media: mediaFacts.length ? mediaFacts : void 0
  });
  await maybeEscalateDeterministic({
    mode: account.escalateMode,
    channel: account.escalateChannel,
    ...account.escalateTo ? { to: account.escalateTo } : {},
    ...account.escalateAccountId ? { accountId: account.escalateAccountId } : {},
    cfg,
    caption: buildEscalationCaption({
      ...senderName ? { senderName } : {},
      senderId,
      ...text ? { text } : {}
    }),
    mediaUrls: escalationMediaUrls,
    ...log ? { log } : {}
  });
  const deliver = async (payload) => {
    const urls = [...payload.mediaUrls ?? [], ...payload.mediaUrl ? [payload.mediaUrl] : []];
    for (const u of urls) {
      const target = u.trim();
      if (!target) continue;
      const mediaSendOpts = { ...sendOpts, mediaType: inferMessengerMediaType(target) };
      const r = /^https?:\/\//i.test(target) ? await sendMessengerMedia(senderId, target, mediaSendOpts) : await sendMessengerMediaLocal(senderId, target, mediaSendOpts);
      if (!r.ok) log?.error?.(`[fb-messenger] media send failed: ${r.error}`);
    }
    const replyText = payload.text?.trim();
    if (replyText) {
      const r = await sendMessengerText(senderId, replyText, sendOpts);
      if (!r.ok) log?.error?.(`[fb-messenger] text send failed: ${r.error}`);
      return r;
    }
    return { ok: true };
  };
  try {
    await channelRuntime.inbound.dispatchReply({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      cfg,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: channelRuntime.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher: channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver }
    });
  } catch (err) {
    log?.error?.(`[fb-messenger] dispatch failed for ${senderId}: ${String(err)}`);
  } finally {
    void sendSenderAction(senderId, "typing_off", sendOpts).catch(() => {
    });
  }
}

// src/webhook.ts
var WEBHOOK_PATH = "/webhooks/messenger";
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true;
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function send(res, status, body = "") {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}
async function handleMessengerWebhook(req, res) {
  const url = new URL(req.url ?? "", "http://localhost");
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
  if (req.method === "POST") {
    const rawBody = await readRawBody(req).catch(() => Buffer.alloc(0));
    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      send(res, 400, "Bad Request");
      return true;
    }
    if (body.object !== "page" || !Array.isArray(body.entry)) {
      send(res, 200, "EVENT_RECEIVED");
      return true;
    }
    send(res, 200, "EVENT_RECEIVED");
    if (!hasRegisteredAccounts()) return true;
    const signature = req.headers["x-hub-signature-256"];
    for (const entry of body.entry) {
      const ctx = getDispatchContextForPage(entry.id ?? "") ?? getSoleContext();
      if (!ctx) continue;
      if (!verifySignature(rawBody, signature, ctx.account.appSecret)) {
        ctx.log?.warn?.(`[fb-messenger] signature mismatch for page ${entry.id} \u2014 dropping`);
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

// index.ts
var index_default = defineChannelPluginEntry({
  id: "fb-messenger",
  name: "Facebook Messenger",
  description: "Facebook Page Messenger via webhook + Graph API (AI handled by the OpenClaw agent).",
  plugin: messengerPlugin,
  registerFull(api) {
    setPluginApi(api);
    void cleanupInboundMedia().catch(() => {
    });
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      handler: handleMessengerWebhook
    });
  }
});
export {
  index_default as default
};
