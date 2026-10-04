import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "fb-messenger";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_GRAPH_API_VERSION = "v21.0";
export const MESSENGER_TEXT_LIMIT = 2000;

export type MessengerDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

/** Escalation behaviour when a customer message may need the boss's attention. */
export type MessengerEscalateMode = "off" | "agent" | "media" | "all";

/** Per-account config as stored under `channels.fb-messenger` in openclaw.json. */
export interface MessengerAccountConfig {
  name?: string;
  enabled?: boolean;
  pageId?: string;
  pageAccessToken?: string;
  appId?: string;
  appSecret?: string;
  verifyToken?: string;
  graphApiVersion?: string;
  dmPolicy?: MessengerDmPolicy;
  allowFrom?: string[];
  historyLimit?: number;
  messagePrefix?: string;
  responsePrefix?: string;
  /** Download + surface inbound attachments to the agent. Default true. */
  mediaEnabled?: boolean;
  /** Transcribe inbound voice messages (Cantonese-first). Default true. */
  audioTranscriptionEnabled?: boolean;
  /** Transcription language hint. Default "yue" (Cantonese). */
  audioLanguage?: string;
  /** Max transcriptions per day. Default 200. */
  audioTranscriptionDailyCap?: number;
  /** Channel used for escalation relay. Default "whatsapp". */
  escalateChannel?: string;
  /** Boss target id on the escalation channel (e.g. "8529XXXXXXX"). Empty = escalation off. */
  escalateTo?: string;
  /**
   * Account id on the escalation channel (multi-account setups only). Never
   * pass this plugin's own Messenger accountId to the other channel's adapter.
   */
  escalateAccountId?: string;
  /** Escalation behaviour. Default "off". */
  escalateMode?: MessengerEscalateMode;
}

export interface MessengerChannelConfig extends MessengerAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, MessengerAccountConfig>;
}

/** Fully-resolved account with secrets layered in from the environment. */
export interface ResolvedMessengerAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  pageId: string;
  pageAccessToken: string;
  appId: string;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
  dmPolicy: MessengerDmPolicy;
  allowFrom: string[];
  historyLimit: number;
  mediaEnabled: boolean;
  audioTranscriptionEnabled: boolean;
  audioLanguage: string;
  audioTranscriptionDailyCap: number;
  escalateChannel: string;
  escalateTo?: string;
  escalateAccountId?: string;
  escalateMode: MessengerEscalateMode;
  /** True when a raw escalateMode value was configured but isn't a valid mode. */
  escalateModeInvalid?: boolean;
  config: MessengerAccountConfig;
}

function readChannelConfig(cfg: OpenClawConfig): MessengerChannelConfig {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
  return (channels[CHANNEL_ID] as MessengerChannelConfig | undefined) ?? {};
}

export function normalizeAccountId(accountId?: string | null): string {
  const trimmed = (accountId ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

export function listMessengerAccountIds(cfg: OpenClawConfig): string[] {
  const channel = readChannelConfig(cfg);
  const ids = Object.keys(channel.accounts ?? {});
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

function pick<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined && v !== "") return v;
  return undefined;
}

/**
 * Resolve a single account, merging (in priority order) env vars → account
 * override → channel top-level → defaults. Env wins so secrets never need to
 * live in openclaw.json.
 */
export function resolveMessengerAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedMessengerAccount {
  const env = params.env ?? process.env;
  const channel = readChannelConfig(params.cfg);
  const accountId = normalizeAccountId(
    params.accountId ?? channel.defaultAccount ?? DEFAULT_ACCOUNT_ID,
  );
  const account = channel.accounts?.[accountId] ?? {};

  const pageAccessToken =
    pick(env.FB_MESSENGER_PAGE_ACCESS_TOKEN, account.pageAccessToken, channel.pageAccessToken) ?? "";
  const appId =
    pick(env.FB_MESSENGER_APP_ID, account.appId, channel.appId) ?? "";
  const appSecret =
    pick(env.FB_MESSENGER_APP_SECRET, account.appSecret, channel.appSecret) ?? "";
  const verifyToken =
    pick(env.FB_MESSENGER_VERIFY_TOKEN, account.verifyToken, channel.verifyToken) ?? "";

  const escalateTo = pick(env.FB_MESSENGER_ESCALATE_TO, account.escalateTo, channel.escalateTo);
  const escalateAccountId = pick(
    env.FB_MESSENGER_ESCALATE_ACCOUNT_ID,
    account.escalateAccountId,
    channel.escalateAccountId,
  );
  const escalateModeRaw = pick(
    env.FB_MESSENGER_ESCALATE_MODE,
    account.escalateMode,
    channel.escalateMode,
  );
  const VALID_ESCALATE_MODES: readonly string[] = ["off", "agent", "media", "all"];
  const escalateModeInvalid =
    escalateModeRaw !== undefined && !VALID_ESCALATE_MODES.includes(escalateModeRaw);
  // Escalation requires a target; without `escalateTo` it is always "off".
  // Invalid mode strings also resolve to "off" (a warning is logged on dispatch).
  const escalateMode: MessengerEscalateMode =
    escalateTo &&
    (escalateModeRaw === "agent" || escalateModeRaw === "media" || escalateModeRaw === "all")
      ? escalateModeRaw
      : "off";

  return {
    accountId,
    name: pick(account.name, channel.name),
    enabled: account.enabled ?? channel.enabled ?? true,
    pageId: pick(account.pageId, channel.pageId) ?? "",
    pageAccessToken,
    appId,
    appSecret,
    verifyToken,
    graphApiVersion:
      pick(account.graphApiVersion, channel.graphApiVersion) ?? DEFAULT_GRAPH_API_VERSION,
    dmPolicy: (pick(account.dmPolicy, channel.dmPolicy) ?? "open") as MessengerDmPolicy,
    allowFrom: account.allowFrom ?? channel.allowFrom ?? ["*"],
    historyLimit: account.historyLimit ?? channel.historyLimit ?? 50,
    mediaEnabled: account.mediaEnabled ?? channel.mediaEnabled ?? true,
    audioTranscriptionEnabled:
      account.audioTranscriptionEnabled ?? channel.audioTranscriptionEnabled ?? true,
    audioLanguage:
      pick(env.FB_MESSENGER_AUDIO_LANGUAGE, account.audioLanguage, channel.audioLanguage) ?? "yue",
    audioTranscriptionDailyCap:
      account.audioTranscriptionDailyCap ?? channel.audioTranscriptionDailyCap ?? 200,
    escalateChannel:
      pick(env.FB_MESSENGER_ESCALATE_CHANNEL, account.escalateChannel, channel.escalateChannel) ??
      "whatsapp",
    escalateTo,
    ...(escalateAccountId ? { escalateAccountId } : {}),
    escalateMode,
    ...(escalateModeInvalid ? { escalateModeInvalid } : {}),
    config: { ...channel, ...account },
  };
}

/** True if the account has the minimum credentials to operate. */
export function isAccountConfigured(account: ResolvedMessengerAccount): boolean {
  return Boolean(account.pageAccessToken && account.verifyToken);
}

/** Allowlist check for DM senders (PSIDs). `*` allows everyone. */
export function isSenderAllowed(account: ResolvedMessengerAccount, senderId: string): boolean {
  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "open") return true;
  const allow = account.allowFrom.map((e) => e.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return allow.includes(senderId.trim());
}
