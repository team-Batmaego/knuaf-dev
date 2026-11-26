"""S-01 의존성 환경 계약 확인(5단계).

스킬 gg_deps 가 `DEPS_VENV_ENV = "KNUAF_DEPS_VENV"` 를 선언한 판만 의존성 메서드를 돌린다. 선언이 없는 판은
`KNUAF_DEPS_VENV` 를 몰라 논문 폴더의 `.venv` python 을 실행할 수 있으므로, 실행 전에
`deps_contract_unsupported` 로 닫는다(폴더 탐색으로 떨어지지 않는다).

- 자식으로 띄우는 `gg_deps.py`(deps.ensure·deps.doctor)는 **실행할 그 파일**을 정적으로 읽는다(import 하지 않음).
- 같은 프로세스 `gg_core.doctor → gg_deps.doctor`(doctor.all)는 import 된 모듈의 상수를 보고, 모르는 판이면
  그 모듈의 doctor·ensure 를 실행 전 거부로 바꾼다. 사이드카 한 프로세스는 스킬 폴더가 고정이라 판정이 바뀌지 않는다.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

from .rpc import RpcError

DEPS_ENV = "KNUAF_DEPS_VENV"
CODE = "deps_contract_unsupported"
MESSAGE = "동봉된 규칙집이 의존성 환경 계약(KNUAF_DEPS_VENV)을 몰라 의존성 준비·점검을 실행하지 않음"
_cache: dict = {}


def declared(gg_deps_py: Path) -> bool:
    """모듈 맨 위에 `DEPS_VENV_ENV = "KNUAF_DEPS_VENV"`(주석형 포함)가 있는가."""
    try:
        st = gg_deps_py.stat()
    except OSError:
        return False
    key = (str(gg_deps_py), st.st_mtime_ns, st.st_size)
    if key not in _cache:
        _cache[key] = _scan(gg_deps_py)
    return _cache[key]


def _scan(path: Path) -> bool:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError, UnicodeDecodeError, ValueError):
        return False
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        else:
            continue
        value = node.value
        if "DEPS_VENV_ENV" in names and isinstance(value, ast.Constant) and value.value == DEPS_ENV:
            return True
    return False


def require(scripts_dir: Path) -> None:
    script = Path(scripts_dir) / "gg_deps.py"
    if not declared(script):
        raise RpcError(CODE, MESSAGE, {"script": str(script)})


def _refused(*_args, **_kwargs):
    raise RpcError(CODE, MESSAGE)


def fence_in_process() -> bool:
    """같은 프로세스의 gg_deps 가 계약을 아는가. 모르면 doctor·ensure 를 실행 전 거부로 바꾸고 False."""
    try:
        import gg_deps  # 스킬 폴더가 sys.path 에 있다(__main__)
    except Exception:  # noqa: BLE001 — 못 읽는 판도 계약을 모르는 판으로 친다
        return False
    if getattr(gg_deps, "DEPS_VENV_ENV", None) == DEPS_ENV:
        return True
    module = sys.modules.get("gg_deps", gg_deps)
    for name in ("doctor", "ensure"):
        if hasattr(module, name):
            setattr(module, name, _refused)
    return False


def unsupported_report() -> dict:
    return {"ready": False, "error": {"code": CODE, "message": MESSAGE, "data": None}}
