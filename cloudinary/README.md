# Etchv for Cloudinary

Watermark every image as it's uploaded to Cloudinary. Cloudinary sends an upload
notification to this small service. The service checks the signature,
watermarks the image with Etchv's invisible forensic watermark, and uploads the
watermarked copy back to Cloudinary next to the original.
The [Cloudinary guide](https://etchv.com/docs/guides/cloudinary?utm_source=cloudinary&utm_medium=readme&utm_campaign=integrations)
walks through setup.

```
upload to Cloudinary ──notification──► this service ──► Etchv (data = {public_id, delivery})
       ▲                                                        │
       └───────── upload watermarked copy as <public_id>_etchv ◄┘
```

- The original stays as it was. The copy is stored as `<public_id>_etchv` in
  the same asset folder and tagged `etchv-watermarked`. Its contextual metadata
  records `etchv_watermark_id` and `etchv_source`.
- Etchv embeds `{"public_id": "<source public ID>", "delivery": "<reference>"}`.
  The reference comes from an upload tag `delivery:<reference>` when there is
  one, and from `ETCHV_DELIVERY` otherwise.
- It is safe to retry. Each asset version maps to one Etchv idempotency key, so
  a repeated notification replays the same Etchv result instead of charging
  again. When you replace the original, the new version is watermarked and
  replaces the copy. Restoring an earlier version from the Media Library isn't
  an upload, so the copy isn't updated; upload the restored version again.
- Just before storing, the service reads the original's current version with
  the Upload API's `explicit` method. Called with no options it changes nothing,
  and it has no hourly limit. If the original was replaced or deleted in the meantime, for example
  while Cloudinary was still retrying a notification for the older version,
  nothing is stored. A replacement that lands in the moment between that check
  and the upload can still leave a copy of the older version; upload the newer
  version again to fix it.
- Uploads tagged `etchv-watermarked`, or whose public ID ends with the suffix,
  are skipped, so the service never watermarks its own copies. Pick a suffix
  your own public IDs don't use.
- Deleting the original leaves the watermarked copy in place.
- If your product environment has a default upload preset for API uploads, its
  incoming transformation also applies to the copy and can re-encode it.

Supported: public image uploads (`type: upload`) in JPEG, PNG, TIFF, PSD/PSB,
GIF, BMP, PPM and WebP, up to 50 MB. Other notifications get a `200` with
`"status": "skipped"`.

## Run it

Node.js 24 (24.2 or later) is required.

```bash
npm install
npm start          # runs src/server.ts on PORT (default 8080)
```

`npm run build` compiles to `dist/`, and `node dist/server.js` runs that.

| Variable | Required | Meaning |
| --- | --- | --- |
| `ETCHV_API_KEY` | yes | An Etchv API key with the `watermarks:embed` scope, from https://etchv.com/dashboard/api-keys |
| `ETCHV_DELIVERY` | yes | Default delivery reference for uploads without a `delivery:` tag |
| `CLOUDINARY_CLOUD_NAME` | yes | Your Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | yes | API key used to read the original's version and upload the watermarked copy |
| `CLOUDINARY_API_SECRET` | yes | Its API secret |
| `CLOUDINARY_WEBHOOK_SECRET` | no | Secret of the key Cloudinary signs notifications with, if that's a different key (the dedicated webhook key, or otherwise your oldest active key). Defaults to `CLOUDINARY_API_SECRET` |
| `CLOUDINARY_SIGNATURE_ALGORITHM` | no | `sha1` (default) or `sha256`, if your product environment only accepts SHA-256 |
| `ETCHV_PUBLIC_ID_SUFFIX` | no | Suffix for the watermarked copy (default `_etchv`) |
| `ETCHV_BASE_URL` | no | Etchv API origin (default `https://api.etchv.com`) |
| `CLOUDINARY_API_ORIGIN` | no | Cloudinary API origin, if your account uses a regional API host (default `https://api.cloudinary.com`) |
| `PORT` | no | Port to listen on (default `8080`) |

The handler in `src/handler.ts` takes a standard `Request` and returns a
`Response`, so it also runs in serverless runtimes that use the Fetch API.
`src/server.ts` is a thin `node:http` adapter around it.

## Connect Cloudinary

Point an upload notification at the service, over HTTPS. Either:

- **For all uploads:** in the Console, open Settings → Webhook Notifications and
  add a notification URL for the `Upload` event type. Keep the trigger's
  signature scheme at **default** or **legacy HMAC**. This service verifies
  `X-Cld-Signature`, which the EdDSA-only scheme doesn't send. Keep the default
  payload too: the service reads Cloudinary's standard notification fields.
- **For some uploads:** pass `notification_url` to the upload call or set it on
  an upload preset.

To pick the delivery reference per upload, tag the upload, for example
`delivery:partner-42`.

To disconnect, remove the notification URL from the trigger, upload call or
preset, then stop the service. Nothing else in your Cloudinary account changes:
the originals and the watermarked copies stay.

Cloudinary waits 20 seconds for a response and then retries after about 3, 6
and 9 minutes. A large image can take longer than 20 seconds. The Node server keeps
working after Cloudinary stops waiting, and a retry resolves to the same Etchv
job. A serverless runtime may stop the handler when Cloudinary disconnects, so
run it where a request can continue for a few minutes, or queue the
notification and process it in the background.

Responses:

| Status | When | Cloudinary retries |
| --- | --- | --- |
| `200` | Watermarked, skipped, or failed in a way a retry can't fix (for example, no credits left, a failed watermarking job, or a notification without the fields it needs). Upload the image again to try once more | no |
| `401` | Missing, stale or invalid signature | yes |
| `413` | Body larger than 1 MB | yes |
| `503` | Rate limit, timeout, network or server error at Etchv or Cloudinary | yes |

Failures are logged with the public ID and never with keys.

Every call to Cloudinary sends the User-Agent
`CloudinaryEtchv/<version> (Node.js <version>)`, the format Cloudinary asks
partner integrations to use, so Cloudinary can see which requests come from
this integration. Calls to Etchv start their User-Agent with
`etchv-cloudinary/<version>`.

## Test

```bash
npm test           # from the repository root
```

The tests use local fakes and never call Etchv or Cloudinary.

## Support

Questions: hello@etchv.com. Report bugs and suggest changes in the issues of
https://github.com/etchv-labs/integrations. Report a vulnerability to
security@etchv.com. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
