import { MIN_SERVER_PROTOCOL_VERSION, PROTOCOL_VERSION, type HealthResponse } from "@websync/shared";

/** Where the public release notes of the plugin live ("What's new"). */
export const RELEASES_URL = "https://github.com/syncst-one/syncstone-plugin/releases";

/**
 * Whether this plugin and the server it talks to fit together:
 *  - `ok`: they do (also when the server could not be asked: offline is no reason to stop);
 *  - `plugin-outdated`: the server needs a newer plugin. Sync pauses until the plugin is updated;
 *  - `server-outdated`: the plugin needs a newer server. Sync pauses until the server is updated.
 */
export type CompatState = "ok" | "plugin-outdated" | "server-outdated";

export interface CompatInfo {
  state: CompatState;
  /** A newer released plugin version than this one, or null. */
  updateAvailable: string | null;
}

export const COMPAT_UNKNOWN: CompatInfo = { state: "ok", updateAvailable: null };

/** Compares the server's `/health` answer with this plugin. */
export function evaluateCompat(health: Partial<HealthResponse> | undefined, pluginVersion: string): CompatInfo {
  if (!health || typeof health.protocolVersion !== "number") return COMPAT_UNKNOWN; // older server without this information
  let state: CompatState = "ok";
  if (typeof health.minClientProtocolVersion === "number" && PROTOCOL_VERSION < health.minClientProtocolVersion) state = "plugin-outdated";
  else if (health.protocolVersion < MIN_SERVER_PROTOCOL_VERSION) state = "server-outdated";
  else if (health.minClientProtocolVersion === undefined && health.protocolVersion > PROTOCOL_VERSION) {
    // A server that does not say what it still accepts but is ahead of us: the old rule (exact match) applies.
    state = "plugin-outdated";
  }
  const latest = typeof health.latestPluginVersion === "string" ? health.latestPluginVersion : "";
  const updateAvailable = latest && compareVersions(latest, pluginVersion) > 0 ? latest : null;
  return { state, updateAvailable };
}

/**
 * Semantic version order: 0.2.21 < 0.3.0-beta.1 < 0.3.0-beta.2 < 0.3.0. Returns <0, 0 or >0. Anything that is not a
 * version counts as 0.0.0, so a strange value never produces an update hint by itself.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length; // a release beats its pre-releases
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx - ny;
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parseVersion(version: string): { core: [number, number, number]; pre: string[] } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return { core: [0, 0, 0], pre: [] };
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}
