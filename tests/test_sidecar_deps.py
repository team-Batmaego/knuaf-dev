"""Project readiness must never inherit the host interpreter's packages."""
import copy
import json
import os
import socket
import sys

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app/sidecar"))
from knuaf_sidecar.methods_core import project_deps_report  # noqa: E402
from knuaf_sidecar.rpc import RpcError  # noqa: E402
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
