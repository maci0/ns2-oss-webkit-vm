#!/usr/bin/env python3
"""Classify the source delta between two NetFront/WebKit OSS drops.

Both Nintendo drops ship the same upstream WebKit tag (JavaScriptCore and
WebCore report 613.3.9), but ACCESS rebase their WKC platform layer forward
between firmware releases. Most of the file churn is mechanical
(`std::` -> `WKCStd::`, version strings, copyright years); the research claim
"the JSC n-day set is identical" only holds if that churn hides no semantic
change, so this tool separates the two instead of eyeballing `diff -rq`.

Usage:
    compare-forks.py OLD_DIR NEW_DIR [--json OUT] [--list]

OLD_DIR / NEW_DIR are the extracted `webkit_x.y.z` trees, e.g.
    oss/ns2-19/NS2_19.0.0/webkit_3.6.8
    oss/ns2-23/NS2_23.0.0/webkit_3.12.11

Exit status is 0 when the run completed; the classification is data, not a
pass/fail gate. `--list` prints one line per file:

    <status> <changed-lines> <path>

where status is
    mechanical  - identical after normalisation (namespace/version churn)
    semantic    - still differs after normalisation (needs a human read)
    only-old    - file exists only in OLD_DIR
    only-new    - file exists only in NEW_DIR

No build, no network, no console. Reads only the two trees.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Mechanical rewrites observed between the 19.0.0 and 23.0.1 drops.
# Each is (pattern, replacement); applied to both sides before comparing.
MECHANICAL = [
    (r"\bWKCStd::", "std::"),
    (r"\bWKCWTF::", "WTF::"),
    (r"\bWKC_NETFRONT_WEBKIT_VERSION\b", "WKC_VERSION_STRING"),
    (r"\b\d+\.\d+\.\d+\b", "X.Y.Z"),          # 3.6.8 vs 3.12.11 in prose
    (r"Copyright \(C\) (\d{4})-(\d{4})", r"Copyright (C) \1-YYYY"),
    (r"Copyright \(C\) (\d{4}) Apple", r"Copyright (C) YYYY Apple"),
]

# Never worth diffing: build products and VCS metadata.
SKIP_DIRS = {".git", ".svn"}
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf"}


def normalise(text: str) -> str:
    for pat, rep in MECHANICAL:
        text = re.sub(pat, rep, text)
    return text


def iter_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if path.suffix.lower() in SKIP_SUFFIX:
            continue
        yield rel


def count_changed_lines(old: str, new: str) -> int:
    import difflib

    diff = difflib.unified_diff(
        old.splitlines(), new.splitlines(), lineterm="", n=0
    )
    return sum(1 for line in diff if line[:1] in "+-" and line[:3] not in ("+++", "---"))


def classify(old_dir: Path, new_dir: Path):
    old_files = set(iter_files(old_dir))
    new_files = set(iter_files(new_dir))
    rows = []

    for rel in sorted(old_files | new_files):
        a, b = old_dir / rel, new_dir / rel
        if rel not in new_files:
            rows.append(("only-old", 0, str(rel)))
            continue
        if rel not in old_files:
            rows.append(("only-new", 0, str(rel)))
            continue
        old = a.read_bytes()
        new = b.read_bytes()
        if old == new:
            continue
        try:
            old_s, new_s = old.decode("utf-8", "replace"), new.decode("utf-8", "replace")
        except Exception:
            rows.append(("semantic", 0, str(rel)))
            continue
        if normalise(old_s) == normalise(new_s):
            rows.append(("mechanical", count_changed_lines(old_s, new_s), str(rel)))
        else:
            rows.append(("semantic", count_changed_lines(old_s, new_s), str(rel)))

    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("old_dir", type=Path)
    ap.add_argument("new_dir", type=Path)
    ap.add_argument("--json", type=Path, help="write the full classification here")
    ap.add_argument("--list", action="store_true", help="print one line per file")
    args = ap.parse_args(argv)

    for d in (args.old_dir, args.new_dir):
        if not d.is_dir():
            ap.error(f"not a directory: {d}")

    rows = classify(args.old_dir, args.new_dir)
    totals = {}
    for status, _, _ in rows:
        totals[status] = totals.get(status, 0) + 1

    semantic = [r for r in rows if r[0] == "semantic"]
    print(f"old: {args.old_dir}")
    print(f"new: {args.new_dir}")
    print(
        "files differing: "
        + ", ".join(f"{k}={v}" for k, v in sorted(totals.items()))
    )
    print(f"semantic after normalisation: {len(semantic)}")
    if args.list:
        for status, lines, rel in rows:
            print(f"{status:10s} {lines:6d} {rel}")
    if args.json:
        args.json.write_text(
            json.dumps(
                [
                    {"status": s, "changedLines": n, "path": p}
                    for s, n, p in rows
                ],
                indent=1,
            )
            + "\n"
        )
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
