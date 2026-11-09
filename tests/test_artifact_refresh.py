"""Generated files stay distinct from intake files, including root Word output."""
import json

import pytest
from docx import Document

import gg_core as core
from conftest import bind_test_major, run_script
from test_sidecar import Sidecar, _intake_fact


@pytest.fixture
def sidecar():
    client = Sidecar()
    yield client
    client.close()


def build_word(root, name):
    body = root / "sections" / "word-body.md"
    body.write_text("# Ⅰ. 머리말\n\n실제 생성된 검토용 본문이다.\n", encoding="utf-8")
    result = run_script("build_docx.py", root, "--in", "sections/word-body.md",
                        "--out", name, "--major", "specialty_crops", "--no-toc")
    assert result.returncode == 0, result.stdout + result.stderr
    return root / name


def test_root_word_and_build_outputs_exclude_intake(sidecar, project):
    bind_test_major(project)
    (project / "기존원고.docx").write_bytes(b"existing manuscript")
    (project / "참고자료.pdf").write_bytes(b"reference")
    (project / "입력재무.xlsx").write_bytes(b"input finance")
    (project / "루트메모.md").write_text("입력 메모", encoding="utf-8")
    revision = core.load(project)["revision"]
    core.apply(project, {
        "request_id": "test:artifact-intake",
        "ops": [_intake_fact("current-manuscript", "intake.current_manuscript",
                             "기존원고.docx", "provided")],
    }, revision)
    assert sidecar.ok("materials.list", root=str(project))["result"]["current_manuscript"]["path"] == "기존원고.docx"
    before = (project / "project.json").read_bytes()
    assert sidecar.ok("artifact.list", root=str(project))["result"]["items"] == []

    review = project / "build" / "7" / "review"
    review.mkdir(parents=True)
    (review / "검토용.md").write_text("# 새 검토본", encoding="utf-8")
    word = build_word(project, "임의이름_생성본.docx")
    (project / "sources" / "참고.docx").write_bytes(word.read_bytes())
    paths = {item["path"]: item for item in sidecar.ok("artifact.list", root=str(project))["result"]["items"]}
    assert set(paths) == {"build/7/review/검토용.md", word.name}
    assert paths[word.name]["kind"] == "docx"
    assert paths[word.name]["revision"] is None
    assert "실제 생성된 검토용 본문이다." in "\n".join(p.text for p in Document(word).paragraphs)
    assert sidecar.ok("artifact.preview", root=str(project), path="build/7/review/검토용.md")["result"]["text"] == "# 새 검토본"
    assert (project / "project.json").read_bytes() == before


@pytest.mark.parametrize("receipt_state", ["missing", "invalid-json", "wrong-kind", "wrong-hash", "changed-file"])
def test_root_word_requires_matching_generation_receipt(sidecar, project, receipt_state):
    bind_test_major(project)
    word = build_word(project, "다른이름.docx")
    receipt_path = word.with_suffix(".manifest.json")
    if receipt_state == "missing":
        receipt_path.unlink()
    elif receipt_state == "invalid-json":
        receipt_path.write_text("{", encoding="utf-8")
    elif receipt_state == "changed-file":
        word.write_bytes(word.read_bytes() + b"changed")
    else:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["kind" if receipt_state == "wrong-kind" else "file_hash"] = "not-generated"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
    assert sidecar.ok("artifact.list", root=str(project))["result"]["items"] == []


def test_registered_output_is_listed_from_canonical_managed_path(sidecar, project):
    bind_test_major(project)
    output = project / "출력본문.md"
    output.write_text("# Ⅰ. 머리말\n\n등록된 산출물 본문.\n", encoding="utf-8")
    p = core.load(project)
    refs = [{"collection": "sections", "id": "sec-01"}]
    core.adopt_output(project, {
        "id": "artifact-review", "path": output.name, "format": "md",
        "file_hash": core.digest(output.read_bytes()), "target_refs": refs,
        "input_fingerprint": core.fingerprint(project, p, refs),
    }, p["revision"], "test:artifact-adopt", major_id="specialty_crops")
    registered = core.load(project)["outputs"]["artifact-review"]
    items = sidecar.ok("artifact.list", root=str(project))["result"]["items"]
    assert [item["path"] for item in items] == [registered["path"]]
    assert items[0]["revision"] == registered["revision"]
    assert items[0]["kind"] == "md"
    assert sidecar.ok("artifact.preview", root=str(project), path=registered["path"])["result"]["text"] == output.read_bytes().decode("utf-8")
