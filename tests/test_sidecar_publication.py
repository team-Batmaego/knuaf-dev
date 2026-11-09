"""Consumer-visible publication/lock boundaries of the composed skill contract."""
import io
import json
import sys

import pytest

from conftest import REPO, bind_test_major
from test_sidecar import Sidecar

sys.path.insert(0, str(REPO / "app" / "sidecar"))
from knuaf_sidecar.envelope import normalize  # noqa: E402


@pytest.mark.parametrize("state,code", [
    ("not_committed", 2), ("committed_cleanup_pending", 3), ("indeterminate", 4),
])
def test_uncertain_or_incomplete_commit_is_never_reported_successful(state, code):
    data = {"operation": "paper", "target": "output", "commit_state": state,
            "reason": "publication_incomplete", "request_id": "synthetic-request",
            "cleanup_errors": [{"operation": "release", "reason": "synthetic_failure"}],
            "detail": {"receipt_path": ".gg-artifacts/synthetic/.publication.json"}}
    for exit_code in (code, 0):
        env = normalize(["gg.py"], "python", exit_code, json.dumps(data), "", 1)
        assert not env["ok"]
        assert env["exit"] == exit_code and env["commit_state"] == state
        assert env["status"] == state and env["block_reason"] == "publication_incomplete"
        assert env["detail"] == data["detail"]
        assert env["data"]["cleanup_errors"] == data["cleanup_errors"]


def test_held_output_retains_reason_and_is_not_a_success_even_on_exit_zero():
    env = normalize([], "python", 0, json.dumps({
        "status": "held", "reason": "major_binding_mismatch", "detail": "different explicit selection",
    }), "", 1)
    assert env["status"] == "held" and not env["ok"]
    assert env["block_reason"] == "major_binding_mismatch"
    assert env["detail"] == "different explicit selection"


def test_export_needs_explicit_matching_major_and_preserves_the_canonical(empty_folder, publication_skill):
    import gg_core as core

    project = empty_folder
    core.init(project)
    sidecar = Sidecar()
    try:
        unbound = sidecar.call("project.major", root=str(project))
        assert unbound["error"]["code"] == "major_required"
        bind_test_major(project)
        binding = sidecar.ok("project.major", root=str(project))["result"]
        assert binding["major_id"] == "specialty_crops" and binding["binding_evidence"].startswith("facts:")
        before = (project / "project.json").read_bytes()
        for params, reason in (({}, "major_id_required"), ({"major_id": "fruit_trees"}, "major_binding_mismatch")):
            error = sidecar.call("project.export", root=str(project), kind="draft", **params)["error"]
            assert error["code"] == "operation_not_committed"
            assert error["data"]["commit_state"] == "not_committed"
            assert error["data"]["exit"] == 2 and error["data"]["reason"] == reason
        assert (project / "project.json").read_bytes() == before
        assert not list((project / "build").glob("*/draft/*.md"))
    finally:
        sidecar.close()


def test_legacy_control_is_preserved_not_unlocked_or_reinitialized(tmp_path, publication_skill):
    control = tmp_path / ".gg-lock"
    control.mkdir()
    owner = control / "owner.json"
    owner.write_text('{"pid":999999,"host":"synthetic","token":"legacy"}', encoding="utf-8")
    before = owner.read_bytes()
    sidecar = Sidecar()
    try:
        inspected = sidecar.ok("lock.info", root=str(tmp_path))["result"]
        assert inspected["structure"] == "legacy"
        denied = sidecar.call("lock.unlock", root=str(tmp_path))["error"]
        assert denied["code"] == "lock_ambiguous" and denied["data"]["status"] == "legacy"
        assert owner.read_bytes() == before and control.is_dir()
        assert not (tmp_path / "project.json").exists()
    finally:
        sidecar.close()


@pytest.mark.parametrize("corrupt_receipt,state,exit_code", [
    (False, "committed_cleanup_pending", 3), (True, "indeterminate", 4),
])
def test_release_failure_reports_rechecked_commit_not_generic_failure(
    publication_project, monkeypatch, corrupt_receipt, state, exit_code,
):
    import gg_lock
    from knuaf_sidecar import methods_core
    from knuaf_sidecar.rpc import Server

    root = publication_project
    out = io.StringIO()
    server = Server(out=out)
    methods_core.register(server)

    def cannot_clean_owner(capability):
        if corrupt_receipt:
            import gg_publication

            for receipt in (root / "build").glob("*/draft/" + gg_publication.RECEIPT_NAME):
                receipt.write_bytes(b"synthetic unreadable receipt")
        raise PermissionError(13, "synthetic owner cleanup denial")

    with monkeypatch.context() as patch:
        patch.setattr(gg_lock, "_cleanup_owner_record", cannot_clean_owner)
        server._handle({"id": 1, "method": "project.export", "params": {
            "root": str(root), "kind": "draft", "major_id": "specialty_crops",
        }})
    error = json.loads(out.getvalue())["error"]
    assert error["code"] == state and error["data"]["commit_state"] == state
    assert error["data"]["exit"] == exit_code
    if not corrupt_receipt:
        assert error["data"]["request_id"]
    assert any("600평" in path.read_text(encoding="utf-8") for path in (root / "build").glob("*/draft/*.md"))
    assert gg_lock.probe_lock(root)["lock_state"] == "free"



@pytest.mark.parametrize("states", [("closed", "closed"), ("unknown", "closed")])
def test_office_clean_accounts_for_every_requested_job(tmp_path, publication_skill, states):
    workspace = tmp_path / "office-workspace"
    jobs = ["job-aaaaaaaaaaaa-1", "job-bbbbbbbbbbbb-2"]
    for job_id, state in zip(jobs, states):
        job = workspace / job_id
        job.mkdir(parents=True)
        (job / "office_session.json").write_text(
            json.dumps({"schema": "gg-office-session/v1", "cleanup": state}), encoding="utf-8",
        )
        (job / "input.docx").write_bytes(b"synthetic preserved job input")
    sidecar = Sidecar()
    try:
        result = sidecar.ok(
            "office.clean", root=str(tmp_path), workspace=str(workspace), jobs=jobs,
        )["result"]
        closed = {job_id for job_id, state in zip(jobs, states) if state == "closed"}
        unknown = set(jobs) - closed
        assert {row["id"] for row in result["data"]["deleted"]} == closed
        assert result["ok"] is (not unknown)
        assert result["exit"] == (1 if unknown else 0)
        assert result["data"]["refused"] == [
            {"id": job_id, "reason": "office_session_not_closed"} for job_id in jobs if job_id in unknown
        ]
        for job_id in closed:
            assert not (workspace / job_id).exists()
        for job_id in unknown:
            assert (workspace / job_id / "input.docx").read_bytes() == b"synthetic preserved job input"
    finally:
        sidecar.close()


def test_student_workbook_inspection_does_not_require_canonical_or_major(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    source = tmp_path / "학생 재무.xlsx"
    workbook = openpyxl.Workbook()
    workbook.active["A1"] = "학생 매출"
    workbook.active["B1"] = 12345
    workbook.save(source)
    before = source.read_bytes()
    sidecar = Sidecar()
    try:
        inspected = sidecar.ok(
            "excel.inspect", root=str(tmp_path), source=source.name, out_map="map.json",
        )["result"]
        assert inspected["ok"], inspected
        assert source.read_bytes() == before
        assert not (tmp_path / "project.json").exists()
        entries = json.loads((tmp_path / "map.json").read_text(encoding="utf-8"))["entries"]
        numeric = next(entry for entry in entries if entry["sheet"] == workbook.active.title and entry["range"] == "B1")
        assert numeric["action"] == "preserve" and numeric["explicit"] is False
    finally:
        sidecar.close()


@pytest.mark.parametrize("source_param", [{}, {"source": ""}])
@pytest.mark.parametrize("file_state", ["valid", "missing", "corrupt"])
def test_registered_finance_inspection_without_major(tmp_path, source_param, file_state):
    import gg_core as core
    import openpyxl

    from test_sidecar import _intake_fact

    core.init(tmp_path)
    source = tmp_path / "sources" / "학생 재무.xlsx"
    source.parent.mkdir(exist_ok=True)
    (source.parent / "answers.md").write_text("학생 재무 파일을 등록함\n", encoding="utf-8")
    if file_state == "valid":
        workbook = openpyxl.Workbook()
        workbook.active["B1"] = 12345
        workbook.save(source)
    elif file_state == "corrupt":
        source.write_bytes(b"not an xlsx")
    core.apply(tmp_path, {"request_id": "test:registered-finance", "ops": [
        {"collection": "sources", "value": {"id": "src-answers", "path": "sources/answers.md"}},
        _intake_fact("finance", "intake.current_finance", "sources/학생 재무.xlsx", "provided"),
    ]}, 0)
    canonical = (tmp_path / "project.json").read_bytes()
    original = source.read_bytes() if source.exists() else None
    sidecar = Sidecar()
    try:
        assert sidecar.call("project.major", root=str(tmp_path))["error"]["code"] == "major_required"
        result = sidecar.ok("excel.inspect", root=str(tmp_path), out_map="map.json", **source_param)["result"]
        if file_state == "valid":
            assert result["ok"], result
            entries = json.loads((tmp_path / "map.json").read_text(encoding="utf-8"))["entries"]
            assert next(entry for entry in entries if entry["range"] == "B1")["action"] == "preserve"
        else:
            explicit = sidecar.ok("excel.inspect", root=str(tmp_path), source="sources/학생 재무.xlsx", out_map="map.json")["result"]
            assert not result["ok"]
            assert {key: result[key] for key in ("status", "block_reason", "data", "stderr")} == {
                key: explicit[key] for key in ("status", "block_reason", "data", "stderr")
            }
            assert not (tmp_path / "map.json").exists()
        assert (source.read_bytes() if source.exists() else None) == original
        assert (tmp_path / "project.json").read_bytes() == canonical
    finally:
        sidecar.close()


@pytest.mark.parametrize("source_param", [{}, {"source": ""}])
def test_inspection_without_student_source_retains_template_major_gate(tmp_path, source_param):
    import gg_core as core

    core.init(tmp_path)
    sidecar = Sidecar()
    try:
        result = sidecar.ok("excel.inspect", root=str(tmp_path), out_map="map.json", template_ref="X01", **source_param)["result"]
        assert not result["ok"] and result["block_reason"] == "major_id_required", result
    finally:
        sidecar.close()
