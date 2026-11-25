"""S-01 재현 시험(v0.7.5 설계 2판): 사이드카의 실제 의존성 호출이 논문 폴더 코드를 실행하면 안 된다.

검토 r1 차단 B-01·B-03의 실제 호출 재현이다. 고치기 전 빨강이 정상이다.

- 폴더 쪽(공격자가 쓸 수 있음): 실행되면 표시 파일을 남기는 가짜 `.venv/bin/python3`,
  `docx.py`(import 검사가 부르는 이름), `pip.py`(`python -m pip`가 부르는 이름).
- 앱 쪽(공격자가 못 씀): 앱 데이터 폴더의 의존성 환경. main 이 `KNUAF_DEPS_VENV`로 알려 준다
  (설계 2판 §3.1 계약 — 이 값이 있으면 스킬 `gg_deps`는 `<폴더>/.venv`를 보지 않는다,
  키가 없으면 사이드카 의존성 호출은 실패로 닫힌다).

표시 파일은 모두 폴더 **바깥**에 생긴다. 설치·진단이 뒤에 실패해도 이미 일어난 실행은 되돌릴 수 없으므로
"표시 파일 없음"만을 합격으로 본다.
"""
import sys
import venv
from pathlib import Path

import pytest

from conftest import REPO

sys.path.insert(0, str(REPO / "app/sidecar"))
from knuaf_sidecar import methods_core, methods_scripts  # noqa: E402
from knuaf_sidecar.rpc import Context, RpcError  # noqa: E402

pytestmark = [
    pytest.mark.skipif(sys.platform == "win32", reason="가짜 실행기는 posix 셸 스크립트로만 만든다"),
    # 고치기 전 빨강 기록: evidence/red-sidecar-venv-guard.txt (6 failed). 구현이 초록으로 만들면
    # strict XPASS 가 실패하므로 이 표시를 지우는 것이 구현 완료 조건이다.
    pytest.mark.xfail(strict=True, reason="S-01 미수정 — 설계 2판 구현 전"),
]

DEPS_ENV = "KNUAF_DEPS_VENV"


class _Server:
    def __init__(self):
        self.events = []

    def write(self, message):
        self.events.append(message)


def _ctx():
    return Context(_Server(), "venv-guard")


def _marker_writer(marker: Path) -> str:
    return "import pathlib; pathlib.Path(%r).write_text('ran')\n" % str(marker)


def _build(tmp_path, monkeypatch, folder_venv):
    """folder_venv: "fake"(실행되면 표시 파일) | "clean"(깨끗한 진짜 venv) | None(없음)."""
    root = tmp_path / "남이 준 논문"
    root.mkdir()
    marks = {name: tmp_path / ("PWNED-" + name) for name in ("venv", "docx", "pip")}
    if folder_venv == "fake":
        _plant_fake_venv(root, marks["venv"])
    elif folder_venv == "clean":
        venv.EnvBuilder(with_pip=False, symlinks=True).create(root / ".venv")
    # 2) 폴더 안 동명 모듈 — 작업 디렉터리가 모듈 검색에 들어가면 실행된다(B-03).
    (root / "docx.py").write_text(_marker_writer(marks["docx"]))
    (root / "pip.py").write_text(_marker_writer(marks["pip"]))
    # 3) 앱 데이터 쪽 의존성 환경(깨끗한 venv, pip 없음 — 진단만 하므로 충분).
    app_env = tmp_path / "userData" / "deps" / "env"
    venv.EnvBuilder(with_pip=False, symlinks=True).create(app_env)
    monkeypatch.delenv(DEPS_ENV, raising=False)
    return {"root": root, "marks": marks, "app_env": app_env, "tmp": tmp_path}


@pytest.fixture
def scene(tmp_path, monkeypatch):
    return _build(tmp_path, monkeypatch, "fake")


def _plant_fake_venv(root, marker):
    """앱이 만들지 않은 .venv — 실행되면 표시 파일."""
    bin_dir = root / ".venv" / "bin"
    bin_dir.mkdir(parents=True)
    (root / ".venv" / "pyvenv.cfg").write_text("home = /opt/attacker/bin\nversion = 3.12.1\n")
    fake = bin_dir / "python3"
    fake.write_text("#!/bin/sh\necho ran > '%s'\nexit 0\n" % marker)
    fake.chmod(0o755)


def _fired(scene):
    return sorted(name for name, path in scene["marks"].items() if path.exists())


def test_doctor_child_uses_only_main_decided_env(scene, monkeypatch):
    """B-01(자식 프로세스) + B-03(import 검사의 작업 디렉터리): deps.doctor."""
    monkeypatch.setenv(DEPS_ENV, str(scene["app_env"]))
    try:
        result = methods_scripts.deps_doctor(_ctx(), {"root": str(scene["root"])})
    except RpcError:
        result = None  # 진단 실패는 허용 — 실행만 없으면 된다
    assert _fired(scene) == []
    if result and result.get("ok"):
        assert result["data"]["venv_python"].startswith(str(scene["app_env"]))


def test_doctor_without_contract_key_fails_closed(scene):
    """판정 키가 없으면(예전 main·잘못된 기동) 폴더를 뒤지지 말고 실패로 닫는다."""
    with pytest.raises(RpcError):
        methods_scripts.deps_doctor(_ctx(), {"root": str(scene["root"])})
    assert _fired(scene) == []


def test_doctor_all_in_process_uses_only_main_decided_env(scene, monkeypatch):
    """B-01(같은 프로세스): doctor.all → gg_core.doctor → gg_deps.doctor."""
    monkeypatch.setenv(DEPS_ENV, str(scene["app_env"]))
    monkeypatch.chdir(scene["root"])  # 사이드카 작업 디렉터리가 어디든 폴더 모듈이 돌면 안 된다
    try:
        methods_core.doctor_all(_ctx(), {"root": str(scene["root"])})
    except RpcError:
        pass
    assert _fired(scene) == []


def test_ensure_never_runs_folder_pip_or_venv(scene, monkeypatch):
    """B-03(pip): .venv 가 없거나 남의 것이어도 ensure 는 폴더의 pip.py·.venv 를 실행하지 않는다."""
    staging = scene["tmp"] / "userData" / "deps" / "staging"
    monkeypatch.setenv(DEPS_ENV, str(staging))
    wheels = scene["tmp"] / "empty-wheels"
    wheels.mkdir()
    try:
        methods_scripts.deps_ensure(_ctx(), {"root": str(scene["root"]), "base_python": sys.executable,
                                             "find_links": str(wheels), "no_index": True})
    except RpcError:
        pass  # 휠이 없어 설치는 실패해도 된다
    assert _fired(scene) == []
    # 앱 환경은 앱 자리에만 생긴다 — 폴더의 .venv 는 손대지 않는다(남의 것 그대로 남음).
    assert (scene["root"] / ".venv" / "bin" / "python3").read_text().startswith("#!/bin/sh")
    assert not any(p.name.startswith(".venv-broken-") for p in scene["root"].iterdir())


def test_doctor_import_probe_never_loads_folder_module(tmp_path, monkeypatch):
    """B-03(import 검사): 깨끗한(신뢰할 만한) 환경이어도 폴더의 docx.py 가 import 되면 안 된다."""
    scene = _build(tmp_path, monkeypatch, "clean")
    monkeypatch.setenv(DEPS_ENV, str(scene["app_env"]))
    try:
        methods_scripts.deps_doctor(_ctx(), {"root": str(scene["root"])})
    except RpcError:
        pass
    assert _fired(scene) == []


def test_ensure_without_folder_venv_never_runs_folder_pip(tmp_path, monkeypatch):
    """B-03(pip): 폴더에 .venv 가 없어도 `python -m pip`가 폴더의 pip.py 를 부르면 안 된다."""
    scene = _build(tmp_path, monkeypatch, None)
    staging = scene["tmp"] / "userData" / "deps" / "staging"
    monkeypatch.setenv(DEPS_ENV, str(staging))
    wheels = scene["tmp"] / "empty-wheels"
    wheels.mkdir()
    try:
        methods_scripts.deps_ensure(_ctx(), {"root": str(scene["root"]), "base_python": sys.executable,
                                             "find_links": str(wheels), "no_index": True})
    except RpcError:
        pass
    assert _fired(scene) == []
    assert not (scene["root"] / ".venv").exists()  # 앱 환경은 앱 자리에만 생긴다
