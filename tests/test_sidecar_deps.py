"""Project readiness must never inherit the host interpreter's packages."""
import copy
import errno
import io
import json
import os
import socket
import signal
import subprocess
import sys
import threading

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app/sidecar"))
from knuaf_sidecar.methods_core import project_deps_report  # noqa: E402
from knuaf_sidecar import runner  # noqa: E402
from knuaf_sidecar.rpc import Context, RpcError, Server  # noqa: E402
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


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX killpg PermissionError regression")
@pytest.mark.parametrize("alive", [False, True])
def test_kill_permission_error_requires_confirmed_leader_exit(monkeypatch, alive):
    code = (
        "import signal,time; "
        + ("signal.signal(signal.SIGTERM, signal.SIG_IGN); " if alive else "")
        + "print('ready', flush=True); time.sleep(60)"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code], start_new_session=True,
        stdout=subprocess.PIPE, text=True,
    )
    killpg = os.killpg

    def deny_kill(pid, sig):
        if pid == proc.pid and sig == signal.SIGKILL:
            raise PermissionError(errno.EPERM, "Operation not permitted")
        return killpg(pid, sig)

    try:
        assert proc.stdout.readline().strip() == "ready"
        monkeypatch.setattr(runner.os, "killpg", deny_kill)
        if alive:
            with pytest.raises(RpcError) as failure:
                runner._kill(proc)
            assert failure.value.code == "process_stop_failed"
            assert proc.poll() is None
        else:
            runner._kill(proc)
            assert proc.returncode == -signal.SIGTERM
    finally:
        if proc.poll() is None:
            killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
        proc.stdout.close()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX cancellation failure regression")
@pytest.mark.parametrize("stop", ["cancel", "shutdown"])
def test_stop_failure_answers_and_keeps_running_write_owned(tmp_path, monkeypatch, stop):
    script = tmp_path / "running.py"
    script.write_text(
        "import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\ntime.sleep(60)\n", encoding="utf-8",
    )
    ready = threading.Event()
    output = io.StringIO()
    server = Server(out=output)
    contexts = []
    second_started = threading.Event()
    killpg = os.killpg
    log = Context.log

    def observe_log(ctx, stream, line):
        log(ctx, stream, line)
        if line == "ready":
            ready.set()

    def deny_kill(pid, sig):
        if contexts and pid == contexts[0].process.pid and sig == signal.SIGKILL:
            raise PermissionError(errno.EPERM, "Operation not permitted")
        return killpg(pid, sig)

    def work(ctx, params):
        contexts.append(ctx)
        return runner.run_script(ctx, sys.executable, script, [], tmp_path, timeout=30)

    def second(ctx, params):
        assert contexts[0].process.poll() is not None, "write overlapped surviving process"
        second_started.set()
        return {"finished": True}

    def requests():
        yield json.dumps({"id": "work", "method": "work"})
        assert ready.wait(5), "script did not become ready"
        yield json.dumps({"id": "stop", "method": stop, "params": {"id": "work"}})
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        reply = next(message for message in replies if message.get("id") == "stop")
        assert reply["error"]["code"] == "process_stop_failed"
        assert "result" not in reply
        assert contexts[0].process.poll() is None
        assert server.pending["work"] is contexts[0]
        assert server.write_lock.locked()
        yield json.dumps({"id": "probe", "method": "methods.list"})
        yield json.dumps({"id": "second", "method": "second"})
        assert not second_started.is_set()
        killpg(contexts[0].process.pid, signal.SIGKILL)

    monkeypatch.setattr(Context, "log", observe_log)
    monkeypatch.setattr(runner.os, "killpg", deny_kill)
    server.register("work", work, write=True)
    server.register("second", second, write=True)
    server.inp = requests()
    try:
        server.serve()
        replies = {message["id"]: message for message in
                   map(json.loads, output.getvalue().splitlines()) if "event" not in message}
        assert replies["work"]["error"]["code"] == "cancelled"
        assert any(method["name"] == "work" for method in replies["probe"]["result"])
        assert replies["second"]["result"] == {"finished": True}
    finally:
        if contexts and contexts[0].process is not None:
            proc = contexts[0].process
            if proc.poll() is None:
                killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
