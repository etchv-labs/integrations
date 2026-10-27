import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { Etchv } = require("../dist/n8n/nodes/Etchv.node.js");
const originalFetch = globalThis.fetch;

test("n8n submission reads binary input and outputs a job receipt", async () => {
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(String(url), "https://api.etchv.com/watermarks/documents/async?accelerator=gpu");
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "etchv_test");
    assert.equal((init?.body as FormData).get("data"), '{"delivery":"001"}');
    return Response.json({ request_id: "req_1", status: "queued", status_url: "/watermarks/jobs/req_1" }, { status: 202 });
  };
  try {
    const parameters: Record<string, string> = { operation: "embed", media: "documents", binaryProperty: "data", referenceData: '{"delivery":"001"}', idempotencyKey: "delivery_001", storageDestinationId: "", storageKey: "", accelerator: "gpu" };
    const context = {
      getInputData: () => [{ json: {}, binary: { data: { fileName: "source.pdf" } } }],
      getCredentials: async () => ({ apiKey: "etchv_test" }),
      getNodeParameter: (name: string) => parameters[name],
      helpers: { getBinaryDataBuffer: async () => Buffer.from("pdf bytes") },
      continueOnFail: () => false,
    };
    const result = await new Etchv().execute.call(context);
    assert.equal(result[0][0].json.request_id, "req_1");
  } finally { globalThis.fetch = originalFetch; }
});

test("n8n download produces a native binary field", async () => {
  globalThis.fetch = async () => new Response(new Blob(["marked"]), { headers: { "Content-Disposition": 'attachment; filename="marked.png"', "X-Etchv-Accelerator": "gpu" } });
  try {
    const context = {
      getInputData: () => [{ json: {} }], getCredentials: async () => ({ apiKey: "etchv_test" }),
      getNodeParameter: (name: string) => ({ operation: "result", resultPath: "/watermarks/jobs/req_1/result", resultOperation: "embed" } as Record<string, string>)[name],
      helpers: { prepareBinaryData: async (bytes: Buffer, filename: string) => {
        assert.equal(bytes.toString(), "marked"); assert.equal(filename, "marked.png"); return { data: bytes.toString("base64") };
      } }, continueOnFail: () => false,
    };
    const result = await new Etchv().execute.call(context);
    assert.equal(result[0][0].binary.data.data, Buffer.from("marked").toString("base64"));
    assert.deepEqual(result[0][0].json, { filename: "marked.png", accelerator: "gpu" });
  } finally { globalThis.fetch = originalFetch; }
});

test("n8n accepts reference data supplied as an object by an expression", async () => {
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(String(url), "https://api.etchv.com/watermarks/images/async");
    assert.equal((init?.body as FormData).get("data"), '{"asset":"142"}');
    return Response.json({ request_id: "req_2", status: "queued" }, { status: 202 });
  };
  try {
    const parameters: Record<string, unknown> = { operation: "embed", media: "images", binaryProperty: "data", referenceData: { asset: "142" }, idempotencyKey: "asset_142_embed", storageDestinationId: "", storageKey: "", accelerator: "cpu" };
    const context = {
      getInputData: () => [{ json: {}, binary: { data: { fileName: "source.png" } } }],
      getCredentials: async () => ({ apiKey: "etchv_test" }),
      getNodeParameter: (name: string) => parameters[name],
      helpers: { getBinaryDataBuffer: async () => Buffer.from("png bytes") },
      continueOnFail: () => false,
    };
    assert.equal((await new Etchv().execute.call(context))[0][0].json.request_id, "req_2");
  } finally { globalThis.fetch = originalFetch; }
});

test("n8n detection results include the accelerator that processed the job", async () => {
  globalThis.fetch = async () => Response.json({ watermarked: false, watermark_id: null }, { headers: { "X-Etchv-Accelerator": "cpu" } });
  try {
    const context = {
      getInputData: () => [{ json: {} }], getCredentials: async () => ({ apiKey: "etchv_test" }),
      getNodeParameter: (name: string) => ({ operation: "result", resultPath: "/watermarks/detection-jobs/req_1/result", resultOperation: "detect" } as Record<string, string>)[name],
      helpers: {}, continueOnFail: () => false,
    };
    const result = await new Etchv().execute.call(context);
    assert.deepEqual(result[0][0].json, { watermarked: false, watermark_id: null, accelerator: "cpu" });
  } finally { globalThis.fetch = originalFetch; }
});

test("n8n offers a CPU/GPU accelerator choice on submit operations", () => {
  const property = new Etchv().description.properties.find((item: { name: string }) => item.name === "accelerator");
  assert.equal(property.default, "cpu");
  assert.deepEqual(property.options.map((option: { value: string }) => option.value), ["cpu", "gpu"]);
  assert.deepEqual(property.displayOptions.show.operation, ["embed", "detect", "batch"]);
  assert.match(property.description, /Business or Enterprise/);
});

const batchId = "bat_" + "b".repeat(32);

test("n8n batch turns three incoming items into one batch and one paired output item", async () => {
  const calls: string[] = [];
  let manifest: { items: { filename: string; size: number; data: unknown }[]; archive: boolean } | undefined;
  globalThis.fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push(`${init?.method} ${target.host}${target.pathname}`);
    if (target.host === "uploads.etchv.com") {
      assert.equal(new Headers(init?.headers).get("X-API-Key"), null);
      return new Response(null, { status: 200 });
    }
    if (target.pathname === "/watermarks/batches") {
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "run_0001_batch");
      manifest = JSON.parse(String(init?.body));
      return Response.json({ batch_id: batchId, status: "draft", items: [0, 1, 2].map((index) => ({ index, status: "pending",
        upload: { method: "PUT", url: `https://uploads.etchv.com/x/${index}?Signature=s` } })) }, { status: 201 });
    }
    return Response.json({ batch_id: batchId, status: "starting", item_count: 3, items: [0, 1, 2].map((index) => ({ index, status: "pending" })) }, { status: 202 });
  };
  try {
    const names = ["a.pdf", "b.png", "c.mp4"];
    const context = {
      getInputData: () => names.map((fileName) => ({ json: { fileName }, binary: { data: { fileName } } })),
      getCredentials: async () => ({ apiKey: "etchv_test" }),
      // Parameters are evaluated per item, so expressions give each file its own data.
      getNodeParameter: (name: string, index: number) => ({ operation: "batch", binaryProperty: "data",
        referenceData: JSON.stringify({ recipient: `r${index}` }), idempotencyKey: index === 0 ? "run_0001_batch" : "ignored_key",
        archive: true, accelerator: "cpu", storageDestinationId: "" } as Record<string, unknown>)[name],
      helpers: { getBinaryDataBuffer: async (index: number) => Buffer.from(`bytes ${index}`) },
      continueOnFail: () => false,
    };
    const result = await new Etchv().execute.call(context);
    assert.equal(result[0].length, 1);
    assert.equal(result[0][0].json.batch_id, batchId);
    assert.deepEqual(result[0][0].pairedItem, [{ item: 0 }, { item: 1 }, { item: 2 }]);
    assert.deepEqual(manifest, { archive: true, items: names.map((filename, index) => ({ filename, size: 7, data: { recipient: `r${index}` } })) });
    assert.equal(calls.filter((call) => call === "POST api.etchv.com/watermarks/batches").length, 1);
    assert.equal(calls.filter((call) => call.startsWith("PUT uploads.etchv.com")).length, 3);
    assert.equal(calls.at(-1), `POST api.etchv.com/watermarks/batches/${batchId}/start`);
  } finally { globalThis.fetch = originalFetch; }
});

test("n8n batch refuses more than 100 items with a clear message", async () => {
  globalThis.fetch = async () => { throw new Error("no request expected"); };
  try {
    const context = {
      getInputData: () => Array.from({ length: 101 }, () => ({ json: {}, binary: { data: { fileName: "a.png" } } })),
      getCredentials: async () => ({ apiKey: "etchv_test" }),
      getNodeParameter: (name: string) => ({ operation: "batch" } as Record<string, unknown>)[name],
      helpers: {}, continueOnFail: () => true,
    };
    const result = await new Etchv().execute.call(context);
    assert.equal(result[0].length, 1);
    assert.match(String(result[0][0].json.error), /up to 100 files and 101 items arrived/);
    assert.equal(result[0][0].pairedItem.length, 101);
  } finally { globalThis.fetch = originalFetch; }
});

test("n8n reads a batch's status by ID", async () => {
  globalThis.fetch = async (url: URL | RequestInfo) => {
    assert.equal(String(url), `https://api.etchv.com/watermarks/batches/${batchId}`);
    return Response.json({ batch_id: batchId, status: "completed", items: [{ index: 0, status: "succeeded", upload: { url: "https://uploads.etchv.com/x" } }] });
  };
  try {
    const context = {
      getInputData: () => [{ json: {} }], getCredentials: async () => ({ apiKey: "etchv_test" }),
      getNodeParameter: (name: string) => ({ operation: "batchStatus", batchId } as Record<string, string>)[name],
      helpers: {}, continueOnFail: () => false,
    };
    const result = await new Etchv().execute.call(context);
    assert.deepEqual(result[0][0].json, { batch_id: batchId, status: "completed", items: [{ index: 0, status: "succeeded" }] });
  } finally { globalThis.fetch = originalFetch; }
});
