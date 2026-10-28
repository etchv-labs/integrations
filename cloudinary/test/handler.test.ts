import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { Etchv, type EmbedResult, type JsonValue, type RequestOptions } from "@etchv-labs/sdk";
import { CLOUDINARY_USER_AGENT, CloudinaryClient, contextValue } from "../src/cloudinary.ts";
import { createHandler, deliveryFor, idempotencyKey, WATERMARKED_TAG } from "../src/handler.ts";
import { identifiedFetch, nodeListener, USER_AGENT } from "../src/server.ts";
import { verifyNotification } from "../src/signature.ts";
import { VERSION } from "../src/version.ts";

const SECRET = "test-secret";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const WATERMARKED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const quiet = { info() {}, warn() {}, error() {} };

const upload = (overrides: Record<string, unknown> = {}) => ({
  notification_type: "upload",
  asset_id: "59a3bb9b5df2b3e80a1013220db70bc7",
  public_id: "catalog/fox",
  version: 1719334720,
  version_id: "f8e875874898b75e6a4e965931566ec3",
  format: "png",
  resource_type: "image",
  type: "upload",
  bytes: PNG.byteLength,
  tags: ["fox"],
  secure_url: "https://res.cloudinary.com/demo/image/upload/v1719334720/catalog/fox.png",
  asset_folder: "catalog",
  original_filename: "fox",
  ...overrides,
});

function signed(body: unknown, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const signature = createHash("sha1").update(raw + timestamp + secret).digest("hex");
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cld-timestamp": String(timestamp), "x-cld-signature": signature },
    body: raw,
  });
}

type Call = { url: string; init?: RequestInit };

function fakes({ embed, uploadStatus = 200, downloadStatus = 200, network, current = upload().version_id, explicit }: {
  embed?: (image: Uint8Array, data: Record<string, JsonValue>, options?: RequestOptions) => Promise<EmbedResult>;
  uploadStatus?: number;
  downloadStatus?: number;
  /** URL prefix whose requests fail as fetch does on a network error. */
  network?: string;
  /** The original's current version_id, or null once deleted. */
  current?: string | null;
  /** Replaces the explicit call's response. */
  explicit?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const state = { current };
  const embeds: { data: Record<string, JsonValue>; options?: RequestOptions }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (network && url.startsWith(network)) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    if (url.endsWith("/image/explicit")) {
      assert.equal(String(init?.body), "public_id=catalog%2Ffox&type=upload");
      if (explicit) return explicit();
      return state.current === null ? Response.json({ error: { message: "Resource not found" } }, { status: 404 }) : Response.json({ version_id: state.current });
    }
    if (url.startsWith("https://res.cloudinary.com/")) return new Response(downloadStatus === 200 ? PNG : "gone", { status: downloadStatus });
    if (uploadStatus !== 200) return Response.json({ error: { message: "Upload refused" } }, { status: uploadStatus });
    const form = init?.body as FormData;
    return Response.json({ public_id: form.get("public_id"), asset_id: "new" });
  }) as typeof fetch;
  const etchv = {
    embedImage: async (image: Uint8Array, data: Record<string, JsonValue>, options?: RequestOptions) => {
      embeds.push({ data, options });
      if (embed) return embed(image, data, options);
      assert.deepEqual(image, PNG);
      return { image: WATERMARKED, watermarkId: "a".repeat(64), requestId: "req_1", contentType: "image/png", filename: "fox.png",
        assetId: null, sourceAssetId: null, storageDeliveryId: null, accelerator: "cpu" } satisfies EmbedResult;
    },
  };
  const cloudinary = new CloudinaryClient({ cloudName: "demo", apiKey: "123", apiSecret: SECRET }, fetcher);
  const handle = createHandler({ webhookSecret: SECRET, defaultDelivery: "web-catalog" }, { etchv, cloudinary, log: quiet });
  return { handle, calls, embeds, state };
}

test("verifies Cloudinary's documented signature example", () => {
  // From Cloudinary's "Verifying notification signatures" page.
  const options = { apiSecret: "abcd", now: 1315060510 };
  assert.ok(verifyNotification("{public_id: 'sample'}", "1315060510", "25f7e91709c858b97d688ce8da799dedb290d9ef", options));
  assert.ok(!verifyNotification("{public_id: 'sample2'}", "1315060510", "25f7e91709c858b97d688ce8da799dedb290d9ef", options));
  assert.ok(!verifyNotification("{public_id: 'sample'}", "1315060510", "25f7e91709c858b97d688ce8da799dedb290d9ef",
    { ...options, now: 1315060510 + 7201 }));
  assert.ok(!verifyNotification("{}", null, null, options));
  assert.ok(!verifyNotification("{public_id: 'sample'}", "1315060510", "25f7e91709c858b97d688ce8da799dedb290d9efzz", options));
});

test("supports SHA-256 signatures", () => {
  const signature = createHash("sha256").update("{}" + "100" + "s").digest("hex");
  assert.ok(verifyNotification("{}", "100", signature, { apiSecret: "s", algorithm: "sha256", now: 100 }));
  assert.ok(!verifyNotification("{}", "100", signature, { apiSecret: "s", now: 100 }));
});

test("watermarks an upload and stores the copy under a new public ID", async () => {
  const { handle, calls, embeds } = fakes();
  const response = await handle(signed(upload()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "watermarked", public_id: "catalog/fox_etchv", watermark_id: "a".repeat(64) });
  assert.deepEqual(embeds[0].data, { public_id: "catalog/fox", delivery: "web-catalog" });
  assert.equal(embeds[0].options?.filename, "fox.png");
  assert.equal(embeds[0].options?.idempotencyKey, idempotencyKey(upload().asset_id, upload().version_id));

  assert.deepEqual(calls.map((call) => call.url.split("/").slice(-2).join("/")), ["catalog/fox.png", "image/explicit", "image/upload"]);
  const store = calls[2];
  assert.equal(store.url, "https://api.cloudinary.com/v1_1/demo/image/upload");
  assert.equal(new Headers(store.init?.headers).get("authorization"), `Basic ${Buffer.from(`123:${SECRET}`).toString("base64")}`);
  const form = store.init?.body as FormData;
  assert.equal(form.get("public_id"), "catalog/fox_etchv");
  assert.equal(form.get("overwrite"), "true");
  assert.equal(form.get("invalidate"), "true");
  assert.equal(form.get("tags"), WATERMARKED_TAG);
  assert.equal(form.get("asset_folder"), "catalog");
  assert.equal(form.get("context"), `etchv_watermark_id=${"a".repeat(64)}|etchv_source=catalog/fox`);
  assert.deepEqual(new Uint8Array(await (form.get("file") as Blob).arrayBuffer()), WATERMARKED);
});

test("a delivery tag overrides the default delivery reference", async () => {
  const { handle, embeds } = fakes();
  await handle(signed(upload({ tags: ["fox", "delivery:partner-42"] })));
  assert.equal(embeds[0].data.delivery, "partner-42");
  assert.equal(deliveryFor(["delivery:"], "fallback"), "fallback");
  assert.equal(deliveryFor(undefined, "fallback"), "fallback");
});

test("a new version of the original replaces the copy", async () => {
  const { handle, calls, embeds, state } = fakes();
  await handle(signed(upload()));
  state.current = "0000000000000000000000000000beef";
  await handle(signed(upload({ version: 1719334999, version_id: "0000000000000000000000000000beef" })));
  assert.equal(embeds.length, 2);
  assert.notEqual(embeds[0].options?.idempotencyKey, embeds[1].options?.idempotencyKey);
  const stores = calls.filter((call) => call.url.endsWith("/image/upload")).map((call) => call.init?.body as FormData);
  assert.deepEqual(stores.map((form) => [form.get("public_id"), form.get("overwrite")]),
    [["catalog/fox_etchv", "true"], ["catalog/fox_etchv", "true"]]);
});

test("a late retry for a replaced or deleted original stores nothing", async () => {
  for (const [current, reason] of [["0000000000000000000000000000beef", "a newer version was uploaded"], [null, "the original was deleted"]] as const) {
    const { handle, calls } = fakes({ current });
    assert.deepEqual(await (await handle(signed(upload()))).json(), { status: "skipped", reason });
    assert.ok(!calls.some((call) => call.url.endsWith("/image/upload")));
  }
  // The version check is retried like any other Cloudinary call, and a wrong API origin is a failure, not a delete.
  const offline = fakes({ network: "https://api.cloudinary.com/v1_1/demo/image/explicit" });
  assert.equal((await offline.handle(signed(upload()))).status, 503);
  const busy = fakes({ explicit: () => Response.json({ error: { message: "Busy" } }, { status: 500 }) });
  assert.equal((await busy.handle(signed(upload()))).status, 503);
  for (const response of [() => new Response("<html>Page not found</html>", { status: 404 }),
    () => Response.json({ error: { message: "Invalid credentials" } }, { status: 401 })]) {
    const { handle, calls } = fakes({ explicit: response });
    assert.deepEqual(await (await handle(signed(upload()))).json(), { status: "failed", reason: "cloudinary" });
    assert.ok(!calls.some((call) => call.url.endsWith("/image/upload")));
  }
});

test("a retry of the same asset version replays the same Etchv job", () => {
  assert.equal(idempotencyKey("a", "v1"), idempotencyKey("a", "v1"));
  assert.notEqual(idempotencyKey("a", "v1"), idempotencyKey("a", "v2"));
  assert.match(idempotencyKey("a", "v1"), /^[A-Za-z0-9_-]{8,128}$/);
});

test("rejects unsigned, stale or tampered notifications", async () => {
  const { handle, embeds } = fakes();
  assert.equal((await handle(signed(upload(), { secret: "wrong" }))).status, 401);
  assert.equal((await handle(signed(upload(), { timestamp: Math.floor(Date.now() / 1000) - 3 * 3600 }))).status, 401);
  const request = signed(upload());
  const tampered = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(upload({ public_id: "other" })) });
  assert.equal((await handle(tampered)).status, 401);
  assert.equal((await handle(new Request("http://localhost/", { method: "GET" }))).status, 405);
  assert.equal(embeds.length, 0);
});

test("skips its own copies and what Etchv can't watermark", async () => {
  const { handle, embeds } = fakes();
  for (const body of [
    upload({ tags: [WATERMARKED_TAG] }),
    upload({ public_id: "catalog/fox_etchv", tags: [] }),
    upload({ format: "avif" }),
    upload({ resource_type: "video" }),
    upload({ type: "authenticated" }),
    upload({ bytes: 51 * 1024 * 1024 }),
    { notification_type: "delete", public_id: "catalog/fox" },
  ]) {
    const response = await handle(signed(body));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "skipped");
  }
  assert.equal(embeds.length, 0);
});

test("asks Cloudinary to retry transient failures and stops on permanent ones", async () => {
  const busy = Object.assign(new Error("busy"), { statusCode: 503 });
  assert.equal((await fakes({ embed: async () => { throw busy; } }).handle(signed(upload()))).status, 503);
  assert.equal((await fakes({ uploadStatus: 500 }).handle(signed(upload()))).status, 503);

  const unpaid = Object.assign(new Error("Out of credits"), { statusCode: 402 });
  const failed = await fakes({ embed: async () => { throw unpaid; } }).handle(signed(upload()));
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { status: "failed", reason: "etchv" });
  const gone = await fakes({ downloadStatus: 404 }).handle(signed(upload()));
  assert.deepEqual(await gone.json(), { status: "failed", reason: "cloudinary" });
  // An idempotency conflict and bad input won't change on a retry.
  const conflict = Object.assign(new Error("Idempotency key was used for a different request"), { statusCode: 409 });
  assert.equal((await fakes({ embed: async () => { throw conflict; } }).handle(signed(upload()))).status, 200);
  const empty = new TypeError("file must contain 1 byte to 50 MB");
  assert.equal((await fakes({ embed: async () => { throw empty; } }).handle(signed(upload()))).status, 200);
  // Cloudinary's rate limit and network failures are worth retrying.
  assert.equal((await fakes({ uploadStatus: 420 }).handle(signed(upload()))).status, 503);
  assert.equal((await fakes({ network: "https://res.cloudinary.com/" }).handle(signed(upload()))).status, 503);
  assert.equal((await fakes({ network: "https://api.cloudinary.com/v1_1/demo/image/upload" }).handle(signed(upload()))).status, 503);
  // A URL that isn't HTTPS, or a notification without the fields it needs, won't improve.
  const http = await fakes().handle(signed(upload({ secure_url: "http://res.cloudinary.com/demo/fox.png" })));
  assert.deepEqual(await http.json(), { status: "failed", reason: "cloudinary" });
  const incomplete = await fakes().handle(signed(upload({ version_id: undefined })));
  assert.deepEqual(await incomplete.json(), { status: "failed", reason: "invalid_notification" });
  const nothing = await fakes().handle(signed(null));
  assert.deepEqual(await nothing.json(), { status: "failed", reason: "invalid_notification" });
});

test("classifies the SDK's own errors", async () => {
  const sdk = (fetcher: typeof fetch) => {
    const etchv = new Etchv({ apiKey: "etchv_test", fetch: fetcher, timeout: 300 });
    const cloudinary = new CloudinaryClient({ cloudName: "demo", apiKey: "123", apiSecret: SECRET },
      (async () => new Response(PNG)) as typeof fetch);
    return createHandler({ webhookSecret: SECRET, defaultDelivery: "web-catalog" }, { etchv, cloudinary, log: quiet });
  };
  // Network failures are retried inside the SDK until its deadline, then reported as a timeout.
  const offline = sdk((async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); }) as typeof fetch);
  assert.equal((await offline(signed(upload()))).status, 503);
  // A failed job replays as 503 with status "failed"; retrying can't change it.
  const failedJob = sdk((async () => Response.json({ status: "failed", request_id: "req_" + "a".repeat(64), error_code: "internal",
    detail: "Watermarking failed; reserved credits were refunded" }, { status: 503 })) as typeof fetch);
  const response = await failedJob(signed(upload()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "failed", reason: "etchv" });
  const unpaid = sdk((async () => Response.json({ detail: "Out of credits" }, { status: 402 })) as typeof fetch);
  assert.equal((await unpaid(signed(upload()))).status, 200);
});

test("escapes context separators", () => {
  assert.equal(contextValue("a=b|c\\d"), "a\\=b\\|c\\d");
});

test("the SDK's requests name this integration first", async () => {
  let agent = "";
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    agent = new Headers(init?.headers).get("user-agent") ?? "";
    return Response.json({ organization_id: "org_1", key_id: "key_1", scopes: [] });
  }) as typeof fetch;
  await new Etchv({ apiKey: "etchv_test", fetch: identifiedFetch(fetcher) }).getApiKeyInfo();
  assert.match(agent, new RegExp(`^${USER_AGENT} etchv-node/`));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("identifies the integration on every Cloudinary call", async () => {
  const { handle, calls } = fakes();
  assert.equal((await handle(signed(upload()))).status, 200);
  assert.equal(calls.length, 3);
  assert.equal(CLOUDINARY_USER_AGENT, `CloudinaryEtchv/${VERSION} (Node.js ${process.versions.node})`);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("User-Agent"), CLOUDINARY_USER_AGENT);
    // The download is a public delivery URL; the API calls keep their credentials.
    if (call.init?.method === "POST") assert.match(headers.get("Authorization") ?? "", /^Basic /);
  }
});

test("the Node server refuses oversized bodies", async () => {
  const server = createServer(nodeListener(async () => new Response("unreachable")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    assert.equal(response.status, 413);
  } finally {
    server.close();
  }
});

test("the handler refuses an oversized body without a Content-Length", async () => {
  const { handle } = fakes();
  const chunk = new Uint8Array(256 * 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request("http://localhost/", { method: "POST", body, duplex: "half" } as RequestInit);
  assert.equal(request.headers.get("content-length"), null);
  assert.equal((await handle(request)).status, 413);
});
