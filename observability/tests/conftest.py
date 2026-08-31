"""Fail fast, and legibly, on an interpreter too old to parse the exporters.

The exporters use PEP 604 unions (`bytes | None`), which need Python 3.10. They
always run on a new enough one — CI pins 3.12/3.13 and the CronJobs use
python:3.12-slim / python:3.13-slim — so this is purely about the person running
the tests.

On macOS `python3` is still the system 3.9, and collecting these tests with it
fails inside an import with:

    TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'

which reads like a bug in the exporter rather than a stale interpreter. This
turns that into a sentence naming the actual problem and the actual fix.
"""

import sys

MINIMUM = (3, 10)

if sys.version_info < MINIMUM:
    running = ".".join(str(p) for p in sys.version_info[:3])
    raise RuntimeError(
        f"These tests need Python {MINIMUM[0]}.{MINIMUM[1]} or newer; this is "
        f"{running} ({sys.executable}).\n"
        "The exporters use `X | None` type syntax, which 3.9 cannot parse — the "
        "error you would otherwise see comes from importing them, not from a "
        "defect in them.\n"
        "On macOS the system python3 is 3.9. Run the suite with a newer one, "
        "e.g. `python3.13 -m pytest observability/tests`.\n"
        "CI runs 3.12 and 3.13; the exporter CronJobs use python:3.12-slim and "
        "python:3.13-slim."
    )
