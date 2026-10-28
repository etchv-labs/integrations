"""Recover a file's Content Credentials from its Etchv watermark.

A file signed with Etchv Content Credentials names its watermark as a C2PA soft
binding (alg ``com.etchv.watermark.1``). When a copy loses its metadata, the
watermark is still in the pixels: Etchv's public Soft Binding Resolution API
finds the copy's manifest from the copy itself or from its watermark ID, and
the C2PA SDK validates the copy against that manifest.

    from etchv_c2pa import recover
    found = recover(open("copy.png", "rb").read())
    if found:
        print(found.match.manifest_id, found.validation.state)
"""
from __future__ import annotations

import base64
import datetime
import email.utils
import io
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

__all__ = ["ALG", "ENDPOINT", "Match", "Recovery", "Resolver", "ResolverError", "Validation",
           "binding_value", "media_type", "recover", "validate"]
__version__ = "0.1.0"

ALG = "com.etchv.watermark.1"
ENDPOINT = "https://api.etchv.com/c2pa/v1"
# A copy's bytes differ from the signed file's, so its hard binding (a hash of
# those bytes) can't match. The soft binding is what ties it to the manifest.
EXPECTED_MISMATCH = "assertion.dataHash.mismatch"
UNTRUSTED = "signingCredential.untrusted"
USER_AGENT = f"etchv-c2pa/{__version__}"


class ResolverError(Exception):
    """A resolver request that failed; ``retry_after`` is in seconds, when the resolver sent one."""

    def __init__(self, status: int, detail: str, retry_after: int | None = None):
        super().__init__(f"{status}: {detail}")
        self.status, self.detail, self.retry_after = status, detail, retry_after


@dataclass(frozen=True)
class Match:
    manifest_id: str
    endpoint: str | None = None
    similarity_score: int | None = None


@dataclass(frozen=True)
class Validation:
    """The C2PA SDK's validation of a copy against a recovered manifest store."""

    state: str
    statuses: tuple[str, ...] = ()
    # The store's active manifest, and whether it has an Etchv soft binding.
    manifest_id: str | None = None
    soft_binding: bool = False

    @property
    def intact(self) -> bool:
        """The signature and the claim validate (only the expected hard-binding mismatch, or an untrusted
        signer, is reported) and the manifest has an Etchv soft binding."""
        return self.soft_binding and set(self.statuses) <= {EXPECTED_MISMATCH, UNTRUSTED}

    @property
    def trusted(self) -> bool:
        return UNTRUSTED not in self.statuses


@dataclass(frozen=True)
class Recovery:
    match: Match
    manifest_store: bytes
    validation: Validation | None = field(default=None)


def binding_value(watermark_id: str) -> str:
    """The soft-binding ``value`` of a 64-character hex watermark ID (as ``X-Watermark-ID`` returns it)."""
    raw = bytes.fromhex(watermark_id)
    if len(raw) != 32:
        raise ValueError("a watermark ID is 32 bytes (64 hex characters)")
    return base64.b64encode(raw).decode()


_SIGNATURES = ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF87a", "image/gif"),
               (b"GIF89a", "image/gif"), (b"II*\x00", "image/tiff"), (b"MM\x00*", "image/tiff"))


def media_type(data: bytes) -> str:
    """The image type of ``data`` from its first bytes: the formats the resolver takes."""
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    for signature, kind in _SIGNATURES:
        if data.startswith(signature):
            return kind
    raise ValueError("not a JPEG, PNG, WebP, TIFF or GIF image")


class Resolver:
    """A client of one Soft Binding Resolution API, Etchv's by default. It needs no credentials."""

    def __init__(self, endpoint: str = ENDPOINT, *, timeout: float = 60):
        self.endpoint, self.timeout = endpoint.rstrip("/"), timeout

    def _request(self, method: str, url: str, body: bytes | None = None, headers: dict | None = None) -> bytes:
        request = urllib.request.Request(url, data=body, method=method,
                                         headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            try:
                detail = str(json.loads(error.read(65536))["detail"])
            except (ValueError, KeyError, TypeError):
                # Not the resolver's JSON, such as a proxy's HTML page.
                detail = error.reason or "request failed"
            raise ResolverError(error.code, detail, _retry_after(error.headers.get("Retry-After"))) from None

    def _matches(self, body: bytes) -> list[Match]:
        return [Match(m["manifestId"], m.get("endpoint"), m.get("similarityScore")) for m in json.loads(body)["matches"]]

    def _query(self, max_results: int | None, **params) -> str:
        if max_results is not None:
            params["maxResults"] = max_results
        return urllib.parse.urlencode(params)

    def by_content(self, data: bytes, kind: str | None = None, *, max_results: int | None = None) -> list[Match]:
        """The manifests bound to the watermark in an image (up to 5 MB and 20 megapixels)."""
        url = f"{self.endpoint}/matches/byContent?{self._query(max_results, alg=ALG)}"
        return self._matches(self._request("POST", url, data, {"Content-Type": kind or media_type(data)}))

    def by_binding(self, value: str, *, max_results: int | None = None) -> list[Match]:
        """The manifests bound to a soft-binding ``value`` (see :func:`binding_value`)."""
        return self._matches(self._request("GET", f"{self.endpoint}/matches/byBinding?{self._query(max_results, alg=ALG, value=value)}"))

    def manifest(self, manifest_id: str) -> bytes:
        """The manifest store (``application/c2pa``) of a manifest ID."""
        return self._request("GET", f"{self.endpoint}/manifests/{urllib.parse.quote(manifest_id, safe='')}",
                             headers={"Accept": "application/c2pa"})

    def supported_algorithms(self) -> dict:
        return json.loads(self._request("GET", f"{self.endpoint}/services/supportedAlgorithms"))


def _retry_after(value: str | None) -> int | None:
    """Retry-After in seconds, from either of its forms."""
    if not value:
        return None
    if value.isdigit():
        return int(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0, int((when - datetime.datetime.now(datetime.timezone.utc)).total_seconds()))


def validate(data: bytes, store: bytes, kind: str | None = None) -> Validation:
    """Validate a copy against a manifest store with the C2PA SDK (``c2pa-python``)."""
    import c2pa

    with c2pa.Reader(kind or media_type(data), io.BytesIO(data), manifest_data=store) as reader:
        report = json.loads(reader.json())
        state = reader.get_validation_state()
    active = report.get("active_manifest")
    assertions = report.get("manifests", {}).get(active, {}).get("assertions", [])
    bound = any(a.get("label") == "c2pa.soft-binding" and (a.get("data") or {}).get("alg") == ALG for a in assertions)
    return Validation(state, tuple(status["code"] for status in report.get("validation_status", [])), active, bound)


def recover(data: bytes, *, resolver: Resolver | None = None, check: bool = True) -> Recovery | None:
    """The best match for an image's watermark, its manifest store and, with ``check``, its validation; None when nothing matches."""
    resolver = resolver or Resolver()
    kind = media_type(data)
    matches = resolver.by_content(data, kind, max_results=1)
    if not matches:
        return None
    match = matches[0]
    # A match names the resolver that holds its manifest (Etchv's names itself);
    # another one is followed only over HTTPS.
    endpoint = (match.endpoint or "").rstrip("/")
    other = endpoint and endpoint != resolver.endpoint and endpoint.startswith("https://")
    source = Resolver(endpoint, timeout=resolver.timeout) if other else resolver
    store = source.manifest(match.manifest_id)
    validation = validate(data, store, kind) if check else None
    if validation and validation.manifest_id != match.manifest_id:
        # A store for some other manifest validates too: it must be the one that matched.
        validation = Validation(validation.state, validation.statuses, validation.manifest_id, False)
    return Recovery(match, store, validation)
