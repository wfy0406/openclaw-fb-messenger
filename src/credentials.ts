import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { CHANNEL_ID } from "./config.js";

/** Shape of the persisted Page credential. */
export interface PersistedPageCredential {
  pageId: string;
  pageAccessToken: string;
  /** ISO timestamp of when it was derived (for diagnostics). */
  derivedAt?: string;
}

/**
 * Resolve OpenClaw's state directory. The gateway exports OPENCLAW_HOME /
 * OPENCLAW_STATE_DIR (both point at `<project>/.openclaw`); fall back to cwd.
 */
function stateDir(): string {
  return (
    process.env.OPENCLAW_HOME ||
    process.env.OPENCLAW_STATE_DIR ||
    join(process.cwd(), ".openclaw")
  );
}

/** `<state>/credentials/fb-messenger/credentials[-<account>].json` (mirrors the zalouser layout). */
function credentialPath(accountId: string): string {
  const file =
    !accountId || accountId === "default" ? "credentials.json" : `credentials-${accountId}.json`;
  return join(stateDir(), "credentials", CHANNEL_ID, file);
}

/** Read the persisted permanent Page credential, or null if absent/unreadable. */
export async function loadPageCredential(accountId: string): Promise<PersistedPageCredential | null> {
  try {
    const raw = await fs.readFile(credentialPath(accountId), "utf8");
    const parsed = JSON.parse(raw) as PersistedPageCredential;
    if (parsed && parsed.pageAccessToken) return parsed;
  } catch {
    /* not present yet */
  }
  return null;
}

/** Persist the permanent Page credential so future startups don't re-derive. */
export async function savePageCredential(
  accountId: string,
  cred: PersistedPageCredential,
): Promise<void> {
  const path = credentialPath(accountId);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ ...cred, derivedAt: cred.derivedAt }, null, 2), "utf8");
  } catch {
    /* best-effort: persistence failure shouldn't crash startup */
  }
}

/** Remove a stale/invalid persisted credential so the next startup re-derives. */
export async function clearPageCredential(accountId: string): Promise<void> {
  try {
    await fs.rm(credentialPath(accountId), { force: true });
  } catch {
    /* ignore */
  }
}
