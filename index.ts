import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { messengerPlugin } from "./src/channel.js";
import { handleMessengerWebhook, WEBHOOK_PATH } from "./src/webhook.js";
import { setPluginApi } from "./src/host-api.js";
import { cleanupInboundMedia } from "./src/media.js";

/**
 * Full channel entry. `defineChannelPluginEntry` registers the `fb-messenger`
 * channel capability; `registerFull` additionally mounts the public Meta
 * webhook on the gateway HTTP surface (`auth: "plugin"` — the plugin verifies
 * the X-Hub-Signature-256 itself, so the gateway must not gate it).
 */
export default defineChannelPluginEntry({
  id: "fb-messenger",
  name: "Facebook Messenger",
  description: "Facebook Page Messenger via webhook + Graph API (AI handled by the OpenClaw agent).",
  plugin: messengerPlugin,
  registerFull(api) {
    // Capture the plugin api so deterministic escalation can reach
    // api.runtime.channel.outbound from the webhook path.
    setPluginApi(api);
    // Best-effort startup housekeeping of downloaded inbound media (>48h).
    void cleanupInboundMedia().catch(() => {});
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      handler: handleMessengerWebhook,
    });
  },
});
