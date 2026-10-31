"""Shared fixtures. The skill scripts import each other by bare module name,
so `scripts/` is put on sys.path and CLI runs use the script path directly."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = Path(os.environ.get("KNUAF_TEST_SCRIPTS_DIR", REPO / "skills" / "knuaf-dev" / "scripts")).resolve()
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

START, END = "<!-- gg:draft:start -->", "<!-- gg:draft:end -->"


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
    path.write_text(f"# {title}\n\n{START}\n{body}\n{END}\n", encoding="utf-8")
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
    """A synthetic project: init + one source + one section + two facts."""
    import gg_core as core

    root = empty_folder
    core.init(root)
    (root / "sources").mkdir(exist_ok=True)  # gg_core.init already creates it
    (root / "sources" / "answers.md").write_text(
        "# 원답변\n\n재배 면적: 600평\n\n수취가격: 모름\n", encoding="utf-8"
    )
    write_section(root, "sections/01.md", "Ⅰ. 머리말", "농장A의 재배 면적은 600평이다.")
    core.apply(root, basic_change(), 0)
    return root


@pytest.fixture
def publication_skill():
    """The first-unit checkpoint keeps the old bundle until composition is staged."""
    if not (SCRIPTS / "gg_major_contract.py").is_file():
        pytest.skip("current knuaf-doc bundle required: set KNUAF_TEST_SCRIPTS_DIR")


def bind_test_major(root, major_id="specialty_crops"):
    import gg_core as core
    import gg_major_contract as mc

    revision = core.load(root)["revision"]
    (root / "major-answer.txt").write_text("Synthetic explicit major selection\n", encoding="utf-8")
    fact = {
        "id": "selected-major", "field_id": "common.major_id", "kind": "reported_fact",
        "value": major_id, "unit": "", "value_type": "text", "period": None, "scope": "project",
        "answer_state": "provided", "verification": "claim_supported",
        "module_version": mc.default_registry().resolve(major_id).module_version,
        "source_refs": [{"id": "major-answer", "revision": revision + 1, "locator": "L1", "claim_id": "major"}],
    }
    claim = {k: fact[k] for k in ("field_id", "value", "unit", "period", "scope", "answer_state", "kind")}
    core.apply(root, {"request_id": "test:bind:" + major_id, "ops": [
        {"collection": "sources", "value": {
            "id": "major-answer", "path": "major-answer.txt", "claims": {"major": claim}, "claim_review": "synthetic-review",
        }},
        {"collection": "facts", "value": fact},
    ]}, revision)


@pytest.fixture
def publication_project(publication_skill, project):
    bind_test_major(project)
    return project
