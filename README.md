# Etchv integrations

Open-source connectors that bring Etchv's invisible watermarking and watermark
detection for images, PDFs and video into the tools you already use.

| Directory | What it is | Guide |
| --- | --- | --- |
| [`zapier/`](zapier) | Zapier integration: watermark, detect, jobs, assets and batches | https://etchv.com/docs/integrations/zapier |
| [`n8n/`](n8n) | n8n community node (`n8n-nodes-etchv`) | https://etchv.com/docs/integrations/n8n |
| [`make/`](make) | Make custom app: connection and nine modules | https://etchv.com/docs/integrations/make |
| [`core/`](core) | Shared TypeScript client used by the Zapier and n8n connectors | |

Every connector uses the public Etchv API: async watermark and detection jobs,
batches for many files at once, and the connection check `GET /auth/api-key`,
which uses no credits. Create a scoped API key at
https://etchv.com/dashboard/api-keys.

The connectors are in early access: request access at hello@etchv.com, and
each guide shows how to set it up.

Batches upload each file to its own signed URL. n8n and Zapier hold every file
of a batch in memory while it uploads, so a batch is bounded by the platform's
memory as well as by 100 files and the per-file limits. Make's Create Batch
takes the files as one zip with a manifest, up to 55 MB.

## Build and test

Node.js 24 is required.

```bash
npm ci
npm run typecheck
npm test
```

`npm test` builds the Zapier and n8n packages, then runs the shared client
tests, both connectors' tests and the Make contract checks. The tests use local
fakes and never call the live API. In `zapier/`, `npm run validate` also runs
Zapier's own structural checks, which need network access.

Store only synthetic fixtures here. Never commit API keys, customer files or
platform account credentials.

## Security

Report a vulnerability to security@etchv.com.

## License

[MIT](LICENSE)
