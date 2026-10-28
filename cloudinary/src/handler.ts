import { createHash } from "node:crypto";
import type { EmbedResult, JsonValue, RequestOptions } from "@etchv-labs/sdk";
import { CloudinaryError, contextValue, type CloudinaryClient } from "./cloudinary.ts";
import { verifyNotification, type SignatureAlgorithm } from "./signature.ts";

/** Tag on every watermarked copy; uploads carrying it are never watermarked again. */
export const WATERMARKED_TAG = "etchv-watermarked";
/** An upload tag `delivery:<reference>` overrides the default delivery reference. */
export const DELIVERY_TAG_PREFIX = "delivery:";
/** Notifications are small JSON documents. */
export const MAX_NOTIFICATION_BYTES = 1024 * 1024;
/** Etchv's image upload limit. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** Cloudinary formats Etchv watermarks. */
const IMAGE_FORMATS = new Set(["jpg", "jpeg", "png", "tif", "tiff", "psd", "psb", "gif", "bmp", "ppm", "webp"]);

export type HandlerConfig = {
  /** Secret Cloudinary signs notifications with. */
  webhookSecret: string;
  signatureAlgorithm?: SignatureAlgorithm;
  /** Delivery reference for uploads without a `delivery:` tag. */
  defaultDelivery: string;
  /** Appended to the source public ID to name the watermarked copy. */
  publicIdSuffix?: string;
};

export type Watermarker = {
  embedImage(image: Uint8Array, data: Record<string, JsonValue>, options?: RequestOptions): Promise<EmbedResult>;
};

export type Logger = Pick<Console, "info" | "warn" | "error">;

type UploadNotification = {
  notification_type?: string;
  asset_id?: string;
  public_id?: string;
  version_id?: string;
  resource_type?: string;
  type?: string;
  format?: string;
  bytes?: number;
  tags?: string[];
  secure_url?: string;
  asset_folder?: string;
  original_filename?: string;
};

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

/** Read a request body, giving up once it passes `limit` bytes, with or without a Content-Length. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The delivery reference from a `delivery:` tag, or the default. */
export function deliveryFor(tags: string[] | undefined, fallback: string): string {
  const tag = tags?.find((t) => t.startsWith(DELIVERY_TAG_PREFIX) && t.length > DELIVERY_TAG_PREFIX.length);
  return tag ? tag.slice(DELIVERY_TAG_PREFIX.length) : fallback;
}

/** One key per asset version, so Cloudinary's retries replay the same Etchv job instead of starting another. */
export function idempotencyKey(assetId: string, versionId: string): string {
  return "cld_" + createHash("sha256").update(`${assetId}:${versionId}`).digest("hex").slice(0, 48);
}

/**
 * Retrying can help after rate limits (Cloudinary also uses 420), server errors, timeouts and network
 * failures. Bad input and other 4xx responses, including an idempotency conflict, need a person.
 */
function transient(error: unknown): boolean {
  // The SDK rejects bad input with a TypeError; fetch's network failures are TypeErrors with a cause.
  if (error instanceof TypeError && error.cause === undefined) return false;
  // A failed Etchv job is replayed for its idempotency key, so retrying returns the same failure.
  if ((error as { detail?: { status?: unknown } }).detail?.status === "failed") return false;
  const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status;
  if (typeof status !== "number") return true;
  return status === 0 || status === 408 || status === 420 || status === 429 || status >= 500;
}

/**
 * Handle a Cloudinary upload notification: verify it, watermark the image with Etchv and upload
 * the result as `<public_id><suffix>`. Answers 200 when done or when there's nothing to do, 401 for
 * a bad signature, 413 for an oversized body, and 503 when Cloudinary should retry.
 */
export function createHandler(
  config: HandlerConfig,
  deps: { etchv: Watermarker; cloudinary: CloudinaryClient; log?: Logger },
) {
  const suffix = config.publicIdSuffix ?? "_etchv";
  const log = deps.log ?? console;
  if (!config.webhookSecret || !config.defaultDelivery || !suffix) throw new Error("Invalid handler configuration.");
  const skipped = (reason: string, publicId?: string) => {
    log.info(`etchv-cloudinary: skipped ${publicId ?? "notification"}: ${reason}`);
    return json(200, { status: "skipped", reason });
  };
  // Cloudinary retries anything but 200, and a retry can't fix these.
  const failed = (reason: string, publicId?: string, detail?: string) => {
    log.error(`etchv-cloudinary: ${publicId ?? "notification"} failed: ${reason}${detail ? `: ${detail}` : ""}`);
    return json(200, { status: "failed", reason });
  };

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const raw = await readBody(request, MAX_NOTIFICATION_BYTES);
    if (raw === null) return json(413, { error: "too_large" });
    const valid = verifyNotification(raw, request.headers.get("x-cld-timestamp"), request.headers.get("x-cld-signature"), {
      apiSecret: config.webhookSecret,
      algorithm: config.signatureAlgorithm,
    });
    if (!valid) return json(401, { error: "invalid_signature" });

    let event: UploadNotification;
    try {
      event = JSON.parse(raw) as UploadNotification;
    } catch {
      return failed("invalid_notification");
    }
    if (!event || typeof event !== "object") return failed("invalid_notification");
    const { asset_id: assetId, public_id: publicId, secure_url: url, version_id: versionId } = event;
    if (event.notification_type !== "upload") return skipped("not an upload", publicId);
    if (event.resource_type !== "image" || event.type !== "upload") return skipped("not a public image upload", publicId);
    if (event.tags?.includes(WATERMARKED_TAG) || publicId?.endsWith(suffix)) return skipped("already watermarked", publicId);
    const format = event.format?.toLowerCase() ?? "";
    if (!IMAGE_FORMATS.has(format)) return skipped(`format ${format || "unknown"} is not supported`, publicId);
    if ((event.bytes ?? 0) > MAX_IMAGE_BYTES) return skipped("image is larger than 50 MB", publicId);
    if (!assetId || !publicId || !url || !versionId) return failed("invalid_notification", publicId);

    const delivery = deliveryFor(event.tags, config.defaultDelivery);
    const target = publicId + suffix;
    const filename = `${(event.original_filename || publicId.split("/").pop()) ?? "image"}.${format}`;
    try {
      const original = await deps.cloudinary.download(url, MAX_IMAGE_BYTES);
      const result = await deps.etchv.embedImage(original, { public_id: publicId, delivery }, {
        filename,
        idempotencyKey: idempotencyKey(assetId, versionId),
      });
      // A late retry downloads the older version's URL, which still serves the older bytes, so check
      // the original wasn't replaced or deleted before storing over the copy.
      const current = await deps.cloudinary.currentVersionId(publicId);
      if (current === null) return skipped("the original was deleted", publicId);
      if (current !== versionId) return skipped("a newer version was uploaded", publicId);
      const params: Record<string, string> = {
        // A new version of the original replaces the copy. A retry replays the same Etchv result,
        // so overwriting stores the same bytes again.
        public_id: target,
        overwrite: "true",
        invalidate: "true",
        tags: WATERMARKED_TAG,
        context: `etchv_watermark_id=${result.watermarkId}|etchv_source=${contextValue(publicId)}`,
      };
      if (event.asset_folder) params.asset_folder = event.asset_folder;
      const stored = await deps.cloudinary.uploadImage(result.image, result.filename || filename, params);
      log.info(`etchv-cloudinary: ${publicId} -> ${stored.public_id}`);
      return json(200, { status: "watermarked", public_id: stored.public_id, watermark_id: result.watermarkId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (transient(error)) {
        log.warn(`etchv-cloudinary: ${publicId} will be retried: ${message}`);
        return json(503, { error: "retry" });
      }
      return failed(error instanceof CloudinaryError ? "cloudinary" : "etchv", publicId, message);
    }
  };
}
