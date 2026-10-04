// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

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

// src/graph-api.ts
import { promises as fs } from "fs";
import { basename } from "path";
var GRAPH_HOST = "https://graph.facebook.com";
function graphUrl(path, version, token) {
  const v = version || DEFAULT_GRAPH_API_VERSION;
  const sep = path.includes("?") ? "&" : "?";
  return `${GRAPH_HOST}/${v}${path}${sep}access_token=${encodeURIComponent(token)}`;
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

// setup-entry.ts
var setup_entry_default = defineSetupPluginEntry(messengerPlugin);
export {
  setup_entry_default as default
};
