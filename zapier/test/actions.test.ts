import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../dist/index.js";

const integration = app as any;
const originalFetch = globalThis.fetch;

test("Zapier submission uploads the mapped file and returns a receipt", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url) === "https://files.example.test/new.png") return new Response(new Blob(["image bytes"]));
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "etchv_test");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "event_000001");
    assert.equal((init?.body as FormData).get("data"), '{"record":"123"}');
    return Response.json({ request_id: "req_1", status: "queued", status_url: "/watermarks/jobs/req_1" }, { status: 202 });
  };
  try {
    const result = await integration.creates.submit_watermark.operation.perform({}, { authData: { apiKey: "etchv_test" }, inputData: {
      media: "images", file: "https://files.example.test/new.png", filename: "new.png", idempotency_key: "event_000001",
      reference_data: '{"record":"123"}', accelerator: "gpu",
    } });
    assert.equal(result.request_id, "req_1");
    assert.deepEqual(calls, ["https://files.example.test/new.png", "https://api.etchv.com/watermarks/images/async?accelerator=gpu"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Zapier result action stashes authenticated output bytes", async () => {
  globalThis.fetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "etchv_test");
    return new Response(new Blob(["marked bytes"], { type: "image/png" }), { headers: { "Content-Disposition": 'attachment; filename="marked.png"', "X-Etchv-Accelerator": "gpu" } });
  };
  try {
    const result = await integration.creates.get_job_result.operation.perform({ stashFile: async (bytes: Buffer, size: number, name: string) => {
      assert.equal(bytes.toString(), "marked bytes"); assert.equal(size, 12); assert.equal(name, "marked.png");
      return "https://zapier.example.test/stashed";
    } }, { authData: { apiKey: "etchv_test" }, inputData: { result_path: "/watermarks/jobs/req_1/result", operation: "embed" } });
    assert.deepEqual(result, { filename: "marked.png", file: "https://zapier.example.test/stashed", accelerator: "gpu" });
  } finally { globalThis.fetch = originalFetch; }
});

test("Zapier submit actions offer an optional CPU/GPU accelerator", async () => {
  for (const key of ["submit_watermark", "submit_detection"]) {
    const field = integration.creates[key].operation.inputFields.find((item: { key: string }) => item.key === "accelerator");
    assert.deepEqual(field.choices, { cpu: "CPU (default)", gpu: "GPU" });
    assert.equal(field.required, false);
    assert.match(field.helpText, /Business or Enterprise/);
  }
  const calls: string[] = [];
  globalThis.fetch = async (url: URL | RequestInfo) => {
    calls.push(String(url));
    if (String(url).startsWith("https://files.example.test/")) return new Response(new Blob(["pdf bytes"]));
    return Response.json({ request_id: "req_2", status: "queued" }, { status: 202 });
  };
  try {
    await integration.creates.submit_detection.operation.perform({}, { authData: { apiKey: "etchv_test" }, inputData: {
      media: "documents", file: "https://files.example.test/new.pdf", filename: "new.pdf", idempotency_key: "event_000002", accelerator: "cpu",
    } });
    await integration.creates.submit_detection.operation.perform({}, { authData: { apiKey: "etchv_test" }, inputData: {
      media: "videos", file: "https://files.example.test/new.mp4", filename: "new.mp4", idempotency_key: "event_000003", accelerator: "gpu",
    } });
    assert.deepEqual(calls.filter((url) => url.startsWith("https://api.etchv.com")), [
      "https://api.etchv.com/watermarks/documents/detect/async",
      "https://api.etchv.com/watermarks/videos/detect/async?accelerator=gpu",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

const batchId = "bat_" + "b".repeat(32);

test("Zapier Submit Batch sends mapped line items as one batch", async () => {
  const calls: string[] = [];
  let manifest: unknown;
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${target.host}${target.pathname}`);
    if (target.host === "files.example.test") return new Response(new Blob([`bytes of ${target.pathname}`]));
    if (target.host === "uploads.etchv.com") {
      assert.equal(new Headers(init?.headers).get("X-API-Key"), null);
      return new Response(null, { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "etchv_test");
    if (target.pathname === "/watermarks/batches") {
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "event_batch_01");
      manifest = JSON.parse(String(init?.body));
      return Response.json({ batch_id: batchId, status: "draft", items: [0, 1].map((index) => ({ index, status: "pending",
        upload: { method: "PUT", url: `https://uploads.etchv.com/x/${index}?Signature=s` } })) }, { status: 201 });
    }
    return Response.json({ batch_id: batchId, status: "starting", items: [{ index: 0, status: "pending" }, { index: 1, status: "pending" }] }, { status: 202 });
  };
  try {
    const result = await integration.creates.submit_batch.operation.perform({}, { authData: { apiKey: "etchv_test" }, inputData: {
      files: ["https://files.example.test/a.pdf", "https://files.example.test/b.png"], filenames: ["contract-acme.pdf", "cover.png"],
      reference_data: ['{"recipient":"acme"}', '{"recipient":"globex"}'], idempotency_key: "event_batch_01", archive: "true", accelerator: "cpu",
    } });
    assert.equal(result.batch_id, batchId);
    assert.equal(JSON.stringify(result).includes("Signature"), false);
    assert.deepEqual(manifest, { archive: true, items: [
      { filename: "contract-acme.pdf", size: "bytes of /a.pdf".length, data: { recipient: "acme" } },
      { filename: "cover.png", size: "bytes of /b.png".length, data: { recipient: "globex" } },
    ] });
    assert.equal(calls.filter((call) => call.startsWith("PUT uploads.etchv.com")).length, 2);
    assert.equal(calls.at(-1), `POST api.etchv.com/watermarks/batches/${batchId}/start`);
  } finally { globalThis.fetch = originalFetch; }
});

test("Zapier Submit Batch checks the mapping before downloading anything", async () => {
  globalThis.fetch = async () => { throw new Error("no request expected"); };
  const perform = (inputData: Record<string, unknown>) => integration.creates.submit_batch.operation.perform({},
    { authData: { apiKey: "etchv_test" }, inputData: { idempotency_key: "event_batch_02", ...inputData } });
  try {
    const urls = Array.from({ length: 101 }, (_, index) => `https://files.example.test/${index}.png`);
    await assert.rejects(perform({ files: urls, filenames: urls.map((_, i) => `${i}.png`), reference_data: ['{"a":1}'] }), /up to 100 files; 101 were mapped/);
    await assert.rejects(perform({ files: ["https://files.example.test/a.png"], filenames: [], reference_data: ['{"a":1}'] }), /one filename per file/);
    await assert.rejects(perform({ files: ["https://files.example.test/a.png", "https://files.example.test/b.png"], filenames: ["a.png", "b.png"],
      reference_data: ['{"a":1}', '{"a":2}', '{"a":3}'] }), /one reference data object per file/);
    await assert.rejects(perform({ files: ["https://files.example.test/a.txt"], filenames: ["a.txt"], reference_data: ['{"a":1}'] }), /batches take images/);
    await assert.rejects(perform({ files: ["https://files.example.test/a.png"], filenames: ["a.png"], reference_data: ["not json"] }), /not valid JSON/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Zapier Get Batch Status is a search that returns the batch", async () => {
  globalThis.fetch = async (url: URL | RequestInfo) => {
    assert.equal(String(url), `https://api.etchv.com/watermarks/batches/${batchId}`);
    return Response.json({ batch_id: batchId, status: "completed", counts: { succeeded: 2 } });
  };
  try {
    const search = integration.searches.get_batch_status;
    assert.equal(search.display.label, "Get Batch Status");
    const result = await search.operation.perform({}, { authData: { apiKey: "etchv_test" }, inputData: { batch_id: `/watermarks/batches/${batchId}` } });
    assert.deepEqual(result, [{ batch_id: batchId, status: "completed", counts: { succeeded: 2 } }]);
  } finally { globalThis.fetch = originalFetch; }
});
