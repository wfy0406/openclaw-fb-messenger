import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelReplyDispatchSurface } from "./types.js";
import type { ResolvedMessengerAccount } from "./config.js";

/**
 * Bridge between `gateway.startAccount` (which holds the live channelRuntime)
 * and the HTTP webhook handler registered once via `registerHttpRoute` (which
 * only receives raw req/res). Each started account registers its dispatch
 * context here, keyed by Page ID; the webhook looks it up per inbound `entry`.
 */
export interface MessengerDispatchContext {
  account: ResolvedMessengerAccount;
  cfg: OpenClawConfig;
  channelRuntime: ChannelReplyDispatchSurface;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

const byPageId = new Map<string, MessengerDispatchContext>();

export function registerDispatchContext(ctx: MessengerDispatchContext): () => void {
  const pageId = ctx.account.pageId?.trim();
  if (!pageId) {
    ctx.log?.warn?.(
      `[fb-messenger] account ${ctx.account.accountId} has no pageId — webhook routing disabled for it`,
    );
    return () => {};
  }
  byPageId.set(pageId, ctx);
  return () => {
    if (byPageId.get(pageId) === ctx) byPageId.delete(pageId);
  };
}

export function getDispatchContextForPage(pageId: string): MessengerDispatchContext | undefined {
  return byPageId.get(pageId.trim());
}

/** Any registered account whose verifyToken matches — used for the GET handshake. */
export function findContextByVerifyToken(token: string): MessengerDispatchContext | undefined {
  const t = token.trim();
  if (!t) return undefined;
  for (const ctx of byPageId.values()) {
    if (ctx.account.verifyToken && ctx.account.verifyToken.trim() === t) return ctx;
  }
  return undefined;
}

export function hasRegisteredAccounts(): boolean {
  return byPageId.size > 0;
}

/** The sole registered context, if exactly one — used as a forgiving fallback. */
export function getSoleContext(): MessengerDispatchContext | undefined {
  return byPageId.size === 1 ? [...byPageId.values()][0] : undefined;
}
