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


def test_chosen_notice_failed_is_not_a_rejection_sentence(scripts, project):
    """선택은 적혔지만 알림 파일을 다시 쓰지 못한 갈래 — 화면은 조용히 다시 읽는다.

    이건 도구의 정상 거절(`rejected`)이 아니므로 `block_reason` 이 없어야 한다. 실패 문구를
    달면 학생은 "선택이 안 됐다"고 오해하고 다시 고르는데, 정본에는 이미 적혀 있다.
    """
    write_stub(scripts, """
import json, sys
print(json.dumps({"status": "chosen_notice_failed", "chosen": "footnote"}))
sys.exit(3)
""")

    result = methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "footnote"})

    assert result["ok"] is False
    assert result["status"] == "chosen_notice_failed"
    assert result["block_reason"] is None


def test_chosen_is_a_plain_success(scripts, project):
    """대조군 — 같은 초안에서 exit 0 이면 그대로 성공이다(문구도 없다)."""
    write_stub(scripts, """
import json, sys
print(json.dumps({"status": "chosen", "chosen": "footnote"}))
""")

    result = methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "footnote"})

    assert result["ok"] is True
    assert result["status"] == "chosen"
    assert result["block_reason"] is None


def test_plain_failed_envelope_is_not_a_saved_choice(scripts, project):
    """v0.4.11 — 고른 값이 정본에 적히지 않은 실행 실패.

    `rejected`(도구의 정상 거절)와 달리 이건 runner 가 exit 1 로 끝낸 실패다. 앱은 `ok`·`status`
    만 보고 저장 여부를 가른다(`chosen`/`chosen_notice_failed` 가 아니면 저장 아님). 그래서 봉투가
    `status` 를 잃거나 `ok` 가 참으로 새면 화면이 실패를 "저장됨"으로 그린다 — 그 계약을 여기서 잠근다.
    """
    write_stub(scripts, """
import json, sys
print(json.dumps({"status": "failed"}))
sys.exit(1)
""")

    result = methods_scripts.notices_choose(Ctx(), {"root": str(project), "identity": "abc123", "value": "footnote"})

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["exit"] == 1
    assert result["data"] == {"status": "failed"}
    assert result["block_reason"] is None


# --- confirm: 바뀐 계산 칸 확인 ----------------------------------------------
#
# `gg_notices.py confirm` 은 출처를 **필수**로 받는다(`--by app_click` 또는 `--relayed-quote`).
# 둘 다 없거나 둘 다 있으면 도구가 거절하므로, 사이드카가 갈래를 하나만 골라 넘기는지 잠근다.


def test_confirm_is_registered_as_a_write():
    """확인은 정본을 고친다 — 읽기로 등록되면 agentBusy 검사가 통째로 빠진다."""
    server = Server()
    methods_scripts.register(server)
    assert server.methods["notices.confirm"][1] is True


def test_confirm_without_a_quote_is_app_click(scripts, tmp_path, project):
    seen = tmp_path / "argv.json"
    write_stub(scripts, f"""
import json, sys
open({str(seen)!r}, "w", encoding="utf-8").write(json.dumps(sys.argv[1:], ensure_ascii=False))
print(json.dumps({{"status": "acknowledged", "acknowledged_by": "app_click", "notice_identity": "abc123"}}))
""")

    result = methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": "abc123"})

    assert result["ok"] is True
    assert result["status"] == "acknowledged"
    assert result["block_reason"] is None
    # 하위 명령 → 폴더 → 플래그. `--by` 는 앱이 고르는 값이 아니라 늘 app_click 이다.
    assert json.loads(seen.read_text(encoding="utf-8")) == [
        "confirm", str(project), "--identity", "abc123", "--by", "app_click",
    ]


def test_confirm_with_a_quote_uses_only_the_relayed_flag(scripts, tmp_path, project):
    """전달 문장이 있으면 `--relayed-quote` 만 — `--by` 를 함께 넘기면 도구가 confirm_source_invalid 로 거절한다."""
    seen = tmp_path / "argv.json"
    write_stub(scripts, f"""
import json, sys
open({str(seen)!r}, "w", encoding="utf-8").write(json.dumps(sys.argv[1:], ensure_ascii=False))
print(json.dumps({{"status": "acknowledged", "acknowledged_by": "relayed"}}))
""")

    result = methods_scripts.notices_confirm(
        Ctx(), {"root": str(project), "identity": "abc123", "relayed_quote": "  교수님이 그대로 두라고 하셨어요  "})

    assert result["ok"] is True
    argv = json.loads(seen.read_text(encoding="utf-8"))
    assert argv == ["confirm", str(project), "--identity", "abc123", "--relayed-quote",
                    "교수님이 그대로 두라고 하셨어요"]
    assert "--by" not in argv


@pytest.mark.parametrize("quote", ["", "   ", 5, ["문장"]])
def test_confirm_refuses_an_unusable_quote_before_spawn(scripts, tmp_path, project, quote):
    marker = tmp_path / "ran"
    write_stub(scripts, f"""
open({str(marker)!r}, "w").write("x")
print(json.dumps({{"status": "acknowledged"}}))
""")
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": "abc123", "relayed_quote": quote})
    assert caught.value.code == "invalid_params"
    assert not marker.exists()


@pytest.mark.parametrize("identity", ["", "   ", "-abc"])
def test_confirm_identity_must_be_a_usable_value(scripts, project, identity):
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": identity})
    assert caught.value.code == "invalid_params"


def test_confirm_without_the_tool_is_a_loud_failure(scripts, project):
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": "abc123"})
    assert caught.value.code == "notices_script_missing"


def test_confirm_requires_a_real_folder(scripts, tmp_path):
    with pytest.raises(RpcError) as caught:
        methods_scripts.notices_confirm(Ctx(), {"root": str(tmp_path / "없는폴더"), "identity": "abc123"})
    assert caught.value.code == "invalid_params"


@pytest.mark.parametrize("reason", [
    "notice_stale", "record_not_active", "record_unwritable", "lineage_id_collision",
    "notice_identity_unknown", "confirm_source_missing", "confirm_source_invalid", "relayed_quote_missing",
])
def test_confirm_rejection_keeps_the_code_and_adds_the_sentence(scripts, project, reason):
    """화면과 e2e 는 `data.reason`(기계 코드)로 판단하고, 학생 문장은 `block_reason` 에만 있다."""
    write_stub(scripts, f"""
import json, sys
print(json.dumps({{"status": "rejected", "reason": {reason!r}}}))
sys.exit(1)
""")

    result = methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": "abc123"})

    assert result["ok"] is False
    assert result["status"] == "rejected"
    assert result["data"] == {"status": "rejected", "reason": reason}
    assert result["block_reason"] == methods_scripts.NOTICE_REJECT_TEXT[reason]


def test_confirm_unknown_rejection_reason_still_gets_a_sentence(scripts, project):
    write_stub(scripts, """
import json, sys
print(json.dumps({"status": "rejected", "reason": "something_new"}))
sys.exit(1)
""")

    result = methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": "abc123"})

    assert result["ok"] is False
    assert result["data"] == {"status": "rejected", "reason": "something_new"}
    assert result["block_reason"] == "확인을 적지 못했어요(something_new)"


def test_confirm_success_with_a_cleanup_warning_stays_a_success(scripts, project):
    """곁파일 정리 실패는 정본에 확인이 적힌 뒤의 경고다 — 성공을 거절로 뒤집지 않는다(계약 §2-1)."""
    write_stub(scripts, """
import json
print(json.dumps({"status": "acknowledged", "acknowledged_by": "app_click",
                  "cleanup_warning": {"reason": "lock_left", "cleanup_errors": ["잠금 파일"]}}))
""")

    result = methods_scripts.notices_confirm(Ctx(), {"root": str(project), "identity": "abc123"})

    assert result["ok"] is True
    assert result["status"] == "acknowledged"
    assert result["block_reason"] is None
    assert result["data"]["cleanup_warning"]["reason"] == "lock_left"
