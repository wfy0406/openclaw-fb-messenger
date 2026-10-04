import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  CHANNEL_ID,
  isAccountConfigured,
  listMessengerAccountIds,
  resolveMessengerAccount,
  normalizeAccountId,
  type MessengerAccountConfig,
  type ResolvedMessengerAccount,
} from "./config.js";
import { resolvePermanentPageContext, subscribePageToApp, validateToken } from "./graph-api.js";
import { loadPageCredential, savePageCredential, clearPageCredential } from "./credentials.js";
import { registerDispatchContext } from "./registry.js";
import type { ChannelReplyDispatchSurface } from "./types.js";

const messengerMeta = {
  id: CHANNEL_ID,
  label: "Facebook Messenger",
  selectionLabel: "Facebook (Messenger)",
  docsPath: "/channels/fb-messenger",
  docsLabel: "fb-messenger",
  blurb: "Facebook Page Messenger via webhook + Graph API.",
  aliases: ["fb", "messenger"],
  order: 90,
  quickstartAllowFrom: false,
};

const messengerCapabilities = {
  chatTypes: ["direct"],
  media: true,
  reactions: false,
  threads: false,
  polls: false,
  nativeCommands: false,
  blockStreaming: true,
};

// ── config adapter (hybrid: default account at root, named under `accounts`) ──
const messengerConfigAdapter = createHybridChannelConfigAdapter<ResolvedMessengerAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: (cfg) => listMessengerAccountIds(cfg as OpenClawConfig),
  resolveAccount: (cfg, accountId) =>
    resolveMessengerAccount({ cfg: cfg as OpenClawConfig, accountId }),
  defaultAccountId: (cfg) => {
    const channels = (cfg as { channels?: Record<string, { defaultAccount?: string }> }).channels;
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
    "responsePrefix",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom),
});

// ── DM security policy resolver ───────────────────────────────────────────────
const messengerDmResolver = createScopedDmSecurityResolver<ResolvedMessengerAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
});

// ── setup adapter: write account credentials into openclaw.json ───────────────
const messengerSetupAdapter = {
  applyAccountConfig: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Record<string, unknown>;
  }): OpenClawConfig => {
    const cfg = params.cfg as OpenClawConfig & { channels?: Record<string, MessengerAccountConfig> };
    const channels = { ...(cfg.channels ?? {}) };
    const existing = (channels[CHANNEL_ID] as MessengerAccountConfig | undefined) ?? {};
    const input = params.input as Partial<MessengerAccountConfig>;
    channels[CHANNEL_ID] = {
      ...existing,
      enabled: true,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.pageAccessToken ? { pageAccessToken: input.pageAccessToken } : {}),
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.appSecret ? { appSecret: input.appSecret } : {}),
      ...(input.verifyToken ? { verifyToken: input.verifyToken } : {}),
      dmPolicy: existing.dmPolicy ?? "open",
      allowFrom: existing.allowFrom ?? ["*"],
    };
    return { ...cfg, channels } as OpenClawConfig;
  },
};

// ── gateway: register dispatch context per account, keep alive until aborted ──
const messengerGateway = {
  startAccount: async (ctx: {
    cfg: OpenClawConfig;
    accountId: string;
    abortSignal: AbortSignal;
    channelRuntime?: unknown;
    log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
    setStatus?: (s: unknown) => void;
  }): Promise<void> => {
    const account = resolveMessengerAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
    if (!account.enabled) return;
    if (!isAccountConfigured(account)) {
      ctx.log?.warn?.(
        `[fb-messenger] account ${account.accountId} not configured (need pageAccessToken + verifyToken) — set FB_MESSENGER_* env or channels.fb-messenger.*`,
      );
      return;
    }
    if (!ctx.channelRuntime) {
      ctx.log?.warn?.("[fb-messenger] channelRuntime unavailable — cannot dispatch to agent");
      return;
    }

    const channelRuntime = ctx.channelRuntime as unknown as ChannelReplyDispatchSurface;

    // Resolve the effective Page token. Prefer a previously-derived permanent
    // token (persisted in .openclaw/credentials/fb-messenger); otherwise derive
    // one from whatever the user supplied — a short-lived User token from the
    // Graph API Explorer is upgraded to a long-lived one and exchanged for the
    // Page's never-expiring token — and persist it so restarts never re-depend
    // on the (expiring) input token.
    let resolvedFromPersist = false;
    const persisted = await loadPageCredential(account.accountId);
    if (persisted?.pageAccessToken && (await validateToken(persisted.pageAccessToken, account.graphApiVersion))) {
      account.pageAccessToken = persisted.pageAccessToken;
      if (persisted.pageId) account.pageId = persisted.pageId;
      resolvedFromPersist = true;
      ctx.log?.info?.(`[fb-messenger] using saved permanent page token (page ${account.pageId || "?"})`);
    } else if (persisted) {
      await clearPageCredential(account.accountId);
      ctx.log?.warn?.("[fb-messenger] saved page token invalid — re-deriving from configured token");
    }

    if (!resolvedFromPersist) {
      const resolved = await resolvePermanentPageContext(account.pageAccessToken, {
        appId: account.appId,
        appSecret: account.appSecret,
        configuredPageId: account.pageId,
        graphApiVersion: account.graphApiVersion,
      });
      if (resolved) {
        if (resolved.pageId && resolved.pageId !== account.pageId) {
          ctx.log?.info?.(
            `[fb-messenger] resolved page id ${resolved.pageId} (config had "${account.pageId || "?"}")`,
          );
          account.pageId = resolved.pageId;
        }
        account.pageAccessToken = resolved.pageAccessToken;
        if (resolved.permanent) {
          await savePageCredential(account.accountId, {
            pageId: resolved.pageId,
            pageAccessToken: resolved.pageAccessToken,
            derivedAt: new Date().toISOString(),
          });
          ctx.log?.info?.(`[fb-messenger] derived & saved permanent page token (page ${resolved.pageId})`);
        } else {
          ctx.log?.warn?.(
            "[fb-messenger] derived a Page token but it is NOT permanent — set FB_MESSENGER_APP_ID + FB_MESSENGER_APP_SECRET for a never-expiring token",
          );
        }
      } else {
        ctx.log?.warn?.(
          "[fb-messenger] could not resolve page from token — it may be expired/invalid. Re-enter the token (with App ID + App Secret) when editing the bot.",
        );
      }
    }

    // Auto-subscribe the Page to this app's webhook (idempotent) so the user
    // doesn't have to do it manually in the Meta dashboard.
    if (account.pageId) {
      void subscribePageToApp(account.pageId, {
        pageAccessToken: account.pageAccessToken,
        graphApiVersion: account.graphApiVersion,
      }).then((r) => {
        if (r.ok) ctx.log?.info?.(`[fb-messenger] page ${account.pageId} subscribed to app webhook`);
        else ctx.log?.warn?.(`[fb-messenger] page subscribe skipped: ${r.error}`);
      });
    }

    const dispose = registerDispatchContext({
      account,
      cfg: ctx.cfg,
      channelRuntime,
      log: ctx.log,
    });
    ctx.setStatus?.({
      accountId: account.accountId,
      name: account.name,
      enabled: true,
      configured: true,
    });
    ctx.log?.info?.(
      `[fb-messenger] account ${account.accountId} listening (page ${account.pageId || "?"}) — webhook /webhooks/messenger`,
    );

    await new Promise<void>((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    dispose();
  },
};

// ── assemble the channel plugin ───────────────────────────────────────────────
// The base satisfies the structural ChannelPlugin shape; SDK adapter types are
// heavily aliased across bundled chunks, so a single boundary cast keeps the
// public composition readable while the runtime shape stays correct.
const base = {
  id: CHANNEL_ID,
  meta: messengerMeta,
  capabilities: messengerCapabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: messengerConfigAdapter,
  setup: messengerSetupAdapter,
  gateway: messengerGateway,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const messengerPlugin = createChatChannelPlugin({
  base,
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account: ResolvedMessengerAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedMessengerAccount) => account.allowFrom,
      defaultPolicy: "open",
    },
  },
  threading: { topLevelReplyToMode: "off" },
});

export { messengerDmResolver };
