/** Shared API contract for Etchv automation connectors. No credentials are logged. */
export type Media = "images" | "documents" | "videos";
export type Operation = "embed" | "detect";
/** Processing hardware. CPU is the API default; GPU needs Business or Enterprise and uses 3× credits. */
export type Accelerator = "cpu" | "gpu";
export const ACCELERATOR_HELP = "GPU requires a Business or Enterprise plan and uses 3× credits. " +
  "If no GPU is ready, the job runs on CPU at normal credits.";
/** Validate an optional accelerator input. Empty means the API default (CPU). */
export function acceleratorInput(value: unknown): Accelerator | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "cpu" || value === "gpu") return value;
  throw new Error("Accelerator must be cpu or gpu.");
}
/** The accelerator that actually processed a job, from X-Etchv-Accelerator. Unknown values are ignored. */
export function acceleratorUsed(headers: Headers): Accelerator | undefined {
  const value = headers.get("X-Etchv-Accelerator")?.trim().toLowerCase();
  return value === "cpu" || value === "gpu" ? value : undefined;
}
/** API input limits in MB; the workflow platform may impose a lower one. */
export const MAX_UPLOAD_MB: Record<Media, number> = { images: 50, documents: 20, videos: 20 };
/** Detection takes the files Etchv delivered, which can be larger than uploads. */
export const MAX_DETECT_MB: Record<Media, number> = { images: 192, documents: 64, videos: 100 };
/** Files above this go through an upload session instead of the request body. */
export const LARGE_FILE_BYTES = 40 * 1024 * 1024;
export const maxBytes = (media: Media, operation: Operation) =>
  (operation === "detect" ? MAX_DETECT_MB : MAX_UPLOAD_MB)[media] * 1024 * 1024;
export const uploadLimitError = (media: Media, operation: Operation = "embed") =>
  new Error(`Etchv ${operation === "detect" ? "checks" : "accepts"} ${media === "images" ? "images" : media === "documents" ? "PDFs" : "videos"} up to ${maxBytes(media, operation) / 1024 / 1024} MB.`);
const UPLOAD_KINDS: Record<Media, string> = { images: "image", documents: "document", videos: "video" };
export type JobReceipt = {
  request_id: string;
  status: "queued" | "running" | "retrying" | "succeeded" | "failed";
  operation: Operation;
  status_url: string;
  result_url: string;
  error_code: string | null;
  asset_id: string | null;
  source_asset_id: string | null;
  result_expires_at: string | null;
  /** Accelerator asked for at submission. */
  accelerator_requested?: Accelerator | null;
  /** Accelerator that processed the job; CPU when a GPU request fell back. */
  accelerator?: Accelerator | null;
};

export type JobResult =
  | { kind: "json"; value: unknown; accelerator?: Accelerator }
  | { kind: "file"; bytes: Blob; filename: string; accelerator?: Accelerator };

/** Files per batch. */
export const MAX_BATCH_ITEMS = 100;
const BATCH_MEDIA: Record<string, Media> = {
  ...Object.fromEntries(["jpg", "jpeg", "png", "tif", "tiff", "psd", "psb", "gif", "bmp", "ppm", "webp"].map((ext) => [ext, "images"])),
  pdf: "documents", mp4: "videos", mov: "videos",
};
/** The media type a batch infers from a file name's extension, if it takes it. */
export function batchMedia(filename: string): Media | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  return ext && Object.hasOwn(BATCH_MEDIA, ext) ? BATCH_MEDIA[ext] : undefined;
}
export type BatchFile = { filename: string; bytes: Blob; data: Record<string, unknown> };
export type BatchItem = {
  index: number;
  filename: string;
  status: "pending" | "rejected" | "queued" | "running" | "retrying" | "succeeded" | "failed";
  request_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  credits: number | null;
  status_url?: string;
  result_url?: string;
  result_expires_at?: string | null;
  upload?: { method: string; url: string; expires_at: string };
  /** On a create replay: the file already arrived, so the item has no upload URL. */
  upload_received?: boolean;
};
export type Batch = {
  batch_id: string;
  status: "draft" | "starting" | "processing" | "assembling" | "completed" | "failed" | "cancelled" | "expired";
  item_count: number;
  archive: boolean;
  counts: Record<"pending" | "accepted" | "rejected" | "succeeded" | "failed" | "in_progress", number>;
  credits: Record<"reserved" | "charged" | "refunded", number>;
  status_url: string;
  archive_status?: string | null;
  archive_url?: string;
  items?: BatchItem[];
  [field: string]: unknown;
};
/** The fields a picker needs from an asset record (GET /assets). */
export type AssetSummary = { id: string; name: string; kind: "source" | "watermarked"; media_type: "image" | "document" | "video"; [field: string]: unknown };
export type AssetPage = { items: AssetSummary[]; next_cursor: string | null };
/** The fields a picker needs from a storage destination (GET /storage/destinations). */
export type StorageDestination = { id: string; name: string; provider: string; enabled: boolean; [field: string]: unknown };
/** Signed upload URLs are credentials: never pass them on to a workflow's output. */
function withoutUploadUrls(batch: Batch): Batch {
  if (!batch.items) return batch;
  return { ...batch, items: batch.items.map(({ upload, ...item }) => (void upload, item)) };
}

export class EtchvError extends Error {
  readonly status: number;
  readonly requestId?: string;
  constructor(status: number, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

export function apiPath(path: string): string {
  // Receipts provide relative paths. Do not send a key to an arbitrary host.
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(path) || path.includes("//") || path.includes("..")) {
    throw new Error("Expected an Etchv API path from a job receipt.");
  }
  return path;
}

export function filenameFrom(disposition: string): string {
  // Asset downloads put the display name in filename* and a generic ASCII name in filename.
  let name: string | undefined;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) try { name = decodeURIComponent(encoded); } catch { /* fall back to filename */ }
  name ??= disposition.match(/filename="([^"]+)"/)?.[1];
  return name?.replace(/[\\/\u0000-\u001f"]/g, "-").trim() || "watermarked-file";
}

export function isIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export type LinkPrepare = "on_open" | "on_create";
/** A traceable link to create: give recipients or allowedDomains (see https://etchv.com/docs/api/links). */
export type LinkInput = {
  assetId: string; name: string; recipients?: string[]; allowedDomains?: string[];
  expiresAt?: string; prepare?: LinkPrepare; downloadLimit?: number; webhookId?: string; idempotencyKey: string;
};

/** Addresses or domains mapped as a list, or as text separated by commas, semicolons or line breaks. */
export function addressList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.flatMap((item) => String(item).split(/[,;\s]+/)).map((item) => item.trim()).filter(Boolean);
}

/** The JSON body of POST /links, checked before any request. */
export function linkBody(input: LinkInput): Record<string, unknown> {
  if (!/^ast_[a-f0-9]{64}$/.test(input.assetId)) throw new Error("Expected a source asset ID such as ast_….");
  const name = String(input.name ?? "");
  if (!/\S/.test(name) || [...name].length > 200) throw new Error("Give the link a name of up to 200 characters.");
  const recipients = input.recipients ?? [], domains = input.allowedDomains ?? [];
  if (!recipients.length === !domains.length) throw new Error("Give either recipients or allowed domains, not both.");
  if (!isIdempotencyKey(input.idempotencyKey)) throw new Error("The idempotency key must be 8 to 128 letters, digits, hyphens or underscores.");
  const body: Record<string, unknown> = { asset_id: input.assetId, name, ...(recipients.length ? { recipients } : { allowed_domains: domains }) };
  if (input.expiresAt) body.expires_at = input.expiresAt;
  if (input.prepare) {
    if (input.prepare !== "on_open" && input.prepare !== "on_create") throw new Error("Prepare must be on_open or on_create.");
    body.prepare = input.prepare;
  }
  if (input.downloadLimit !== undefined) {
    if (!Number.isInteger(input.downloadLimit) || input.downloadLimit < 1 || input.downloadLimit > 100) throw new Error("The download limit must be 1 to 100.");
    body.download_limit = input.downloadLimit;
  }
  if (input.webhookId) {
    if (!/^wh_[a-f0-9]{32}$/.test(input.webhookId)) throw new Error("Expected a webhook ID such as wh_….");
    body.webhook_id = input.webhookId;
  }
  return body;
}

/** Slowest upload rate a signed PUT is given time for, in bytes per second. */
export const UPLOAD_FLOOR = 128 * 1024;

export class EtchvClient {
  /** Base deadline in milliseconds for each signed upload, before time for its size. */
  uploadTimeout = 45_000;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly userAgent?: string;
  /** `userAgent` names the connector to the API: `etchv-<connector>/<version>`. */
  constructor(
    apiKey: string,
    baseUrl = "https://api.etchv.com",
    fetcher: typeof fetch = fetch,
    userAgent?: string,
  ) {
    const base = new URL(baseUrl);
    if (!apiKey.startsWith("etchv_") || /[\r\n]/.test(apiKey) || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash ||
        (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))) {
      throw new Error("Invalid Etchv connection configuration.");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
    this.userAgent = userAgent;
  }

  /** Headers every API request carries; signed upload URLs get neither. */
  private apiHeaders(init?: HeadersInit): Headers {
    const headers = new Headers(init);
    headers.set("X-API-Key", this.apiKey);
    if (this.userAgent) headers.set("User-Agent", this.userAgent);
    return headers;
  }

  private async request(path: string, init: RequestInit = {}, query?: URLSearchParams): Promise<Response> {
    const url = new URL(apiPath(path), this.baseUrl);
    if (query) url.search = query.toString();
    const response = await this.fetcher(url, { ...init, headers: this.apiHeaders(init.headers), redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EtchvError(response.status, `Etchv returned HTTP ${response.status}.`, response.headers.get("X-Request-ID") ?? undefined);
    }
    return response;
  }

  async connection(): Promise<{ organization_id: string; key_id: string; scopes: string[] }> {
    return (await this.request("/auth/api-key")).json();
  }

  async submit(input: {
    media: Media; operation: Operation; filename: string; bytes: Blob;
    data?: Record<string, unknown>; idempotencyKey: string;
    storageDestinationId?: string; storageKey?: string; accelerator?: string;
  }): Promise<JobReceipt> {
    const accelerator = acceleratorInput(input.accelerator);
    if (!isIdempotencyKey(input.idempotencyKey)) throw new Error("Idempotency key must be 8–128 letters, digits, hyphens, or underscores.");
    if (input.bytes.size > maxBytes(input.media, input.operation)) throw uploadLimitError(input.media, input.operation);
    if (input.operation === "embed" && (!input.data || Array.isArray(input.data) || !Object.keys(input.data).length)) {
      throw new Error("Watermark reference data must be a nonempty JSON object.");
    }
    const form = new FormData();
    if (input.bytes.size > LARGE_FILE_BYTES) {
      // Too large for one request body: upload once and send its ID.
      const kind = input.operation === "detect" ? "detect" : UPLOAD_KINDS[input.media];
      form.set("upload_id", await this.upload(kind, input.bytes, input.filename));
    } else {
      form.set("file", input.bytes, input.filename);
    }
    if (input.operation === "embed") form.set("data", JSON.stringify(input.data));
    const params = new URLSearchParams();
    if (input.operation === "embed" && input.storageDestinationId) params.set("storage_destination_id", input.storageDestinationId);
    if (input.operation === "embed" && input.storageKey) params.set("storage_key", input.storageKey);
    // CPU is the API default, so only a GPU request adds the parameter.
    if (accelerator === "gpu") params.set("accelerator", accelerator);
    const path = `/watermarks/${input.media}${input.operation === "detect" ? "/detect" : ""}/async${params.size ? `?${params}` : ""}`;
    // Query parameters are constructed locally; apiPath intentionally rejects '?' on receipts.
    const url = new URL(path, this.baseUrl);
    const response = await this.fetcher(url, {
      method: "POST", body: form, redirect: "manual",
      headers: this.apiHeaders({ "Idempotency-Key": input.idempotencyKey }),
    });
    if (response.status !== 202) {
      await response.body?.cancel();
      throw new EtchvError(response.status, `Etchv returned HTTP ${response.status}.`, response.headers.get("X-Request-ID") ?? undefined);
    }
    return response.json();
  }

  /**
   * Upload a file once through an upload session and return its upload_id. The
   * signed URL carries its own authorization, so the API key never goes to it.
   */
  async upload(kind: string, bytes: Blob, filename: string): Promise<string> {
    const session = await (await this.request("/uploads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, filename, size: bytes.size }),
    })).json() as { upload_id?: unknown; upload?: unknown };
    if (!/^upl_[a-f0-9]{32}$/.test(String(session.upload_id))) throw new Error("Etchv returned an invalid upload session.");
    await this.putSigned(session.upload, bytes);
    return String(session.upload_id);
  }

  /**
   * PUT a file to a signed upload URL from an upload session or a batch item.
   * The signature in the URL is the credential: the API key is never sent there.
   */
  async putSigned(upload: unknown, bytes: Blob): Promise<void> {
    const { method, url } = (upload ?? {}) as { method?: unknown; url?: unknown };
    let target: URL;
    try { target = new URL(String(url)); } catch { throw new Error("Etchv returned an invalid upload session."); }
    const local = new URL(this.baseUrl).protocol === "http:" && target.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(target.hostname);
    if (method !== "PUT" || target.username || target.password || (target.protocol !== "https:" && !local)) {
      throw new Error("Etchv returned an invalid upload session.");
    }
    // Each attempt gets a base deadline plus time for the body at 128 KiB/s or faster,
    // so a stalled upload fails instead of hanging the workflow step.
    const deadline = this.uploadTimeout + Math.ceil(bytes.size / UPLOAD_FLOOR * 1000);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(target, { method: "PUT", body: bytes, redirect: "manual",
          headers: { "Content-Type": "application/octet-stream" }, signal: AbortSignal.timeout(deadline) });
      } catch (error) {
        if (attempt < 2) continue;
        if (error instanceof Error && error.name === "TimeoutError") throw new Error("The file upload to Etchv timed out.");
        throw error;
      }
      await response.body?.cancel();
      if (response.status === 200) return;
      if (response.status >= 500 && attempt < 2) continue;
      throw new EtchvError(response.status, `Etchv upload returned HTTP ${response.status}.`);
    }
  }

  /**
   * Create a batch of up to 100 files, upload each one to its signed URL and
   * start it. Returns the started batch; follow it with batchStatus.
   */
  async submitBatch(input: {
    items: BatchFile[]; idempotencyKey: string; archive?: boolean; accelerator?: string;
    webhookId?: string; storageDestinationId?: string;
  }): Promise<Batch> {
    const accelerator = acceleratorInput(input.accelerator);
    if (!isIdempotencyKey(input.idempotencyKey)) throw new Error("Idempotency key must be 8–128 letters, digits, hyphens, or underscores.");
    if (!input.items.length || input.items.length > MAX_BATCH_ITEMS) {
      throw new Error(`A batch takes 1 to ${MAX_BATCH_ITEMS} files; this one has ${input.items.length}. Split the files into several batches.`);
    }
    if (input.archive && input.storageDestinationId) throw new Error("A zip archive cannot be combined with a storage destination.");
    const manifest = input.items.map((item, index) => {
      const label = `File ${index + 1} (${item.filename})`;
      const media = batchMedia(item.filename);
      if (!media) throw new Error(`${label}: batches take images, PDFs and MP4 or MOV videos, named with their extension.`);
      if (!item.bytes.size) throw new Error(`${label} is empty.`);
      if (item.bytes.size > maxBytes(media, "embed")) throw new Error(`${label}: ${uploadLimitError(media).message}`);
      if (!item.data || typeof item.data !== "object" || Array.isArray(item.data) || !Object.keys(item.data).length) {
        throw new Error(`${label}: reference data must be a nonempty JSON object.`);
      }
      if (new TextEncoder().encode(JSON.stringify(item.data)).length > 8192) throw new Error(`${label}: reference data must be 8 KB or smaller.`);
      return { filename: item.filename, size: item.bytes.size, data: item.data };
    });
    const body: Record<string, unknown> = { items: manifest, archive: Boolean(input.archive) };
    // CPU is the API default, so only a GPU request adds the field.
    if (accelerator === "gpu") body.accelerator = accelerator;
    if (input.webhookId) body.webhook_id = input.webhookId;
    if (input.storageDestinationId) body.storage_destination_id = input.storageDestinationId;
    const created = await (await this.request("/watermarks/batches", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
    })).json() as Batch;
    if (!/^bat_[a-f0-9]{32}$/.test(String(created.batch_id))) throw new Error("Etchv returned an invalid batch.");
    // A retry with the same key returns the same batch. Files that already arrived are
    // marked upload_received and carry no upload URL; only the others are sent again.
    const uploads = (created.items ?? []).filter((item) => item.upload && !item.upload_received && input.items[item.index]);
    let next = 0;
    let stopped = false;
    await Promise.all(Array.from({ length: Math.min(4, uploads.length) }, async () => {
      while (!stopped && next < uploads.length) {
        const item = uploads[next++];
        try { await this.putSigned(item.upload, input.items[item.index].bytes); } catch (error) { stopped = true; throw error; }
      }
    }));
    if (created.status !== "draft") return withoutUploadUrls(created);
    return withoutUploadUrls(await (await this.request(`/watermarks/batches/${created.batch_id}/start`, { method: "POST" })).json() as Batch);
  }

  /** Read a batch: status, counts, credits and each item's status and result_url. */
  async batchStatus(batchId: string): Promise<Batch> {
    const id = batchId.trim().replace(/^\/watermarks\/batches\//, "");
    if (!/^bat_[a-f0-9]{32}$/.test(id)) throw new Error("Expected a batch ID such as bat_… or its status_url.");
    return withoutUploadUrls(await (await this.request(`/watermarks/batches/${id}`)).json() as Batch);
  }

  async status(path: string): Promise<JobReceipt> {
    return (await this.request(path)).json();
  }

  async result(path: string, operation: Operation): Promise<JobResult> {
    const response = await this.request(path);
    if (response.status === 202) {
      await response.body?.cancel();
      throw new EtchvError(202, "Etchv job is still processing.", response.headers.get("X-Request-ID") ?? undefined);
    }
    const accelerator = acceleratorUsed(response.headers);
    if (operation === "detect") {
      const value: unknown = await response.json();
      // Detection JSON may already carry the accelerator; the header fills it in otherwise.
      if (accelerator && value && typeof value === "object" && !Array.isArray(value) && !("accelerator" in value)) {
        return { kind: "json", value: { ...value, accelerator }, accelerator };
      }
      return { kind: "json", value, ...(accelerator ? { accelerator } : {}) };
    }
    return { kind: "file", bytes: await response.blob(), filename: filenameFrom(response.headers.get("Content-Disposition") ?? ""),
      ...(accelerator ? { accelerator } : {}) };
  }

  /**
   * Create a traceable link: each recipient opens their own watermarked copy of the source asset.
   * Retrying with the same idempotency key returns the same link.
   */
  async createLink(input: LinkInput): Promise<Record<string, unknown>> {
    const body = linkBody(input);
    return (await this.request("/links", { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey } })).json();
  }

  /** One page of the workspace's assets, newest first, optionally only one kind (needs assets:read). */
  async assets(cursor?: string, limit = 100, kind?: AssetSummary["kind"]): Promise<AssetPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    if (kind) params.set("kind", kind);
    return (await this.request("/assets", {}, params)).json();
  }

  /** The workspace's storage destinations, newest first (needs storage:read). */
  async storageDestinations(): Promise<StorageDestination[]> {
    return (await this.request("/storage/destinations")).json();
  }

  async asset(assetId: string): Promise<{ bytes: Blob; filename: string; accelerator?: Accelerator }> {
    if (!/^ast_[a-f0-9]{64}$/.test(assetId)) throw new Error("Invalid asset ID.");
    const result = await this.result(`/assets/${assetId}/content`, "embed");
    if (result.kind !== "file") throw new Error("Expected a file.");
    return result;
  }
}
