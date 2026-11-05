"""gg_commands: the four legacy entrypoints (build_status·lint_evidence·
merge_sections·lint_format) that share one dispatcher.

Nothing in SKILL.md or the app references these any more — gg.py covers the
same ground — but lint_format keeps one capability gg.py does not have: it can
check a single section file in a folder that has no project.json yet. The rest
must refuse that folder rather than pass judgement on an unimported ledger.
"""
import json

import pytest

from conftest import run_script, write_section

SHIMS = {"build_status": "status", "lint_evidence": "evidence",
         "merge_sections": "merge", "lint_format": "format"}


def rows(result):
    return json.loads(result.stdout)


@pytest.fixture
def loose_sections(tmp_path):
    """A pre-project.json folder: sections on disk, no canon."""
    folder = tmp_path / "예전 작업"
    write_section(folder, "sections/01.md", "Ⅰ. 머리말", "농장A의 재배 면적은 600평이다.")
    return folder


# --- an unimported folder is refused, not judged ------------------------------

@pytest.mark.parametrize("shim", ["build_status", "lint_evidence", "merge_sections"])
def test_a_folder_without_a_canon_is_blocked(shim, loose_sections):
    """A legacy ledger must be imported before anything reports on it."""
    r = run_script(f"{shim}.py", loose_sections)
    assert r.returncode == 2, r.stdout
    body = rows(r)
    assert body[0]["status"] == "blocked"
    assert body[0]["check_id"] == "execution"
    assert "import" in body[0]["reason"]




# --- the one thing gg.py cannot do --------------------------------------------

def test_format_checks_a_single_file_without_a_project(loose_sections):
    """This is why the shim is kept; gg.py check needs a canon."""
    r = run_script("lint_format.py", loose_sections / "sections" / "01.md")
    assert r.returncode == 0, r.stdout
    body = rows(r)
    assert body[0]["status"] == "pass"




def test_format_reports_unit_spacing_defect_and_passes_after_correction(tmp_path):
    document = tmp_path / "단위.md"
    document.write_text("무게는 1kg이다.\n", encoding="utf-8")
    rejected = run_script("lint_format.py", document)
    assert rejected.returncode == 1, rejected.stdout + rejected.stderr
    assert any(row["check_id"] == "unit_spacing" and row["status"] == "fail"
               for row in rows(rejected)), rejected.stdout

    document.write_text("무게는 1 kg이다.\n", encoding="utf-8")
    corrected = run_script("lint_format.py", document)
    assert corrected.returncode == 0, corrected.stdout + corrected.stderr
    assert not any(row["check_id"] == "unit_spacing" and row["status"] != "pass"
                   for row in rows(corrected)), corrected.stdout


# --- the canon path -----------------------------------------------------------

def test_status_on_a_real_project_reports_the_revision_and_checks(project):
    r = run_script("build_status.py", project)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["revision"] >= 1
    assert isinstance(data["checks"], list)
    assert isinstance(data["tasks"], list)




# --- an empty target is not a pass --------------------------------------------

@pytest.mark.parametrize("make,label", [
    (lambda t: t / "없는폴더", "없는 경로"),
    (lambda t: _empty_sections(t), "빈 sections 폴더"),
    (lambda t: _empty_file(t), "빈 파일"),
])
def test_format_blocks_an_empty_target_instead_of_passing_it(make, label, tmp_path):
    """glob on a missing folder yields nothing, and an empty body used to sail
    through as '서식 통과' — a wrong path got a green light."""
    r = run_script("lint_format.py", make(tmp_path))
    assert r.returncode == 2, f"{label}: {r.stdout}"
    assert rows(r)[0]["status"] == "blocked"


def _empty_sections(t):
    (t / "빈폴더" / "sections").mkdir(parents=True)
    return t / "빈폴더"


def _empty_file(t):
    f = t / "빈파일.md"
    f.write_text("", encoding="utf-8")
    return f


# --- failures are reported, never raised --------------------------------------

@pytest.mark.parametrize("shim", sorted(SHIMS))
def test_a_missing_target_is_reported_as_json_not_a_traceback(shim, tmp_path):
    r = run_script(f"{shim}.py", tmp_path / "없는폴더")
    assert r.returncode == 2
    assert "Traceback" not in r.stderr
    body = rows(r)
    assert body[0]["status"] == "blocked"


