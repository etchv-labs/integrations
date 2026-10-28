"""etchv-c2pa FILE [--save STORE] [--no-validate]: Recover a copy's Content Credentials from its watermark."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import ENDPOINT, Resolver, ResolverError, recover


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="etchv-c2pa", description=__doc__.split(": ", 1)[1])
    parser.add_argument("file", type=Path, help="A JPEG, PNG, WebP, TIFF or GIF image")
    parser.add_argument("--save", type=Path, metavar="STORE", help="Write the manifest store (application/c2pa) here")
    parser.add_argument("--no-validate", action="store_true", help="Skip validation with the C2PA SDK")
    parser.add_argument("--endpoint", default=ENDPOINT, help=f"The resolver (default {ENDPOINT})")
    args = parser.parse_args(argv)
    try:
        found = recover(args.file.read_bytes(), resolver=Resolver(args.endpoint), check=not args.no_validate)
    except ResolverError as error:
        wait = f" Retry after {error.retry_after} seconds." if error.retry_after else ""
        print(f"The resolver refused the request ({error.status}): {error.detail.rstrip('.')}.{wait}", file=sys.stderr)
        return 2
    except (OSError, ValueError) as error:
        # A missing file, an unsupported image, or a network error or timeout.
        print(error, file=sys.stderr)
        return 2
    if not found:
        print("No Content Credentials are bound to this file's watermark.")
        return 1
    print(f"Manifest: {found.match.manifest_id}")
    if found.match.similarity_score is not None:
        print(f"Similarity: {found.match.similarity_score}/100")
    if args.save:
        args.save.write_bytes(found.manifest_store)
        print(f"Saved the manifest store to {args.save}")
    if found.validation:
        v = found.validation
        print(f"Validation: {v.state}; {', '.join(v.statuses) or 'no status codes'}")
        print("The signature and claim are intact." if v.intact else
              "The manifest does not validate, or is not the Etchv manifest bound to this file.")
        if v.intact and not v.trusted:
            print("Its signing certificate is not on your trust list.")
        return 0 if v.intact else 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
