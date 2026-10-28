/** The Cloudinary calls the integration makes, over plain HTTPS: download the original, read its current version, upload the copy. */
import { VERSION } from "./version.ts";

export type CloudinaryAccount = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** API origin; change it only for a regional API host. */
  apiOrigin?: string;
};

export type UploadedAsset = {
  public_id: string;
  asset_id?: string;
  secure_url?: string;
};

/** `status` is the HTTP status, or 0 when Cloudinary couldn't be reached. */
export class CloudinaryError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** How long one download or upload may take. Cloudinary retries the notification if we give up. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Identifies this integration on every Cloudinary call, in the format Cloudinary asks partner
 * integrations to use for REST calls without one of its SDKs: `Cloudinary<name>/<version> (<platform> <version>)`.
 */
export const CLOUDINARY_USER_AGENT = `CloudinaryEtchv/${VERSION} (Node.js ${process.versions.node})`;

/** Escape `=` and `|`, which separate contextual metadata entries. */
export const contextValue = (value: string) => value.replace(/([=|])/g, "\\$1");

export class CloudinaryClient {
  private readonly account: CloudinaryAccount;
  private readonly fetcher: typeof fetch;
  constructor(account: CloudinaryAccount, fetcher: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_-]+$/.test(account.cloudName) || !account.apiKey || !account.apiSecret) {
      throw new Error("Invalid Cloudinary account configuration.");
    }
    this.account = account;
    this.fetcher = fetcher;
  }

  /** Run one request and read its body; a network failure or timeout becomes a retryable CloudinaryError. */
  private async call<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    try {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", CLOUDINARY_USER_AGENT);
      return await read(await this.fetcher(url, { ...init, headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }));
    } catch (error) {
      if (error instanceof CloudinaryError) throw error;
      throw new CloudinaryError(0, `Cloudinary request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private get origin() {
    return `${this.account.apiOrigin ?? "https://api.cloudinary.com"}/v1_1/${this.account.cloudName}`;
  }

  private get authorization() {
    return `Basic ${Buffer.from(`${this.account.apiKey}:${this.account.apiSecret}`).toString("base64")}`;
  }

  /** Download an asset's original bytes, refusing anything that isn't HTTPS or exceeds `maxBytes`. */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new CloudinaryError(400, "Expected an HTTPS asset URL.");
    const tooLarge = () => new CloudinaryError(413, "The asset is larger than Etchv accepts.");
    return this.call(url, {}, async (response) => {
      if (!response.ok) throw new CloudinaryError(response.status, `Download failed with HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw tooLarge();
      return bytes;
    });
  }

  /**
   * The current `version_id` of an uploaded image, or null once it's deleted. Uses the Upload API's
   * `explicit` method, which unlike the Admin API has no hourly limit. Called with no options it left
   * the asset's version, etag and version_id unchanged and sent no notification (observed, not documented).
   */
  async currentVersionId(publicId: string): Promise<string | null> {
    const body = new URLSearchParams({ public_id: publicId, type: "upload" });
    return this.call(`${this.origin}/image/explicit`, { method: "POST", headers: { Authorization: this.authorization }, body }, async (response) => {
      const result = (await response.json().catch(() => ({}))) as { version_id?: string; error?: { message?: string } };
      // Only Cloudinary's own JSON "not found" means deleted; an HTML 404 is a wrong API origin.
      if (response.status === 404 && result.error?.message) return null;
      if (!response.ok || typeof result.version_id !== "string") {
        throw new CloudinaryError(response.status, result.error?.message ?? `Version lookup failed with HTTP ${response.status}.`);
      }
      return result.version_id;
    });
  }

  /** Upload an image under the given public ID and parameters. */
  async uploadImage(
    file: Uint8Array,
    filename: string,
    params: Record<string, string>,
  ): Promise<UploadedAsset> {
    const form = new FormData();
    for (const [name, value] of Object.entries(params)) form.append(name, value);
    form.append("file", new Blob([file as Uint8Array<ArrayBuffer>]), filename);
    const init = { method: "POST", headers: { Authorization: this.authorization }, body: form };
    return this.call(`${this.origin}/image/upload`, init, async (response) => {
      const body = (await response.json().catch(() => ({}))) as UploadedAsset & { error?: { message?: string } };
      if (!response.ok) {
        throw new CloudinaryError(response.status, body.error?.message ?? `Upload failed with HTTP ${response.status}.`);
      }
      return body;
    });
  }
}
