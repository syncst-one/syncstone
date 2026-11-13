/**
 * Minimal HTTP client shared by AuthClient and RemoteApiClient.
 *
 * Uses Obsidian's `requestUrl()`, NOT the global `fetch`. Obsidian's
 * Electron renderer applies a Content-Security-Policy that can block (or
 * behave inconsistently for) raw `fetch()` calls to arbitrary external
 * hosts/IPs - this is a well-known Obsidian plugin gotcha, and exactly what
 * caused "Failed to fetch"/inconsistent errors when this client used `fetch`
 * against a LAN server. `requestUrl` goes through Obsidian's own request
 * layer instead of the page's fetch/CORS/CSP stack and is the officially
 * recommended way for plugins to make network requests - it works
 * identically on desktop (Electron) and mobile (Capacitor).
 *
 * `requestUrl` only accepts a `string | ArrayBuffer` body (no FormData), so
 * the multipart/form-data body for the file-upload endpoint is constructed
 * by hand in `buildMultipartFormData` below.
 */
import { t } from "../i18n/index.js";
import { requestUrl } from "obsidian";
import { currentLocale } from "../i18n";

/** A transfer that was stopped on purpose (the file was deleted while it was on its way): not an error to report. */
export class TransferCancelled extends Error {
  constructor() {
    super("transfer cancelled");
    this.name = "TransferCancelled";
  }
}

export class SyncstoneApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
    /** `PUT /vaults/1a2b3c4d…/files/…`: which request failed, for the sync log. */
    public readonly request?: string,
  ) {
    super(message);
    this.name = "SyncstoneApiError";
  }
}

export interface MultipartPart {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface RequestOptions {
  method?: string;
  path: string;
  /** Session token to send as `Authorization: Bearer <token>`. Omit for unauthenticated endpoints. */
  token?: string | null;
  /** JSON-serializable request body. Sets Content-Type: application/json. Mutually exclusive with `multipart`. */
  json?: unknown;
  /** Multipart/form-data parts (e.g. file upload). Mutually exclusive with `json`. */
  multipart?: MultipartPart[];
  /** Raw binary body (one chunk of a chunked upload), sent as application/octet-stream. */
  raw?: Uint8Array;
  /** Extra request headers (e.g. `Range`). */
  headers?: Record<string, string>;
}

/** `METHOD /path` with ids cut short - enough to tell the endpoint apart in the log. */
function describeRequest(options: RequestOptions): string {
  const path = options.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => `${id.slice(0, 8)}…`);
  return `${options.method ?? "GET"} ${path}`;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function randomBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `----SyncstoneBoundary${hex}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Hand-rolled multipart/form-data encoder - byte-level, so binary parts (encrypted blobs) survive intact. */
function buildMultipartFormData(parts: MultipartPart[]): { contentType: string; body: ArrayBuffer } {
  const boundary = randomBoundary();
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
      `Content-Type: ${part.contentType}\r\n\r\n`;
    chunks.push(encoder.encode(header));
    chunks.push(part.data);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return { contentType: `multipart/form-data; boundary=${boundary}`, body: toArrayBuffer(combined) };
}

interface RawResponse {
  status: number;
  arrayBuffer: ArrayBuffer;
  text: string;
}

async function doRequest(serverUrl: string, options: RequestOptions): Promise<RawResponse> {
  if (!serverUrl) throw new SyncstoneApiError("Syncstone: Server-URL ist nicht konfiguriert.", 0);
  const url = `${trimTrailingSlash(serverUrl)}${options.path}`;
  const headers: Record<string, string> = { "Accept-Language": currentLocale(), ...options.headers };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  let body: string | ArrayBuffer | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.multipart) {
    const built = buildMultipartFormData(options.multipart);
    headers["Content-Type"] = built.contentType;
    body = built.body;
  } else if (options.raw) {
    headers["Content-Type"] = "application/octet-stream";
    body = toArrayBuffer(options.raw);
  } else if ((options.method ?? "GET") !== "GET") {
    // A request without a body (deleting a file, for example): Obsidian on Android would send it with the content type
    // of an empty form, which a server may refuse (415). An empty JSON object says clearly that there is nothing in it.
    headers["Content-Type"] = "application/json";
    body = "{}";
  }

  try {
    const response = await requestUrl({
      url,
      method: options.method ?? "GET",
      headers,
      // Obsidian's own field as well as the header: the mobile HTTP layer goes by this one.
      contentType: headers["Content-Type"],
      body,
      throw: false,
    });
    return { status: response.status, arrayBuffer: response.arrayBuffer, text: response.text };
  } catch (err) {
    throw new SyncstoneApiError(t("p.http.network", { url, error: (err as Error).message }), 0, undefined, describeRequest(options));
  }
}

function parseErrorBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function throwIfNotOk(response: RawResponse, options: RequestOptions): void {
  const path = options.path;
  if (response.status >= 200 && response.status < 300) return;
  const errorBody = parseErrorBody(response.text);
  const message =
    (errorBody as { message?: string; error?: string } | undefined)?.message ??
    (errorBody as { message?: string; error?: string } | undefined)?.error ??
    t("p.http.status", { path, status: response.status });
  throw new SyncstoneApiError(message, response.status, errorBody, describeRequest(options));
}

/** Performs a request and parses a JSON response (or returns undefined for empty/non-JSON responses). */
export async function apiRequest<T>(serverUrl: string, options: RequestOptions): Promise<T> {
  const response = await doRequest(serverUrl, options);
  throwIfNotOk(response, options);

  if (response.status === 204 || !response.text) return undefined as T;
  try {
    return JSON.parse(response.text) as T;
  } catch {
    return undefined as T;
  }
}

/** Performs a request and returns the raw response body as bytes (e.g. an encrypted file blob). */
export async function apiRequestBinary(serverUrl: string, options: RequestOptions): Promise<Uint8Array> {
  const response = await doRequest(serverUrl, options);
  throwIfNotOk(response, options);
  return new Uint8Array(response.arrayBuffer);
}
