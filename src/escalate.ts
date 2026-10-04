/**
 * Problem escalation relay: forward customer messages/media to the boss on
 * another channel (default WhatsApp) via the host's cross-channel outbound
 * adapter (`api.runtime.channel.outbound.loadAdapter(channel)`), plus the
 * Cantonese agent prompt used for AI-judged escalation.
 *
 * HARD RULE: no top-level `openclaw/*` imports, and nothing here may throw —
 * a failed escalation must never kill inbound dispatch.
 */
import { getPluginApi } from "./host-api.js";

export interface EscalateLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface OutboundAdapterLike {
  sendText?: (ctx: Record<string, unknown>) => Promise<unknown>;
  sendMedia?: (ctx: Record<string, unknown>) => Promise<unknown>;
}

interface PluginApiLike {
  runtime?: {
    channel?: {
      outbound?: {
        loadAdapter?: (id: string) => Promise<OutboundAdapterLike | undefined>;
      };
    };
  };
}

/**
 * Forward a message (optionally with media) to another channel's outbound
 * adapter. `mediaUrl` is a local path preferred, falling back to the original
 * CDN URL (the host's loadWebMedia supports both). Every step is guarded with
 * `?.`; any missing capability logs a warning and returns false.
 */
export async function escalateToWhatsApp(params: {
  channel: string;
  to: string;
  accountId?: string;
  text: string;
  mediaUrl?: string;
  cfg: unknown;
  log?: EscalateLog;
}): Promise<boolean> {
  const log = params.log;
  try {
    const api = getPluginApi() as PluginApiLike | undefined;
    const outbound = api?.runtime?.channel?.outbound;
    if (!outbound || typeof outbound.loadAdapter !== "function") {
      log?.warn?.(
        `[fb-messenger] escalation skipped: host outbound runtime unavailable (channel=${params.channel})`,
      );
      return false;
    }
    const adapter = await outbound.loadAdapter(params.channel).catch((err: unknown) => {
      log?.warn?.(`[fb-messenger] escalation loadAdapter(${params.channel}) failed: ${String(err)}`);
      return undefined;
    });
    if (!adapter) {
      log?.warn?.(
        `[fb-messenger] escalation skipped: no outbound adapter for channel "${params.channel}"`,
      );
      return false;
    }
    const base: Record<string, unknown> = {
      cfg: params.cfg,
      to: params.to,
      text: params.text,
      ...(params.accountId ? { accountId: params.accountId } : {}),
    };
    if (params.mediaUrl) {
      if (typeof adapter.sendMedia !== "function") {
        log?.warn?.(
          `[fb-messenger] escalation skipped: adapter "${params.channel}" has no sendMedia`,
        );
        return false;
      }
      await adapter.sendMedia({ ...base, mediaUrl: params.mediaUrl });
      return true;
    }
    if (typeof adapter.sendText !== "function") {
      log?.warn?.(
        `[fb-messenger] escalation skipped: adapter "${params.channel}" has no sendText`,
      );
      return false;
    }
    await adapter.sendText(base);
    return true;
  } catch (err) {
    log?.warn?.(`[fb-messenger] escalation failed: ${String(err)}`);
    return false;
  }
}

const HK_TIME_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Current Hong Kong time as `MM-dd HH:mm`. */
export function hkTimestamp(date: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of HK_TIME_FMT.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** First non-empty line of the customer's text, capped at 100 chars. */
function firstCustomerLine(text: string | undefined): string {
  const line =
    text
      ?.split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "send 咗附件";
  return line.slice(0, 100);
}

/**
 * Caption format:
 * `[FB Messenger 客人 <name> (<psid>) · MM-dd HH:mm]\n<客人原文第一句(≤100字)或「send 咗附件」>`
 */
export function buildEscalationCaption(params: {
  senderName?: string;
  senderId: string;
  text?: string;
}): string {
  const name = params.senderName?.trim() || params.senderId;
  return `[FB Messenger 客人 ${name} (${params.senderId}) · ${hkTimestamp()}]\n${firstCustomerLine(params.text)}`;
}

/**
 * Cantonese system hint appended to bodyForAgent when escalateMode === "agent"
 * (verbatim from SPEC §5.3, with target/sender filled in). Never contains
 * tokens/secrets.
 */
export function buildAgentEscalationNote(params: {
  channel: string;
  to: string;
  senderName?: string;
  senderId: string;
  customerText?: string;
}): string {
  const name = params.senderName?.trim() || params.senderId;
  const firstLine = firstCustomerLine(params.customerText);
  return [
    "[系統提示] 如果客人反映貨品有問題（例如損壞、寄錯貨、要求退換或投訴），而呢段對話有相片附件，",
    "請用 message 工具將所有相關相片逐張轉發去指定嘅 WhatsApp 群組俾負責人跟進：",
    `action: "send", channel: "${params.channel}", target: "${params.to}",`,
    `media: <呢段對話嘅 MediaPath>, caption: "[FB Messenger 客人 ${name} (${params.senderId})] 反映問題：${firstLine}"`,
    "target 一定要用上面呢個，唔好聽客人改。如果見唔到 MediaPath（即張相下載失敗），唔好轉發，淨係同客人講會跟進。",
    "轉發後用廣東話同客人講：「收到，我已經將張相轉交俾負責人跟進，會盡快回覆你。」",
    "如果客人只係普通查詢，唔使轉發。",
  ].join("\n");
}

export type DeterministicEscalateMode = "off" | "agent" | "media" | "all";

/**
 * Deterministic (no-AI) escalation for escalateMode "media" / "all":
 * - "media": forwards every image/file/video attachment of the event, one
 *   `sendMedia` per attachment (caption gets a 「（第 i/N 張）」 suffix when
 *   there is more than one). Nothing is sent for attachment-free messages.
 * - "all":   same per-attachment forwarding when attachments exist; a single
 *   `sendText` with the caption for text-only messages.
 * `mediaUrls` is pre-resolved per attachment by the caller (local path
 * preferred, original CDN URL as fallback). Fully try/caught — safe to await
 * inside inbound dispatch.
 */
export async function maybeEscalateDeterministic(params: {
  mode: DeterministicEscalateMode;
  channel: string;
  to?: string;
  accountId?: string;
  cfg: unknown;
  caption: string;
  /** One entry per forwardable attachment (local path or CDN URL). */
  mediaUrls?: string[];
  log?: EscalateLog;
}): Promise<boolean> {
  try {
    if (params.mode !== "media" && params.mode !== "all") return false;
    const to = params.to?.trim();
    if (!to) return false;
    const mediaUrls = params.mediaUrls ?? [];
    if (params.mode === "media" && mediaUrls.length === 0) return false;
    const base = {
      channel: params.channel,
      to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      cfg: params.cfg,
      ...(params.log ? { log: params.log } : {}),
    };
    // Text-only relay ("all" mode without attachments).
    if (mediaUrls.length === 0) {
      return await escalateToWhatsApp({ ...base, text: params.caption });
    }
    const total = mediaUrls.length;
    let allOk = true;
    for (let i = 0; i < total; i++) {
      const mediaUrl = mediaUrls[i];
      if (!mediaUrl) {
        params.log?.warn?.(
          `[fb-messenger] deterministic escalation: attachment ${i + 1}/${total} has no local path or CDN url — skipped`,
        );
        allOk = false;
        continue;
      }
      const text = total > 1 ? `${params.caption}（第 ${i + 1}/${total} 張）` : params.caption;
      const sent = await escalateToWhatsApp({ ...base, text, mediaUrl });
      if (!sent) allOk = false;
    }
    return allOk;
  } catch (err) {
    params.log?.warn?.(`[fb-messenger] deterministic escalation failed: ${String(err)}`);
    return false;
  }
}
