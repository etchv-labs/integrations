import { defineApp, version as platformVersion } from "zapier-platform-core";
import packageJson from "../package.json" with { type: "json" };
import { ACCELERATOR_HELP, EtchvClient, MAX_BATCH_ITEMS, addressList, batchMedia, maxBytes, uploadLimitError, type LinkPrepare, type Media, type Operation } from "../../core/etchv";

type ZapContext = { stashFile: (bytes: Buffer, size: number, filename: string, contentType: string) => string | Promise<string> };
type CursorContext = { cursor: { get: () => Promise<string | undefined>; set: (cursor: string) => Promise<unknown> } };
type Bundle = { authData: Record<string, string>; inputData: Record<string, string> };
/** Names this connector to the API. */
const USER_AGENT = `etchv-zapier/${packageJson.version}`;
const client = (bundle: { authData: Record<string, string> }) =>
  new EtchvClient(bundle.authData.apiKey, undefined, undefined, USER_AGENT);

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
        { key: "storage_destination_id", label: "Storage destination ID", dynamic: "list_storage_destinations.id.name",
          helpText: "Optional. Deliver the watermarked file to one of your storage destinations (needs storage:read to list them)." },
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

/** A hidden trigger for an asset picker. Zapier asks for page 1, 2… on "Load more"; the API's cursor
 * carries over between them, and past the last page there is none, so nothing more is listed. */
const assetPicker = (key: string, description: string, kind?: "source" | "watermarked") => ({
  key, noun: "Asset", display: { label: "List Assets", description, hidden: true },
  operation: { canPaginate: true,
    perform: async (z: CursorContext, bundle: any) => {
      const later = Boolean(bundle.meta?.page);
      const cursor = later ? await z.cursor.get() : undefined;
      if (later && !cursor) return [];
      const page = await client(bundle).assets(cursor, 100, kind);
      await z.cursor.set(page.next_cursor ?? "");
      return page.items.map((item) => ({ id: item.id, name: item.name, kind: item.kind, media_type: item.media_type }));
    }, sample: { id: "ast_example", name: "contract-acme.pdf", kind: kind ?? "watermarked", media_type: "document" } },
});

const linkSample = {
  id: "lnk_example", url: "https://etchv.com/l/example", name: "Board pack, October", asset_id: "ast_example", media_type: "document",
  status: "active", prepare: "on_open", allowed_domains: [], expires_at: "2026-11-27T14:02:00+00:00", download_limit: 3,
  recipient_count: 2, credits_per_copy: 4, estimated_credits: 8, batch_id: null, webhook_id: null,
  created_at: "2026-10-28T14:02:00+00:00", revoked_at: null,
  recipients: [{ email: "alex@example.com", status: "not_opened", opened_at: null, last_opened_at: null, open_count: 0, download_count: 0,
    copy: { status: "not_started", asset_id: null, error_code: null } }],
};

const createLink = {
  key: "create_link", noun: "Link",
  display: { label: "Create Traceable Link", description: "Share a file from your Etchv library so each recipient opens their own watermarked copy." },
  operation: {
    inputFields: [
      { key: "asset_id", label: "Source asset ID", required: true, dynamic: "list_source_assets.id.name", helpText: "The original in your Etchv asset library (ast_…), such as the source of a file you watermarked." },
      { key: "name", label: "Link name", required: true, helpText: "Shown to recipients on the page they open. Up to 200 characters." },
      { key: "recipients", label: "Recipients", list: true, helpText: "Email addresses only, without names, up to 100. Give recipients or allowed domains, not both." },
      { key: "allowed_domains", label: "Allowed domains", list: true, helpText: "Anyone with a confirmed email at exactly one of these domains may open the link, up to 10." },
      { key: "expires_at", label: "Expires at", type: "datetime" as const, helpText: "Default 30 days from now, or sooner if the source file expires first. At most a year." },
      { key: "prepare", label: "Make copies", choices: { on_open: "When each recipient opens it", on_create: "All at once, now" }, helpText: "Leave empty for the default: all at once for video and PDFs over 5 pages. Links for allowed domains always make copies when opened." },
      { key: "download_limit", label: "Downloads per recipient", type: "integer" as const, helpText: "1 to 100. Leave empty or 0 for no limit." },
      { key: "webhook_id", label: "Webhook ID", helpText: "An Etchv webhook endpoint (wh_…) that receives an event each time a recipient opens the link." },
      { key: "idempotency_key", label: "Idempotency key", required: true, helpText: "Use a stable source event ID. Keep it unchanged when retrying so the same link is returned." },
    ],
    perform: async (_z: unknown, bundle: any) => {
      const input = bundle.inputData;
      return client(bundle).createLink({ assetId: input.asset_id, name: input.name,
        recipients: addressList(input.recipients), allowedDomains: addressList(input.allowed_domains),
        expiresAt: input.expires_at || undefined, prepare: (input.prepare || undefined) as LinkPrepare | undefined,
        downloadLimit: Number(input.download_limit) > 0 ? Number(input.download_limit) : undefined,
        webhookId: input.webhook_id || undefined, idempotencyKey: input.idempotency_key });
    },
    sample: linkSample,
  },
};

export default defineApp({
  version: packageJson.version, platformVersion,
  authentication: {
    type: "custom",
    fields: [{ key: "apiKey", label: "Etchv API key", type: "password", required: true, helpText: "Create a scoped key in [Etchv API keys](https://etchv.com/dashboard/api-keys). See the [Zapier setup guide](https://etchv.com/docs/integrations/zapier?utm_source=zapier&utm_medium=app&utm_campaign=integrations)." }],
    test: async (_z, bundle) => client(bundle).connection(),
    connectionLabel: "{{organization_id}}",
  },
  // Hidden triggers: they only fill the asset and storage destination pickers.
  triggers: {
    list_assets: assetPicker("list_assets", "Lists assets for the Asset ID picker."),
    list_source_assets: assetPicker("list_source_assets", "Lists source assets for the Source asset ID picker.", "source"),
    list_storage_destinations: {
      key: "list_storage_destinations", noun: "Destination",
      display: { label: "List Storage Destinations", description: "Lists storage destinations for the picker.", hidden: true },
      operation: {
        // A disabled destination is refused at submission, so it isn't offered.
        perform: async (_z: unknown, bundle: any) => (await client(bundle).storageDestinations())
          .filter((destination) => destination.enabled).map(({ id, name, provider }) => ({ id, name, provider })),
        sample: { id: "dst_example", name: "Archive bucket", provider: "s3" } },
    },
  },
  creates: {
    create_link: createLink,
    submit_batch: submitBatch,
    submit_watermark: submitAction("embed"),
    submit_detection: submitAction("detect"),
    get_job_status: {
      key: "get_job_status", noun: "Job", display: { label: "Get Job Status", description: "Check whether a submitted Etchv job has completed." },
      operation: { inputFields: [{ key: "status_path", required: true, label: "Status path" }],
        perform: async (_z: unknown, bundle: any) => client(bundle).status(bundle.inputData.status_path),
        sample: { request_id: "req_example", status: "succeeded", result_url: "/watermarks/jobs/req_example/result", accelerator_requested: "cpu", accelerator: "cpu" } },
    },
    get_batch_status: {
      key: "get_batch_status", noun: "Batch",
      display: { label: "Get Batch Status", description: "Read a batch's status, counts, and each file's result path." },
      operation: {
        inputFields: [{ key: "batch_id", label: "Batch ID", required: true, helpText: "Map batch_id or status_url from Submit Batch." }],
        perform: async (_z: unknown, bundle: any) => client(bundle).batchStatus(bundle.inputData.batch_id),
        sample: { ...batchSample, status: "completed",
          counts: { pending: 0, accepted: 2, rejected: 0, succeeded: 2, failed: 0, in_progress: 0 },
          items: [{ index: 0, filename: "contract-acme.pdf", status: "succeeded", request_id: "req_example", error_code: null,
            result_url: "/watermarks/jobs/req_example/result" }] },
      },
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
      operation: { inputFields: [{ key: "asset_id", required: true, label: "Asset ID", dynamic: "list_assets.id.name",
        helpText: "Pick an asset, or map asset_id from Get Job Status." }],
        perform: async (z: ZapContext, bundle: any) => {
          const result = await client(bundle).asset(bundle.inputData.asset_id);
          const bytes = Buffer.from(await result.bytes.arrayBuffer());
          return { filename: result.filename, file: await z.stashFile(bytes, bytes.length, result.filename, result.bytes.type || "application/octet-stream") };
        }, outputFields: [{ key: "file", type: "file" }, { key: "filename" }], sample: { filename: "marked.png", file: "https://example.com/marked.png" } },
    },
  },
});
