# Etchv integrations

Open-source connectors that bring Etchv's invisible watermarking and watermark
detection for images, PDFs and video into the tools you already use.

| Directory | What it is | Guide |
| --- | --- | --- |
| [`zapier/`](zapier) | Zapier integration: watermark, detect, jobs, assets and batches | [Zapier guide](https://etchv.com/docs/integrations/zapier?utm_source=zapier&utm_medium=readme&utm_campaign=integrations) |
| [`n8n/`](n8n) | n8n community node (`n8n-nodes-etchv`) | [n8n guide](https://etchv.com/docs/integrations/n8n?utm_source=n8n&utm_medium=readme&utm_campaign=integrations) |
| [`make/`](make) | Make custom app: connection and nine modules | [Make guide](https://etchv.com/docs/integrations/make?utm_source=make&utm_medium=readme&utm_campaign=integrations) |
| [`cloudinary/`](cloudinary) | Watermarks Cloudinary image uploads and stores the watermarked copy back | [Cloudinary guide](https://etchv.com/docs/guides/cloudinary?utm_source=cloudinary&utm_medium=readme&utm_campaign=integrations) |
| [`c2pa/`](c2pa) | Python client that recovers a copy's Content Credentials from its watermark | [Content Credentials guide](https://etchv.com/docs/guides/content-credentials?utm_source=c2pa&utm_medium=readme&utm_campaign=integrations) |
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

## Links back to Etchv

Every link to an etchv.com page that a listing, package page, README or the
integration's own interface shows carries the same three tags, so we can tell
which listing a visit came from:

| Tag | Value |
| --- | --- |
| `utm_source` | The integration's ID: `zapier`, `n8n`, `make`, `cloudinary`, `c2pa`, or `mcp-local` for the MCP server. A new integration gets its own ID when it ships. |
| `utm_medium` | Where the link is shown: `directory` (an app directory or marketplace listing), `registry` (a server or extension registry entry), `package` (a package manager's homepage field), `readme` (a README) or `app` (text inside the integration) |
| `utm_campaign` | `integrations` |

For example, the Zapier directory listing links to
`https://etchv.com/docs/integrations/zapier?utm_source=zapier&utm_medium=directory&utm_campaign=integrations`.

Tag links to pages a visitor can land on, such as the homepage and the docs.
Leave these untagged: links to the dashboard (`/dashboard/...`), which needs a
sign-in; links between etchv.com pages; error messages; and content an
integration returns to an AI model or a program, such as MCP resources and tool
results.

## Build and test

Node.js 24 is required.

```bash
npm ci
npm run typecheck
npm test
```

`npm test` builds the Cloudinary, Zapier and n8n packages, then runs the
shared client tests, the Cloudinary service tests, both connectors' tests and
the Make contract checks. The Content Credentials client is Python 3.10 or
later, tested with `python -m unittest discover -s c2pa/tests`. The tests use local fakes and never call the live
API. In `zapier/`, `npm run validate` also runs Zapier's own structural checks,
which need network access.

Store only synthetic fixtures here. Never commit API keys, customer files or
platform account credentials.

## Security

Report a vulnerability to security@etchv.com.

## License

[MIT](LICENSE)
