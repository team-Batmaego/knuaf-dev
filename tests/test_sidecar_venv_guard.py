"""S-01 재현·계약 시험(v0.7.5 설계 3판): 사이드카의 실제 의존성 호출이 논문 폴더 코드를 실행하면 안 되고,
신뢰된 앱 데이터 환경으로는 정상 동작해야 한다.

검토 r1 B-01·B-03, r2 B-01 ①·B-03 대응. 고치기 전 빨강이 정상이다(strict xfail — 아래 pytestmark).

장면
- 폴더 쪽(공격자가 쓸 수 있음): 그 인터프리터가 뜨기만 하면 `.pth` 가 표시 파일을 남기는 **실제** `.venv`
  (윈도는 `Scripts\\python.exe`, 그 밖은 `bin/python3` — 12단계 I-02: 모든 OS 에서 같은 장면), 폴더 루트의
  `docx.py`(import 검사·문서 생성이 부르는 이름), `pip.py`(`python -m pip`가 부르는 이름).
- 앱 쪽(공격자가 못 씀): 앱 데이터 의존성 환경. main 이 호출마다 `deps_venv` 인자로 알려 준다(설계 §3.3).
  이 환경의 python 이 실제로 떴는지는 환경 안 `.pth` 증인이 `KNUAF_TEST_WITNESS` 파일에 남기는 줄로 본다
  (끝날 때의 인자·`sys.prefix`·`sys.path`·격리 플래그 — 윈도 CI 에서도 실제 자식을 본다).

정상 계약 시험은 예외를 삼키지 않는다 — "인자 누락 → 실행 전 RpcError → 표시 없음 → 통과"가 되지 않게
성공(ok·ready·문서 파일)과 증인 존재를 함께 요구한다(r2 B-01 ①). 키 누락 거부는 따로, 오류 코드까지 본다.
"""
import ast
import importlib.util
import json
import os
import sys
import venv
from pathlib import Path

import pytest

from conftest import REPO, SCRIPTS, bind_test_major

sys.path.insert(0, str(REPO / "app/sidecar"))
from knuaf_sidecar import methods_core, methods_scripts  # noqa: E402
from knuaf_sidecar.rpc import Context, RpcError  # noqa: E402

# 고치기 전 빨강 기록: evidence/red-sidecar-venv-guard-r3.txt(10 failed, 973b3dd). 앱 쪽 구현(3단계)으로 키 누락 3·
# 폴더 안 1·문서 생성 1이 초록이 됐다. 아래 표시가 남은 5건은 스킬 gg_deps 계약(D-U: KNUAF_DEPS_VENV 를 따르고
# -m/-c 자식은 -I) 이 들어와야 초록이 된다 — strict 라 들어오면 XPASS 실패로 표시 제거를 강제한다.
D_U = pytest.mark.xfail(strict=True, reason="TODO(D-U): 고정 스킬 gg_deps 가 KNUAF_DEPS_VENV·-I 계약을 아직 모름")

DEPS_ENV = "KNUAF_DEPS_VENV"
WITNESS_ENV = "KNUAF_TEST_WITNESS"


class _Server:
    def __init__(self):
        self.events = []

    def write(self, message):
        self.events.append(message)


def _ctx():
    return Context(_Server(), "venv-guard")


def _marker_writer(marker: Path) -> str:
    return "import pathlib; pathlib.Path(%r).write_text('ran')\n" % str(marker)


WITNESS_MODULE = """import atexit, json, os, sys

def _record():
    target = os.environ.get(%r)
    if target:
        with open(target, "a", encoding="utf-8") as out:
            out.write(json.dumps({"argv": list(getattr(sys, "orig_argv", [])), "prefix": sys.prefix,
                                  "path": list(sys.path), "isolated": sys.flags.isolated,
                                  "no_user_site": sys.flags.no_user_site}) + "\\n")

atexit.register(_record)
""" % WITNESS_ENV


def _make_venv(env: Path, with_pip: bool) -> Path:
    """실제 venv 를 만들고 그 site-packages 를 돌려준다(윈도는 링크 권한이 없어 복사)."""
    venv.EnvBuilder(with_pip=with_pip, symlinks=os.name != "nt").create(env)
    return env / "Lib" / "site-packages" if os.name == "nt" else next(env.glob("lib/python*/site-packages"))


@pytest.fixture(scope="module")
def app_env(tmp_path_factory):
    """앱 데이터 쪽 신뢰 환경: pip 포함 venv + 시험 실행기의 의존성(docx·openpyxl·pypdf) 경로 + 실행 증인."""
    env = tmp_path_factory.mktemp("userData") / "deps" / "k0"
    purelib = _make_venv(env, with_pip=True)
    # 실행기의 site 폴더 전부가 아니라 의존성이 실제로 놓인 폴더만 — 사용자 site·기반 설치 폴더를 통째로 넣지 않는다.
    found = [importlib.util.find_spec(name) for name in ("docx", "openpyxl", "pypdf")]
    deps = sorted({str(Path(spec.origin).parent.parent) for spec in found if spec and spec.origin})
    (purelib / "runner-deps.pth").write_text("\n".join(deps) + "\n", encoding="utf-8")
    (purelib / "knuaf_test_witness.py").write_text(WITNESS_MODULE, encoding="utf-8")
    (purelib / "zz_knuaf_witness.pth").write_text("import knuaf_test_witness\n", encoding="utf-8")
    return env


def _witnessed(scene) -> list:
    return [json.loads(line) for line in scene["witness"].read_text(encoding="utf-8").splitlines() if line]


@pytest.fixture
def scene(tmp_path, monkeypatch, app_env):
    root = tmp_path / "남이 준 논문"
    root.mkdir()
    marks = {name: tmp_path / ("PWNED-" + name) for name in ("venv", "docx", "pip")}
    planted = _make_venv(root / ".venv", with_pip=False)
    (planted / "zz_planted.pth").write_text(
        "import pathlib; pathlib.Path(%r).write_text('ran')\n" % str(marks["venv"]), encoding="utf-8")
    (root / "docx.py").write_text(_marker_writer(marks["docx"]), encoding="utf-8")
    (root / "pip.py").write_text(_marker_writer(marks["pip"]), encoding="utf-8")
    witness = tmp_path / "WITNESS-app-env"
    monkeypatch.setenv(WITNESS_ENV, str(witness))
    monkeypatch.delenv(DEPS_ENV, raising=False)
    return {"root": root, "marks": marks, "witness": witness, "tmp": tmp_path, "app_env": app_env,
            "folder_venv": _tree(root / ".venv")}


def _tree(path: Path) -> list:
    """폴더 `.venv` 가 그대로인지 보는 목록(이름 + pyvenv.cfg 내용). 링크는 따라가지 않는다."""
    names = sorted(os.path.relpath(os.path.join(base, name), path)
                   for base, dirs, files in os.walk(path) for name in dirs + files if name != "__pycache__"
                   and "__pycache__" not in base)
    return [*names, (path / "pyvenv.cfg").read_bytes()]


def _under(entry: str, folder: Path) -> bool:
    child, base = Path(entry).resolve(), folder.resolve()
    return child == base or base in child.parents


def _fired(scene):
    return sorted(name for name, path in scene["marks"].items() if path.exists())


def _params(scene, **extra):
    return {"root": str(scene["root"]), "deps_venv": str(scene["app_env"]), **extra}


# --- 정상 계약: 유효한 deps_venv → 실제 자식이 앱 환경에서 돌고 성공한다 ----------------------------


@D_U
def test_doctor_child_runs_in_app_env_and_is_ready(scene):
    result = methods_scripts.deps_doctor(_ctx(), _params(scene))
    assert result["ok"], result
    assert result["data"]["ready"] is True
    assert result["data"]["selected_python"].startswith(str(scene["app_env"]))
    assert scene["witness"].exists()  # import 검사가 앱 환경 python 으로 실제 실행됐다
    assert _fired(scene) == []


@D_U
def test_ensure_child_installs_in_app_env(scene):
    wheels = scene["tmp"] / "empty-wheels"
    wheels.mkdir()
    result = methods_scripts.deps_ensure(_ctx(), _params(scene, base_python=sys.executable,
                                                         find_links=str(wheels), no_index=True))
    assert result["ok"], result  # 이미 충족된 요구라 오프라인으로 성공해야 한다
    assert scene["witness"].exists()  # pip 이 앱 환경 python 으로 실제 실행됐다
    assert _fired(scene) == []
    assert _tree(scene["root"] / ".venv") == scene["folder_venv"]  # 폴더의 .venv 는 그대로
    assert not any(p.name.startswith(".venv-broken-") for p in scene["root"].iterdir())


@D_U
def test_doctor_all_in_process_uses_app_env(scene, monkeypatch):
    import gg_deps

    # 계약을 모르는 판이면 doctor_all 이 이 모듈의 doctor·ensure 를 거부로 바꾼다 — 시험 뒤 되돌린다.
    monkeypatch.setattr(gg_deps, "doctor", gg_deps.doctor)
    monkeypatch.setattr(gg_deps, "ensure", gg_deps.ensure)
    monkeypatch.setenv(DEPS_ENV, str(scene["app_env"]))  # main 이 사이드카 기동 env 로 싣는 값
    monkeypatch.chdir(scene["root"])  # 사이드카 작업 디렉터리가 어디든 폴더 모듈이 돌면 안 된다
    out = methods_core.doctor_all(_ctx(), _params(scene))
    assert out["deps"]["ready"] is True, out["deps"]
    assert scene["witness"].exists()
    assert _fired(scene) == []


def test_doc_generation_runs_in_app_env_without_folder_modules(scene):
    import gg_core as core

    core.init(scene["root"])
    bind_test_major(scene["root"])
    body = scene["root"] / "sections" / "word-body.md"
    body.parent.mkdir(exist_ok=True)
    body.write_text("# Ⅰ. 머리말\n\n실제 생성된 검토용 본문이다.\n", encoding="utf-8")
    result = methods_scripts.docx_build(_ctx(), _params(scene, **{
        "in": "sections/word-body.md", "out": "build/venv-guard.docx", "no_toc": True,
        "major_id": "specialty_crops"}))
    assert result["ok"], result
    assert (scene["root"] / "build" / "venv-guard.docx").is_file()
    assert scene["witness"].exists()
    assert _fired(scene) == []


# --- 키 누락: 폴더를 뒤지지 않고 실행 전에 정해진 오류로 닫는다 ----------------------------------------


@pytest.mark.parametrize("method,extra", [
    (methods_scripts.deps_doctor, {}),
    (methods_scripts.deps_ensure, {"base_python": sys.executable, "no_index": True}),
    (methods_scripts.docx_build, {"in": "sections/word-body.md", "out": "build/x.docx"}),
])
def test_deps_calls_without_contract_key_are_refused(scene, method, extra):
    with pytest.raises(RpcError) as caught:
        method(_ctx(), {"root": str(scene["root"]), **extra})
    assert caught.value.code == "deps_contract_missing"
    assert _fired(scene) == []
    assert not scene["witness"].exists()


def test_deps_venv_inside_project_is_refused(scene):
    with pytest.raises(RpcError) as caught:
        methods_scripts.deps_doctor(_ctx(), {"root": str(scene["root"]), "deps_venv": str(scene["root"] / ".venv")})
    assert caught.value.code == "deps_venv_untrusted"
    assert _fired(scene) == []


@pytest.mark.parametrize("via_link", [False, True])
def test_project_inside_deps_venv_is_refused(scene, via_link):
    """격리 계약 전제 ①: 어느 쪽도 다른 쪽 안에 있지 않아야 한다 — 논문 폴더가 환경 안인 경우(링크로 열어도)."""
    env = scene["tmp"] / "userData" / "deps" / "k9"
    project = env / "paper"
    project.mkdir(parents=True)
    if via_link:
        alias = scene["tmp"] / "paper-alias"
        try:
            alias.symlink_to(project, target_is_directory=True)
        except OSError as error:
            pytest.skip("심볼릭 링크를 만들 수 없음: %s" % error)
        project = alias
    with pytest.raises(RpcError) as caught:
        methods_scripts.deps_doctor(_ctx(), {"root": str(project), "deps_venv": str(env)})
    assert caught.value.code == "deps_venv_untrusted"
    assert _fired(scene) == []


# --- 12단계 I-02(격리 계약 2판): 실제 -c·pip 자식이 대상 환경 prefix 에서 격리돼 돈다(윈도 CI 포함) ----------------


@D_U
def test_real_m_and_c_children_run_in_target_prefix_without_user_site_or_decoys(scene, monkeypatch):
    decoys = scene["tmp"] / "pythonpath-decoys"
    decoys.mkdir()
    # 미끼: 자식이 PYTHONPATH 를 따르면 검색 경로에 이 폴더가 남는다. 부모(`gg_deps.py` 의 current 열 검사)는 호출자
    # 환경변수를 따르는 별도 신뢰 입력이라(계약 밖) 여기서 단언하지 않는다 — 단언 대상은 `-m`·`-c` 자식이다.
    for name in ("docx", "pip", "openpyxl", "pypdf"):
        (decoys / (name + ".py")).write_text("", encoding="utf-8")
    userbase = scene["tmp"] / "userbase"
    monkeypatch.setenv("PYTHONPATH", str(decoys))
    monkeypatch.setenv("PYTHONUSERBASE", str(userbase))
    wheels = scene["tmp"] / "empty-wheels"
    wheels.mkdir()
    ensured = methods_scripts.deps_ensure(_ctx(), _params(scene, base_python=sys.executable,
                                                          find_links=str(wheels), no_index=True))
    assert ensured["ok"], ensured
    checked = methods_scripts.deps_doctor(_ctx(), _params(scene))
    assert checked["data"]["ready"] is True, checked
    children = [r for r in _witnessed(scene) if "-c" in r["argv"] or "-m" in r["argv"]]
    assert any("-c" in r["argv"] for r in children), children  # import 검사
    assert any("pip" in r["argv"] for r in children), children  # python -m pip
    for record in children:
        assert os.path.samefile(record["prefix"], scene["app_env"]), record
        assert record["isolated"] == 1 and record["no_user_site"] == 1, record
        assert all(record["path"]) and all(os.path.isabs(entry) for entry in record["path"]), record
        for banned in (scene["root"], decoys, userbase):
            assert not [e for e in record["path"] if _under(e, banned)], record
    assert _fired(scene) == []


# --- B-03 정적 계약: 스킬이 python 을 -m/-c 로 띄우는 곳은 모두 -I(작업 디렉터리 제외) -----------------


def _python_flag_lists(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.List):
            consts = [e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            if "-m" in consts or "-c" in consts:
                yield node.lineno, consts


@D_U
def test_skill_python_children_with_m_or_c_are_isolated():
    """스크립트 경로 실행(`python 스크립트.py`)은 sys.path[0]=스킬 폴더라 안전하다. `-m`·`-c`는 작업
    디렉터리를 검색 경로에 넣으므로 `-I`가 있어야 한다. 새 스킬 판이 이런 자리를 더하면 여기서 잡힌다."""
    offenders = [f"{p.name}:{line} {consts}" for p in sorted(SCRIPTS.glob("*.py"))
                 for line, consts in _python_flag_lists(p) if "-I" not in consts]
    assert offenders == []


@D_U
def test_contract_constant_is_declared():
    import gg_deps

    assert getattr(gg_deps, "DEPS_VENV_ENV", None) == DEPS_ENV
    assert os.environ.get(DEPS_ENV) is None  # 시험 기본 환경이 계약값을 새지 않는다


# --- D-A(형님 결정): READONLY 는 도우미 전용 — 사이드카(앱의 '준비하기')가 띄우는 자식에는 물려주지 않는다 ------


def test_sidecar_deps_children_never_inherit_readonly(tmp_path, monkeypatch):
    from knuaf_sidecar import runner

    monkeypatch.setenv("KNUAF_DEPS_VENV_READONLY", "1")  # 어쩌다 앱 프로세스에 실린 값
    seen = tmp_path / "seen.txt"
    script = tmp_path / "show_env.py"
    script.write_text(
        "import os, pathlib\n"
        "pathlib.Path(%r).write_text(repr((os.environ.get('KNUAF_DEPS_VENV_READONLY'), os.environ.get('KNUAF_DEPS_VENV'))))\n"
        "print('{\"ok\": true}')\n" % str(seen))
    env_extra = methods_scripts._deps_child_env("/app/deps/k0")
    runner.run_script(_ctx(), sys.executable, script, [], tmp_path, 30, env_extra=env_extra)
    assert seen.read_text() == repr((None, "/app/deps/k0"))


# --- 계약 확인(5단계): 계약 상수를 모르는 스킬 판이면 의존성 메서드는 실행 전에 닫는다 -------------------------
# 가짜 스킬로 양쪽을 본다 — 고정판이 올라가도(D-U) 이 시험의 뜻은 그대로다. 모르는 판은 폴더 .venv 를 볼 수 있으므로
# gg_deps 를 자식으로도, 같은 프로세스(doctor.all → gg_core.doctor → gg_deps.doctor)로도 부르지 않는다.

CONTRACT_LINE = 'DEPS_VENV_ENV = "KNUAF_DEPS_VENV"\n'


def _fake_skill(tmp_path: Path, declared: bool) -> Path:
    scripts = tmp_path / ("skill-new" if declared else "skill-old") / "scripts"
    scripts.mkdir(parents=True)
    ran = scripts.parent / "RAN"
    (scripts / "gg_deps.py").write_text(
        (CONTRACT_LINE if declared else "") +
        "import json, os, pathlib, sys\n"
        "pathlib.Path(%r).write_text(json.dumps([sys.argv[1:], os.environ.get('KNUAF_DEPS_VENV')]))\n"
        "print(json.dumps({'status': 'ok'}))\n" % str(ran), encoding="utf-8")
    return scripts


@pytest.mark.parametrize("method,extra", [
    (methods_scripts.deps_doctor, {}),
    (methods_scripts.deps_ensure, {"base_python": sys.executable, "no_index": True}),
])
def test_skill_without_contract_refuses_deps_methods_before_running(scene, monkeypatch, method, extra):
    scripts = _fake_skill(scene["tmp"], declared=False)
    monkeypatch.setattr(methods_scripts, "_scripts_dir", lambda: scripts)
    with pytest.raises(RpcError) as caught:
        method(_ctx(), _params(scene, **extra))
    assert caught.value.code == "deps_contract_unsupported"
    assert not (scripts.parent / "RAN").exists()
    assert _fired(scene) == []


def test_skill_with_contract_runs_deps_child_with_app_env(scene, monkeypatch):
    scripts = _fake_skill(scene["tmp"], declared=True)
    monkeypatch.setattr(methods_scripts, "_scripts_dir", lambda: scripts)
    result = methods_scripts.deps_ensure(_ctx(), _params(scene, base_python=sys.executable, no_index=True))
    assert result["ok"], result
    import json
    argv, seen_env = json.loads((scripts.parent / "RAN").read_text())
    assert argv[:2] == ["ensure", str(scene["root"])]
    assert seen_env == str(scene["app_env"])
    assert _fired(scene) == []


def _fake_gg_deps(declared: bool, calls: list):
    import types

    mod = types.ModuleType("gg_deps")
    if declared:
        mod.DEPS_VENV_ENV = DEPS_ENV

    def doctor(root):
        calls.append(str(root))
        raise RuntimeError("fake doctor stops here")
    mod.doctor = doctor
    mod.ensure = doctor
    return mod


def test_doctor_all_does_not_call_in_process_gg_deps_without_contract(scene, monkeypatch):
    import gg_core as core

    core.init(scene["root"])
    calls = []
    monkeypatch.setitem(sys.modules, "gg_deps", _fake_gg_deps(False, calls))
    out = methods_core.doctor_all(_ctx(), _params(scene))
    assert calls == []
    assert out["deps"]["ready"] is False
    assert out["deps"]["error"]["code"] == "deps_contract_unsupported"
    assert _fired(scene) == []


def test_doctor_all_calls_in_process_gg_deps_with_contract(scene, monkeypatch):
    import gg_core as core

    core.init(scene["root"])
    calls = []
    monkeypatch.setitem(sys.modules, "gg_deps", _fake_gg_deps(True, calls))
    out = methods_core.doctor_all(_ctx(), _params(scene))
    assert calls == [str(scene["root"])]
    assert out["deps"].get("error", {}).get("code") != "deps_contract_unsupported"


@pytest.mark.parametrize("source,expected", [
    (CONTRACT_LINE, True),
    ('DEPS_VENV_ENV: str = "KNUAF_DEPS_VENV"\n', True),
    ("", False),
    ('DEPS_VENV_ENV = "OTHER"\n', False),
    ('def f():\n    DEPS_VENV_ENV = "KNUAF_DEPS_VENV"\n', False),
    ('DEPS_VENV_ENV = (\n', False),
])
def test_contract_declaration_is_read_statically(tmp_path, source, expected):
    from knuaf_sidecar import deps_contract

    path = tmp_path / "gg_deps.py"
    path.write_text(source, encoding="utf-8")
    assert deps_contract.declared(path) is expected
    assert deps_contract.declared(tmp_path / "missing.py") is False


def test_stage_skill_gate_runs_this_contract_suite():
    """stage:skill 호환 게이트(run-skill-compat CONSUMER_TESTS)가 이 파일을 돌린다 — 새 스킬 판이 계약을 빼면
    표시 없는 정상 계약 시험이 빨강이 돼 동봉이 거부된다(@D_U 표시는 D-U 판 올림 때 걷는다)."""
    gate = REPO / "app/scripts/tests/run-skill-compat.mjs"
    if not gate.exists():
        pytest.skip("호환 게이트의 소비자 사본 안에서 돌고 있다 — 이 파일이 실행된다는 것 자체가 포함 증거")
    text = gate.read_text(encoding="utf-8")
    block = text.split("export const CONSUMER_TESTS = [", 1)[1].split("]", 1)[0]
    assert "'test_sidecar_venv_guard.py'" in block


# --- D1(형님 결정: 옛 폴더 .venv 는 쓰지 않음 → PC당 1회 준비): 있다는 사실만 알린다 --------------------------------


@pytest.mark.parametrize("kind", ["fake-venv", "dangling-link", "none"])
def test_doctor_all_reports_legacy_folder_venv_without_touching_it(scene, monkeypatch, kind):
    import shutil

    import gg_core as core

    core.init(scene["root"])
    venv_dir = scene["root"] / ".venv"
    if kind != "fake-venv":
        shutil.rmtree(venv_dir)
    if kind == "dangling-link":
        try:
            venv_dir.symlink_to(scene["tmp"] / "no-such-dir", target_is_directory=True)
        except OSError as error:  # 윈도에서 링크 권한이 없는 자리
            pytest.skip("심볼릭 링크를 만들 수 없음: %s" % error)
    before = sorted(p.name for p in scene["root"].iterdir())
    monkeypatch.setitem(sys.modules, "gg_deps", _fake_gg_deps(False, []))
    out = methods_core.doctor_all(_ctx(), _params(scene))
    assert out["legacy_venv"] is (kind != "none")
    assert _fired(scene) == []  # 존재 확인만 — 실행하지 않는다
    assert sorted(p.name for p in scene["root"].iterdir()) == before  # 지우지도 옮기지도 않는다
    if kind == "fake-venv":
        assert _tree(venv_dir) == scene["folder_venv"]


# --- B-01: 환경 없음 = 앱 데이터 안 고정 "없음" 경로(만들지 않음) -----------------------------------------------


def test_none_path_is_never_an_ensure_target_and_never_runs_anything(scene):
    none = scene["tmp"] / "userData" / "deps" / "_none"
    with pytest.raises(RpcError) as caught:
        methods_scripts.deps_ensure(_ctx(), {"root": str(scene["root"]), "deps_venv": str(none),
                                             "base_python": sys.executable, "no_index": True})
    assert caught.value.code == "deps_contract_missing"
    assert not none.exists()
    assert _fired(scene) == []


def test_none_path_means_not_ready_for_dependent_scripts(scene):
    none = scene["tmp"] / "userData" / "deps" / "_none"
    with pytest.raises(RpcError) as caught:
        methods_scripts.docx_build(_ctx(), {"root": str(scene["root"]), "deps_venv": str(none),
                                            "in": "sections/word-body.md", "out": "build/x.docx"})
    assert caught.value.code == "deps_not_ready"
    assert not none.exists()
    assert _fired(scene) == []


# --- R-01: doctor.all 도 deps_venv 공통 검사를 거친다(전역 os.environ 을 바꾸지 않고) ----------------------------


def test_doctor_all_requires_deps_venv_key_and_refuses_folder_inside_path(scene, monkeypatch):
    import gg_core as core

    core.init(scene["root"])
    monkeypatch.setitem(sys.modules, "gg_deps", _fake_gg_deps(False, []))
    before = dict(os.environ)
    with pytest.raises(RpcError) as missing:
        methods_core.doctor_all(_ctx(), {"root": str(scene["root"])})
    assert missing.value.code == "deps_contract_missing"
    with pytest.raises(RpcError) as inside:
        methods_core.doctor_all(_ctx(), {"root": str(scene["root"]), "deps_venv": str(scene["root"] / ".venv")})
    assert inside.value.code == "deps_venv_untrusted"
    assert _fired(scene) == []
    assert dict(os.environ) == before  # 검사가 프로세스 환경을 건드리지 않는다
