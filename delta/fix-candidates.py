#!/usr/bin/env python3
"""Extract added lines from the 19->23 fork delta that look like fixes.

Second stage after compare-forks.py: reads its fork-delta.json, diffs every
`semantic` file and prints only the *added* lines that look like a fix (bounds
checks, RELEASE_ASSERT, Checked<>, overflow/OOM guards, rdar:// and bug-id
comments, exception throws).

Usage:
    fix-candidates.py [OLD_DIR] [NEW_DIR] [--json]

OLD_DIR / NEW_DIR default to the sibling layout used when the two drops are
extracted side by side:

    NS2_19.0.0/webkit_3.6.8
    NS2_23.0.0/webkit_3.12.11

run from the directory containing fork-delta.json. `--json` writes
fix-candidates.json into the current directory instead of printing.
"""
import json, re, sys, collections
import difflib
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith('--')]
OLD = Path(args[0]) if len(args) > 0 else Path('NS2_19.0.0/webkit_3.6.8')
NEW = Path(args[1]) if len(args) > 1 else Path('NS2_23.0.0/webkit_3.12.11')
rows = json.load(open('fork-delta.json'))

PAT = re.compile(
    r'rdar://|bugs\.webkit\.org|CVE-|speculative|mitigat|security|hardening|'
    r'out.of.bounds|OOB|heap buffer|use.after.free|UAF|'
    r'RELEASE_ASSERT|gcProtect|DeferGC|SuspendGC|'
    r'overflow|isSafeTo|wouldOverflow|hasOverflowed|CheckedInt|WTF::safeCast|'
    r'clamp|isValid|sanity|invalid|malformed|'
    r'UNLIKELY|LIKELY', re.I)

out = []
for r in rows:
    if r['status'] != 'semantic':
        continue
    p = r['path']
    a, b = OLD / p, NEW / p
    if not (a.exists() and b.exists()):
        continue
    ao = a.read_text('utf-8', 'replace').splitlines()
    bo = b.read_text('utf-8', 'replace').splitlines()
    sm = difflib.SequenceMatcher(None, ao, bo, autojunk=False)
    added = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ('insert', 'replace'):
            for k in range(j1, j2):
                line = bo[k]
                if PAT.search(line):
                    added.append((k + 1, line.rstrip()))
    if added:
        out.append((p, r['changedLines'], added))

print(f"{len(out)} files with fix-shaped added lines\n", file=sys.stderr)
tot = sum(len(a) for _, _, a in out)
print(f"{tot} candidate lines\n", file=sys.stderr)
if '--json' in sys.argv:
    json.dump([{'path': p, 'changedLines': c, 'added': [{'line': l, 'text': t} for l, t in a]} for p, c, a in out],
              open('fix-candidates.json', 'w'), indent=1)
    sys.exit(0)

for p, c, added in out:
    print(f"### {p}  ({c} changed lines)")
    for l, t in added:
        print(f"  {l}: {t.strip()[:300]}")
    print()
