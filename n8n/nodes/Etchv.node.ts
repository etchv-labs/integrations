import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
import { ACCELERATOR_HELP, EtchvClient, MAX_BATCH_ITEMS, addressList, type LinkPrepare, type Media, type Operation } from "../../core/etchv";

/** Names this node to the API; keep the version equal to package.json. */
const USER_AGENT = "etchv-n8n/0.1.0";

export class Etchv implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Etchv", name: "etchv", icon: "file:etchv.svg", group: ["transform"], version: 1,
    description: "Watermark and detect images, PDFs, and videos", defaults: { name: "Etchv" },
    inputs: ["main"], outputs: ["main"], credentials: [{ name: "etchvApi", required: true }],
    properties: [
      { displayName: "Operation", name: "operation", type: "options", default: "embed", options: [
        { name: "Submit Watermark", value: "embed" }, { name: "Submit Detection", value: "detect" },
        { name: "Get Job Status", value: "status" }, { name: "Get Job Result", value: "result" },
        { name: "Download Asset", value: "asset" },
        { name: "Submit Batch", value: "batch", description: `Watermark every incoming item's file in one batch (up to ${MAX_BATCH_ITEMS})` },
        { name: "Get Batch Status", value: "batchStatus" },
        { name: "Create Traceable Link", value: "createLink", description: "Share a library file so each recipient opens their own watermarked copy" },
      ] },
      { displayName: "Media", name: "media", type: "options", default: "images", displayOptions: { show: { operation: ["embed", "detect"] } }, options: [
        { name: "Image", value: "images" }, { name: "PDF", value: "documents" }, { name: "Video", value: "videos" },
      ] },
      { displayName: "Input Binary Field", name: "binaryProperty", type: "string", default: "data", required: true, displayOptions: { show: { operation: ["embed", "detect", "batch"] } } },
      { displayName: "Reference Data (JSON)", name: "referenceData", type: "json", default: "{}", required: true, displayOptions: { show: { operation: ["embed", "batch"] } }, description: "For a batch, an expression here is evaluated for each incoming item" },
      { displayName: "Idempotency Key", name: "idempotencyKey", type: "string", default: "", required: true, displayOptions: { show: { operation: ["embed", "detect", "batch", "createLink"] } }, description: "Stable source event ID plus operation; reuse unchanged on retry. A batch uses the first item's value" },
      { displayName: "Zip Archive", name: "archive", type: "boolean", default: false, displayOptions: { show: { operation: ["batch"] } }, description: "Whether to also zip every result into one download" },
      { displayName: "Batch ID", name: "batchId", type: "string", default: "", required: true, displayOptions: { show: { operation: ["batchStatus"] } }, description: "The batch_id or status_url from Submit Batch" },
      { displayName: "Accelerator", name: "accelerator", type: "options", default: "cpu", displayOptions: { show: { operation: ["embed", "detect", "batch"] } }, options: [
        { name: "CPU (Default)", value: "cpu" }, { name: "GPU", value: "gpu" },
      ], description: ACCELERATOR_HELP },
      { displayName: "Status Path", name: "statusPath", type: "string", default: "", required: true, displayOptions: { show: { operation: ["status"] } } },
      { displayName: "Result Path", name: "resultPath", type: "string", default: "", required: true, displayOptions: { show: { operation: ["result"] } } },
      { displayName: "Result Operation", name: "resultOperation", type: "options", default: "embed", displayOptions: { show: { operation: ["result"] } }, options: [{ name: "Watermark", value: "embed" }, { name: "Detection", value: "detect" }] },
      { displayName: "Asset ID", name: "assetId", type: "string", default: "", required: true, displayOptions: { show: { operation: ["asset"] } } },
      { displayName: "Source Asset ID", name: "sourceAssetId", type: "string", default: "", required: true, displayOptions: { show: { operation: ["createLink"] } }, description: "The original in your Etchv asset library (ast_…) to share" },
      { displayName: "Link Name", name: "linkName", type: "string", default: "", required: true, displayOptions: { show: { operation: ["createLink"] } }, description: "Shown to recipients on the page they open. Up to 200 characters" },
      { displayName: "Recipients", name: "recipients", type: "string", default: "", typeOptions: { rows: 4 }, displayOptions: { show: { operation: ["createLink"] } }, description: "Email addresses only, without names, separated by commas or line breaks, up to 100. Give recipients or allowed domains, not both" },
      { displayName: "Allowed Domains", name: "allowedDomains", type: "string", default: "", typeOptions: { rows: 2 }, displayOptions: { show: { operation: ["createLink"] } }, description: "Anyone with a confirmed email at exactly one of these domains may open the link, up to 10" },
      { displayName: "Expires At", name: "expiresAt", type: "dateTime", default: "", displayOptions: { show: { operation: ["createLink"] } }, description: "Default 30 days from now, or sooner if the source file expires first. At most a year" },
      { displayName: "Make Copies", name: "prepare", type: "options", default: "", displayOptions: { show: { operation: ["createLink"] } }, options: [
        { name: "Default", value: "" }, { name: "When Each Recipient Opens It", value: "on_open" }, { name: "All at Once, Now", value: "on_create" },
      ], description: "The default makes them all at once for video and PDFs over 5 pages. Links for allowed domains always make copies when opened" },
      { displayName: "Downloads per Recipient", name: "downloadLimit", type: "number", default: 0, typeOptions: { minValue: 0, maxValue: 100 }, displayOptions: { show: { operation: ["createLink"] } }, description: "1 to 100; 0 for no limit" },
      { displayName: "Webhook ID", name: "webhookId", type: "string", default: "", displayOptions: { show: { operation: ["createLink"] } }, description: "An Etchv webhook endpoint (wh_…) that receives an event each time a recipient opens the link" },
      { displayName: "Storage Destination ID", name: "storageDestinationId", type: "string", default: "", displayOptions: { show: { operation: ["embed", "batch"] } } },
      { displayName: "Storage Key", name: "storageKey", type: "string", default: "", displayOptions: { show: { operation: ["embed"] } } },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("etchvApi");
    const client = new EtchvClient(String(credentials.apiKey), undefined, undefined, USER_AGENT);
    if (items.length && this.getNodeParameter("operation", 0) === "batch") return [await submitBatch.call(this, client, items)];
    const results: INodeExecutionData[] = [];
    for (let index = 0; index < items.length; index++) {
      try {
        const operation = this.getNodeParameter("operation", index) as string;
        if (operation === "embed" || operation === "detect") {
          const binaryProperty = this.getNodeParameter("binaryProperty", index) as string;
          const file = items[index].binary?.[binaryProperty];
          if (!file) throw new Error(`Missing binary field ${binaryProperty}.`);
          const bytes = await this.helpers.getBinaryDataBuffer(index, binaryProperty);
          // JSON parameters arrive as text, or as an object when set by an expression.
          const reference = operation === "embed" ? this.getNodeParameter("referenceData", index) : undefined;
          const data = typeof reference === "string" ? JSON.parse(reference) : reference as IDataObject | undefined;
          const receipt = await client.submit({ media: this.getNodeParameter("media", index) as Media,
            operation: operation as Operation, filename: file.fileName || "upload", bytes: new Blob([new Uint8Array(bytes)]),
            data, idempotencyKey: this.getNodeParameter("idempotencyKey", index) as string,
            storageDestinationId: operation === "embed" ? this.getNodeParameter("storageDestinationId", index) as string : undefined,
            storageKey: operation === "embed" ? this.getNodeParameter("storageKey", index) as string : undefined,
            accelerator: this.getNodeParameter("accelerator", index, "cpu") as string });
          results.push({ json: receipt, pairedItem: { item: index } });
        } else if (operation === "createLink") {
          const limit = this.getNodeParameter("downloadLimit", index, 0) as number;
          const expiresAt = this.getNodeParameter("expiresAt", index, "") as string;
          const link = await client.createLink({ assetId: this.getNodeParameter("sourceAssetId", index) as string,
            name: this.getNodeParameter("linkName", index) as string,
            recipients: addressList(this.getNodeParameter("recipients", index, "")),
            allowedDomains: addressList(this.getNodeParameter("allowedDomains", index, "")),
            expiresAt: expiresAt ? zonedTime(expiresAt, this.getTimezone()) : undefined,
            prepare: (this.getNodeParameter("prepare", index, "") as string || undefined) as LinkPrepare | undefined,
            downloadLimit: limit > 0 ? limit : undefined,
            webhookId: (this.getNodeParameter("webhookId", index, "") as string) || undefined,
            idempotencyKey: this.getNodeParameter("idempotencyKey", index) as string });
          results.push({ json: link as IDataObject, pairedItem: { item: index } });
        } else if (operation === "batchStatus") {
          results.push({ json: await client.batchStatus(this.getNodeParameter("batchId", index) as string) as IDataObject, pairedItem: { item: index } });
        } else if (operation === "status") {
          results.push({ json: await client.status(this.getNodeParameter("statusPath", index) as string), pairedItem: { item: index } });
        } else {
          const output = operation === "asset"
            ? await client.asset(this.getNodeParameter("assetId", index) as string)
            : await client.result(this.getNodeParameter("resultPath", index) as string, this.getNodeParameter("resultOperation", index) as Operation);
          if ("bytes" in output) {
            const binary = await this.helpers.prepareBinaryData(Buffer.from(await output.bytes.arrayBuffer()), output.filename);
            const json: IDataObject = { filename: output.filename };
            if (output.accelerator) json.accelerator = output.accelerator;
            results.push({ json, binary: { data: binary }, pairedItem: { item: index } });
          } else results.push({ json: output.value as IDataObject, pairedItem: { item: index } });
        }
      } catch (error) {
        if (this.continueOnFail()) results.push({ json: { error: error instanceof Error ? error.message : "Etchv request failed" }, pairedItem: { item: index } });
        else throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: index });
      }
    }
    return [results];
  }
}

/**
 * An n8n date and time as ISO 8601 UTC. The picker's value has no offset and means the workflow's
 * time zone; a value that names its own offset or Z keeps it.
 */
export function zonedTime(value: string, zone: string): string {
  const fail = () => new Error(`Expires At must be a date and time, such as 2026-12-31T17:00:00; got "${value}".`);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw fail();
    return at.toISOString();
  }
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/);
  if (!parts) throw fail();
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts.slice(1, 7).map((part) => Number(part ?? 0));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, Number((parts[7] ?? "0").padEnd(3, "0")));
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) throw fail();
  // The zone's offset at that moment, from the wall clock Intl shows there; twice, for times near a DST change.
  const offset = (at: number) => {
    const shown = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((part) => [part.type, part.value]));
    return Date.UTC(+shown.year, +shown.month - 1, +shown.day, +shown.hour, +shown.minute, +shown.second) - Math.floor(at / 1000) * 1000;
  };
  let at = wall - offset(wall);
  at = wall - offset(at);
  if (Number.isNaN(at)) throw fail();
  return new Date(at).toISOString();
}

/** Every incoming item becomes one file of a single batch, outside the per-item loop. */
async function submitBatch(this: IExecuteFunctions, client: EtchvClient, items: INodeExecutionData[]): Promise<INodeExecutionData[]> {
  const pairedItem = items.map((_, item) => ({ item }));
  try {
    if (items.length > MAX_BATCH_ITEMS) {
      throw new Error(`A batch takes up to ${MAX_BATCH_ITEMS} files and ${items.length} items arrived. Split them first, for example with Loop Over Items (batch size ${MAX_BATCH_ITEMS}).`);
    }
    const files = [];
    for (let index = 0; index < items.length; index++) {
      const binaryProperty = this.getNodeParameter("binaryProperty", index) as string;
      const file = items[index].binary?.[binaryProperty];
      if (!file) throw new Error(`Item ${index + 1} has no binary field ${binaryProperty}.`);
      if (!file.fileName) throw new Error(`Item ${index + 1}: the file needs a name with its extension.`);
      const reference = this.getNodeParameter("referenceData", index);
      const data = typeof reference === "string" ? JSON.parse(reference) : reference as IDataObject;
      const bytes = await this.helpers.getBinaryDataBuffer(index, binaryProperty);
      files.push({ filename: file.fileName, bytes: new Blob([new Uint8Array(bytes)]), data });
    }
    const batch = await client.submitBatch({ items: files,
      idempotencyKey: this.getNodeParameter("idempotencyKey", 0) as string,
      archive: this.getNodeParameter("archive", 0, false) as boolean,
      accelerator: this.getNodeParameter("accelerator", 0, "cpu") as string,
      storageDestinationId: (this.getNodeParameter("storageDestinationId", 0, "") as string) || undefined });
    return [{ json: batch as IDataObject, pairedItem }];
  } catch (error) {
    if (this.continueOnFail()) return [{ json: { error: error instanceof Error ? error.message : "Etchv request failed" }, pairedItem }];
    throw new NodeOperationError(this.getNode(), error as Error);
  }
}
