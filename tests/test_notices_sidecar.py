"""`notices.choose` — the app never writes the ledger itself; it asks gg_notices.py.

The real tool is not in this checkout yet, so the tests place a stub where
`_scripts_dir()` looks and drive the real `_run` → `runner.run_script` → `envelope.normalize`
chain. What is pinned: argv order the CLI's argparse sub-parser needs, exit-code
translation, and that a `rejected` result reaches the screen as a sentence rather than
as a false success.
"""
import json
import sys
import threading

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app/sidecar"))
from knuaf_sidecar import methods_scripts  # noqa: E402
from knuaf_sidecar.rpc import RpcError, Server  # noqa: E402


class Ctx:
    """The parts of rpc.Context that runner.run_script touches."""

    def __init__(self):
        self.cancelled = threading.Event()
        self.process = None

    def progress(self, *args, **kwargs):
        pass

    def log(self, *args, **kwargs):
        pass


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "논문"
    root.mkdir()
    return root


@pytest.fixture
def scripts(tmp_path, monkeypatch):
    """A scripts dir holding only the stub — `_run` and `_confine` stay real."""
    folder = tmp_path / "scripts"
    folder.mkdir()
    monkeypatch.setattr(methods_scripts, "_scripts_dir", lambda: folder)
    return folder


def write_stub(scripts, body: str):
    (scripts / "gg_notices.py").write_text(body, encoding="utf-8")


def test_registered_as_a_write():
    server = Server()
    methods_scripts.register(server)
    assert server.methods["notices.choose"][1] is True


def test_choose_sends_subcommand_folder_then_flags(scripts, tmp_path, project):
    seen = tmp_path / "argv.json"
    write_stub(scripts, f"""
import json, sys
open({str(seen)!r}, "w", encoding="utf-8").write(json.dumps(sys.argv[1:], ensure_ascii=False))
print(json.dumps({{"status": "written", "chosen": "footnote"}}))
""")

    result = methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "footnote"})

    assert result["ok"] is True
    assert result["status"] == "written"
    assert json.loads(seen.read_text(encoding="utf-8")) == [
        "choose", str(project), "--identity", "abc123", "--value", "footnote",
    ]


def test_missing_tool_is_a_loud_failure_not_a_silent_success(scripts, project):
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "direct_tell"})
    assert caught.value.code == "notices_script_missing"
    assert "gg_notices.py" in caught.value.message


def test_value_outside_the_contract_never_reaches_the_script(scripts, tmp_path, project):
    marker = tmp_path / "ran"
    write_stub(scripts, f"""
open({str(marker)!r}, "w").write("x")
print(json.dumps({{"status": "written"}}))
""")
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "both"})
    assert caught.value.code == "invalid_params"
    assert not marker.exists()


@pytest.mark.parametrize("identity", ["", "   ", "-abc"])
def test_identity_must_be_a_usable_value(scripts, project, identity):
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": identity, "value": "footnote"})
    assert caught.value.code == "invalid_params"


def test_folder_that_is_not_a_directory_is_refused_before_spawn(scripts, tmp_path):
    missing = tmp_path / "없는폴더"
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_choose(Ctx(), {"root": str(missing), "identity": "abc123", "value": "footnote"})
    assert caught.value.code == "invalid_params"


def test_rejected_envelope_carries_the_reason_to_the_screen(scripts, project):
    write_stub(scripts, """
import json, sys
print(json.dumps({"status": "rejected", "reason": "revision_conflict"}))
sys.exit(1)
""")

    result = methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "footnote"})

    assert result["ok"] is False
    assert result["status"] == "rejected"
    assert result["block_reason"] == methods_scripts.NOTICE_REJECT_TEXT["revision_conflict"]


def test_unknown_rejection_reason_still_gets_a_sentence(scripts, project):
    write_stub(scripts, """
import json, sys
print(json.dumps({"status": "rejected", "reason": "something_new"}))
sys.exit(1)
""")

    result = methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "footnote"})

    assert result["ok"] is False
    assert result["block_reason"] == "선택을 적지 못했어요(something_new)"
