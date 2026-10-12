#!/usr/bin/env python3
"""Fail on hand-typed ASCII box diagrams whose right borders don't line up.

Misaligned box art renders as ragged, broken diagrams on the docs site. Draw
real diagrams instead (docs/diagrams/README.md) or fix the alignment.

Usage: scripts/check-docs-diagrams.py [docs-dir]
"""
import glob
import sys
import unicodedata


def width(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def main(root):
    bad = 0
    for path in sorted(glob.glob(f"{root}/**/*.md", recursive=True)):
        in_block, start, block = False, 0, []
        for n, line in enumerate(open(path, encoding="utf-8").read().split("\n"), 1):
            if line.startswith("```"):
                if in_block and any(c in "".join(block) for c in "┌└╔"):
                    ends = {width(x) for x in block if x.rstrip()[-1:] in "┐┘│╗╝"}
                    if len(ends) > 1:
                        print(f"{path}:{start}: misaligned box diagram ({len(ends)} different right edges)")
                        bad += 1
                in_block, start, block = not in_block, n, []
            elif in_block:
                block.append(line)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "docs"))
