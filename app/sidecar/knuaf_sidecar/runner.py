"""Run a skill script as a subprocess with streaming logs, timeout and cancel."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from .envelope import normalize
from .rpc import RpcError

CREATE_NO_WINDOW = 0x08000000


def run_script(ctx, python, script_path, args, cwd, timeout: float, env_extra=None) -> dict:
    argv = [str(python), str(script_path), *map(str, args)]
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "KORDOC_OFFLINE": "1"})
    if env_extra:
        env.update(env_extra)
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    else:
        # The ensure process can spawn pip; cancellation owns the whole child group.
        kwargs["start_new_session"] = True
    started = time.monotonic()
    ctx.progress("start", argv=argv, cwd=str(cwd))
    with ctx.process_lock:
        if ctx.cancelled.is_set():
            raise RpcError("cancelled", "request cancelled before script start")
        proc = subprocess.Popen(
            argv,
            cwd=str(cwd) if cwd else None,
            env=env,
            # The scripts never read stdin: it belongs to the host's RPC pipe.
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            **kwargs,
        )
        ctx.process = proc
    out_buf, err_buf = [], []

    def pump(stream, buf, name):
        for line in iter(stream.readline, ""):
            buf.append(line)
            ctx.log(name, line.rstrip("\n"))
        stream.close()

    threads = [
        threading.Thread(target=pump, args=(proc.stdout, out_buf, "stdout"), daemon=True),
        threading.Thread(target=pump, args=(proc.stderr, err_buf, "stderr"), daemon=True),
    ]
    for t in threads:
        t.start()
    timed_out = False
    deadline = started + timeout
    while True:
        with ctx.process_lock:
            if ctx.stop_error is not None:
                raise ctx.stop_error
            try:
                # Bound lock ownership so cancel can enter, but never reap while
                # another thread owns the tree-signalling boundary.
                proc.wait(timeout=max(0, min(0.05, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            else:
                ctx.process = None
                break
        if time.monotonic() >= deadline:
            timed_out = True
            ctx.stop_process()
            break
        # Yield outside the lifecycle lock to a waiting cancel/shutdown caller.
        ctx.cancelled.wait(0.01)
    for t in threads:
        t.join(timeout=5)
    duration_ms = int((time.monotonic() - started) * 1000)
    if ctx.cancelled.is_set():
        raise RpcError("cancelled", "request cancelled", {"argv": argv})
    if timed_out:
        raise RpcError("timeout", "script exceeded %ss" % timeout, {"argv": argv, "stdout": "".join(out_buf)[-4000:], "stderr": "".join(err_buf)[-4000:]})
    envelope = normalize(argv, python, proc.returncode, "".join(out_buf), "".join(err_buf), duration_ms, cwd=str(cwd) if cwd else None)
    ctx.progress("done", ok=envelope["ok"], exit=envelope["exit"], duration_ms=duration_ms)
    return envelope


def _kill(proc):
    """Stop the script tree. Caller holds Context.process_lock through reap."""
    if sys.platform == "win32":
        system_root = os.environ.get("SystemRoot") or os.environ.get("SYSTEMROOT") or r"C:\Windows"
        killed = subprocess.run(
            [os.path.join(system_root, "System32", "taskkill.exe"), "/T", "/F", "/PID", str(proc.pid)],
            capture_output=True, timeout=10,
        )
        if killed.returncode and proc.poll() is None:
            raise RpcError("process_stop_failed", "script tree termination was not confirmed")
    else:
        # Cancellation is a hard boundary, not graceful shutdown. One group
        # signal also avoids signalling a macOS group whose leader TERM exited.
        # The caller's lock keeps the leader unreaped until signalling is over.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError as error:
            raise RpcError("process_stop_failed", "script tree termination was not confirmed") from error
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired as error:
        raise RpcError("process_stop_failed", "script exit was not confirmed") from error


def project_python(project: Path):
    """Interpreter for dependency-needing scripts: the project venv, else None."""
    try:
        import gg_deps  # noqa: WPS433 - scripts dir is on sys.path
    except ImportError:
        return None
    return gg_deps.venv_python(project)
