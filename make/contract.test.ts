import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const load = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const modules = ["submit-watermark", "submit-detection", "get-job-status", "get-watermarked-file", "get-detection-result", "download-asset", "create-batch", "get-batch", "download-batch-zip"];

test("Make connection checks the non-billable key endpoint without logging credentials", () => {
  const base = load("./base.json");
  const connection = load("./connection/communication.json");
  assert.equal(base.baseUrl, "https://api.etchv.com");
  assert.equal(connection.url, "/auth/api-key");
  assert.equal(connection.headers["X-API-Key"], "{{parameters.apiKey}}");
  assert.ok(connection.log.sanitize.includes("request.headers.x-api-key"));
});

test("Make exposes all operations and uses binary file fields", () => {
  for (const module of modules) {
    const parameters = load(`./modules/${module}/parameters.json`);
    const communication = load(`./modules/${module}/communication.json`);
    assert.ok(Array.isArray(parameters));
    assert.ok(communication.response);
  }
  for (const module of ["submit-watermark", "submit-detection"]) {
    const parameters = load(`./modules/${module}/parameters.json`);
    const communication = load(`./modules/${module}/communication.json`);
    assert.equal(parameters.find((item: any) => item.name === "file_data").type, "buffer");
    assert.equal(communication.type, "multipart/form-data");
    assert.equal(communication.headers["Idempotency-Key"], "{{parameters.idempotency_key}}");
  }
  for (const module of ["get-watermarked-file", "download-asset", "download-batch-zip"]) {
    assert.equal(load(`./modules/${module}/communication.json`).response.type, "binary");
    assert.equal(load(`./modules/${module}/interface.json`).find((item: any) => item.name === "data").semantic, "file:data");
  }
});

test("Make never sends the connection key to a host taken from mapped input", () => {
  const hostile = ["@elsewhere.test/x", "//elsewhere.test/x", "/watermarks/jobs/../../x", "https://elsewhere.test/watermarks/jobs/req_" + "a".repeat(64)];
  const mapped = { "get-job-status": "status_path", "get-watermarked-file": "result_path", "get-detection-result": "result_path", "download-asset": "asset_id" };
  const valid = {
    "get-job-status": "/watermarks/detection-jobs/req_" + "a".repeat(64),
    "get-watermarked-file": "/watermarks/jobs/req_" + "b".repeat(64) + "/result",
    "get-detection-result": "/watermarks/detection-jobs/req_" + "c".repeat(32) + "/result",
    "download-asset": "ast_" + "d".repeat(64),
  };
  for (const [module, name] of Object.entries(mapped)) {
    const parameter = load(`./modules/${module}/parameters.json`).find((item: any) => item.name === name);
    const pattern = new RegExp(parameter.validate.pattern);
    assert.match(valid[module as keyof typeof valid], pattern);
    for (const value of hostile) assert.doesNotMatch(value, pattern, `${module} accepted ${value}`);
  }
  for (const module of modules) assert.ok(load(`./modules/${module}/communication.json`).url.startsWith("/") ||
    load(`./modules/${module}/communication.json`).url.startsWith("{{parameters."), `${module} must use the base URL`);
});

test("Make submit modules offer an optional CPU/GPU accelerator and report the one used", () => {
  for (const module of ["submit-watermark", "submit-detection"]) {
    const accelerator = load(`./modules/${module}/parameters.json`).find((item: any) => item.name === "accelerator");
    assert.equal(accelerator.type, "select");
    assert.notEqual(accelerator.required, true);
    assert.equal(accelerator.default, "cpu");
    assert.deepEqual(accelerator.options.map((option: any) => option.value), ["cpu", "gpu"]);
    assert.match(accelerator.help, /Business or Enterprise/);
    // CPU is the API default: only a GPU choice adds the query parameter.
    assert.equal(load(`./modules/${module}/communication.json`).qs.accelerator, "{{if(parameters.accelerator == 'gpu', 'gpu', undefined)}}");
  }
  assert.equal(load("./modules/submit-watermark/communication.json").qs.storage_key, "{{ifempty(parameters.storage_key, undefined)}}");
  for (const module of ["submit-watermark", "submit-detection", "get-job-status"]) {
    const names = load(`./modules/${module}/interface.json`).map((item: any) => item.name);
    assert.ok(names.includes("accelerator_requested") && names.includes("accelerator"), module);
  }
  assert.ok(load("./modules/get-detection-result/interface.json").some((item: any) => item.name === "accelerator"));
  assert.ok(load("./modules/get-watermarked-file/interface.json").some((item: any) => item.name === "accelerator"));
  assert.equal(load("./modules/get-watermarked-file/communication.json").response.output.accelerator, "{{headers['x-etchv-accelerator']}}");
});

test("Make Create Batch sends one zip and a manifest that is valid JSON for every option", () => {
  const communication = load("./modules/create-batch/communication.json");
  const parameters = load("./modules/create-batch/parameters.json");
  assert.equal(communication.url, "/watermarks/batches/zip");
  assert.equal(communication.type, "multipart/form-data");
  assert.equal(communication.headers["Idempotency-Key"], "{{parameters.idempotency_key}}");
  assert.equal(communication.body.archive.value, "{{parameters.zip_data}}");
  assert.equal(parameters.find((item: any) => item.name === "zip_data").type, "buffer");
  assert.equal(parameters.find((item: any) => item.name === "idempotency_key").validate.pattern, "^[A-Za-z0-9_-]{8,128}$");
  assert.match(communication.response.valid, /202/);
  // Evaluate the manifest template the way Make's IML would, for each choice.
  const items = [{ filename: "contracts/acme.pdf", data: { recipient: "acme" } }];
  for (const zip of [true, false]) {
    for (const accelerator of ["cpu", "gpu"]) {
      const manifest = String(communication.body.manifest)
        .replace("{{parameters.items}}", JSON.stringify(items))
        .replace("{{if(parameters.results_archive, 'true', 'false')}}", String(zip))
        .replace(`{{if(parameters.accelerator == 'gpu', ',"accelerator":"gpu"', '')}}`, accelerator === "gpu" ? ',"accelerator":"gpu"' : "");
      assert.deepEqual(JSON.parse(manifest), { items, archive: zip, ...(accelerator === "gpu" ? { accelerator } : {}) });
    }
  }
});

test("Make batch modules never pass signed upload URLs on, and the zip module downloads the archive", () => {
  for (const module of ["create-batch", "get-batch"]) {
    const output = load(`./modules/${module}/communication.json`).response.output;
    assert.equal(typeof output, "object", `${module} must list its output fields, not pass {{body}} through`);
    // Items carry upload URLs only on a draft (or expired draft): leave them out then.
    assert.equal(output.items, "{{if(body.status == 'draft' || body.status == 'expired', undefined, body.items)}}");
    for (const field of load(`./modules/${module}/interface.json`).map((item: any) => item.name))
      assert.ok(field in output, `${module} output lacks ${field}`);
  }
  const zip = load("./modules/download-batch-zip/communication.json");
  assert.equal(zip.url, "/watermarks/batches/{{parameters.batch_id}}/archive");
  assert.equal(zip.response.valid, "{{statusCode === 200}}");
  assert.equal(zip.response.output.data, "{{body}}");
  const parameter = load("./modules/download-batch-zip/parameters.json").find((item: any) => item.name === "batch_id");
  assert.doesNotMatch("bat_" + "a".repeat(32) + "/../x", new RegExp(parameter.validate.pattern));
});

test("Make Get Batch reads one batch by ID and exposes counts and items", () => {
  const parameter = load("./modules/get-batch/parameters.json").find((item: any) => item.name === "batch_id");
  const pattern = new RegExp(parameter.validate.pattern);
  assert.match("bat_" + "a".repeat(32), pattern);
  for (const value of ["bat_" + "a".repeat(32) + "/../../x", "//elsewhere.test/x", "@elsewhere.test", "bat_123"])
    assert.doesNotMatch(value, pattern, value);
  assert.equal(load("./modules/get-batch/communication.json").url, "/watermarks/batches/{{parameters.batch_id}}");
  for (const module of ["create-batch", "get-batch"]) {
    const output = load(`./modules/${module}/interface.json`);
    const names = output.map((item: any) => item.name);
    for (const name of ["batch_id", "status", "counts", "credits", "items", "archive_url"]) assert.ok(names.includes(name), `${module} ${name}`);
    const items = output.find((item: any) => item.name === "items").spec.spec.map((item: any) => item.name);
    assert.ok(items.includes("result_url") && items.includes("error_code") && !items.includes("upload"));
  }
});

test("every Make module declares metadata and mappable output", () => {
  for (const module of modules) {
    const metadata = load(`./modules/${module}/module.json`);
    assert.equal(metadata.type, "action");
    assert.ok(metadata.label && metadata.description);
    assert.ok(load(`./modules/${module}/interface.json`).length);
  }
  for (const module of ["submit-watermark", "submit-detection"]) {
    const key = load(`./modules/${module}/parameters.json`).find((item: any) => item.name === "idempotency_key");
    assert.equal(key.validate.pattern, "^[A-Za-z0-9_-]{8,128}$");
  }
});
