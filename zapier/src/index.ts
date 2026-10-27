import { defineApp, version as platformVersion } from "zapier-platform-core";
import { ACCELERATOR_HELP, EtchvClient, MAX_BATCH_ITEMS, batchMedia, maxBytes, uploadLimitError, type Media, type Operation } from "../../core/etchv";

type ZapContext = { stashFile: (bytes: Buffer, size: number, filename: string, contentType: string) => string | Promise<string> };
type Bundle = { authData: Record<string, string>; inputData: Record<string, string> };
const client = (bundle: { authData: Record<string, string> }) => new EtchvClient(bundle.authData.apiKey);

async function sourceFile(url: string, media: Media, operation: Operation): Promise<Blob> {
  const limit = maxBytes(media, operation);
  let response: Response | undefined;
  for (let redirect = 0; redirect < 5; redirect++) {
    const source = new URL(url);
    if (source.protocol !== "https:") throw new Error("Map an HTTPS file from a previous Zap step.");
    response = await fetch(source, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("Source file redirected without a location.");
    await response.body?.cancel();
    url = new URL(location, source).toString();
  }
  if (!response || [301, 302, 303, 307, 308].includes(response.status)) throw new Error("Source file redirected too many times.");
  if (!response.ok) throw new Error(`Source file returned HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit) throw uploadLimitError(media, operation);
  if (!response.body) throw new Error("Source file is empty.");
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw uploadLimitError(media, operation); }
    chunks.push(Uint8Array.from(value).buffer);
  }
  return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
}

const mediaChoices = { images: "Image", documents: "PDF", videos: "Video" };
const jobFields = [
  { key: "media", label: "Media", required: true, choices: mediaChoices },
  { key: "file", label: "File", type: "file", required: true },
  { key: "filename", label: "Filename", required: true },
  { key: "idempotency_key", label: "Idempotency key", required: true, helpText: "Use a stable source event ID and operation. Keep it unchanged when retrying." },
  { key: "accelerator", label: "Accelerator", required: false, choices: { cpu: "CPU (default)", gpu: "GPU" }, default: "cpu", helpText: ACCELERATOR_HELP },
] as const;

function submitAction(operation: Operation) {
  return {
    key: operation === "embed" ? "submit_watermark" : "submit_detection",
    noun: "Job",
    display: { label: operation === "embed" ? "Submit Watermark" : "Submit Detection", description: `Submit an Etchv ${operation === "embed" ? "watermark" : "detection"} job for an image, PDF, or video.` },
    operation: {
      inputFields: [...jobFields, ...(operation === "embed" ? [
        { key: "reference_data", label: "Reference data (JSON object)", required: true },
        { key: "storage_destination_id", label: "Storage destination ID" },
        { key: "storage_key", label: "Storage key" },
      ] : [])],
      perform: async (_z: unknown, bundle: any) => {
        const data = operation === "embed" ? JSON.parse(bundle.inputData.reference_data) : undefined;
        return client(bundle).submit({ media: bundle.inputData.media as Media, operation,
          filename: bundle.inputData.filename, bytes: await sourceFile(bundle.inputData.file, bundle.inputData.media as Media, operation),
          data, idempotencyKey: bundle.inputData.idempotency_key,
          storageDestinationId: bundle.inputData.storage_destination_id, storageKey: bundle.inputData.storage_key,
          accelerator: bundle.inputData.accelerator });
      },
      sample: { request_id: "req_example", status: "queued", status_url: "/watermarks/jobs/req_example", result_url: "/watermarks/jobs/req_example/result", accelerator_requested: "cpu", accelerator: null },
    },
  };
}

/** A list field's values; a single mapped value arrives as a plain string. */
const listOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value === undefined || value === null || value === "" ? [] : [String(value)];
const batchSample = {
  batch_id: "bat_example", status: "starting", item_count: 2, archive: false, status_url: "/watermarks/batches/bat_example",
  counts: { pending: 2, accepted: 0, rejected: 0, succeeded: 0, failed: 0, in_progress: 0 },
  credits: { reserved: 0, charged: 0, refunded: 0 },
  items: [{ index: 0, filename: "contract-acme.pdf", status: "pending", request_id: null, error_code: null }],
};

const submitBatch = {
  key: "submit_batch", noun: "Batch",
  display: { label: "Submit Batch", description: `Watermark up to ${MAX_BATCH_ITEMS} files in one batch, each with its own reference data.` },
  operation: {
    inputFields: [
      { key: "files", label: "Files", type: "file" as const, list: true, required: true, helpText: `Up to ${MAX_BATCH_ITEMS} images, PDFs, or MP4/MOV videos. Map line items from a previous step.` },
      { key: "filenames", label: "Filenames", list: true, required: true, helpText: "One name per file, in the same order, with the extension (for example contract-acme.pdf)." },
      { key: "reference_data", label: "Reference data (JSON objects)", list: true, required: true, helpText: "One JSON object per file, in the same order, or a single object for every file." },
      { key: "idempotency_key", label: "Idempotency key", required: true, helpText: "Use a stable source event ID. Keep it unchanged when retrying so the same batch is returned." },
      { key: "archive", label: "Zip archive", type: "boolean" as const, required: false, default: "false", helpText: "Also zip every result into one download." },
      { key: "accelerator", label: "Accelerator", required: false, choices: { cpu: "CPU (default)", gpu: "GPU" }, default: "cpu", helpText: ACCELERATOR_HELP },
    ],
    perform: async (_z: unknown, bundle: any) => {
      const files = listOf(bundle.inputData.files);
      const names = listOf(bundle.inputData.filenames);
      const references = listOf(bundle.inputData.reference_data);
      if (files.length > MAX_BATCH_ITEMS) throw new Error(`A batch takes up to ${MAX_BATCH_ITEMS} files; ${files.length} were mapped. Split them into several batches.`);
      if (names.length !== files.length) throw new Error(`Map one filename per file: ${files.length} files and ${names.length} filenames.`);
      if (references.length !== files.length && references.length !== 1) {
        throw new Error(`Map one reference data object per file, or one for every file: ${files.length} files and ${references.length} objects.`);
      }
      const items = [];
      for (const [index, url] of files.entries()) {
        const filename = names[index];
        const media = batchMedia(filename);
        if (!media) throw new Error(`File ${index + 1} (${filename}): batches take images, PDFs and MP4 or MOV videos, named with their extension.`);
        const reference = references[references.length === 1 ? 0 : index];
        let data: Record<string, unknown>;
        try { data = JSON.parse(reference); } catch { throw new Error(`File ${index + 1} (${filename}): reference data is not valid JSON.`); }
        items.push({ filename, bytes: await sourceFile(url, media, "embed"), data });
      }
      return client(bundle).submitBatch({ items, idempotencyKey: bundle.inputData.idempotency_key,
        archive: [true, "true", "yes"].includes(bundle.inputData.archive), accelerator: bundle.inputData.accelerator });
    },
    sample: batchSample,
  },
};

export default defineApp({
  version: "0.1.0", platformVersion,
  authentication: {
    type: "custom",
    fields: [{ key: "apiKey", label: "Etchv API key", type: "password", required: true, helpText: "Create a scoped key in [Etchv API keys](https://etchv.com/dashboard/api-keys). See the [Zapier setup guide](https://etchv.com/docs/integrations/zapier)." }],
    test: async (_z, bundle) => client(bundle).connection(),
    connectionLabel: "{{organization_id}}",
  },
  creates: {
    submit_batch: submitBatch,
    submit_watermark: submitAction("embed"),
    submit_detection: submitAction("detect"),
    get_job_status: {
      key: "get_job_status", noun: "Job", display: { label: "Get Job Status", description: "Check whether a submitted Etchv job has completed." },
      operation: { inputFields: [{ key: "status_path", required: true, label: "Status path" }],
        perform: async (_z: unknown, bundle: any) => client(bundle).status(bundle.inputData.status_path),
        sample: { request_id: "req_example", status: "succeeded", result_url: "/watermarks/jobs/req_example/result", accelerator_requested: "cpu", accelerator: "cpu" } },
    },
    get_job_result: {
      key: "get_job_result", noun: "Result", display: { label: "Get Job Result", description: "Collect a completed watermarked file or detection result." },
      operation: { inputFields: [
        { key: "result_path", required: true, label: "Result path" },
        { key: "operation", required: true, label: "Operation", choices: { embed: "Watermark", detect: "Detection" } },
      ], perform: async (z: ZapContext, bundle: any) => {
        const result = await client(bundle).result(bundle.inputData.result_path, bundle.inputData.operation as Operation);
        if (result.kind === "json") return result.value;
        const bytes = Buffer.from(await result.bytes.arrayBuffer());
        return { filename: result.filename, file: await z.stashFile(bytes, bytes.length, result.filename, result.bytes.type || "application/octet-stream"),
          ...(result.accelerator ? { accelerator: result.accelerator } : {}) };
      }, outputFields: [{ key: "file", type: "file" }, { key: "filename" }, { key: "accelerator", label: "Accelerator used" }],
      sample: { filename: "marked.png", file: "https://example.com/marked.png", accelerator: "cpu" } },
    },
    download_asset: {
      key: "download_asset", noun: "Asset", display: { label: "Download Asset", description: "Download an available Etchv asset by ID." },
      operation: { inputFields: [{ key: "asset_id", required: true, label: "Asset ID" }],
        perform: async (z: ZapContext, bundle: any) => {
          const result = await client(bundle).asset(bundle.inputData.asset_id);
          const bytes = Buffer.from(await result.bytes.arrayBuffer());
          return { filename: result.filename, file: await z.stashFile(bytes, bytes.length, result.filename, result.bytes.type || "application/octet-stream") };
        }, outputFields: [{ key: "file", type: "file" }, { key: "filename" }], sample: { filename: "marked.png", file: "https://example.com/marked.png" } },
    },
  },
  searches: {
    get_batch_status: {
      key: "get_batch_status", noun: "Batch",
      display: { label: "Get Batch Status", description: "Find a batch by ID and read its status, counts, and each file's result path." },
      operation: {
        inputFields: [{ key: "batch_id", label: "Batch ID", required: true, helpText: "Map batch_id or status_url from Submit Batch." }],
        perform: async (_z: unknown, bundle: any) => [await client(bundle).batchStatus(bundle.inputData.batch_id)],
        sample: { ...batchSample, status: "completed",
          counts: { pending: 0, accepted: 2, rejected: 0, succeeded: 2, failed: 0, in_progress: 0 },
          items: [{ index: 0, filename: "contract-acme.pdf", status: "succeeded", request_id: "req_example", error_code: null,
            result_url: "/watermarks/jobs/req_example/result" }] },
      },
    },
  },
});
