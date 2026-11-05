"""Project readiness must never inherit the host interpreter's packages."""
import contextlib
import copy
import json
import os
import queue
import signal
import socket
import sys
import threading
import time

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app/sidecar"))
from knuaf_sidecar.methods_core import project_deps_report  # noqa: E402
from knuaf_sidecar import runner  # noqa: E402
from knuaf_sidecar.rpc import RpcError, Server  # noqa: E402
from test_sidecar import Sidecar


def report():
    installed = {"imported": True, "version_in_range": True, "status": "installed"}
    return {"ready": True, "current_python": "/bundled/python", "venv_python": None,
            "dependencies": [{"dist": "docx", "current": installed, "venv": None, "status": "installed"}]}


def test_current_packages_without_project_venv_are_not_ready():
    raw = report()
    original = copy.deepcopy(raw)
    normalized = project_deps_report(raw)
    assert normalized["ready"] is False
    assert normalized["selected_python"] is None
    assert normalized["dependencies"][0]["status"] == "missing"
    assert normalized["dependencies"][0]["current"]["imported"] is True
    assert raw == original


@pytest.mark.parametrize("field,value", [("imported", False), ("version_in_range", False),
                                         ("version_in_range", None), ("status", "unsupported-version")])
def test_each_project_venv_requirement_is_mandatory(field, value):
    raw = report()
    raw["venv_python"] = "/project/.venv/bin/python3"
    raw["dependencies"][0]["venv"] = {**raw["dependencies"][0]["current"], field: value}
    assert project_deps_report(raw)["ready"] is False


def test_ready_selects_project_venv_not_current_python():
    raw = report()
    raw["venv_python"] = "/project/.venv/bin/python3"
    raw["dependencies"][0]["venv"] = raw["dependencies"][0]["current"].copy()
    raw["dependencies"][0]["current"] = {"imported": False, "status": "missing", "version_in_range": None}
    normalized = project_deps_report(raw)
    assert normalized["ready"] is True
    assert normalized["selected_python"] == raw["venv_python"]


@pytest.mark.parametrize("raw", [None, [], {}, {"dependencies": []}, {"dependencies": [None]},
                                 {"error": "doctor failed"},
                                 {"venv_python": None, "current_python": "/python", "dependencies": [{}]},
                                 {"venv_python": None, "current_python": "/python", "dependencies": [{"dist": "docx", "current": {}, "venv": []}]},
                                 {"venv_python": "/project/python", "current_python": "/python", "dependencies": [{"dist": "docx", "current": {}, "venv": None}]}])
def test_malformed_diagnosis_is_an_error_not_an_install_request(raw):
    with pytest.raises(RpcError) as failure:
        project_deps_report(raw)
    assert failure.value.code == "deps_doctor"


@pytest.mark.parametrize("field,value", [("imported", "yes"), ("imported", 1),
                                       ("version_in_range", "true"), ("status", None)])
def test_malformed_venv_probe_is_not_reinterpreted_as_install_needed(field, value):
    raw = report()
    raw["venv_python"] = "/project/.venv/bin/python3"
    raw["dependencies"][0]["venv"] = {**raw["dependencies"][0]["current"], field: value}
    with pytest.raises(RpcError) as failure:
        project_deps_report(raw)
    assert failure.value.code == "deps_doctor"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX script wrapper; Windows tree termination requires real-device QA")
@pytest.mark.parametrize("stop", ["cancel", "shutdown"])
def test_stopping_ensure_also_stops_its_pip_child(tmp_path, stop):
    """A surviving pip child could race the next installation into the same .venv."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(10)
    child_code = (
        "import socket; s=socket.create_connection(('127.0.0.1',%d)); "
        "s.sendall(b'child-ready'); s.recv(1)"
    ) % listener.getsockname()[1]
    wrapper = tmp_path / "ensure-python"
    wrapper.write_text(
        "#!%s\nimport subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',%r])\ntime.sleep(60)\n"
        % (sys.executable, child_code), encoding="utf-8",
    )
    os.chmod(wrapper, 0o755)
    sidecar = Sidecar()
    connection = None
    try:
        rid = sidecar.send("deps.ensure", root=str(tmp_path), base_python=str(wrapper))
        connection, _ = listener.accept()
        connection.settimeout(5)
        assert connection.recv(20) == b"child-ready"
        sidecar.proc.stdin.write(json.dumps(
            {"id": "stop", "method": stop, "params": {"id": rid}},
        ) + "\n")
        sidecar.proc.stdin.flush()
        assert connection.recv(1) == b"", "pip child survived cancellation/shutdown"
        if stop == "cancel":
            assert sidecar.wait(rid, timeout=5)["error"]["code"] == "cancelled"
        else:
            sidecar.proc.wait(timeout=5)
    finally:
        if connection:
            connection.close()
        listener.close()
        if sidecar.proc.poll() is None:
            sidecar.close()


class ScriptServer:
    """Real RPC dispatcher and script worker, with queue-backed JSON-lines I/O."""

    def __init__(self, script, timeout=60):
        self.requests = queue.Queue()
        self.responses = queue.Queue()
        self.messages = []
        self.server = Server(inp=iter(self.requests.get, None), out=self)
        self.server.register("script", lambda ctx, params: runner.run_script(
            ctx, sys.executable, script, [], script.parent, timeout,
        ))
        self.thread = threading.Thread(target=self.server.serve, daemon=True)
        self.thread.start()

    def write(self, line):
        self.responses.put(json.loads(line))

    def flush(self):
        pass

    def send(self, rid, method, **params):
        self.requests.put(json.dumps({"id": rid, "method": method, "params": params}))

    def wait(self, rid):
        deadline = time.monotonic() + 8
        while True:
            for message in self.messages:
                if message.get("id") == rid and "event" not in message:
                    self.messages.remove(message)
                    return message
            self.messages.append(self.responses.get(timeout=max(0, deadline - time.monotonic())))

    def finish(self):
        # Test teardown never relies on the injected failing stop function.
        for ctx in list(self.server.pending.values()):
            with ctx.process_lock:
                proc = ctx.process
                if proc is not None:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
                    ctx.process = None
        self.requests.put(None)
        self.thread.join(timeout=8)
        assert not self.thread.is_alive()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX group ownership regression")
@pytest.mark.parametrize("stop", ["cancel", "shutdown", "timeout"])
def test_tree_signals_keep_leader_unreaped_with_active_worker(tmp_path, monkeypatch, stop):
    """Hold the signal boundary after real exit while the worker wants to reap."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(8)
    child = (
        "import signal,socket; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "s=socket.create_connection(('127.0.0.1',%d)); s.sendall(b'R'); s.recv(1)"
    ) % listener.getsockname()[1]
    script = tmp_path / "tree.py"
    script.write_text(
        "import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',%r])\ntime.sleep(60)\n" % child,
        encoding="utf-8",
    )
    real_killpg = os.killpg
    observations = []

    def signal_with_scheduling_window(pid, sig):
        real_killpg(pid, sig)
        deadline = time.monotonic() + 3
        while os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            assert time.monotonic() < deadline
            time.sleep(0.005)
        time.sleep(0.15)
        # Observe the real zombie without releasing its PID. No worker may
        # reap it while tree signalling still owns the lifecycle boundary.
        state = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        observations.append(state.si_pid)

    rpc = ScriptServer(script, timeout=0.8 if stop == "timeout" else 60)
    connection = None
    try:
        monkeypatch.setattr(runner.os, "killpg", signal_with_scheduling_window)
        rpc.send("work", "script")
        connection, _ = listener.accept()
        connection.settimeout(8)
        assert connection.recv(1) == b"R"
        ctx = rpc.server.pending["work"]
        pid = ctx.process.pid
        if stop != "timeout":
            rpc.send("stop", stop, id="work")
            assert rpc.wait("stop")["result"] == ({"bye": True} if stop == "shutdown" else {"cancelled": True})
        assert rpc.wait("work")["error"]["code"] == ("timeout" if stop == "timeout" else "cancelled")
        assert observations == [pid]
        assert connection.recv(1) == b"", "SIGTERM-ignoring descendant survived"
        with pytest.raises(ChildProcessError):
            os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    finally:
        monkeypatch.setattr(runner.os, "killpg", real_killpg)
        rpc.finish()
        if connection:
            connection.close()
        listener.close()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signal failure injection")
@pytest.mark.parametrize("stop", ["cancel", "shutdown", "timeout"])
@pytest.mark.parametrize("failure", ["permission", "wait_timeout"])
def test_failed_stop_preserves_rpc_and_owned_process_for_retry(tmp_path, monkeypatch, stop, failure):
    script = tmp_path / "live.py"
    # A denied signal must leave a genuinely live process, not a fake Popen.
    script.write_text(
        "import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('ready',flush=True)\ntime.sleep(60)\n",
        encoding="utf-8",
    )
    rpc = ScriptServer(script, timeout=0.5 if stop == "timeout" else 60)
    real_killpg = os.killpg

    def denied(pid, sig):
        if failure == "wait_timeout":
            raise runner.subprocess.TimeoutExpired("injected taskkill/stop timeout", 10)
        raise PermissionError("injected signal denial")

    try:
        rpc.send("work", "script")
        while True:
            message = rpc.responses.get(timeout=8)
            if message.get("event") == "log" and message["data"]["line"] == "ready":
                break
        ctx = rpc.server.pending["work"]
        proc = ctx.process
        monkeypatch.setattr(runner.os, "killpg", denied)
        if stop != "timeout":
            rpc.send("failed", stop, id="work")
            assert rpc.wait("failed")["error"]["code"] == "process_stop_failed"
        assert rpc.wait("work")["error"]["code"] == "process_stop_failed"
        # Wait until the worker's finally ran, not just its response write.
        deadline = time.monotonic() + 3
        while not ctx.finished:
            assert time.monotonic() < deadline
            time.sleep(0.005)
        assert rpc.server.pending["work"] is ctx
        assert ctx.process is proc and not ctx.cancelled.is_set()
        os.kill(proc.pid, 0)
        rpc.send("list", "methods.list")
        assert {entry["name"] for entry in rpc.wait("list")["result"]} == {"methods.list", "script"}
        rpc.send("again", "cancel", id="work")
        assert rpc.wait("again")["error"]["code"] == "process_stop_failed"
        assert rpc.server.pending["work"] is ctx
        monkeypatch.setattr(runner.os, "killpg", real_killpg)
        # Cover both retry mechanisms after a failed control request/timeout.
        recovery = "shutdown" if stop == "shutdown" else "cancel"
        rpc.send("recovered", recovery, id="work")
        assert rpc.wait("recovered")["result"] == ({"bye": True} if recovery == "shutdown" else {"cancelled": True})
        assert proc.returncode == -signal.SIGKILL
        assert "work" not in rpc.server.pending
        if recovery != "shutdown":
            rpc.send("gone", "cancel", id="work")
            assert rpc.wait("gone")["result"] == {"cancelled": False}
            rpc.send("bye", "shutdown")
            assert rpc.wait("bye")["result"] == {"bye": True}
        rpc.thread.join(timeout=8)
        assert not rpc.thread.is_alive()
    finally:
        monkeypatch.setattr(runner.os, "killpg", real_killpg)
        rpc.finish()
