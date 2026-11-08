#!/usr/bin/env python3
"""Record a run of the tests that boot real microVMs, which CI can't run because its runners have no /dev/kvm.

    python scripts/kvm_record.py                    run `pytest -m kvm` here and record it in bench/kvm_tests.json
    python scripts/kvm_record.py --from report.xml  record an existing JUnit report instead

The record keeps counts, duration and time only, not the machine's name.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "bench" / "kvm_tests.json"


def summarise(report: Path) -> dict:
    root = ET.parse(report).getroot()
    suite = root.find("testsuite") if root.tag == "testsuites" else root
    tests, failures, errors, skipped = (int(suite.get(k, 0)) for k in ("tests", "failures", "errors", "skipped"))
    return {
        "at": suite.get("timestamp"),
        "tests": tests,
        "passed": tests - failures - errors - skipped,
        "failures": failures,
        "errors": errors,
        "skipped": skipped,
        "seconds": round(float(suite.get("time", 0)), 1),
        "host": "a developer machine with KVM and Microsandbox, the runtime the VX1 uses",
        "rerun": "python scripts/kvm_record.py",
    }


def main() -> int:
    if "--from" in sys.argv:
        report = Path(sys.argv[sys.argv.index("--from") + 1])
    else:
        report = Path(tempfile.mkdtemp()) / "kvm.xml"
        subprocess.run([sys.executable, "-m", "pytest", "-q", "-m", "kvm", "-p", "no:cacheprovider", f"--junitxml={report}"], cwd=ROOT, env=os.environ)
    rec = summarise(report)
    OUT.write_text(json.dumps(rec, indent=1) + "\n")
    print(f"{rec['passed']} of {rec['tests']} KVM tests passed in {rec['seconds']} s -> {OUT.relative_to(ROOT)}")
    return 0 if rec["passed"] == rec["tests"] else 1


if __name__ == "__main__":
    sys.exit(main())
