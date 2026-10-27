import assert from "node:assert/strict";
import { test } from "node:test";
import { EtchvClient, EtchvError, MAX_UPLOAD_MB, acceleratorInput, apiPath, batchMedia, filenameFrom } from "./etchv.ts";

test("connection check is authenticated and does not submit a billable operation", async () => {
  const calls: string[] = [];
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "etchv_test");
    return Response.json({ organization_id: "org_a", key_id: "key_a", scopes: ["watermarks:detect"] });
  });
  assert.deepEqual(await client.connection(), { organization_id: "org_a", key_id: "key_a", scopes: ["watermarks:detect"] });
  assert.deepEqual(calls, ["https://api.etchv.com/auth/api-key"]);
});

test("all six async routes submit file bytes with one idempotency key", async () => {
  for (const media of ["images", "documents", "videos"] as const) {
    for (const operation of ["embed", "detect"] as const) {
      const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url, init) => {
        assert.equal(String(url), `https://api.etchv.com/watermarks/${media}${operation === "detect" ? "/detect" : ""}/async`);
        assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "source_event_001");
        const body = init?.body as FormData;
        assert.equal((body.get("file") as File).name, "source.bin");
        assert.equal(body.get("data"), operation === "embed" ? '{"source":"record-1"}' : null);
        return Response.json({ request_id: "req_1", status: "queued", status_url: "/watermarks/jobs/req_1" }, { status: 202 });
      });
      const receipt = await client.submit({ media, operation, filename: "source.bin", bytes: new Blob(["abc"]),
        data: { source: "record-1" }, idempotencyKey: "source_event_001" });
      assert.equal(receipt.request_id, "req_1");
    }
  }
});

test("GPU requests add the accelerator parameter alongside storage options; CPU sends none", async () => {
  const urls: string[] = [];
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url) => {
    urls.push(String(url));
    return Response.json({ request_id: "req_1", status: "queued", accelerator_requested: "gpu", accelerator: null }, { status: 202 });
  });
  const base = { filename: "source.bin", bytes: new Blob(["abc"]), data: { source: "record-1" }, idempotencyKey: "source_event_001" };
  const receipt = await client.submit({ ...base, media: "images", operation: "embed", accelerator: "gpu",
    storageDestinationId: "dst_" + "a".repeat(32), storageKey: "out/a.png" });
  assert.equal(receipt.accelerator_requested, "gpu");
  await client.submit({ ...base, media: "videos", operation: "detect", accelerator: "gpu" });
  await client.submit({ ...base, media: "documents", operation: "embed", accelerator: "cpu" });
  await client.submit({ ...base, media: "documents", operation: "detect", accelerator: "" });
  assert.deepEqual(urls, [
    `https://api.etchv.com/watermarks/images/async?storage_destination_id=dst_${"a".repeat(32)}&storage_key=out%2Fa.png&accelerator=gpu`,
    "https://api.etchv.com/watermarks/videos/detect/async?accelerator=gpu",
    "https://api.etchv.com/watermarks/documents/async",
    "https://api.etchv.com/watermarks/documents/detect/async",
  ]);
  assert.equal(acceleratorInput(undefined), undefined);
  await assert.rejects(client.submit({ ...base, media: "images", operation: "embed", accelerator: "tpu" }), /cpu or gpu/);
  assert.equal(urls.length, 4);
});

test("results report the accelerator that processed the job", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url) => {
    if (String(url).endsWith("/gpu/result")) return Response.json({ watermarked: true }, { headers: { "X-Etchv-Accelerator": "gpu" } });
    if (String(url).endsWith("/json/result")) return Response.json({ watermarked: false, accelerator: "cpu" }, { headers: { "X-Etchv-Accelerator": "cpu" } });
    if (String(url).endsWith("/odd/result")) return new Response("x", { headers: { "X-Etchv-Accelerator": "quantum" } });
    return new Response("output", { headers: { "X-Etchv-Accelerator": "cpu", "Content-Disposition": 'attachment; filename="m.png"' } });
  });
  assert.deepEqual(await client.result("/gpu/result", "detect"), { kind: "json", value: { watermarked: true, accelerator: "gpu" }, accelerator: "gpu" });
  assert.deepEqual(await client.result("/json/result", "detect"), { kind: "json", value: { watermarked: false, accelerator: "cpu" }, accelerator: "cpu" });
  const file = await client.result("/embed/result", "embed");
  assert.equal(file.accelerator, "cpu");
  const unknown = await client.result("/odd/result", "embed");
  assert.equal("accelerator" in unknown, false);
});

test("uploads are bounded per media type before any request", async () => {
  assert.deepEqual(MAX_UPLOAD_MB, { images: 50, documents: 20, videos: 20 });
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () => {
    throw new Error("Must not upload an oversized file");
  });
  const submit = (media: "images" | "documents" | "videos", size: number) => client.submit({ media, operation: "embed",
    filename: "source.bin", bytes: new Blob([new Uint8Array(size)]), data: { source: "record-1" }, idempotencyKey: "source_event_001" });
  await assert.rejects(submit("images", 50 * 1024 * 1024 + 1), /images up to 50 MB/);
  await assert.rejects(submit("documents", 20 * 1024 * 1024 + 1), /PDFs up to 20 MB/);
  await assert.rejects(submit("videos", 20 * 1024 * 1024 + 1), /videos up to 20 MB/);
  await assert.rejects(submit("images", 20 * 1024 * 1024 + 1), /Must not upload/);
});

test("receipt paths cannot leak credentials to another host", async () => {
  for (const path of ["https://elsewhere.test/x", "//elsewhere.test/x", "/x/../y", "/x?url=elsewhere"])
    assert.throws(() => apiPath(path));
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () => {
    throw new Error("Must not fetch invalid path");
  });
  await assert.rejects(client.status("//elsewhere.test/x"));
});

test("status, detection JSON, and authenticated file results stay distinct", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url) => {
    if (String(url).endsWith("/status")) return Response.json({ status: "succeeded", result_url: "/detect/result" });
    if (String(url).endsWith("/detect/result")) return Response.json({ watermarked: false });
    return new Response(new Blob(["output"]), { headers: { "Content-Disposition": 'attachment; filename="marked.png"' } });
  });
  assert.equal((await client.status("/status")).status, "succeeded");
  assert.deepEqual(await client.result("/detect/result", "detect"), { kind: "json", value: { watermarked: false } });
  const result = await client.result("/embed/result", "embed");
  assert.equal(result.kind, "file");
  if (result.kind === "file") {
    assert.equal(result.filename, "marked.png");
    assert.equal(await result.bytes.text(), "output");
  }
});

test("API failures surface status without echoing response bodies", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () =>
    new Response('{"detail":"private"}', { status: 402, headers: { "X-Request-ID": "req_a" } }));
  await assert.rejects(client.connection(), (error: unknown) =>
    error instanceof EtchvError && error.status === 402 && error.requestId === "req_a" && !error.message.includes("private"));
});

test("a pending result cannot be mistaken for a finished file", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () =>
    Response.json({ status: "running" }, { status: 202 }));
  await assert.rejects(client.result("/watermarks/jobs/req_x/result", "embed"),
    (error: unknown) => error instanceof EtchvError && error.status === 202);
});

test("download filenames prefer the encoded display name and never contain a path", () => {
  assert.equal(filenameFrom(`attachment; filename="asset.png"; filename*=UTF-8''Launch%20r%C3%A9sum%C3%A9.png`), "Launch résumé.png");
  assert.equal(filenameFrom('attachment; filename="marked.png"'), "marked.png");
  assert.equal(filenameFrom(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`), "..-..-etc-passwd");
  assert.equal(filenameFrom(`attachment; filename="a.png"; filename*=UTF-8''%E0%A4%A`), "a.png");
  assert.equal(filenameFrom(""), "watermarked-file");
});

test("files above 40 MB go through an upload session without the API key", async () => {
  const calls: string[] = [];
  const uploadId = "upl_" + "1".repeat(32);
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url, init) => {
    const target = new URL(String(url));
    calls.push(`${init?.method} ${target.host}${target.pathname}`);
    if (target.pathname === "/uploads") {
      assert.equal(new Headers(init?.headers).get("X-API-Key"), "etchv_test");
      assert.deepEqual(JSON.parse(String(init?.body)), { kind: "detect", filename: "delivered.png", size: 41 * 1024 * 1024 });
      return Response.json({ upload_id: uploadId, upload: { method: "PUT", url: `https://uploads.etchv.com/detect/${uploadId}.png?Signature=s` } }, { status: 201 });
    }
    if (target.host === "uploads.etchv.com") {
      assert.equal(new Headers(init?.headers).get("X-API-Key"), null);
      return new Response(null, { status: 200 });
    }
    const body = init?.body as FormData;
    assert.equal(body.get("upload_id"), uploadId);
    assert.equal(body.get("file"), null);
    return Response.json({ request_id: "req_1", status: "queued" }, { status: 202 });
  });
  const receipt = await client.submit({ media: "images", operation: "detect", filename: "delivered.png",
    bytes: new Blob([new Uint8Array(41 * 1024 * 1024)]), idempotencyKey: "source_event_002" });
  assert.equal(receipt.request_id, "req_1");
  assert.deepEqual(calls, ["POST api.etchv.com/uploads", `PUT uploads.etchv.com/detect/${uploadId}.png`, "POST api.etchv.com/watermarks/images/detect/async"]);
});

test("limits follow the operation: 50 MB to embed images, 192 MB to detect them", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () => { throw new Error("no request expected"); });
  await assert.rejects(client.submit({ media: "images", operation: "embed", filename: "a.png", bytes: new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]),
    data: { a: 1 }, idempotencyKey: "source_event_003" }), /accepts images up to 50 MB/);
  await assert.rejects(client.submit({ media: "videos", operation: "detect", filename: "a.mp4", bytes: new Blob([new Uint8Array(100 * 1024 * 1024 + 1)]),
    idempotencyKey: "source_event_004" }), /checks videos up to 100 MB/);
});

test("a refused upload raises with its status", async () => {
  const uploadId = "upl_" + "2".repeat(32);
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url) => new URL(String(url)).pathname === "/uploads"
    ? Response.json({ upload_id: uploadId, upload: { method: "PUT", url: `https://uploads.etchv.com/image/${uploadId}.png` } }, { status: 201 })
    : new Response("Forbidden", { status: 403 }));
  await assert.rejects(client.upload("image", new Blob(["x"]), "a.png"), (error: unknown) => error instanceof EtchvError && error.status === 403);
});

const batchId = "bat_" + "b".repeat(32);
const batchView = (status: string, items: Record<string, unknown>[]) => ({
  batch_id: batchId, status, item_count: items.length, archive: false, status_url: `/watermarks/batches/${batchId}`,
  counts: { pending: items.length, accepted: 0, rejected: 0, succeeded: 0, failed: 0, in_progress: 0 },
  credits: { reserved: 0, charged: 0, refunded: 0 }, items,
});

test("submitBatch creates one batch, uploads every file without the API key, then starts it", async () => {
  const calls: string[] = [];
  let manifest: unknown;
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url, init) => {
    const target = new URL(String(url));
    const headers = new Headers(init?.headers);
    calls.push(`${init?.method ?? "GET"} ${target.host}${target.pathname}`);
    if (target.host === "uploads.etchv.com") {
      assert.equal(headers.get("X-API-Key"), null);
      assert.equal(headers.get("Idempotency-Key"), null);
      assert.equal(target.searchParams.get("Signature"), "s");
      return new Response(null, { status: 200 });
    }
    assert.equal(headers.get("X-API-Key"), "etchv_test");
    if (target.pathname === "/watermarks/batches") {
      assert.equal(headers.get("Idempotency-Key"), "batch_event_001");
      manifest = JSON.parse(String(init?.body));
      return Response.json(batchView("draft", [0, 1, 2].map((index) => ({ index, filename: ["a.pdf", "b.png", "c.mov"][index], status: "pending",
        upload: { method: "PUT", url: `https://uploads.etchv.com/x/upl_${index}?Signature=s`, expires_at: "2026-10-09T18:00:00Z" } }))), { status: 201 });
    }
    assert.equal(target.pathname, `/watermarks/batches/${batchId}/start`);
    return Response.json(batchView("starting", [{ index: 0, filename: "a.pdf", status: "pending" }]), { status: 202 });
  });
  const batch = await client.submitBatch({
    idempotencyKey: "batch_event_001", archive: true, accelerator: "gpu",
    items: [
      { filename: "a.pdf", bytes: new Blob(["pdf"]), data: { recipient: "a" } },
      { filename: "b.png", bytes: new Blob(["png!"]), data: { recipient: "b" } },
      { filename: "c.mov", bytes: new Blob(["mov"]), data: { recipient: "c" } },
    ],
  });
  assert.equal(batch.status, "starting");
  assert.deepEqual(manifest, { items: [
    { filename: "a.pdf", size: 3, data: { recipient: "a" } },
    { filename: "b.png", size: 4, data: { recipient: "b" } },
    { filename: "c.mov", size: 3, data: { recipient: "c" } },
  ], archive: true, accelerator: "gpu" });
  assert.equal(calls[0], "POST api.etchv.com/watermarks/batches");
  assert.deepEqual(calls.slice(1, 4).sort(), ["PUT uploads.etchv.com/x/upl_0", "PUT uploads.etchv.com/x/upl_1", "PUT uploads.etchv.com/x/upl_2"]);
  assert.equal(calls[4], `POST api.etchv.com/watermarks/batches/${batchId}/start`);
});

test("submitBatch checks the 100-file cap and every file before any request", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () => { throw new Error("no request expected"); });
  const file = { filename: "a.png", bytes: new Blob(["x"]), data: { a: 1 } as Record<string, unknown> };
  const submit = (items: typeof file[], extra = {}) => client.submitBatch({ items, idempotencyKey: "batch_event_002", ...extra });
  await assert.rejects(submit(Array(101).fill(file)), /1 to 100 files; this one has 101/);
  await assert.rejects(submit([]), /1 to 100 files/);
  await assert.rejects(submit([file, { ...file, filename: "notes.txt" }]), /File 2 \(notes.txt\): batches take images/);
  await assert.rejects(submit([{ ...file, data: {} }]), /nonempty JSON object/);
  await assert.rejects(submit([{ ...file, filename: "a.pdf", bytes: new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]) }]), /PDFs up to 20 MB/);
  await assert.rejects(submit([file], { archive: true, storageDestinationId: "dst_" + "a".repeat(32) }), /cannot be combined/);
  await assert.rejects(client.submitBatch({ items: [file], idempotencyKey: "short" }), /Idempotency key/);
  assert.equal(batchMedia("Scan.TIFF"), "images");
  assert.equal(batchMedia("clip.mov"), "videos");
  assert.equal(batchMedia("noext"), undefined);
  assert.equal(batchMedia("x.constructor"), undefined);
});

test("a replayed batch that already started is returned without uploading or starting again", async () => {
  const calls: string[] = [];
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url) => {
    calls.push(new URL(String(url)).pathname);
    return Response.json(batchView("processing", [{ index: 0, filename: "a.png", status: "queued" }]));
  });
  const batch = await client.submitBatch({ items: [{ filename: "a.png", bytes: new Blob(["x"]), data: { a: 1 } }], idempotencyKey: "batch_event_003" });
  assert.equal(batch.status, "processing");
  assert.deepEqual(calls, ["/watermarks/batches"]);
});

test("a retried draft re-sends only the files the API has not received, then starts", async () => {
  const calls: string[] = [];
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url, init) => {
    const target = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${target.host}${target.pathname}`);
    if (target.host === "uploads.etchv.com") return new Response(null, { status: 200 });
    if (target.pathname === "/watermarks/batches") {
      return Response.json(batchView("draft", [
        { index: 0, filename: "a.png", status: "pending", upload_received: true },
        { index: 1, filename: "b.png", status: "pending", upload: { method: "PUT", url: "https://uploads.etchv.com/x/upl_1?Signature=s" } },
      ]));
    }
    return Response.json(batchView("starting", []), { status: 202 });
  });
  const file = (filename: string) => ({ filename, bytes: new Blob(["x"]), data: { a: 1 } });
  await client.submitBatch({ items: [file("a.png"), file("b.png")], idempotencyKey: "batch_event_004" });
  assert.deepEqual(calls, ["POST api.etchv.com/watermarks/batches", "PUT uploads.etchv.com/x/upl_1",
    `POST api.etchv.com/watermarks/batches/${batchId}/start`]);
});

test("a stalled signed upload times out instead of hanging", async () => {
  let attempts = 0;
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", (_url, init) => {
    attempts++;
    // Never answers; only the upload deadline ends the request.
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  });
  client.uploadTimeout = 20;
  const started = Date.now();
  await assert.rejects(client.putSigned({ method: "PUT", url: "https://uploads.etchv.com/x?Signature=s" }, new Blob(["x"])), /timed out/);
  assert.equal(attempts, 3);
  assert.ok(Date.now() - started < 5000);
});

test("batchStatus takes an ID or status_url and never returns signed upload URLs", async () => {
  const urls: string[] = [];
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async (url) => {
    urls.push(String(url));
    return Response.json(batchView("draft", [{ index: 0, filename: "a.png", status: "pending",
      upload: { method: "PUT", url: "https://uploads.etchv.com/x?Signature=s", expires_at: "" } }]));
  });
  const batch = await client.batchStatus(batchId);
  assert.equal(JSON.stringify(batch).includes("Signature"), false);
  await client.batchStatus(`/watermarks/batches/${batchId}`);
  assert.deepEqual(urls, [`https://api.etchv.com/watermarks/batches/${batchId}`, `https://api.etchv.com/watermarks/batches/${batchId}`]);
  await assert.rejects(client.batchStatus("https://elsewhere.test/watermarks/batches/" + batchId), /batch ID/);
  await assert.rejects(client.batchStatus("bat_123"), /batch ID/);
});

test("a signed upload URL must be HTTPS and carry no credentials", async () => {
  const client = new EtchvClient("etchv_test", "https://api.etchv.com", async () => { throw new Error("no request expected"); });
  for (const upload of [{ method: "PUT", url: "http://uploads.etchv.com/x" }, { method: "POST", url: "https://uploads.etchv.com/x" },
    { method: "PUT", url: "https://user:pass@uploads.etchv.com/x" }, { method: "PUT", url: "not a url" }, null]) {
    await assert.rejects(client.putSigned(upload, new Blob(["x"])), /invalid upload session/);
  }
});
