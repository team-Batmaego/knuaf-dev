"""`lock.upgrade_offline` — 옮긴·복사한 논문 폴더의 잠금을 학생 확인 뒤 오프라인 복구한다.

규칙집 v0.6.5(skill 1.0.17)부터 `gg_lock.upgrade_offline` 이 있다. 옮긴 폴더는
`structure='damaged'`, `reason='directory_identity_mismatch'`, `relocation_candidate=True` 로 보이고
`lock.unlock` 은 계속 거부한다. 앱은 확인 창에서 받은 값만 `offline_confirmed=True` 로 넘긴다.

동봉 규칙집이 1.0.14(함수 없음)면 실물 복구 시험은 건너뛰고, '업데이트 필요' 오류 시험이 실물로 돈다.
1.0.17 실물로 돌리려면 `KNUAF_TEST_SCRIPTS_DIR=<v0.6.5 scripts>` 로 이 파일을 실행한다.
"""
import io
import json
import shutil
import sys

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app" / "sidecar"))
from knuaf_sidecar import methods_core  # noqa: E402
from knuaf_sidecar.rpc import Server  # noqa: E402

import gg_lock  # noqa: E402  (scripts dir is on sys.path via conftest)

HAS_UPGRADE = callable(getattr(gg_lock, "upgrade_offline", None))
needs_upgrade = pytest.mark.skipif(not HAS_UPGRADE, reason="설치 규칙집에 gg_lock.upgrade_offline 없음(1.0.14 동봉판)")


def _rpc(method, params):
    """실제 등록·디스패치를 그대로 지나 응답 하나를 돌려준다(사이드카 기동 없이)."""
    out = io.StringIO()
    server = Server(out=out)
    methods_core.register(server)
    server._handle({"id": 1, "method": method, "params": params})
    return json.loads(out.getvalue())


def _tree(root):
    """폴더 안 파일 경로·내용 지문 — '아무것도 안 바뀌었다'를 확인할 때 쓴다."""
    return {str(p.relative_to(root)): (p.read_bytes() if p.is_file() else None) for p in sorted(root.rglob("*"))}


@pytest.fixture
def moved(tmp_path):
    """규칙집 시험(test_p2_recovery.test_copied_workspace_recovery)과 같은 방법으로 복사본을 만든다."""
    base = tmp_path / "base"
    base.mkdir()
    proto = gg_lock.install_new(base)
    (base / "project.json").write_text("{}", encoding="utf-8")
    copy = tmp_path / "copy"
    shutil.copytree(base, copy)
    return copy, proto


def test_upgrade_offline_is_a_write_method():
    server = Server(out=io.StringIO())
    methods_core.register(server)
    assert server.methods["lock.upgrade_offline"][1] is True


def test_missing_skill_function_is_a_recognizable_error(tmp_path, monkeypatch):
    """L4: 규칙집 1.0.14(함수 없음)면 '업데이트 필요' 코드로 끝나고 폴더를 건드리지 않는다."""
    if HAS_UPGRADE:
        monkeypatch.delattr(gg_lock, "upgrade_offline")
    (tmp_path / "project.json").write_text("{}", encoding="utf-8")
    before = _tree(tmp_path)
    error = _rpc("lock.upgrade_offline", {"root": str(tmp_path), "offline_confirmed": True})["error"]
    assert error["code"] == "skill_update_required"
    assert error["data"] == {"feature": "lock.upgrade_offline"}
    assert _tree(tmp_path) == before


def test_only_literal_true_counts_as_confirmation(tmp_path, monkeypatch):
    calls = []

    def fake(root, *, offline_confirmed, resume_id=None):
        calls.append((offline_confirmed, resume_id))
        return {"status": "blocked"}

    monkeypatch.setattr(gg_lock, "upgrade_offline", fake, raising=False)
    for value in (None, False, "true", 1, "yes"):
        params = {"root": str(tmp_path)} if value is None else {"root": str(tmp_path), "offline_confirmed": value}
        assert "result" in _rpc("lock.upgrade_offline", params)
    _rpc("lock.upgrade_offline", {"root": str(tmp_path), "offline_confirmed": True, "resume": "rid-1"})
    assert calls == [(False, None)] * 5 + [(True, "rid-1")]


@pytest.mark.parametrize("resume", ["", 3, ["x"]])
def test_bad_resume_is_invalid_params(tmp_path, monkeypatch, resume):
    monkeypatch.setattr(gg_lock, "upgrade_offline", lambda *a, **k: pytest.fail("called"), raising=False)
    error = _rpc("lock.upgrade_offline", {"root": str(tmp_path), "offline_confirmed": True, "resume": resume})["error"]
    assert error["code"] == "invalid_params"


def test_lock_error_maps_like_unlock(tmp_path, monkeypatch):
    def busy(*a, **k):
        raise gg_lock.LockError("busy", "guard_busy")

    monkeypatch.setattr(gg_lock, "upgrade_offline", busy, raising=False)
    error = _rpc("lock.upgrade_offline", {"root": str(tmp_path), "offline_confirmed": True})["error"]
    assert error["code"] == "lock_held" and error["data"] == {"status": "busy", "reason": "guard_busy"}


@needs_upgrade
def test_moved_folder_is_relocation_candidate_and_unlock_refuses(moved):
    copy, _ = moved
    info = _rpc("lock.info", {"root": str(copy)})["result"]
    assert (info["structure"], info["reason"], info["relocation_candidate"]) == (
        "damaged", "directory_identity_mismatch", True), info
    error = _rpc("lock.unlock", {"root": str(copy)})["error"]
    assert error["code"] == "lock_ambiguous" and error["data"]["status"] == "damaged"


@needs_upgrade
def test_without_confirmation_nothing_changes(moved):
    """L2: 확인 없이 부르면 blocked/offline_confirmation_required, 폴더 내용 그대로."""
    copy, _ = moved
    before = _tree(copy)
    result = _rpc("lock.upgrade_offline", {"root": str(copy)})["result"]
    assert (result["status"], result["commit_state"], result["reason"]) == (
        "blocked", "not_committed", "offline_confirmation_required")
    assert _tree(copy) == before


@needs_upgrade
def test_confirmed_recovery_makes_moved_folder_ready_and_free(moved):
    """L1(사이드카 몫): 확인 뒤 복구 → 잠금 준비됨·비어 있음, 새 workspace_id."""
    copy, proto = moved
    result = _rpc("lock.upgrade_offline", {"root": str(copy), "offline_confirmed": True})["result"]
    assert result["status"] == "completed", result
    assert {"recovery_id", "status", "commit_state", "reason", "receipt_path", "preserved_paths", "cleanup_errors"} <= result.keys()
    info = _rpc("lock.info", {"root": str(copy), "probe": True})["result"]
    assert (info["structure"], info["lock_state"], info["relocation_candidate"]) == ("ready", "free", False), info
    assert info["protocol"]["workspace_id"] != proto["workspace_id"]
    assert (copy / "project.json").read_text(encoding="utf-8") == "{}"
    with gg_lock.Lock(copy):  # 다음 쓰기가 실제로 잠금을 잡을 수 있다
        pass


@needs_upgrade
def test_other_damage_is_not_a_relocation_candidate(tmp_path):
    """L3: 옮긴 게 아닌 손상은 relocation_candidate=False — 화면은 풀기 단추를 안 보인다."""
    gg_lock.install_new(tmp_path)
    (tmp_path / ".gg-lock" / "protocol.json").write_bytes(b"not json")
    info = _rpc("lock.info", {"root": str(tmp_path)})["result"]
    assert info["structure"] == "damaged" and info.get("relocation_candidate", False) is False, info
