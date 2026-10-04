import { CHANNEL_ID, isSenderAllowed } from "./config.js";
import {
  getUserProfile,
  sendMessengerText,
  sendMessengerMedia,
  sendMessengerMediaLocal,
  sendSenderAction,
  inferMessengerMediaType,
} from "./graph-api.js";
import {
  extractAttachments,
  downloadAttachment,
  transcribeAudio,
  describeAttachmentsZh,
  stateDir,
  ATTACHMENT_LABELS_PLAIN,
  IMAGE_MAX_BYTES,
  OTHER_MAX_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  type ExtractedAttachment,
  type ExtractedAttachmentType,
  type InboundMediaFact,
} from "./media.js";
import {
  buildAgentEscalationNote,
  buildEscalationCaption,
  maybeEscalateDeterministic,
} from "./escalate.js";
import { join } from "node:path";
import type { MessengerDispatchContext } from "./registry.js";
import type { MessengerMessagingEvent, OutboundReplyPayload } from "./types.js";

/** Pull the user-visible text out of a Messenger event (message or postback). */
function extractText(event: MessengerMessagingEvent): string | undefined {
  if (event.message?.is_echo) return undefined; // ignore our own echoes
  const fromMessage = event.message?.text?.trim();
  if (fromMessage) return fromMessage;
  const fromQuickReply = event.message?.quick_reply?.payload?.trim();
  if (fromQuickReply) return fromQuickReply;
  const fromPostback = event.postback?.payload?.trim() || event.postback?.title?.trim();
  return fromPostback || undefined;
}

// ── sender-name cache (24h TTL, in-memory, PSID-scoped) ─────────────────────
const NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const nameCache = new Map<string, { name?: string; ts: number }>();

async function getCachedSenderName(
  senderId: string,
  sendOpts: { pageAccessToken: string; graphApiVersion: string },
): Promise<string | undefined> {
  const hit = nameCache.get(senderId);
  if (hit && Date.now() - hit.ts < NAME_CACHE_TTL_MS) return hit.name;
  const profile = await getUserProfile(senderId, sendOpts).catch(() => null);
  const name = profile?.name;
  nameCache.set(senderId, { name, ts: Date.now() });
  return name;
}

/** Map our attachment types onto the SDK's InboundMediaFacts kind. */
function mediaKindFor(type: ExtractedAttachmentType): InboundMediaFact["kind"] {
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

function isDownloadable(type: ExtractedAttachmentType): boolean {
  return (
    type === "image" ||
    type === "audio" ||
    type === "video" ||
    type === "file" ||
    type === "sticker" ||
    type === "unknown"
  );
}

/** Attachment kinds that deterministic escalation forwards (image/video/document). */
function isForwardable(type: ExtractedAttachmentType): boolean {
  return type === "image" || type === "video" || type === "file" || type === "sticker";
}

// ── one-time escalation config warnings (S7) ─────────────────────────────────
let warnedInvalidEscalateMode = false;
let warnedEscalateOff = false;

function warnEscalateConfigOnce(
  account: MessengerDispatchContext["account"],
  log: MessengerDispatchContext["log"],
): void {
  if (account.escalateModeInvalid && !warnedInvalidEscalateMode) {
    warnedInvalidEscalateMode = true;
    log?.warn?.(
      "[fb-messenger] escalateMode 設定唔係合法值（off/agent/media/all），已當 off 處理",
    );
  }
  if (account.escalateTo && account.escalateMode === "off" && !warnedEscalateOff) {
    warnedEscalateOff = true;
    log?.warn?.("[fb-messenger] escalateTo 已設定但 escalateMode=off，分流未開");
  }
}

/**
 * Handle one inbound Messenger event: enforce DM policy, run the media
 * pipeline (download + transcribe), relay escalations, build the inbound
 * context (with top-level media facts), and hand it to the agent runtime
 * which streams the reply back through `deliver` → Graph API.
 */
export async function dispatchMessengerEvent(
  ctx: MessengerDispatchContext,
  event: MessengerMessagingEvent,
): Promise<void> {
  const { account, cfg, channelRuntime, log } = ctx;

  // Echoes can carry attachments too — drop them before anything else.
  if (event.message?.is_echo) return;

  const senderId = event.sender?.id?.trim();
  if (!senderId) return;

  const text = extractText(event);
  const attachments = extractAttachments(event);
  if (!text && attachments.length === 0) return; // genuinely empty event

  if (!isSenderAllowed(account, senderId)) {
    log?.info?.(`[fb-messenger] drop message from ${senderId} (dmPolicy=${account.dmPolicy})`);
    return;
  }

  warnEscalateConfigOnce(account, log);

  const sendOpts = {
    pageAccessToken: account.pageAccessToken,
    graphApiVersion: account.graphApiVersion,
  };

  // Best-effort: mark seen + typing while the agent thinks.
  void sendSenderAction(senderId, "mark_seen", sendOpts).catch(() => {});
  void sendSenderAction(senderId, "typing_on", sendOpts).catch(() => {});

  const senderName = await getCachedSenderName(senderId, sendOpts);
  const messageId = event.message?.mid || event.postback?.mid || `${event.timestamp ?? ""}`;

  // ── media pipeline (skipped when mediaEnabled === false) ──
  const mediaFacts: InboundMediaFact[] = [];
  const attachmentNotes: string[] = [];
  // Per-attachment relay targets for deterministic escalation (local path
  // preferred, original CDN URL as fallback), in attachment order.
  const escalationMediaUrls: string[] = [];

  interface AttachmentResult {
    fact?: InboundMediaFact;
    note?: string;
    escalateUrl?: string;
    escalateWarn?: string;
  }

  const processAttachment = async (
    att: ExtractedAttachment,
    index: number,
  ): Promise<AttachmentResult> => {
    if (att.type === "sticker" && !att.url) {
      return { note: "[貼圖]" }; // sticker without a URL: pure label, no download
    }
    if (isDownloadable(att.type)) {
      const dir = join(stateDir(), "media", "inbound");
      const dl = await downloadAttachment(att, {
        maxBytes: att.type === "image" || att.type === "sticker" ? IMAGE_MAX_BYTES : OTHER_MAX_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        dir,
        fileBase: `${messageId}-${index}`,
      });
      // Deterministic escalation relays image/video/document kinds; when the
      // download failed we fall back to the original CDN url.
      const escalateUrl = isForwardable(att.type) ? (dl?.path ?? att.url) : undefined;
      const escalateWarn =
        isForwardable(att.type) && !escalateUrl
          ? `[fb-messenger] escalation: attachment ${index + 1} (${att.type}) has no local path or CDN url — skipped`
          : undefined;
      if (!dl) {
        return {
          note: `[${ATTACHMENT_LABELS_PLAIN[att.type]}下載失敗，你睇唔到內容，可以叫客人描述或者再 send 一次]`,
          ...(escalateUrl ? { escalateUrl } : {}),
          ...(escalateWarn ? { escalateWarn } : {}),
        };
      }
      const fact: InboundMediaFact = {
        path: dl.path,
        ...(att.url ? { url: att.url } : {}),
        contentType: dl.contentType,
        kind: mediaKindFor(att.type),
        messageId,
      };
      let note: string | undefined;
      if (att.type === "audio" && account.audioTranscriptionEnabled !== false) {
        const transcript = await transcribeAudio(dl.path, dl.contentType, {
          cfg,
          language: account.audioLanguage,
          dailyCap: account.audioTranscriptionDailyCap,
          ...(log ? { log } : {}),
        });
        if (transcript) {
          fact.transcribed = true;
          note = `[語音訊息轉寫] ${transcript}`;
        } else {
          note = "[語音轉寫唔成功，你聽唔到內容 — 請客人打字再講一次，或者講返重點]";
        }
      }
      return {
        fact,
        ...(note ? { note } : {}),
        ...(escalateUrl ? { escalateUrl } : {}),
        ...(escalateWarn ? { escalateWarn } : {}),
      };
    }
    if (att.type === "location" && att.coordinates) {
      return {
        note: `[位置] https://www.google.com/maps?q=${att.coordinates.lat},${att.coordinates.long}`,
      };
    }
    if (att.type === "fallback") {
      return att.url ? { note: `[連結] ${att.url}` } : {};
    }
    return {};
  };

  if (attachments.length > 0) {
    if (account.mediaEnabled !== false) {
      // Download (and transcribe) all attachments in parallel; results are
      // re-assembled in attachment order so facts/notes stay deterministic.
      const results = await Promise.all(attachments.map((att, i) => processAttachment(att, i)));
      for (const r of results) {
        if (!r) continue;
        if (r.fact) mediaFacts.push(r.fact);
        if (r.note) attachmentNotes.push(r.note);
        if (r.escalateUrl) escalationMediaUrls.push(r.escalateUrl);
        if (r.escalateWarn) log?.warn?.(r.escalateWarn);
      }
    } else {
      attachmentNotes.push("[老闆未開啟圖片功能，你睇唔到附件]");
    }
  }

  // ── compose bodies ──
  const baseText = text ?? `[客人 send 咗 ${describeAttachmentsZh(attachments)}]`;
  const escalationNote =
    account.escalateMode === "agent" && account.escalateTo
      ? buildAgentEscalationNote({
          channel: account.escalateChannel,
          to: account.escalateTo,
          ...(senderName ? { senderName } : {}),
          senderId,
          ...(text ? { customerText: text } : {}),
        })
      : undefined;
  const bodyForAgent = [baseText, ...attachmentNotes, ...(escalationNote ? [escalationNote] : [])].join(
    "\n",
  );

  // Resolve the agent route + session for this peer (gives agentId + sessionKey).
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: senderId },
  });
  const cfgSession = (cfg as { session?: { store?: unknown } }).session;
  const storePath = channelRuntime.session.resolveStorePath(cfgSession?.store, {
    agentId: route.agentId,
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
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: `${CHANNEL_ID}:${senderId}`,
      originatingTo: `${CHANNEL_ID}:${senderId}`,
    },
    message: {
      body: baseText,
      bodyForAgent,
      rawBody: baseText,
      commandBody: text ?? "",
    },
    // Top-level media — the SDK spreads MediaPath/MediaUrl/MediaType/... itself.
    media: mediaFacts.length ? mediaFacts : undefined,
  });

  // ── deterministic escalation (escalateMode "media" / "all") ──
  // Awaited (fully try/caught inside) so typing_off in `finally` comes after it.
  // Every forwardable attachment is relayed individually; the Messenger
  // accountId is never passed to the other channel's adapter — only an
  // explicitly configured escalateAccountId is.
  await maybeEscalateDeterministic({
    mode: account.escalateMode,
    channel: account.escalateChannel,
    ...(account.escalateTo ? { to: account.escalateTo } : {}),
    ...(account.escalateAccountId ? { accountId: account.escalateAccountId } : {}),
    cfg,
    caption: buildEscalationCaption({
      ...(senderName ? { senderName } : {}),
      senderId,
      ...(text ? { text } : {}),
    }),
    mediaUrls: escalationMediaUrls,
    ...(log ? { log } : {}),
  });

  const deliver = async (payload: OutboundReplyPayload): Promise<unknown> => {
    const urls = [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])];
    for (const u of urls) {
      const target = u.trim();
      if (!target) continue;
      const mediaSendOpts = { ...sendOpts, mediaType: inferMessengerMediaType(target) };
      const r = /^https?:\/\//i.test(target)
        ? await sendMessengerMedia(senderId, target, mediaSendOpts)
        : await sendMessengerMediaLocal(senderId, target, mediaSendOpts);
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
      dispatchReplyWithBufferedBlockDispatcher:
        channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
    });
  } catch (err) {
    log?.error?.(`[fb-messenger] dispatch failed for ${senderId}: ${String(err)}`);
  } finally {
    void sendSenderAction(senderId, "typing_off", sendOpts).catch(() => {});
  }
}
