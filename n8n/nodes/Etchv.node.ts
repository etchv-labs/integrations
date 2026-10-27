import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
import { ACCELERATOR_HELP, EtchvClient, MAX_BATCH_ITEMS, type Media, type Operation } from "../../core/etchv";

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
      ] },
      { displayName: "Media", name: "media", type: "options", default: "images", displayOptions: { show: { operation: ["embed", "detect"] } }, options: [
        { name: "Image", value: "images" }, { name: "PDF", value: "documents" }, { name: "Video", value: "videos" },
      ] },
      { displayName: "Input Binary Field", name: "binaryProperty", type: "string", default: "data", required: true, displayOptions: { show: { operation: ["embed", "detect", "batch"] } } },
      { displayName: "Reference Data (JSON)", name: "referenceData", type: "json", default: "{}", required: true, displayOptions: { show: { operation: ["embed", "batch"] } }, description: "For a batch, an expression here is evaluated for each incoming item" },
      { displayName: "Idempotency Key", name: "idempotencyKey", type: "string", default: "", required: true, displayOptions: { show: { operation: ["embed", "detect", "batch"] } }, description: "Stable source event ID plus operation; reuse unchanged on retry. A batch uses the first item's value" },
      { displayName: "Zip Archive", name: "archive", type: "boolean", default: false, displayOptions: { show: { operation: ["batch"] } }, description: "Whether to also zip every result into one download" },
      { displayName: "Batch ID", name: "batchId", type: "string", default: "", required: true, displayOptions: { show: { operation: ["batchStatus"] } }, description: "The batch_id or status_url from Submit Batch" },
      { displayName: "Accelerator", name: "accelerator", type: "options", default: "cpu", displayOptions: { show: { operation: ["embed", "detect", "batch"] } }, options: [
        { name: "CPU (Default)", value: "cpu" }, { name: "GPU", value: "gpu" },
      ], description: ACCELERATOR_HELP },
      { displayName: "Status Path", name: "statusPath", type: "string", default: "", required: true, displayOptions: { show: { operation: ["status"] } } },
      { displayName: "Result Path", name: "resultPath", type: "string", default: "", required: true, displayOptions: { show: { operation: ["result"] } } },
      { displayName: "Result Operation", name: "resultOperation", type: "options", default: "embed", displayOptions: { show: { operation: ["result"] } }, options: [{ name: "Watermark", value: "embed" }, { name: "Detection", value: "detect" }] },
      { displayName: "Asset ID", name: "assetId", type: "string", default: "", required: true, displayOptions: { show: { operation: ["asset"] } } },
      { displayName: "Storage Destination ID", name: "storageDestinationId", type: "string", default: "", displayOptions: { show: { operation: ["embed", "batch"] } } },
      { displayName: "Storage Key", name: "storageKey", type: "string", default: "", displayOptions: { show: { operation: ["embed"] } } },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("etchvApi");
    const client = new EtchvClient(String(credentials.apiKey));
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
