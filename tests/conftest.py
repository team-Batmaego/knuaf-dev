"""Shared fixtures. The skill scripts import each other by bare module name,
so `scripts/` is put on sys.path and CLI runs use the script path directly."""
import importlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = Path(os.environ.get("KNUAF_TEST_SCRIPTS_DIR") or REPO / "app" / "resources" / "skill" / "scripts").resolve()
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

START, END = "<!-- gg:draft:start -->", "<!-- gg:draft:end -->"


def pytest_sessionstart(session):
    """Old personal hook commands also prepare the pinned runtime before collection."""
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    if os.environ.get("KNUAF_TEST_SCRIPTS_DIR"):
        # Explicit local compose / isolated compatibility runs must not recursively stage.
        if not SCRIPTS.is_dir():
            raise pytest.UsageError(f"Explicit KNUAF_TEST_SCRIPTS_DIR is not a directory: {SCRIPTS}")
        return
    print("[skill-tests] Preparing pinned runtime offline before pytest collection", file=sys.stderr, flush=True)
    try:
        prepared = subprocess.run(
            ["node", str(REPO / "app/scripts/stage-skill.mjs"), "--offline", "--python", sys.executable],
            cwd=REPO, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, check=False,
        )
    except OSError as error:
        raise pytest.UsageError(f"Pinned runtime preparation could not start: {error}") from error
    if prepared.returncode:
        raise pytest.UsageError(
            f"Pinned runtime preparation failed before collection (exit {prepared.returncode}); "
            "see source/cache or compatibility errors above. No stale runtime fallback."
        )
    importlib.invalidate_caches()

@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    blocked = getattr(sys.modules.get("gg_kordoc"), "KordocBlocked", ())
    if call.excinfo is not None and isinstance(call.excinfo.value, blocked):
        error = call.excinfo.value
        report.sections.append(("Kordoc failure evidence", json.dumps(
            {"reason": error.reason, "details": error.details}, ensure_ascii=True, indent=2,
        )))



def run_script(script, *args, python=None, env=None, cwd=None, timeout=120):
    """Run a skill script as a subprocess and return CompletedProcess (text)."""
    argv = [python or sys.executable, str(SCRIPTS / script), *map(str, args)]
    full_env = dict(os.environ)
    full_env.setdefault("PYTHONIOENCODING", "utf-8")
    if env:
        full_env.update(env)
    return subprocess.run(
        argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=full_env, cwd=str(cwd or SCRIPTS), timeout=timeout,
    )


def run_gg(folder, command, *args, **kw):
    return run_script("gg.py", command, folder, *args, **kw)


def parse_json(text):
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(text.splitlines()[-1])


def python39():
    """Return a Python 3.9 interpreter path if one is reachable, else None."""
    cand = os.environ.get("PY39")
    if cand and shutil.which(cand):
        return shutil.which(cand)
    for name in ("python3.9", "/usr/bin/python3"):
        p = shutil.which(name) if not name.startswith("/") else (name if Path(name).exists() else None)
        if not p:
            continue
        out = subprocess.run([p, "-c", "import sys;print(sys.version_info[:2])"],
                             capture_output=True, text=True)
        if out.stdout.strip() == "(3, 9)":
            return p
    return None


def write_section(root, rel, title, body):
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    # `newline="\n"` — 텍스트 모드 기본값은 윈도에서 `\r\n` 로 바꿔 쓴다. 원고는 플랫폼과
    # 무관하게 같은 바이트여야 한다(바이트를 통째로 세우는 시험이 있다).
    path.write_text(f"# {title}\n\n{START}\n{body}\n{END}\n", encoding="utf-8", newline="\n")
    return path


def basic_change():
    return json.loads((FIXTURES / "change-basic.json").read_text(encoding="utf-8"))


@pytest.fixture
def empty_folder(tmp_path):
    folder = tmp_path / "논문 작업"  # Korean + space on purpose
    folder.mkdir()
    return folder


@pytest.fixture
def project(empty_folder):
    """A synthetic project with source-backed facts and an explicit test major."""
    import gg_core as core

    root = empty_folder
    core.init(root)
    (root / "sources").mkdir(exist_ok=True)  # gg_core.init already creates it
    (root / "sources" / "answers.md").write_text(
        "# 원답변\n\n재배 면적: 600평\n\n수취가격: 모름\n", encoding="utf-8"
    )
    write_section(root, "sections/01.md", "Ⅰ. 머리말", "농장A의 재배 면적은 600평이다.")
    change = basic_change()
    change["ops"].extend(major_ops(root, 1))
    core.apply(root, change, 0)
    return root


@pytest.fixture
def publication_skill():
    """Current publication contracts are mandatory for the composed app bundle."""
    if not (SCRIPTS / "gg_major_contract.py").is_file():
        pytest.fail("incompatible app bundle: missing gg_major_contract.py; run stage:skill")


def major_ops(root, revision, major_id="specialty_crops"):
    import gg_major_contract as mc

    (root / "major-answer.txt").write_text("Synthetic explicit major selection\n", encoding="utf-8")
    fact = {
        "id": "selected-major", "field_id": "common.major_id", "kind": "reported_fact",
        "value": major_id, "unit": "", "value_type": "text", "period": None, "scope": "project",
        "answer_state": "provided", "verification": "claim_supported",
        "module_version": mc.default_registry().resolve(major_id).module_version,
        "source_refs": [{"id": "major-answer", "revision": revision, "locator": "L1", "claim_id": "major"}],
    }
    claim = {k: fact[k] for k in ("field_id", "value", "unit", "period", "scope", "answer_state", "kind")}
    return [
        {"collection": "sources", "value": {
            "id": "major-answer", "path": "major-answer.txt", "claims": {"major": claim}, "claim_review": "synthetic-review",
        }},
        {"collection": "facts", "value": fact},
    ]


def bind_test_major(root, major_id="specialty_crops"):
    import gg_core as core

    revision = core.load(root)["revision"]
    core.apply(root, {"request_id": "test:bind:" + major_id,
                      "ops": major_ops(root, revision + 1, major_id)}, revision)


def bound_test_context(root):
    """Explicit output context for synthetic standalone tool fixtures, never a production default."""
    import gg_core as core
    import gg_major_contract as mc

    if not (root / "project.json").exists():
        core.init(root)
    if "selected-major" not in core.load(root)["facts"]:
        bind_test_major(root)
    return mc.output_context(root, "specialty_crops")


@pytest.fixture
def publication_project(publication_skill, project):
    return project
