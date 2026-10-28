# Etchv for n8n

Submit watermark or detection jobs for images, PDFs, and videos, check their
status, then collect a file or detection JSON. The node uses an Etchv API key
stored in n8n credentials.

## Install

The node is in early access for self-hosted n8n. Contact hello@etchv.com for
the package and installation steps.

## Connect

Create a scoped key at https://etchv.com/dashboard/api-keys. Choose
`watermarks:embed` for watermarking, `watermarks:detect` for detection, and
`assets:read` if you will download an asset. Add an **Etchv API** credential in
n8n and paste the key there. The connection check does not consume credits.

## Workflow

Map a binary file and a stable idempotency key into **Submit Watermark** or
**Submit Detection**. For watermarking, also enter a nonempty JSON reference
object. The node returns `status_url` and `result_url`; wait and check the job
status before collecting the result. A successful detection can return
`watermarked: false`. A watermarked file arrives in the output's `data` binary
field. See https://etchv.com/docs/integrations/n8n?utm_source=n8n&utm_medium=readme&utm_campaign=integrations for the full setup guide.

**Accelerator** defaults to CPU. Choose GPU on a Business or Enterprise plan;
GPU operations use 3× credits. If no GPU is ready, the job runs on CPU at
normal credits. Job status and results report the `accelerator` actually used.

The job result expires after 24 hours. **Download Asset** can retrieve an
available retained asset using `assets:read`. Never treat a pending `202`
result as a completed file.

## Traceable links

**Create Traceable Link** shares a file from your Etchv asset library so each
recipient opens their own watermarked copy. Map the source `asset_id`, a name,
and recipients' email addresses or allowed domains (separated by commas or line
breaks), with an idempotency key. The node outputs the link with its `url`; send
it to your recipients yourself. The key needs `links:write`.

## Many files at once

**Submit Batch** sends every item that reaches the node, up to 100, as one batch
instead of one job per item. Each item needs a binary file whose name keeps its
extension. Reference data is evaluated per item, so an expression such as
`{"recipient": "{{ $json.email }}"}` gives each file its own data; the idempotency
key, zip option and accelerator come from the first item. The node outputs one
item with the batch, paired with every input.

Check it with **Get Batch Status** about once a minute until `status` is
`completed`, `failed` or `cancelled`, then collect each file with **Get Job
Result** and the item's `result_url`. Each file costs the same credits as a single
request, and files that fail are refunded; `error_code` on each item says why.
For more than 100 items, split them first with **Loop Over Items**.

The node holds every file of a batch in memory while it uploads them. On a small
n8n instance, send large files in smaller batches.
