/**
 * Holds the plugin API object captured at `registerFull` time so that modules
 * which run outside the registration closure (e.g. deterministic escalation
 * from the inbound webhook path) can reach the host runtime.
 *
 * HARD RULE: no top-level `openclaw/*` imports. Tests inject a mock api via
 * `setPluginApi`.
 */
let pluginApi: unknown;

export function setPluginApi(api: unknown): void {
  pluginApi = api;
}

export function getPluginApi(): unknown {
  return pluginApi;
}
