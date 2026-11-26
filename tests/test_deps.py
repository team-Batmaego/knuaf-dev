"""gg_deps.ensure: project-local venv that actually runs (symlinked interpreter), offline wheelhouse path.

pip 자식의 꼴은 규칙집 판마다 다르다(v0.6.6 D-U 계약: 격리 실행 + 환경 폴더 cwd). 시험은 지금
도는 판을 `version.json`에서 읽어 그 판의 꼴만 요구한다 — 두 판이 함께 도는 동안(핀 승격 전
호환 시험) 옛 판을 새 꼴로 재단하지 않는다.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

import pytest

from conftest import REPO, SCRIPTS, parse_json, run_script

WHEELHOUSE = REPO / "app" / "resources" / "wheelhouse"
# the wheelhouse is built for the bundled runtime (lxml is cp312-specific), so use that interpreter
BUNDLED = REPO / "app" / "resources" / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
needs_wheels = pytest.mark.skipif(
    not (WHEELHOUSE.is_dir() and BUNDLED.exists()), reason="no bundled runtime + wheelhouse (pnpm fetch:python && pnpm build:wheelhouse)"
)

# 규칙집 판 -> 그 판이 pip 자식에게 주는 꼴. `argv`는 인터프리터 뒤에 붙는 앞부분이고,
# `cwd`가 True면 자식이 환경 폴더에서 시작한다(v0.6.6 D-U 계약). 새 판이 이 시험에 걸리면
# 그 판의 계약을 여기 적는다 — 모르는 판을 조용히 통과시키지 않는다.
PIP_CONTRACTS = {
    "0.6.5": {"argv": ["-m", "pip"], "cwd": False},
    "0.6.6": {"argv": ["-I", "-X", "utf8", "-m", "pip"], "cwd": True},
}


def _skill_release(gg_deps):
    """The rulebook release of the `gg_deps` module this run actually tests.

    The marker is read beside the module's own file, never from the `SCRIPTS`
    global: Python reuses an already-loaded module, so a `sys.path` change can
    leave 0.6.5 loaded while `SCRIPTS` points at 0.6.6. Both must agree before a
    contract is chosen, otherwise the wrong release's shape gets asserted.
    """
    actual = Path(gg_deps.__file__).resolve()
    expected = SCRIPTS.resolve() / "gg_deps.py"
    if actual != expected:
        pytest.fail(
            f"규칙집 스크립트 출처 불일치 — 적재된 gg_deps={actual}, 시험할 루트={expected}. "
            "계약을 고르기 전에 멈춘다(sys.modules 재사용으로 다른 판을 재단하지 않게)."
        )
    path = actual.parent.parent / "version.json"
    if not path.is_file():
        pytest.fail(f"규칙집 판 표지가 없음: {path}")
    return json.loads(path.read_text(encoding="utf-8"))["version"]


def _pip_contract(gg_deps):
    version = _skill_release(gg_deps)
    try:
        return PIP_CONTRACTS[version]
    except KeyError:
        pytest.fail(
            f"규칙집 {version}의 pip 자식 꼴을 모름 — 그 판의 계약을 tests/test_deps.py의 PIP_CONTRACTS에 적어야 함"
        )


@needs_wheels
def test_ensure_offline_creates_working_venv(empty_folder):
    r = run_script("gg_deps.py", "ensure", empty_folder, "--no-index", "--find-links", WHEELHOUSE, python=str(BUNDLED), timeout=600)
    assert r.returncode == 0, r.stdout + r.stderr
    data = parse_json(r.stdout)
    assert data["status"] == "installed" and data["created"] is True
    vpy = data["venv_python"]
    if os.name != "nt":
        assert os.path.islink(vpy) or os.path.islink(os.path.join(os.path.dirname(vpy), "python"))
    probe = subprocess.run([vpy, "-c", "import openpyxl, docx, pypdf; print('ok')"], capture_output=True, text=True)
    assert probe.stdout.strip() == "ok", probe.stderr
    d = parse_json(run_script("gg_deps.py", "doctor", empty_folder, python=str(BUNDLED)).stdout)
    assert d["ready"] is True and d["venv_python"] == vpy


def test_ensure_failure_is_json_not_traceback(empty_folder, monkeypatch):
    """A failing pip/venv step must surface as {"status": ...}, never a traceback."""
    r = run_script("gg_deps.py", "ensure", empty_folder, "--no-index", "--find-links", str(empty_folder / "nowhere"), timeout=600)
    assert r.returncode in (1, 2), r.stderr
    data = parse_json(r.stdout)
    assert data["status"] in ("failed", "blocked")
    assert "Traceback" not in r.stderr


def test_pip_requirement_files_are_ascii():
    """The actual composed runtime input must be safe for locale-decoding pip bootstraps."""
    requirements = SCRIPTS / "requirements-runtime.txt"
    assert requirements.read_bytes().isascii(), str(requirements)


def test_ensure_hands_pip_utf8_env(empty_folder, monkeypatch):
    """pip 자식에 격리·UTF-8 플래그, 환경 폴더 cwd, 명시적 UTF-8 해독을 적용한다.

    실제 pip 은 돌리지 않는다 — subprocess.run 만 대역으로 바꿔 넘긴 환경을 본다.
    argv 앞부분과 cwd 는 지금 도는 규칙집 판의 계약을 그대로 요구한다(모듈 상단 PIP_CONTRACTS).
    """
    import gg_deps

    contract = _pip_contract(gg_deps)
    monkeypatch.delenv("KNUAF_DEPS_VENV", raising=False)  # 계약 변수는 환경 폴더를 <project>/.venv 로 고정한다
    vpy = empty_folder / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python3")
    vpy.parent.mkdir(parents=True)
    vpy.write_text("")  # venv_python 은 존재만 보므로 venv 를 만들지 않고 이 파일로 대신한다

    calls = []

    class _Proc:
        returncode = 0
        stdout = "1.0\n"
        stderr = ""

    def fake_run(cmd, **kw):
        calls.append((cmd, kw))
        return _Proc()

    shim = SimpleNamespace(run=fake_run, SubprocessError=subprocess.SubprocessError)
    monkeypatch.setattr(gg_deps, "subprocess", shim)
    result, _ = gg_deps.ensure(empty_folder, no_index=True, find_links=empty_folder)

    pip_cmd, pip_kw = calls[0]  # 첫 호출이 pip 설치다
    prefix = contract["argv"]
    assert pip_cmd[:1 + len(prefix)] == [str(vpy), *prefix]
    if contract["cwd"]:
        # 자식은 환경 폴더에서 시작한다(D-U 계약) — 상대 실행 파일·--find-links 가 그 폴더로 풀리지 않게.
        assert pip_kw["cwd"] == os.path.abspath(str(empty_folder / ".venv"))
    else:
        assert "cwd" not in pip_kw  # 옛 판은 cwd 를 넘기지 않는다
    assert "--requirement" in pip_cmd and str(gg_deps.REQUIREMENTS) in pip_cmd
    assert pip_kw["env"]["PYTHONUTF8"] == "1"
    assert pip_kw["env"]["PYTHONIOENCODING"] == "utf-8"  # 자식은 UTF-8 로 말한다
    assert pip_kw["encoding"] == "utf-8"  # 부모도 같은 인코딩으로 읽어야 한다(W2-ENC-R1-01)
    assert pip_kw["errors"] == "replace"  # 해독 실패가 pip 결과를 뒤집지 않게
    assert pip_kw["env"].get("PATH") == os.environ.get("PATH")  # 나머지 환경은 그대로 물려준다
    assert result["pip_exit"] == 0


def _locale_decoding_subprocess(codec):
    """encoding 을 생략한 **텍스트 모드** 호출을 그 로케일로 해독하는 대역으로 만든다.

    파이썬 3.10 에는 `subprocess._text_encoding`(3.11 이상에만 있는 사설 함수)이 없어 그것을
    패치할 수 없다. 대신 제품 코드가 `encoding` 을 주지 않았을 때만 그 로케일 인코딩을 끼워 넣어
    실제 cp1252·cp949 부모와 같은 조건을 만든다 — 3.10·3.11+ 에서 같은 방식으로 동작한다.

    텍스트 모드 판정은 `text` 가 아니라 `subprocess` 의 실제 규칙을 따른다: `text`·`encoding`·
    `errors`·`universal_newlines` 중 하나라도 있으면 텍스트 모드다(3.10 `subprocess.py` 의
    `Popen.__init__`). 실제 pip 호출에는 `text=True` 가 없고 `errors="replace"` 만으로 텍스트
    모드이므로, `text` 만 보면 `encoding` 단독 제거 회귀를 놓친다(W1MERGE-R1-01).
    """
    real_run = subprocess.run
    calls = []

    def run(cmd, **kw):
        calls.append((cmd, kw))
        text_mode = any(kw.get(k) for k in ("text", "encoding", "errors", "universal_newlines"))
        if text_mode and "encoding" not in kw:
            kw["encoding"] = codec
        return real_run(cmd, **kw)

    return SimpleNamespace(run=run, SubprocessError=subprocess.SubprocessError), calls


def test_ensure_survives_non_utf8_parent_decoding(tmp_path, monkeypatch):
    """검토 W2-ENC-R1-01: 부모가 로케일(cp1252·cp949)로 읽어도 준비가 깨지면 안 된다.

    실제 pip 자식을 돌린다 — 빈 ASCII 요구 파일 + 빈 한글 wheelhouse + `--no-index` 라
    설치·다운로드가 없다(`Looking in links: <한글 경로>` 가 나온다). 부모 쪽 해독기만
    `gg_deps` 안의 `subprocess.run` 대역으로 바꾼다(macOS 에서는 cp1252·cp949 로케일을 만들 수
    없다). 대역으로 kwargs 만 보는 시험은 이 바이트 해독 문제를 잡지 못하므로 실제 자식을 돌린다.
    """
    import gg_deps

    contract = _pip_contract(gg_deps)
    monkeypatch.delenv("KNUAF_DEPS_VENV", raising=False)  # 환경 폴더는 <project>/.venv 로 고정한다
    root = tmp_path / "홍길동 논문"
    wheels = root / "휠 모음"
    wheels.mkdir(parents=True)
    req = root / "requirements-empty.txt"
    req.write_text("# empty offline probe\n", encoding="ascii")
    # v0.6.6 은 pip 자식을 환경 폴더에서 시작한다 — venv_python 이 그 안 실행 파일일 때만 여기 오므로
    # 실제 제품에서는 폴더가 늘 있다. 대역 인터프리터를 끼울 때도 같은 조건을 만들어 둔다.
    (root / ".venv").mkdir()

    monkeypatch.setattr(gg_deps, "REQUIREMENTS", req)
    monkeypatch.setattr(gg_deps, "load_manifest", lambda *a, **k: [])
    monkeypatch.setattr(gg_deps, "venv_python", lambda *a, **k: Path(sys.executable))

    for codec in ("utf-8", "cp1252", "cp949"):
        shim, calls = _locale_decoding_subprocess(codec)
        monkeypatch.setattr(gg_deps, "subprocess", shim)
        out = io.StringIO()
        with redirect_stdout(out):
            code = gg_deps.main(["ensure", str(root), "--no-index", "--find-links", str(wheels)])
        data = json.loads(out.getvalue())
        assert code == 0, (codec, data)
        assert data["pip_exit"] == 0, (codec, data)
        if contract["cwd"]:
            assert calls[0][1]["cwd"] == os.path.abspath(str(root / ".venv")), (codec, calls[0][1])
        # pip 의 실제 진단(한글 경로)이 깨지지 않고 남는다.
        assert "휠 모음" in data["pip_stdout_tail"] + data["pip_stderr_tail"], (codec, data)


def _fake_release(root, version):
    """A throwaway rulebook release: `scripts/gg_deps.py` plus its own `version.json`."""
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "gg_deps.py").write_text("RELEASE_MARKER = 1\n", encoding="utf-8")
    (root / "version.json").write_text(json.dumps({"schema": "gg-skill", "version": version}), encoding="utf-8")
    return scripts


def _load_release_module(scripts, name):
    """Import a release's gg_deps by file, the way the suite does; leave sys.modules clean."""
    spec = importlib.util.spec_from_file_location(name, scripts / "gg_deps.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(name, None)
    return module


def test_release_marker_is_bound_to_loaded_module(tmp_path, monkeypatch):
    """검토 I-01: 적재된 모듈과 SCRIPTS 루트가 다르면 계약을 고르기 전에 멈춘다."""
    loaded_scripts = _fake_release(tmp_path / "0.6.5", "0.6.5")
    other_scripts = _fake_release(tmp_path / "0.6.6", "0.6.6")
    module = _load_release_module(loaded_scripts, "_gg_deps_release_probe")
    monkeypatch.setattr(sys.modules[__name__], "SCRIPTS", other_scripts)

    with pytest.raises(pytest.fail.Exception) as failure:
        _pip_contract(module)
    assert "출처 불일치" in str(failure.value)


def test_release_marker_follows_the_loaded_module(tmp_path, monkeypatch):
    """짝: 적재된 모듈과 SCRIPTS 루트가 같으면 그 판의 계약을 고른다."""
    for version in ("0.6.5", "0.6.6"):
        scripts = _fake_release(tmp_path / version, version)
        module = _load_release_module(scripts, f"_gg_deps_release_probe_{version.replace('.', '')}")
        monkeypatch.setattr(sys.modules[__name__], "SCRIPTS", scripts)
        assert _pip_contract(module) is PIP_CONTRACTS[version], version


def test_release_marker_missing_beside_loaded_module(tmp_path, monkeypatch):
    """모듈 옆에 판 표지가 없으면 다른 판 표지를 빌려오지 않고 실패한다."""
    scripts = _fake_release(tmp_path / "0.6.6", "0.6.6")
    (tmp_path / "0.6.6" / "version.json").unlink()
    module = _load_release_module(scripts, "_gg_deps_release_probe_missing")
    monkeypatch.setattr(sys.modules[__name__], "SCRIPTS", scripts)

    with pytest.raises(pytest.fail.Exception) as failure:
        _pip_contract(module)
    assert "판 표지가 없음" in str(failure.value)


def test_release_marker_rejects_unregistered_release(tmp_path, monkeypatch):
    """모르는 판은 조용히 통과하지 않는다 — 그 판의 계약을 표에 적어야 한다."""
    scripts = _fake_release(tmp_path / "0.6.7", "0.6.7")
    module = _load_release_module(scripts, "_gg_deps_release_probe_unknown")
    monkeypatch.setattr(sys.modules[__name__], "SCRIPTS", scripts)

    with pytest.raises(pytest.fail.Exception) as failure:
        _pip_contract(module)
    assert "0.6.7" in str(failure.value)
