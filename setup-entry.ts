import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { messengerPlugin } from "./src/channel.js";

/** Lightweight setup entry used during onboarding (avoids pulling runtime code). */
export default defineSetupPluginEntry(messengerPlugin);
