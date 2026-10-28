# Etchv Content Credentials client

Recover a file's Content Credentials (C2PA) from its Etchv watermark.

A file signed with Etchv Content Credentials names its invisible watermark as a
C2PA soft binding (`com.etchv.watermark.1`). When a copy loses its metadata,
the watermark is still in the pixels. This client sends the copy to Etchv's
public Soft Binding Resolution API, fetches the manifest it is bound to and
validates the copy against it with the C2PA SDK. It needs no API key.

See the [Content Credentials guide](https://etchv.com/docs/guides/content-credentials?utm_source=c2pa&utm_medium=readme&utm_campaign=integrations)
for how signing and resolution work.

## Install

Python 3.10 or later.

```bash
git clone https://github.com/etchv-labs/integrations.git
pip install ./integrations/c2pa
```

## Use it

```bash
etchv-c2pa copy.png --save copy.c2pa
```

```
Manifest: urn:c2pa:6f1e2a7c-4d3b-4c55-9a8e-2b1f0c9d7e61
Similarity: 100/100
Saved the manifest store to copy.c2pa
Validation: Invalid; signingCredential.untrusted, assertion.dataHash.mismatch
The signature and claim are intact.
Its signing certificate is not on your trust list.
```

The C2PA SDK reports `assertion.dataHash.mismatch` for every recovered copy, and
that's expected: the hard binding hashes the signed file's bytes, and a copy
without its metadata has different ones. The soft binding is what ties the copy
to its manifest. The client calls a manifest intact when it is the manifest
the resolver matched, it has an Etchv soft binding, and that mismatch or a
signing certificate missing from your trust list is all the SDK reports. The
SDK reports `signingCredential.untrusted` unless Etchv's signing certificate is
on the trust list you configure for it.

| Exit code | Meaning |
| --- | --- |
| `0` | Recovered, and intact (or not validated, with `--no-validate`) |
| `1` | No Content Credentials are bound to the file's watermark |
| `2` | The resolver refused the request, the network failed, or the file is missing or isn't a supported image |
| `3` | Recovered, but the manifest doesn't validate |

From Python:

```python
from etchv_c2pa import Resolver, binding_value, recover

found = recover(open("copy.png", "rb").read())
if found:
    print(found.match.manifest_id, found.validation.intact)

# With a watermark ID instead of the file:
matches = Resolver().by_binding(binding_value(watermark_id))
```

The resolver takes one JPEG, PNG, WebP, TIFF or GIF image of up to 5 MB and 20
megapixels, and limits how often each IP address can call it. A refusal raises
`ResolverError` with the status, the reason and, when the resolver sends one,
`retry_after` in seconds.

## Test

From this directory:

```bash
python -m unittest discover -s tests
```

The tests use a local fake resolver and a stand-in for the C2PA SDK, and never
call the live API.

## License

[MIT](LICENSE)
