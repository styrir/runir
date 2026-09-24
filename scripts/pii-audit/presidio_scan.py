#!/usr/bin/env python3
"""PII gate for committed corpora and labeled fixtures (Rúnir-szl).

Scans every string in the given files (JSON/JSONL leaves, or lines of text
files) with Presidio Analyzer and exits 1 if any high-signal PII entity is
found. Findings print location, entity type, and score only; the matched text
is never echoed, because CI logs for this repository are public.

Usage: presidio_scan.py [--allowlist FILE] PATH [PATH ...]
Directories are walked for .json, .jsonl, .md, and .txt files.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

# High-signal identifiers only. DATE_TIME, NRP, LOCATION, and URL are left out:
# benchmark rows legitimately carry timestamps, places named in code, and links.
ENTITIES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "IBAN_CODE",
    "IP_ADDRESS",
    "US_SSN",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
    "CRYPTO",
]
TOKEN_ENTITIES = [entity for entity in ENTITIES if entity != "PERSON"]
SCORE_THRESHOLD = 0.5
SUFFIXES = {".json", ".jsonl", ".md", ".txt"}


def build_analyzer() -> AnalyzerEngine:
    # en_core_web_sm keeps the CI install small; Presidio defaults to _lg.
    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        }
    )
    return AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])


def string_leaves(value, path: str):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        # Keys are scanned but never printed (a key can itself be a name);
        # locations use the key's position instead.
        for position, (key, child) in enumerate(value.items()):
            yield f"{path}{{key {position}}}", key
            yield from string_leaves(child, f"{path}{{{position}}}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from string_leaves(child, f"{path}[{index}]")


def texts_in(file: Path):
    raw = file.read_text(encoding="utf-8")
    if file.suffix == ".json":
        yield from string_leaves(json.loads(raw), "$")
    elif file.suffix == ".jsonl":
        for number, line in enumerate(raw.splitlines(), 1):
            if line.strip():
                yield from string_leaves(json.loads(line), f"line{number}")
    else:
        for number, line in enumerate(raw.splitlines(), 1):
            if line.strip():
                yield f"line{number}", line


def files_under(paths: list[str]) -> list[Path]:
    """Every scannable file under the given paths. A missing path or a
    directory with nothing to scan is an error: a renamed corpus must not
    turn the gate green by scanning nothing."""
    files: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            found = sorted(p for p in path.rglob("*") if p.is_file() and p.suffix in SUFFIXES)
            if not found:
                raise SystemExit(f"presidio_scan: no .json/.jsonl/.md/.txt files under {raw}")
            files.extend(found)
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit(f"presidio_scan: path does not exist: {raw}")
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--allowlist", type=Path, help="Exact strings known to be synthetic, one per line")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()

    allow = []
    if args.allowlist:
        allow = [
            line.strip()
            for line in args.allowlist.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        ]

    analyzer = build_analyzer()
    findings = 0
    scanned = 0
    for file in files_under(args.paths):
        scanned += 1
        for location, text in texts_in(file):
            # PERSON comes from the NER model, which tags bare ids and hashes
            # as names. A single token containing a digit is an identifier, not
            # a name, so only there is PERSON skipped; pattern recognizers
            # (email, phone, card, ...) still run on it.
            identifier = not any(c.isspace() for c in text.strip()) and any(c.isdigit() for c in text)
            entities = TOKEN_ENTITIES if identifier else ENTITIES
            results = analyzer.analyze(
                text=text,
                language="en",
                entities=entities,
                score_threshold=SCORE_THRESHOLD,
                allow_list=allow or None,
            )
            for result in results:
                findings += 1
                print(
                    f"::error file={file}::PII {result.entity_type} "
                    f"(score {result.score:.2f}, {result.end - result.start} chars) at {location}"
                )
    print(f"presidio_scan: {scanned} file(s) scanned, {findings} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
