"""`project.outline` — 규칙집이 알려 주는 차례 상태를 그대로 넘기는 읽기 전용 메서드.

CONTRACT-A4 §2: `gg_outline` 이 없으면(옛 스킬 핀) `{"state": "unsupported"}` 이고 오류가 아니다.
답이 오류가 되면 화면이 "이 전공은 학교 차례가 없다"로 읽어 버리므로, 없는 것과 깨진 것을 가른다.
"""
import io
import json
import sys
import types

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app" / "sidecar"))
from knuaf_sidecar import methods_core  # noqa: E402
from knuaf_sidecar.rpc import Server  # noqa: E402


def _rpc(method, params):
    """실제 등록·디스패치를 그대로 지나 응답 하나를 돌려준다(사이드카 기동 없이)."""
    out = io.StringIO()
    server = Server(out=out)
    methods_core.register(server)
    server._handle({"id": 1, "method": method, "params": params})
    return json.loads(out.getvalue())


def _fake_outline(calls, answer):
    """`gg_outline` 대역 — 받은 인자를 적어 두고 정해진 답을 돌려준다."""
    module = types.ModuleType("gg_outline")

    def outline_state(root, project):
        calls.append((root, project))
        return dict(answer)

    module.outline_state = outline_state
    return module


@pytest.fixture
def skill_stub(tmp_path, monkeypatch):
    """진짜 `gg_outline.py` 파일을 sys.path 앞에 세우는 설치기 — import 기계를 그대로 지난다."""
    def install(body):
        monkeypatch.delitem(sys.modules, "gg_outline", raising=False)
        (tmp_path / "gg_outline.py").write_text(body, encoding="utf-8")
        monkeypatch.syspath_prepend(str(tmp_path))  # also invalidates the finder caches
    yield install
    sys.modules.pop("gg_outline", None)  # a broken stub stays imported for later tests otherwise


def test_outline_is_read_only_and_returns_the_skill_answer(monkeypatch, project):
    answer = {"state": "no_school_toc", "major_id": "specialty_crops", "profile_id": None,
              "sections": 3, "reason": None}
    calls = []
    monkeypatch.setitem(sys.modules, "gg_outline", _fake_outline(calls, answer))

    flags = {m["name"]: m["write"] for m in _rpc("methods.list", {})["result"]}
    assert flags["project.outline"] is False

    reply = _rpc("project.outline", {"root": str(project)})
    assert "error" not in reply, reply
    assert reply["result"] == answer
    assert len(calls) == 1
    root, loaded = calls[0]
    assert root == str(project)
    assert loaded["revision"] == 2 and "sections" in loaded


def test_missing_skill_module_is_unsupported_not_an_error(monkeypatch):
    # None in sys.modules makes `import gg_outline` fail the way an absent module does, whatever
    # module the staged pin ships. root is never opened: an old pin lacks the capability outright.
    monkeypatch.setitem(sys.modules, "gg_outline", None)

    reply = _rpc("project.outline", {"root": "/nonexistent"})
    assert "error" not in reply, reply
    assert reply["result"] == {"state": "unsupported"}


@pytest.mark.parametrize("body,code", [
    # 스킬 안쪽 의존성이 빠진 판 — 고쳐야 할 것이지 "학교 차례 없음"이 아니다.
    ("import gg_outline_support_missing\n", "deps_not_ready"),
    ("def outline_state(root, project)\n", "internal"),
])
def test_a_broken_skill_module_is_an_error_not_unsupported(skill_stub, project, body, code):
    skill_stub(body)

    reply = _rpc("project.outline", {"root": str(project)})
    assert reply["error"]["code"] == code, reply
    assert "result" not in reply


@pytest.mark.parametrize("params", [{}, {"root": ""}, {"root": None}, {"root": 3}])
def test_outline_requires_a_root_before_touching_the_skill(monkeypatch, params):
    # `_root()` 가 import 보다 먼저다 — 잘못된 root 는 스킬을 부르지 않고 같은 오류로 끝난다.
    calls = []
    monkeypatch.setitem(sys.modules, "gg_outline", _fake_outline(calls, {"state": "not_bound"}))

    reply = _rpc("project.outline", params)
    assert reply["error"]["code"] == "invalid_params", reply
    assert calls == []
