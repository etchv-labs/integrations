import { createHash, timingSafeEqual } from "node:crypto";

export type SignatureAlgorithm = "sha1" | "sha256";

export type VerifyOptions = {
  /** Secret of the API key Cloudinary signs notifications with: the dedicated webhook key, or the oldest active key. */
  apiSecret: string;
  /** SHA-1 unless the product environment is set to accept only SHA-256. */
  algorithm?: SignatureAlgorithm;
  /** Reject notifications older than this. Cloudinary's guidance is two hours. */
  maxAgeSeconds?: number;
  /** Current Unix time in seconds; for tests. */
  now?: number;
};

/**
 * Verify Cloudinary's `X-Cld-Signature`: the hex SHA digest of the raw body, then
 * `X-Cld-Timestamp`, then the API secret. Pass the body exactly as received, not re-serialized JSON.
 * Triggers set to `auth_scheme: eddsa_v2` don't send this header, so they're rejected here.
 */
export function verifyNotification(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  { apiSecret, algorithm = "sha1", maxAgeSeconds = 7200, now = Math.floor(Date.now() / 1000) }: VerifyOptions,
): boolean {
  if (!apiSecret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  // Allow a little clock skew for timestamps slightly in the future.
  const age = now - Number(timestamp);
  if (age > maxAgeSeconds || age < -300) return false;
  const hex = signature.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hex)) return false;
  const expected = createHash(algorithm).update(rawBody + timestamp + apiSecret).digest();
  const given = Buffer.from(hex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
