/**
 * Facebook Messenger webhook payload shapes (subset we consume) and the
 * loosely-typed channel-runtime surface we lean on for AI dispatch.
 *
 * The full Messenger Platform webhook reference:
 * https://developers.facebook.com/docs/messenger-platform/reference/webhook-events
 */

/** A single inbound messaging event from Meta (the part we care about). */
export interface MessengerMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Array<{
      type?: string;
      payload?: {
        url?: string;
        /** Present on `location` attachments. */
        coordinates?: { lat?: number; long?: number };
      };
    }>;
  };
  postback?: { title?: string; payload?: string; mid?: string };
}

/** One webhook `entry` — `id` is the Page ID that received the events. */
export interface MessengerWebhookEntry {
  id: string;
  time?: number;
  messaging?: MessengerMessagingEvent[];
}

/** Top-level webhook POST body for the `page` object. */
export interface MessengerWebhookBody {
  object?: string;
  entry?: MessengerWebhookEntry[];
}

/**
 * Minimal view of the host `channelRuntime` surface we use at runtime.
 *
 * The plugin SDK types `ChannelGatewayContext.channelRuntime` loosely
 * (`{ runtimeContexts; [key: string]: unknown }`), but the gateway supplies the
 * full runtime at startup. We pin only the `reply` dispatch helper documented
 * for external channel plugins.
 */
export interface AgentRoute {
  agentId: string;
  accountId?: string;
  sessionKey: string;
}

export interface ChannelReplyDispatchSurface {
  routing: {
    resolveAgentRoute: (params: {
      cfg: unknown;
      channel: string;
      accountId: string;
      peer: { kind: string; id: string };
    }) => AgentRoute;
  };
  session: {
    resolveStorePath: (store: unknown, opts: { agentId: string }) => string;
    recordInboundSession: unknown;
  };
  inbound: {
    buildContext: (params: Record<string, unknown>) => unknown;
    dispatchReply: (params: Record<string, unknown>) => Promise<unknown>;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: unknown;
  };
  [key: string]: unknown;
}

/** Reply payload streamed by the agent into our `deliver` callback. */
export interface OutboundReplyPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  [key: string]: unknown;
}
