/**
 * Inbound media pipeline: attachment extraction, allowlisted download to local
 * disk, Cantonese-first audio transcription, and Cantonese labels for the agent.
 *
 * HARD RULE: no top-level `openclaw/*` imports in this module — smoke tests must
 * run without the host installed. The SDK transcription entry point
 * (`openclaw/plugin-sdk/media-understanding-runtime`) is dynamically imported
 * and every failure degrades gracefully (returns undefined / null, never throws).
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { MessengerMessagingEvent } from "./types.js";

// ── attachment extraction ────────────────────────────────────────────────────

export type ExtractedAttachmentType =
  | "image"
  | "audio"
  | "video"
  | "file"
  | "location"
  | "fallback"
  | "sticker"
  | "unknown";

export interface ExtractedAttachment {
  type: ExtractedAttachmentType;
  /** payload.url — present for image/audio/video/file (and usually fallback). */
  url?: string;
  /** Present for location attachments. */
  coordinates?: { lat: number; long: number };
}

/**
 * Local mirror of the SDK's `InboundMediaFacts` (kept local so this module
 * never imports `openclaw/*`; `buildContext` accepts these structurally).
 */
export interface InboundMediaFact {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  transcribed?: boolean;
  messageId?: string;
}

/**
 * Pull attachments out of a Messenger event. Echo events never reach this
 * (blocked upstream). image/audio/video/file require `payload.url`; sticker
 * with `payload.url` downloads like an image (without it, it's a pure label);
 * location reads `payload.coordinates`; fallback (link share) is treated as
 * text. During Meta's transition period the same sticker may arrive twice —
 * once as `image` and once as `sticker` pointing at the same URL — so results
 * are deduped by URL, preferring the sticker entry (labelled 「張貼圖」).
 */
export function extractAttachments(event: MessengerMessagingEvent): ExtractedAttachment[] {
  const raw = event.message?.attachments ?? [];
  const out: ExtractedAttachment[] = [];
  for (const a of raw) {
    const t = (a.type ?? "").trim().toLowerCase();
    const url = a.payload?.url?.trim() || undefined;
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
  // Dedupe by URL: keep the first occurrence, but let a sticker replace an
  // earlier non-sticker entry so the 「張貼圖」 semantics win.
  const indexByUrl = new Map<string, number>();
  const deduped: ExtractedAttachment[] = [];
  for (const att of out) {
    if (!att.url) {
      deduped.push(att);
      continue;
    }
    const existing = indexByUrl.get(att.url);
    if (existing === undefined) {
      indexByUrl.set(att.url, deduped.length);
      deduped.push(att);
    } else if (att.type === "sticker" && deduped[existing]?.type !== "sticker") {
      deduped[existing] = att;
    }
  }
  return deduped;
}

// ── state dir (mirrors credentials.ts) ───────────────────────────────────────

/** Resolve OpenClaw's state directory (OPENCLAW_HOME → OPENCLAW_STATE_DIR → cwd/.openclaw). */
export function stateDir(): string {
  return (
    process.env.OPENCLAW_HOME ||
    process.env.OPENCLAW_STATE_DIR ||
    join(process.cwd(), ".openclaw")
  );
}

// ── download ─────────────────────────────────────────────────────────────────

export interface DownloadedAttachment {
  path: string;
  contentType: string;
  sizeBytes: number;
}

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OTHER_MAX_BYTES = 25 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

const ALLOWED_DOWNLOAD_HOSTS = ["facebook.com", "fbcdn.net", "fbsbx.com", "fb.com"];

/** Hostname allowlist: exact match or any subdomain of the allowed hosts. */
function isAllowedDownloadHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
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
  "audio/mp3": "mp3",
};

function baseContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extForContentType(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[baseContentType(contentType)] ?? "bin";
}

function defaultContentType(type: ExtractedAttachmentType): string {
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

/** File names stay inside [a-zA-Z0-9._-] (SPEC §8). */
function sanitizeFileBase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "attachment";
}

/**
 * Download an attachment to `<dir>/<fileBase>.<ext>`. Only Facebook-owned
 * hosts are fetched (and redirects landing off-allowlist are discarded).
 * Failures return null — one bad attachment must not break the others.
 */
export async function downloadAttachment(
  att: ExtractedAttachment,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    dir: string;
    fileBase: string;
    /** Test seam: defaults to globalThis.fetch. */
    fetchFn?: typeof fetch;
  },
): Promise<DownloadedAttachment | null> {
  const url = att.url?.trim();
  if (!url || !isAllowedDownloadHost(url)) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchFn(url, { redirect: "follow", signal: controller.signal });
    // Redirects are followed, but the final URL must stay on the allowlist.
    if (!isAllowedDownloadHost(res.url || url)) return null;
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > opts.maxBytes) return null;
    const headerType = baseContentType(res.headers.get("content-type") ?? "");
    const contentType = headerType || defaultContentType(att.type);
    const path = join(opts.dir, `${sanitizeFileBase(opts.fileBase)}.${extForContentType(contentType)}`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, buf);
    return { path, contentType, sizeBytes: buf.byteLength };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── audio transcription (dynamic SDK import + daily cap) ─────────────────────

export const TRANSCRIBE_PROMPT = "廣東話/粵語語音訊息，逐字轉寫，保留口語。";
export const DEFAULT_TRANSCRIBE_DAILY_CAP = 200;

type TranscribeAudioFileFn = (params: {
  filePath: string;
  cfg: unknown;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  activeModel?: unknown;
  language?: string;
  prompt?: string;
}) => Promise<{ text: string | undefined; provider?: string; model?: string }>;

let transcribeFnOverride: TranscribeAudioFileFn | undefined;

/**
 * Test seam: inject (or clear, with undefined) the transcription function so
 * smoke tests don't need the host SDK installed.
 */
export function _setTranscribeFnForTest(fn: TranscribeAudioFileFn | undefined): void {
  transcribeFnOverride = fn;
}

async function loadTranscribeFn(): Promise<TranscribeAudioFileFn | undefined> {
  if (transcribeFnOverride) return transcribeFnOverride;
  try {
    const mod = (await import("openclaw/plugin-sdk/media-understanding-runtime")) as {
      transcribeAudioFile?: TranscribeAudioFileFn;
    };
    return typeof mod.transcribeAudioFile === "function" ? mod.transcribeAudioFile : undefined;
  } catch {
    return undefined; // host without the media-understanding runtime — degrade gracefully
  }
}

function transcribeCountPath(): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(stateDir(), "media", `transcribe-count-${day}.txt`);
}

async function readTranscribeCount(): Promise<number> {
  try {
    const raw = await fs.readFile(transcribeCountPath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function bumpTranscribeCount(): Promise<void> {
  try {
    const path = transcribeCountPath();
    const next = (await readTranscribeCount()) + 1;
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, String(next), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Transcribe a downloaded voice message. Any failure (missing SDK, over the
 * daily cap, empty result) returns undefined instead of throwing.
 */
export async function transcribeAudio(
  localPath: string,
  mime: string,
  opts: {
    cfg: unknown;
    language: string;
    workspaceDir?: string;
    dailyCap?: number;
    log?: { warn?: (msg: string) => void };
  },
): Promise<string | undefined> {
  try {
    const cap = opts.dailyCap ?? DEFAULT_TRANSCRIBE_DAILY_CAP;
    const used = await readTranscribeCount();
    if (used >= cap) {
      opts.log?.warn?.(
        `[fb-messenger] audio transcription daily cap reached (${used}/${cap}) — skipping`,
      );
      return undefined;
    }
    const fn = await loadTranscribeFn();
    if (!fn) {
      opts.log?.warn?.(
        "[fb-messenger] media-understanding runtime unavailable — skipping audio transcription",
      );
      return undefined;
    }
    const result = await fn({
      filePath: localPath,
      cfg: opts.cfg,
      mime,
      language: opts.language,
      ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      prompt: TRANSCRIBE_PROMPT,
    });
    const text = result?.text?.trim();
    // Only count successful transcriptions against the daily cap.
    if (text) await bumpTranscribeCount();
    return text || undefined;
  } catch (err) {
    opts.log?.warn?.(`[fb-messenger] audio transcription failed: ${String(err)}`);
    return undefined;
  }
}

// ── Cantonese labels for the agent ───────────────────────────────────────────

export const ATTACHMENT_LABELS: Record<ExtractedAttachmentType, string> = {
  image: "張圖片",
  audio: "段語音訊息",
  video: "段影片",
  file: "個檔案",
  location: "個位置",
  fallback: "條連結",
  sticker: "張貼圖",
  unknown: "個附件",
};

/** Measure-word-free labels for failure notes (e.g. 「圖片下載失敗…」). */
export const ATTACHMENT_LABELS_PLAIN: Record<ExtractedAttachmentType, string> = {
  image: "圖片",
  audio: "語音訊息",
  video: "影片",
  file: "檔案",
  location: "位置",
  fallback: "連結",
  sticker: "貼圖",
  unknown: "附件",
};

/** e.g. "1 張圖片、2 段語音訊息" */
export function describeAttachmentsZh(atts: ExtractedAttachment[]): string {
  const order: ExtractedAttachmentType[] = [];
  const counts = new Map<ExtractedAttachmentType, number>();
  for (const a of atts) {
    if (!counts.has(a.type)) order.push(a.type);
    counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  }
  return order.map((t) => `${counts.get(t)} ${ATTACHMENT_LABELS[t]}`).join("、");
}

// ── cleanup ──────────────────────────────────────────────────────────────────

export const DEFAULT_MEDIA_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Delete downloaded inbound media older than maxAgeMs. Best-effort. */
export async function cleanupInboundMedia(maxAgeMs = DEFAULT_MEDIA_MAX_AGE_MS): Promise<void> {
  try {
    const dir = join(stateDir(), "media", "inbound");
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const cutoff = Date.now() - maxAgeMs;
    for (const name of entries) {
      try {
        const path = join(dir, name);
        const st = await fs.stat(path);
        if (st.isFile() && st.mtimeMs < cutoff) await fs.rm(path, { force: true });
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* best-effort */
  }
}
