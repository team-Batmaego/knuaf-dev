"""Opt-in E2E timing only; never record project paths, payloads or credentials."""
from contextlib import contextmanager
import json
import os
import sys
import time


_STAGES = {
    ("gg_core", "doctor"): "aggregate",
    ("gg_lock", "inspect_lock"): "lock.inspect",
    ("gg_lock", "probe_lock"): "lock.probe",
    ("gg_deps", "doctor"): "dependencies",
    ("gg_deps", "_import_and_version_current"): "dependency.current",
    ("gg_deps", "_import_and_version"): "dependency.project",
    ("gg_kordoc", "diagnose"): "kordoc",
    ("gg_core", "history"): "history",
}


@contextmanager
def trace_doctor(ctx):
    target = os.environ.get("KNUAF_E2E_DOCTOR_TRACE")
    if not target:
        yield
        return
    started = time.monotonic()
    calls = {}
    scan_started = None

    def record(stage, event, now, **fields):
        row = {"request_id": ctx.id, "pid": os.getpid(), "stage": stage,
               "event": event, "elapsed_ms": round((now - started) * 1000, 3), **fields}
        with open(target, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=True) + "\n")

    def observe(frame, event, _arg):
        nonlocal scan_started
        key = (frame.f_globals.get("__name__"), frame.f_code.co_name)
        stage = _STAGES.get(key)
        if stage is None or event not in ("call", "return"):
            return
        now = time.monotonic()
        if event == "call":
            calls[id(frame)] = now
            # These names come from the pinned dependency manifest, not student data.
            fields = {"module": frame.f_locals["module"]} if stage.startswith("dependency.") else {}
            record(stage, "start", now, **fields)
        else:
            begin = calls.pop(id(frame), now)
            record(stage, "end", now, duration_ms=round((now - begin) * 1000, 3))
            if stage == "history":
                # In the pinned doctor, history is followed by the orphan scan and report assembly.
                scan_started = now
                record("orphan_scan", "start", now)
            elif stage == "aggregate" and scan_started is not None:
                record("orphan_scan", "end", now, duration_ms=round((now - scan_started) * 1000, 3))

    previous = sys.getprofile()
    record("doctor.all", "start", started)
    sys.setprofile(observe)
    try:
        yield
    finally:
        sys.setprofile(previous)
        now = time.monotonic()
        record("doctor.all", "end", now, duration_ms=round((now - started) * 1000, 3))
