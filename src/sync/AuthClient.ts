import { Platform } from "obsidian";
import { PROTOCOL_VERSION, type DeviceStartRequest, type DeviceStartResponse, type DevicePollResponse, type HealthResponse, type MeResponse } from "@websync/shared";
import { t } from "../i18n";
import { apiRequest } from "./httpClient.js";
import { evaluateCompat } from "./compat.js";

/**
 * Wraps the /auth/* endpoints. Holds no session state itself - the caller
 * (SettingsTab / main.ts) persists the resulting session token into plugin
 * settings and passes it back in for authenticated calls (logout, getMe).
 *
 * Login is device-pairing based (like `gh auth login --web`), not manual
 * username/password/2FA entry: `startDeviceAuth` asks the server for a short
 * pairing code + a browser URL, and `pollDeviceAuth` is polled until the
 * user approves (or denies/lets it expire) on the web panel, where they're
 * already logged in and also pick which vault to link. See SettingsTab.ts
 * for the polling loop.
 */
export class AuthClient {
  constructor(private readonly getServerUrl: () => string) {}

  private get serverUrl(): string {
    const url = this.getServerUrl();
    if (!url) throw new Error("Syncstone: Server-URL ist nicht konfiguriert.");
    return url;
  }

  /**
   * Refuses to pair with a server that speaks another protocol / crypto format version, instead of failing later in
   * confusing ways. A server that does not report a version (older hosted builds) is let through.
   */
  async assertCompatibleServer(): Promise<void> {
    const health = await apiRequest<Partial<HealthResponse> | undefined>(this.serverUrl, { path: "/health" });
    const server = health?.protocolVersion;
    const { state } = evaluateCompat(health, "0.0.0");
    if (server === undefined || state === "ok") return;
    const which = state === "plugin-outdated" ? t("p.protocolPlugin") : t("p.protocolServer");
    throw new Error(t("p.protocolMismatch", { server, plugin: PROTOCOL_VERSION, which }));
  }

  /**
   * `clientType` is derived from `Platform.isMobile` (from the `obsidian`
   * API), not from any build-time flag - the same bundled main.js runs on
   * both platforms, so this has to be a runtime check.
   */
  async startDeviceAuth(deviceName: string): Promise<DeviceStartResponse> {
    await this.assertCompatibleServer();
    const clientType = Platform.isMobile ? "plugin-mobile" : "plugin-desktop";
    const resolvedDeviceName = deviceName.trim() || `Syncstone Plugin (${Platform.isMobile ? "Mobile" : "Desktop"})`;
    const payload: DeviceStartRequest = { clientType, deviceName: resolvedDeviceName };
    return apiRequest<DeviceStartResponse>(this.serverUrl, {
      method: "POST",
      path: "/auth/device/start",
      json: payload,
    });
  }

  /**
   * Polls the pairing status. The server's response is single-use: once it
   * returns `approved`, `denied`, or `expired`, a subsequent poll with the
   * same `pollToken` 404s - the caller MUST stop polling as soon as it sees
   * one of those terminal statuses (see SettingsTab.ts's polling loop). A
   * 404 (thrown here as a SyncstoneApiError with status 404) is also terminal
   * and should be treated as a failed/expired attempt.
   */
  async pollDeviceAuth(pollToken: string): Promise<DevicePollResponse> {
    const query = new URLSearchParams({ pollToken });
    return apiRequest<DevicePollResponse>(this.serverUrl, {
      path: `/auth/device/poll?${query.toString()}`,
    });
  }

  async logout(sessionToken: string): Promise<void> {
    await apiRequest<void>(this.serverUrl, {
      method: "POST",
      path: "/auth/logout",
      token: sessionToken,
    });
  }

  async getMe(sessionToken: string): Promise<MeResponse> {
    return apiRequest<MeResponse>(this.serverUrl, {
      path: "/auth/me",
      token: sessionToken,
    });
  }
}
