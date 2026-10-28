"""The client against a local fake resolver; no network, no live API."""
import base64
import contextlib
import io
import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import etchv_c2pa  # noqa: E402
from etchv_c2pa import ALG, Resolver, ResolverError, binding_value, media_type, recover  # noqa: E402
from etchv_c2pa.__main__ import main  # noqa: E402

WATERMARK_ID = "ab" * 32
MANIFEST_ID = "urn:c2pa:00000000-0000-4000-8000-000000000001"
STORE = b"c2pa manifest store"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
ASSERTIONS = [{"label": "c2pa.actions.v2", "data": {}}, {"label": "c2pa.soft-binding", "data": {"alg": ALG}}]


class FakeResolver(BaseHTTPRequestHandler):
    """The resolver's routes, as the C2PA Soft Binding Resolution API shapes them."""
    requests: list = []
    matches: list = []
    refuse: tuple | None = None

    def log_message(self, *args):
        pass

    def reply(self, status, body, kind="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

    def handle_route(self, body=b""):
        url = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        type(self).requests.append((self.command, url.path, query, dict(self.headers), body))
        if self.refuse:
            status, detail, headers = self.refuse
            return self.reply(status, {"detail": detail}, headers=headers)
        if url.path in ("/c2pa/v1/matches/byContent", "/c2pa/v1/matches/byBinding"):
            return self.reply(200, {"matches": self.matches})
        if url.path == f"/c2pa/v1/manifests/{MANIFEST_ID.replace(':', '%3A')}":
            return self.reply(200, STORE, "application/c2pa")
        if url.path == "/c2pa/v1/services/supportedAlgorithms":
            return self.reply(200, {"watermarks": [{"alg": ALG}], "fingerprints": []})
        self.reply(404, {"detail": "Not Found"})

    def html(self, status, headers):
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(b"<html><body>Rate limited</body></html>")

    def do_GET(self):
        self.handle_route()

    def do_POST(self):
        self.handle_route(self.rfile.read(int(self.headers.get("Content-Length", 0))))


class FakeReader:
    """c2pa.Reader's shape: validation of a copy against external manifest data."""
    seen = None
    statuses = [{"code": "assertion.dataHash.mismatch"}]
    state = "Invalid"
    active = MANIFEST_ID
    assertions = []

    def __init__(self, kind, stream, manifest_data=None):
        type(self).seen = (kind, stream.read(), manifest_data)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def json(self):
        return json.dumps({"active_manifest": self.active, "manifests": {self.active: {"assertions": self.assertions}},
                           "validation_status": self.statuses})

    def get_validation_state(self):
        return self.state


class ClientTests(unittest.TestCase):
    def setUp(self):
        FakeResolver.requests, FakeResolver.refuse = [], None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeResolver)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}/c2pa/v1"
        FakeResolver.matches = [{"manifestId": MANIFEST_ID, "endpoint": self.endpoint, "similarityScore": 100}]
        self.resolver = Resolver(self.endpoint, timeout=5)
        FakeReader.statuses, FakeReader.state = [{"code": "assertion.dataHash.mismatch"}], "Invalid"
        FakeReader.active, FakeReader.assertions = MANIFEST_ID, ASSERTIONS
        patcher = mock.patch.dict(sys.modules, {"c2pa": types.SimpleNamespace(Reader=FakeReader)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_watermark_id_becomes_its_soft_binding_value(self):
        self.assertEqual(binding_value(WATERMARK_ID), base64.b64encode(bytes.fromhex(WATERMARK_ID)).decode())
        self.assertEqual(len(binding_value(WATERMARK_ID)), 44)
        with self.assertRaises(ValueError):
            binding_value("ab" * 16)

    def test_media_types_come_from_the_bytes(self):
        self.assertEqual(media_type(PNG), "image/png")
        self.assertEqual(media_type(b"\xff\xd8\xff\xe0"), "image/jpeg")
        self.assertEqual(media_type(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp")
        self.assertEqual(media_type(b"GIF89a"), "image/gif")
        self.assertEqual(media_type(b"II*\x00"), "image/tiff")
        with self.assertRaises(ValueError):
            media_type(b"%PDF-1.7")

    def test_recover_uploads_the_image_then_fetches_and_validates_the_manifest(self):
        found = recover(PNG, resolver=self.resolver)
        self.assertEqual(found.match.manifest_id, MANIFEST_ID)
        self.assertEqual(found.match.similarity_score, 100)
        self.assertEqual(found.manifest_store, STORE)
        (method, path, query, headers, body), (_, manifest_path, _, manifest_headers, _) = FakeResolver.requests
        self.assertEqual((method, path, query, body), ("POST", "/c2pa/v1/matches/byContent",
                                                       {"alg": ALG, "maxResults": "1"}, PNG))
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertTrue(headers["User-Agent"].startswith("etchv-c2pa/"))
        self.assertEqual(manifest_headers["Accept"], "application/c2pa")
        self.assertEqual(FakeReader.seen, ("image/png", PNG, STORE))
        # The copy's bytes differ from the signed file's: the data hash mismatch is expected.
        self.assertTrue(found.validation.intact)
        self.assertTrue(found.validation.trusted)

    def test_other_validation_failures_are_not_intact(self):
        FakeReader.statuses = [{"code": "assertion.dataHash.mismatch"}, {"code": "claimSignature.mismatch"}]
        self.assertFalse(recover(PNG, resolver=self.resolver).validation.intact)
        FakeReader.statuses = [{"code": "signingCredential.untrusted"}]
        validation = recover(PNG, resolver=self.resolver).validation
        self.assertTrue(validation.intact)
        self.assertFalse(validation.trusted)

    def test_a_store_for_another_manifest_or_without_an_etchv_binding_is_not_intact(self):
        FakeReader.active = "urn:c2pa:00000000-0000-4000-8000-000000000002"
        validation = recover(PNG, resolver=self.resolver).validation
        self.assertFalse(validation.intact)
        self.assertEqual(validation.manifest_id, FakeReader.active)
        FakeReader.active = MANIFEST_ID
        FakeReader.assertions = [{"label": "c2pa.soft-binding", "data": {"alg": "com.example.other.1"}}]
        self.assertFalse(recover(PNG, resolver=self.resolver).validation.intact)

    def test_no_match_is_none_and_checks_can_be_skipped(self):
        FakeResolver.matches = []
        self.assertIsNone(recover(PNG, resolver=self.resolver))
        FakeResolver.matches = [{"manifestId": MANIFEST_ID}]
        FakeReader.seen = None
        found = recover(PNG, resolver=self.resolver, check=False)
        self.assertIsNone(found.validation)
        self.assertIsNone(FakeReader.seen)

    def test_another_resolver_is_followed_only_over_https(self):
        FakeResolver.matches = [{"manifestId": MANIFEST_ID, "endpoint": "http://elsewhere.invalid/c2pa/v1"}]
        self.assertEqual(recover(PNG, resolver=self.resolver).manifest_store, STORE)
        FakeResolver.matches = [{"manifestId": MANIFEST_ID, "endpoint": "https://elsewhere.invalid/c2pa/v1"}]
        with mock.patch.object(Resolver, "manifest", autospec=True, return_value=b"other") as fetch:
            self.assertEqual(recover(PNG, resolver=self.resolver).manifest_store, b"other")
        self.assertEqual(fetch.call_args.args[0].endpoint, "https://elsewhere.invalid/c2pa/v1")

    def test_by_binding_and_supported_algorithms(self):
        self.assertEqual(self.resolver.by_binding(binding_value(WATERMARK_ID), max_results=3)[0].manifest_id, MANIFEST_ID)
        _, path, query, _, _ = FakeResolver.requests[0]
        self.assertEqual((path, query), ("/c2pa/v1/matches/byBinding",
                                         {"alg": ALG, "value": binding_value(WATERMARK_ID), "maxResults": "3"}))
        self.assertEqual(self.resolver.supported_algorithms()["watermarks"], [{"alg": ALG}])

    def test_a_refusal_carries_its_status_detail_and_retry_after(self):
        FakeResolver.refuse = (429, "byContent has reached today's limit. Try again tomorrow.", {"Retry-After": "3600"})
        with self.assertRaises(ResolverError) as caught:
            recover(PNG, resolver=self.resolver)
        self.assertEqual((caught.exception.status, caught.exception.retry_after), (429, 3600))
        self.assertIn("today's limit", caught.exception.detail)

    def test_a_refusal_that_is_not_json_and_a_dated_retry_after(self):
        when = (etchv_c2pa.datetime.datetime.now(etchv_c2pa.datetime.timezone.utc)
                + etchv_c2pa.datetime.timedelta(seconds=120))
        FakeResolver.refuse = (429, None, {"Retry-After": etchv_c2pa.email.utils.format_datetime(when, usegmt=True)})
        with mock.patch.object(FakeResolver, "reply", lambda self, status, body, kind="text/html", headers=None:
                               FakeResolver.html(self, status, headers)):
            with self.assertRaises(ResolverError) as caught:
                self.resolver.by_binding(binding_value(WATERMARK_ID))
        self.assertEqual(caught.exception.detail, "Too Many Requests")
        self.assertTrue(100 <= caught.exception.retry_after <= 120)

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main([*args, "--endpoint", self.endpoint])
        return code, out.getvalue(), err.getvalue()

    def test_the_command_line_reports_saves_and_exits_by_outcome(self):
        with self.subTest("recovered"), contextlib.ExitStack() as stack:
            import tempfile
            directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            (directory / "copy.png").write_bytes(PNG)
            code, out, _ = self.run_cli(str(directory / "copy.png"), "--save", str(directory / "copy.c2pa"))
            self.assertEqual(code, 0)
            self.assertIn(f"Manifest: {MANIFEST_ID}", out)
            self.assertIn("The signature and claim are intact.", out)
            self.assertEqual((directory / "copy.c2pa").read_bytes(), STORE)
            FakeResolver.matches = []
            self.assertEqual(self.run_cli(str(directory / "copy.png"))[0], 1)
            FakeResolver.refuse = (429, "Too many requests", {})
            code, _, err = self.run_cli(str(directory / "copy.png"))
            self.assertEqual(code, 2)
            self.assertIn("(429): Too many requests.", err)
            self.assertEqual(self.run_cli(str(directory / "missing.png"))[0], 2)


if __name__ == "__main__":
    unittest.main()
