"""Protocol tests for app/sidecar (JSON-lines over stdio)."""
import json
import os
import select
import subprocess
import sys
import time

import pytest

from conftest import REPO, SCRIPTS, bind_test_major

SIDECAR_DIR = REPO / "app" / "sidecar"


class Sidecar:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "knuaf_sidecar", "--scripts-dir", str(SCRIPTS), "--interpreter-kind", "test"],
            cwd=str(SIDECAR_DIR), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        self.n = 0
        ready = json.loads(self.proc.stdout.readline())
        assert ready.get("event") == "ready", ready

    def send(self, method, **params):
        """Write one request and return its id without waiting for the answer."""
        self.n += 1
        rid = "r%d" % self.n
        self.proc.stdin.write(json.dumps({"id": rid, "method": method, "params": params}, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        return rid

    def wait(self, rid, timeout=None):
        """Read until the response for `rid` arrives; events for it are attached under "events"."""
        events = []
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                assert remaining > 0, "no response for %s within %ss" % (rid, timeout)
                ready, _, _ = select.select([self.proc.stdout], [], [], remaining)
                assert ready, "no response for %s within %ss" % (rid, timeout)
            line = self.proc.stdout.readline()
            assert line, "sidecar closed: " + self.proc.stderr.read()
            msg = json.loads(line)
            if msg.get("id") != rid:
                continue
            if "event" in msg:
                events.append(msg)
                continue
            msg["events"] = events
            return msg

    def call(self, method, **params):
        return self.wait(self.send(method, **params))

    def ok(self, method, **params):
        """call() that fails with the sidecar's error instead of a bare KeyError."""
        r = self.call(method, **params)
        assert "result" in r, "%s 실패: %s" % (method, json.dumps(r.get("error"), ensure_ascii=False))
        return r

    def close(self):
        try:
            self.proc.stdin.write(json.dumps({"id": "bye", "method": "shutdown"}) + "\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=10)
        finally:
            self.proc.kill()


@pytest.fixture
def sidecar():
    s = Sidecar()
    yield s
    s.close()


def test_hello_and_unknown_method(sidecar):
    hello = sidecar.call("sys.hello")
    assert hello["result"]["python_version"].startswith("3.")
    assert hello["result"]["interpreter_kind"] == "test"
    bad = sidecar.call("no.such")
    assert bad["error"]["code"] == "not_found"


def test_methods_list_reports_write_flags(sidecar):
    flags = {m["name"]: m["write"] for m in sidecar.call("methods.list")["result"]}
    assert flags["project.init"] is True
    assert flags["project.status"] is False
    assert flags["methods.list"] is False


def test_status_has_four_lanes_and_banner(sidecar, project):
    st = sidecar.call("project.status", root=str(project))["result"]
    assert st["revision"] == 1
    assert set(st["lanes"]) == {"machine", "content_review", "output_review", "professor"}
    assert st["lanes"]["content_review"]["independent_review_missing"] is True
    assert st["lanes"]["professor"]["recorded"] is False
    assert isinstance(st["user_finish_pending"], list)


def test_sections_and_read(sidecar, project):
    secs = sidecar.call("project.sections", root=str(project))["result"]
    assert secs[0]["id"] == "sec-01" and secs[0]["draft_hash_ok"] is True
    body = sidecar.call("section.read", root=str(project), id="sec-01")["result"]
    assert "600평" in body["draft"]
    missing = sidecar.call("section.read", root=str(project), id="nope")
    assert missing["error"]["code"] == "not_found"


def test_history_restore_and_export_preserve_publication_evidence(sidecar, publication_project):
    project = publication_project
    import gg_core as core

    revision = core.load(project)["revision"]
    hist = sidecar.call("project.history", root=str(project))["result"]
    assert hist[-1]["current"] is True
    ex = sidecar.ok("project.export", root=str(project), kind="draft", major_id="specialty_crops")["result"]
    assert ex["status"] == "generated" and ex["request_id"]
    assert "600평" in core.local(project, ex["path"]).read_text(encoding="utf-8")
    again = sidecar.ok("project.export", root=str(project), kind="draft", major_id="specialty_crops")["result"]
    assert again["status"] == "existing" and again["request_id"] == ex["request_id"]
    res = sidecar.ok("project.restore", root=str(project), revision=0, expected_revision=revision)["result"]
    assert res["revision"] == revision + 1 and res["commit_state"] == "committed"


def test_owner_cleanup_cannot_break_a_live_guard(sidecar, publication_project):
    import gg_lock

    root = publication_project
    guard = root / ".gg-lock" / "guard"
    original = guard.read_bytes(), guard.stat().st_ino
    owner = root / ".gg-lock" / "owner.json"
    with gg_lock.Lock(root):
        before = owner.read_bytes()
        assert sidecar.ok("lock.info", root=str(root), probe=True)["result"]["lock_state"] == "busy"
        assert sidecar.call("lock.unlock", root=str(root))["error"]["code"] == "lock_held"
        assert owner.read_bytes() == before
    owner.write_text(json.dumps({"pid": 999999, "host": "synthetic", "token": "stale"}), encoding="utf-8")
    assert sidecar.ok("lock.info", root=str(root))["result"]["lock_state"] == "unprobed"
    assert sidecar.ok("lock.info", root=str(root), probe=True)["result"]["lock_state"] == "free"
    assert sidecar.ok("lock.unlock", root=str(root))["result"]["owner_cleaned"] is True
    assert not owner.exists()
    assert (guard.read_bytes(), guard.stat().st_ino) == original


def test_doctor_all_shape(sidecar, publication_project):
    d = sidecar.ok("doctor.all", root=str(publication_project))["result"]
    assert {"gg", "lock", "deps", "kordoc", "snapshots", "python"} <= set(d)
    assert "ready" in d["deps"]
    assert d["kordoc"]["capability_verified"] is False
    assert "error" not in d["kordoc"]


def test_project_owned_paths_cannot_escape_the_working_folder(sidecar, project):
    """The renderer gates output fields, but the sidecar is the real boundary."""
    for params in (
        {"input": "paper.json", "out": "../탈출.md"},
        {"input": "paper.json", "out": "/tmp/탈출.md"},
    ):
        r = sidecar.call("paper.generate", root=str(project), **params)
        assert r["error"]["code"] == "invalid_params", params
        assert "작업 폴더 밖" in r["error"]["message"]


def test_positional_value_cannot_pose_as_an_option(sidecar, project):
    r = sidecar.call("office.word", root=str(project), input="--help", out_dir="build/native")
    assert r["error"]["code"] == "invalid_params"
    assert "'-'" in r["error"]["message"]


def test_docx_build_without_venv_reports_deps_not_ready(sidecar, project):
    r = sidecar.call("docx.build", root=str(project), out="build/x.docx")
    assert r["error"]["code"] == "deps_not_ready"


def _intake_fact(fid, field_id, value, answer_state, **extra):
    value = {
        "id": fid, "field_id": field_id, "kind": "reported_fact",
        "value": value, "unit": None, "value_type": "text", "period": None, "scope": None,
        "answer_state": answer_state, "verification": "unreviewed",
        "source_refs": [{"id": "src-answers", "revision": 1, "locator": "L1"}],
    }
    value.update(extra)
    return {"collection": "facts", "value": value}


def test_materials_list_facts_and_roles(sidecar, project):
    (project / "sources" / "원고.docx").write_bytes(b"docx")
    (project / "sources" / "참고.pdf").write_bytes(b"%PDF-1.4\n")
    (project / "sources" / ".hidden.md").write_text("x", encoding="utf-8")
    change = {
        "request_id": "test:intake:1",
        "ops": [
            _intake_fact("fact-manuscript", "intake.current_manuscript", "sources/원고.docx", "provided"),
            _intake_fact("fact-finance", "intake.current_finance", None, "explicit_none", reason="재무 파일 없음"),
            _intake_fact("fact-basis", "intake.work_basis", "이어쓰기", "provided"),
        ],
    }
    import gg_core as core
    core.apply(project, change, 1)
    res = sidecar.call("materials.list", root=str(project))["result"]
    assert res["current_manuscript"]["provided"] is True
    assert res["current_manuscript"]["path"] == "sources/원고.docx"
    assert res["current_finance"]["provided"] is False
    assert res["current_finance"]["answer_state"] == "explicit_none"
    assert res["work_basis"] == "이어쓰기"
    roles = {f["path"]: f["role"] for f in res["files"]}
    assert roles["sources/원고.docx"] == "current"
    assert roles["sources/참고.pdf"] == "reference"
    assert roles["sources/answers.md"] == "reference"
    assert "sources/.hidden.md" not in roles


def test_materials_list_empty_project(sidecar, project):
    res = sidecar.call("materials.list", root=str(project))["result"]
    assert res["current_manuscript"]["provided"] is False
    assert res["work_basis"] is None
    assert {f["path"] for f in res["files"]} == {"sources/answers.md"}


def test_artifact_list_kinds_and_revision(sidecar, project):
    (project / "build").mkdir(exist_ok=True)
    (project / "build" / "메모.md").write_text("# 메모\n", encoding="utf-8")
    (project / "build" / "receipt.json").write_text("{}", encoding="utf-8")
    res = sidecar.call("artifact.list", root=str(project))["result"]
    paths = [i["path"] for i in res["items"]]
    assert all(p.startswith("build/") for p in paths)
    assert not any(p.endswith(".json") for p in paths)
    assert "build/메모.md" in paths
    md = next(i for i in res["items"] if i["path"] == "build/메모.md")
    assert md["kind"] == "md" and md["name"] == "메모.md" and md["bytes"] > 0
    mtimes = [i["mtime"] for i in res["items"]]
    assert mtimes == sorted(mtimes, reverse=True)


def test_artifact_preview_text_pdf_missing_and_escape(sidecar, project):
    (project / "build").mkdir(exist_ok=True)
    (project / "build" / "메모.md").write_text("# 메모\n\n본문\n", encoding="utf-8")
    (project / "build" / "문서.pdf").write_bytes(b"%PDF-1.4\n")
    res = sidecar.call("artifact.preview", root=str(project), path="build/메모.md")["result"]
    assert res["kind"] == "text" and "본문" in res["text"]
    res = sidecar.call("artifact.preview", root=str(project), path="build/문서.pdf")["result"]
    assert res == {"kind": "pdf"}
    missing = sidecar.call("artifact.preview", root=str(project), path="build/nope.md")
    assert missing["error"]["code"] == "not_found"
    escaped = sidecar.call("artifact.preview", root=str(project), path="../outside.md")
    assert escaped["error"]["code"] == "invalid_params"
    unsupported = sidecar.call("artifact.preview", root=str(project), path="project.json")
    assert unsupported["result"]["kind"] == "unavailable"


def test_artifact_preview_xlsx(sidecar, project):
    openpyxl = pytest.importorskip("openpyxl")
    (project / "build").mkdir(exist_ok=True)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "재무"
    ws["A1"] = "항목"
    ws["B1"] = "값"
    ws["A2"] = "매출"
    ws["B2"] = 42
    ws2 = wb.create_sheet("긴 시트")
    for r in range(1, 210):
        ws2.cell(row=r, column=1, value=r)
    wb.save(project / "build" / "재무.xlsx")
    res = sidecar.call("artifact.preview", root=str(project), path="build/재무.xlsx")["result"]
    assert res["kind"] == "xlsx"
    sheets = {s["name"]: s for s in res["sheets"]}
    assert sheets["재무"]["rows"][0] == ["항목", "값"]
    assert sheets["재무"]["rows"][1][1] == "42"
    assert sheets["긴 시트"]["truncated"] is True
    assert len(sheets["긴 시트"]["rows"]) == 200


@pytest.mark.skipif(sys.platform == "win32", reason="sh wrapper + select() on pipes")
def test_cancel_terminates_running_script(sidecar, project, tmp_path):
    # deps.ensure spawns `base_python gg_deps.py ensure <root>`; a wrapper that just sleeps stands in for it.
    wrapper = tmp_path / "slow-python"
    wrapper.write_text("#!/bin/sh\nexec sleep 30\n", encoding="utf-8")
    os.chmod(wrapper, 0o755)
    rid = sidecar.send("deps.ensure", root=str(project), base_python=str(wrapper))
    time.sleep(0.5)
    started = time.monotonic()
    sidecar.proc.stdin.write(json.dumps({"id": "c", "method": "cancel", "params": {"id": rid}}) + "\n")
    sidecar.proc.stdin.flush()
    r = sidecar.wait(rid, timeout=5)
    assert r["error"]["code"] == "cancelled", r
    assert time.monotonic() - started < 5


# 시험주행 발견 15 — 앱의 "논문 DOCX 만들기" 가 겉표지·인준서 없는 문서를 내놓던 길.
# 사이드카가 `body` 를 CLI 로 넘겨야 생성기가 앞머리를 붙이고 학생 본문을 싣는다.
def test_paper_generate_passes_body_through(sidecar, tmp_path, publication_skill):
    import json as _json
    from conftest import SCRIPTS as _S

    root = tmp_path / "proj"
    root.mkdir()
    r = subprocess.run(
        [sys.executable, str(_S / "gg.py"), "init", str(root)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    bind_test_major(root)
    (root / "build").mkdir(exist_ok=True)
    (root / "build" / "body.md").write_text(
        "Ⅰ. 머리말\n\n학생이 직접 쓴 본문.\n\nⅦ. 참고문헌\n\n없음.\n", encoding="utf-8"
    )
    (root / "spec.json").write_text(_json.dumps({
        "writing_year": 2026,
        "school_profile": {"mode": "school", "layout": "forms_1_to_4",
                           "title": "시험 논문", "author": "합성 작성자",
                           "department": "특용작물학과", "school": "한국농수산대학교"},
    }, ensure_ascii=False), encoding="utf-8")

    env = sidecar.ok("paper.generate", root=str(root), input="spec.json",
                     out="build/본문.md", body="build/body.md", major_id="specialty_crops")["result"]
    assert env["ok"] is True, env
    text = (root / "build" / "본문.md").read_text(encoding="utf-8")
    assert "겉표지" in text, "앞머리가 빠졌다 — 제출본이 아니다"
    assert "학생이 직접 쓴 본문." in text, "학생 본문이 실리지 않았다"
    assert "Ⅶ. 참고문헌" in text, "학생 목차가 잘렸다"


def test_paper_generate_refuses_a_body_outside_the_folder(sidecar, tmp_path):
    """폴더 밖 경로는 CLI 에 닿기 전에 막는다."""
    root = tmp_path / "proj2"
    root.mkdir()
    res = sidecar.call("paper.generate", root=str(root), input="spec.json",
                       out="build/본문.md", body="../../../남의논문.md")
    assert "error" in res, res
    assert res["error"]["code"] == "invalid_params", res
