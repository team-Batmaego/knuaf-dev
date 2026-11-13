"""§11 뷰어 직접 수정 시험 — sidecar `section.edit` 계열과 밀어내기 저장(§4-2·§5).

두 층으로 나눈다.
- 프로토콜 층: 진짜 sidecar 프로세스를 띄워 JSON-lines 로 부른다(배선·오류 코드 포함).
- 트랜잭션 층: `apply` 실패 갈래와 끼어들기 순서는 실제로 재현하기 어려워서 같은
  프로세스에서 `methods_edit` 의 저장 단계를 직접 몬다. 주입한 실패만 다르고 파일
  조작은 제품 코드 그대로다.
"""
import hashlib
import json
import os
import sys

import pytest

import gg_core as core
from conftest import END, REPO, START, write_section
from test_sidecar import Sidecar

SIDECAR_DIR = REPO / "app" / "sidecar"
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from knuaf_sidecar import methods_edit  # noqa: E402
from knuaf_sidecar.rpc import RpcError  # noqa: E402

BODY = "농장A의 재배 면적은 600평이다."
TYPED = "농장A의 재배 면적은 600평이에요."


@pytest.fixture
def sidecar():
    server = Sidecar()
    yield server
    server.close()


@pytest.fixture
def two_sections(project):
    """sec-01(내용) + sec-02(숫자만 있는 문단)."""
    _register_section(project, "sec-02", "sections/02.md", "Ⅱ. 본문", 2, "농장A는 600평 규모다.")
    return project


def _register_section(root, sid, rel, title, order, body):
    write_section(root, rel, title, body)
    p = core.load(root)
    core.apply(root, {
        "request_id": "test:section:" + sid,
        "ops": [{"collection": "sections", "value": {
            "id": sid, "title": title, "order": order, "path": rel, "status": "drafting",
        }}],
    }, p["revision"])


def _params(root, sid="sec-01", **extra):
    p = core.load(root)
    params = {
        "root": str(root),
        "id": sid,
        "expected_revision": p["revision"],
        "expected_draft_hash": p["sections"][sid]["draft_hash"],
    }
    params.update(extra)
    return params


def _edit(sidecar, root, sid="sec-01", before=BODY, after=TYPED, **extra):
    return sidecar.call("section.edit", **_params(root, sid, before_block=before, after_block=after, **extra))


def _ok(sidecar, root, sid="sec-01", before=BODY, after=TYPED, **extra):
    r = _edit(sidecar, root, sid, before, after, **extra)
    assert "result" in r, r.get("error")
    return r["result"]


def _code(r):
    return (r.get("error") or {}).get("code")


def _ledger(root):
    path = root / ".knuaf-gui" / "student-edits.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ── 프로토콜: 저장 성공 갈래 ───────────────────────────────────────────────


def test_methods_list_marks_only_saving_calls_as_write(sidecar):
    flags = {m["name"]: m["write"] for m in sidecar.ok("methods.list")["result"]}
    assert flags["section.edit"] is True
    assert flags["section.edit_batch"] is True
    # §4-5-1: 되돌리기는 v0.6.4에 없다 — 등록하지 않는다.
    assert "section.edit_undo" not in flags
    # 원장 읽기·표시는 정본을 안 건드린다 — AI 작업 중에도 불려야 한다(§5).
    assert flags["section.edits"] is False
    assert flags["section.edits_mark"] is False


def test_marker_manuscript_saves_the_block_and_keeps_the_envelope(sidecar, project):
    before_file = (project / "sections" / "01.md").read_bytes()
    loaded = core.load(project)
    result = _ok(sidecar, project)

    assert result["revision"] == loaded["revision"] + 1
    assert result["needs_check"] is False
    assert result["new_issues"] == []
    assert result["reviews_staled"] == 0
    assert result["recheck_before_submit"] is False
    text = (project / "sections" / "01.md").read_bytes()
    # 구획 밖은 한 바이트도 안 바뀐다 — 기대 바이트를 통째로 세워 둔다.
    assert text == ("# Ⅰ. 머리말\n\n%s\n%s\n%s\n" % (START, TYPED, END)).encode()
    assert before_file == ("# Ⅰ. 머리말\n\n%s\n%s\n%s\n" % (START, BODY, END)).encode()
    after = core.load(project)
    assert after["sections"]["sec-01"]["draft_hash"] == result["draft_hash"]
    assert core.draft((project / "sections" / "01.md").read_text(encoding="utf-8")) == TYPED


def test_legacy_draft_heading_manuscript_saves_without_touching_metadata(project, sidecar):
    rel = "sections/03.md"
    path = project / rel
    path.write_text(
        "# Ⅲ. 결론\n\n## DRAFT\n\n농장A의 재배 면적은 600평이다.\n\n## STATUS\n완료\n",
        encoding="utf-8",
    )
    p = core.load(project)
    core.apply(project, {"request_id": "test:legacy", "ops": [{"collection": "sections", "value": {
        "id": "sec-03", "title": "Ⅲ. 결론", "order": 3, "path": rel, "status": "drafting",
    }}]}, p["revision"])

    _ok(sidecar, project, "sec-03")
    text = path.read_text(encoding="utf-8")
    assert text == "# Ⅲ. 결론\n\n## DRAFT\n\n농장A의 재배 면적은 600평이에요.\n\n## STATUS\n완료\n"


def test_crlf_manuscript_keeps_crlf(sidecar, project):
    path = project / "sections" / "01.md"
    path.write_bytes(("# Ⅰ. 머리말\r\n\r\n%s\r\n%s\r\n%s\r\n" % (START, BODY, END)).encode())
    p = core.load(project)
    core.apply(project, {"request_id": "test:crlf", "ops": [{"collection": "sections", "value": {
        **dict(p["sections"]["sec-01"]),
    }}]}, p["revision"])

    _ok(sidecar, project)
    data = path.read_bytes()
    assert data == ("# Ⅰ. 머리말\r\n\r\n%s\r\n%s\r\n%s\r\n" % (START, TYPED, END)).encode()
    assert b"\n" not in data.replace(b"\r\n", b"")


# ── 프로토콜: 거절 갈래 ────────────────────────────────────────────────────


def test_a_block_absent_or_repeated_is_ambiguous(sidecar, project):
    before_file = (project / "sections" / "01.md").read_bytes()
    missing = _edit(sidecar, project, before="없는 문단입니다.", after="아무 문단.")
    assert _code(missing) == "ambiguous"

    path = project / "sections" / "01.md"
    doubled = "# Ⅰ. 머리말\n\n%s\n%s\n%s\n%s\n" % (START, BODY, BODY, END)
    path.write_text(doubled, encoding="utf-8")
    p = core.load(project)
    core.apply(project, {"request_id": "test:doubled", "ops": [{"collection": "sections", "value": {
        **dict(p["sections"]["sec-01"]),
    }}]}, p["revision"])
    twice = _edit(sidecar, project)
    assert _code(twice) == "ambiguous"
    assert path.read_text(encoding="utf-8") == doubled
    assert before_file  # 원본도 남아 있다


def test_revision_and_hash_mismatch_are_rejected(sidecar, project):
    stale = _edit(sidecar, project, expected_revision=0)
    assert _code(stale) == "stale_view"
    wrong_hash = _edit(sidecar, project, expected_draft_hash="0" * 64)
    assert _code(wrong_hash) == "stale_view"
    assert BODY in (project / "sections" / "01.md").read_text(encoding="utf-8")


def test_a_change_made_outside_the_app_is_not_adopted(sidecar, project):
    path = project / "sections" / "01.md"
    path.write_text("# Ⅰ. 머리말\n\n%s\n남이 쓴 글.\n%s\n" % (START, END), encoding="utf-8")
    r = _edit(sidecar, project)
    assert _code(r) == "draft_unregistered"
    assert "남이 쓴 글." in path.read_text(encoding="utf-8")


@pytest.mark.skipif(sys.platform == "win32", reason="윈도는 폴더 chmod(쓰기 금지)로 쓰기를 막지 않는다 — 폴더 권한으로 원장 쓰기 실패를 만들 수 없다")
def test_an_unwritable_ledger_stops_the_save_closed(sidecar, project, monkeypatch):
    holder = project / ".knuaf-gui"
    holder.mkdir(exist_ok=True)
    before_file = (project / "sections" / "01.md").read_bytes()
    holder.chmod(0o500)
    try:
        r = _edit(sidecar, project)
    finally:
        holder.chmod(0o700)
    assert _code(r) == "ledger_unreadable"
    assert (project / "sections" / "01.md").read_bytes() == before_file


# ── 확인 필요 판정 ─────────────────────────────────────────────────────────


def test_a_number_change_needs_a_check(sidecar, two_sections):
    result = _ok(sidecar, two_sections, "sec-02", "농장A는 600평 규모다.", "농장A는 700평 규모다.")
    assert result["needs_check"] is True
    states = [row["state"] for row in _ledger(two_sections) if row["edit_id"] == result["edit_id"]]
    assert states[-1] == "pending"


def _claim_project(project):
    """sec-01 주장 한 건: 인용문이 본문에 그대로 있다."""
    body = "농장A의 재배 면적은 600평이다. 수확은 감소했다."
    write_section(project, "sections/01.md", "Ⅰ. 머리말", body)
    p = core.load(project)
    record = dict(p["sections"]["sec-01"])
    record["claims"] = [{
        "fact_id": "fact-area", "field_id": "farm.area", "kind": "reported_fact",
        "value": "600", "unit": "평", "period": "2026", "scope": "농장A",
        "quote": "농장A의 재배 면적은 600평이다.",
    }]
    core.apply(project, {"request_id": "test:claims", "ops": [
        {"collection": "sections", "value": record},
    ]}, p["revision"])
    return project


def test_editing_the_claim_quote_needs_a_check_and_names_claim_location(sidecar, project):
    root = _claim_project(project)
    p = core.load(root)
    assert not [r for r in core.checks(root, p) if r["check_id"] == "claim_location"]

    result = _ok(sidecar, root, before="농장A의 재배 면적은 600평이다.",
                 after="농장B의 재배 면적은 600평이다.")
    assert result["needs_check"] is True
    assert "claim_location" in {issue["check_id"] for issue in result["new_issues"]}

    listed = {row["edit_id"]: row for row in sidecar.ok("section.edits", root=str(root))["result"]["edits"]}
    remaining = {i["check_id"] for i in listed[result["edit_id"]]["remaining_issues"]}
    assert "claim_location" in remaining


def test_a_word_change_beside_the_quote_still_needs_a_check(sidecar, project):
    root = _claim_project(project)
    result = _ok(sidecar, root, before="농장A의 재배 면적은 600평이다. 수확은 감소했다.",
                 after="농장A의 재배 면적은 600평이다. 수확은 증가했다.")
    # 인용문은 그대로지만 같은 문단(근거 판단 단위)을 고쳤다.
    assert result["needs_check"] is True
    assert result["new_issues"] == []


def test_a_typo_on_a_reviewed_section_stays_plain_but_flags_recheck(sidecar, project):
    _register_review(project)
    result = _ok(sidecar, project)
    assert result["needs_check"] is False
    assert result["reviews_staled"] == 1
    assert result["recheck_before_submit"] is True
    review = core.load(project)["reviews"]["rev-01"]
    assert review["stale"] is True


def _register_review(root):
    (root / "reviews").mkdir(exist_ok=True)
    (root / "reviews" / "r1.md").write_text("# 검토\n문제 없음\n", encoding="utf-8")
    p = core.load(root)
    refs = [{"collection": "sections", "id": "sec-01"}]
    core.apply(root, {"request_id": "test:review", "ops": [{"collection": "reviews", "value": {
        "id": "rev-01", "review_kind": "content", "author_id": "author-x", "reviewer_id": "reviewer-y",
        "target_refs": refs, "input_fingerprint": core.fingerprint(root, p, refs),
        "findings": [], "disposition": "resolved", "status": "pass", "path": "reviews/r1.md",
        "coverage": [{"axis": "content", "locator": "전체"}],
    }}]}, p["revision"])


def test_a_stale_review_blocks_the_submission_candidate(sidecar, project):
    _register_review(project)
    assert not [r for r in core.gate(project, core.load(project)) if r["check_id"] == "review_content"]
    _ok(sidecar, project)
    p = core.load(project)
    assert p["reviews"]["rev-01"]["stale"] is True
    blocked = [r for r in core.gate(project, p) if r["check_id"] == "review_content"]
    assert blocked and {r["status"] for r in blocked} == {"blocked"}


def test_only_a_dependency_revision_does_not_need_a_check(sidecar, two_sections):
    p = core.load(two_sections)
    record = dict(p["sections"]["sec-02"])
    record["depends_on"] = [{"collection": "sections", "id": "sec-01",
                             "revision": p["sections"]["sec-01"]["revision"]}]
    core.apply(two_sections, {"request_id": "test:depends", "ops": [
        {"collection": "sections", "value": record},
    ]}, p["revision"])

    result = _ok(sidecar, two_sections, "sec-01")
    assert [i["check_id"] for i in result["new_issues"]] == ["dependency_revision"]
    assert result["needs_check"] is False
    assert result["recheck_before_submit"] is True
    # 개정 하나로 저장되고, 말없이 막히지 않도록 재검토 신호를 함께 준다.
    assert result["revision"] == p["revision"] + 2


# ── 원장·되돌리기 ──────────────────────────────────────────────────────────


def test_undo_is_not_available_in_this_release(sidecar, project):
    """§4-5-1: 되돌리기를 뺐다 — 잘못 고쳤으면 그 문장을 다시 고친다."""
    first = _ok(sidecar, project)
    r = sidecar.call("section.edit_undo", root=str(project), edit_id=first["edit_id"],
                     expected_revision=first["revision"])
    assert _code(r) == "not_found"
    # 그 문장을 다시 드래그해 고치는 길은 그대로다.
    again = _ok(sidecar, project, before=TYPED, after=BODY)
    assert again["revision"] == first["revision"] + 1
    assert BODY in (project / "sections" / "01.md").read_text(encoding="utf-8")


def test_sent_alone_does_not_clear_the_mark_until_the_turn_ends(sidecar, project):
    first = _ok(sidecar, project)
    marked = sidecar.ok("section.edits_mark", root=str(project),
                        edit_ids=[first["edit_id"]], state="sent")["result"]
    assert marked["state"] == "sent"
    row = _find(sidecar, project, first["edit_id"])
    assert row["state"] == "sent" and row["answered"] is False

    sidecar.ok("section.edits_mark", root=str(project),
               edit_ids=[first["edit_id"]], state="sent", turn_done=True)
    assert _find(sidecar, project, first["edit_id"])["answered"] is True


def _find(sidecar, root, edit_id):
    rows = sidecar.ok("section.edits", root=str(root))["result"]["edits"]
    return next(row for row in rows if row["edit_id"] == edit_id)


def test_a_confirmed_request_without_a_ledger_row_is_revived_as_lost(sidecar, project):
    first = _ok(sidecar, project)
    (project / ".knuaf-gui" / "student-edits.jsonl").unlink()
    rows = sidecar.ok("section.edits", root=str(project))["result"]["edits"]
    lost = [row for row in rows if row.get("lost_record")]
    assert len(lost) == 1
    assert lost[0]["edit_id"].startswith(methods_edit.REQUEST_PREFIX)
    assert lost[0]["state"] == "pending" and lost[0]["needs_check"] is True
    assert lost[0]["revision_after"] == first["revision"]
    assert lost[0]["section_ids"] == ["sec-01"]


def test_a_broken_ledger_line_is_skipped_not_erased(sidecar, project):
    first = _ok(sidecar, project)
    path = project / ".knuaf-gui" / "student-edits.jsonl"
    path.write_text(path.read_text(encoding="utf-8") + "{깨진 줄\n", encoding="utf-8")
    rows = sidecar.ok("section.edits", root=str(project))["result"]["edits"]
    assert [row["edit_id"] for row in rows] == [first["edit_id"]]
    assert "{깨진 줄" in path.read_text(encoding="utf-8")


# ── 묶음 저장 ──────────────────────────────────────────────────────────────


def test_batch_saves_several_sections_in_one_revision(sidecar, two_sections):
    p = core.load(two_sections)
    r = sidecar.ok("section.edit_batch", root=str(two_sections), expected_revision=p["revision"], edits=[
        {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED,
         "expected_draft_hash": p["sections"]["sec-01"]["draft_hash"]},
        {"section_id": "sec-02", "before_block": "농장A는 600평 규모다.",
         "after_block": "농장A는 700평 규모다.",
         "expected_draft_hash": p["sections"]["sec-02"]["draft_hash"]},
    ])["result"]
    assert r["revision"] == p["revision"] + 1
    assert TYPED in (two_sections / "sections" / "01.md").read_text(encoding="utf-8")
    assert "700평" in (two_sections / "sections" / "02.md").read_text(encoding="utf-8")

    # 되돌리기는 없다(§4-5-1) — 두 장을 다시 고쳐 되돌린다.
    back = sidecar.ok("section.edit_batch", root=str(two_sections), expected_revision=r["revision"], edits=[
        {"section_id": "sec-01", "before_block": TYPED, "after_block": BODY},
        {"section_id": "sec-02", "before_block": "농장A는 700평 규모다.",
         "after_block": "농장A는 600평 규모다."},
    ])["result"]
    assert back["revision"] == r["revision"] + 1
    assert BODY in (two_sections / "sections" / "01.md").read_text(encoding="utf-8")
    assert "600평" in (two_sections / "sections" / "02.md").read_text(encoding="utf-8")


def test_batch_undo_is_gone_and_a_partly_changed_batch_cannot_be_reverted(sidecar, two_sections):
    """되돌리기가 없으므로 '묶음 되돌리기' 계약도 없다 — 한 장만 다시 고쳐 되돌린다."""
    p = core.load(two_sections)
    r = sidecar.ok("section.edit_batch", root=str(two_sections), expected_revision=p["revision"], edits=[
        {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
        {"section_id": "sec-02", "before_block": "농장A는 600평 규모다.",
         "after_block": "농장A는 700평 규모다."},
    ])["result"]
    again = _ok(sidecar, two_sections, "sec-02", "농장A는 700평 규모다.", "농장A는 800평 규모다.")
    gone = sidecar.call("section.edit_undo", root=str(two_sections), edit_id=r["edit_id"],
                        expected_revision=again["revision"])
    assert _code(gone) == "not_found"
    assert "800평" in (two_sections / "sections" / "02.md").read_text(encoding="utf-8")


def test_batch_rolls_back_everything_when_one_edit_is_ambiguous(sidecar, two_sections):
    before = {rel: (two_sections / rel).read_bytes() for rel in ("sections/01.md", "sections/02.md")}
    p = core.load(two_sections)
    r = sidecar.call("section.edit_batch", root=str(two_sections), expected_revision=p["revision"], edits=[
        {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
        {"section_id": "sec-02", "before_block": "없는 문단.", "after_block": "아무 문단."},
    ])
    assert _code(r) == "ambiguous"
    assert {rel: (two_sections / rel).read_bytes() for rel in before} == before
    assert core.load(two_sections)["revision"] == p["revision"]
    assert _ledger(two_sections) == []


def test_batch_rejects_the_same_block_twice(sidecar, two_sections):
    p = core.load(two_sections)
    r = sidecar.call("section.edit_batch", root=str(two_sections), expected_revision=p["revision"], edits=[
        {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
        {"section_id": "sec-01", "before_block": BODY, "after_block": "다른 문단."},
    ])
    assert _code(r) == "invalid_params"
    assert core.load(two_sections)["revision"] == p["revision"]


def test_the_same_request_twice_lands_once(sidecar, project):
    p = core.load(project)
    params = _params(project, before_block=BODY, after_block=TYPED)
    first = sidecar.ok("section.edit", **params)["result"]
    again = sidecar.ok("section.edit", **params)["result"]
    assert again["edit_id"] == first["edit_id"] and again["replayed"] is True
    assert again["revision"] == first["revision"]
    assert core.load(project)["revision"] == p["revision"] + 1
    assert len([row for row in _ledger(project) if row["state"] in ("plain", "pending")]) == 1


# ── 트랜잭션: apply 실패 세 갈래 ───────────────────────────────────────────


def _call_edit(root, sid="sec-01", before=BODY, after=TYPED):
    return methods_edit.section_edit(None, _params(root, sid, before_block=before, after_block=after))


def _op_error(state):  # 공개 계약 모양 그대로
    return core.OperationError({
        "operation": "apply", "target": "canonical", "commit_state": state,
        "reason": "invalid_change", "cleanup_errors": [],
    })


def test_not_committed_restores_the_manuscript(project, monkeypatch):
    path = project / "sections" / "01.md"
    original = path.read_bytes()
    revision = core.load(project)["revision"]
    monkeypatch.setattr(core, "apply", lambda root, change, rev: (_ for _ in ()).throw(_op_error("not_committed")))
    with pytest.raises(RpcError) as caught:
        _call_edit(project)
    assert caught.value.code == "edit_failed"
    assert path.read_bytes() == original
    assert core.load(project)["revision"] == revision
    states = [row["state"] for row in _ledger(project)]
    assert states[0] == "writing" and states[-1] == "aborted"


def test_committed_cleanup_pending_is_success_with_a_warning(project, monkeypatch):
    original = (project / "sections" / "01.md").read_bytes()
    real = core.apply

    def applied_then_failed(root, change, rev):
        real(root, change, rev)
        raise _op_error("committed_cleanup_pending")

    monkeypatch.setattr(core, "apply", applied_then_failed)
    result = _call_edit(project)
    assert result["revision"] == 2
    assert "cleanup_warning" in result
    assert TYPED in (project / "sections" / "01.md").read_text(encoding="utf-8")
    # 확정(_cleanup_pending)은 보존 폴더를 지우지 않는다 — 실패 원인을 남겨 둔다(§4-2 7).
    # 파일 이름은 절 ID 대신 순번이다(§4-4-1).
    backups = list((project / ".knuaf-gui" / "edit-backup").glob("*/displaced-1-0"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original


def test_indeterminate_but_mine_keeps_the_new_text(project, monkeypatch):
    real = core.apply

    def applied_then_failed(root, change, rev):
        real(root, change, rev)
        raise _op_error("indeterminate")

    monkeypatch.setattr(core, "apply", applied_then_failed)
    result = _call_edit(project)
    assert result["revision"] == 2
    assert "cleanup_warning" in result
    assert TYPED in (project / "sections" / "01.md").read_text(encoding="utf-8")


def test_indeterminate_and_not_mine_restores(project, monkeypatch):
    path = project / "sections" / "01.md"
    original = path.read_bytes()
    monkeypatch.setattr(core, "apply", lambda root, change, rev: (_ for _ in ()).throw(_op_error("indeterminate")))
    with pytest.raises(RpcError) as caught:
        _call_edit(project)
    assert caught.value.code == "edit_failed"
    assert path.read_bytes() == original


def test_indeterminate_and_unreadable_leaves_the_files_alone(project, monkeypatch):
    params = _params(project, before_block=BODY, after_block=TYPED)
    real_load = core.load
    calls = {"n": 0}

    def flaky(root):
        calls["n"] += 1
        if calls["n"] > 1:
            raise OSError("읽을 수 없음")
        return real_load(root)

    monkeypatch.setattr(core, "load", flaky)
    monkeypatch.setattr(core, "apply", lambda root, change, rev: (_ for _ in ()).throw(_op_error("indeterminate")))
    with pytest.raises(RpcError) as caught:
        methods_edit.section_edit(None, params)
    assert caught.value.code == "indeterminate"
    text = (project / "sections" / "01.md").read_text(encoding="utf-8")
    assert TYPED in text  # 되돌리지 않는다 — 판정 불가에 손대지 않는 쪽이 안전하다
    assert [row["state"] for row in _ledger(project)] == ["writing"]


# ── 트랜잭션: 끼어들기 세 순서에서 지워지는 바이트가 없다 ─────────────────


def _record(root, data, n=0):
    path = root / "sections" / "01.md"
    raw = path.read_bytes()
    return {
        "n": n,
        "section_id": "sec-01",
        "path": path,
        "rel": "sections/01.md",
        "raw": raw,
        "new": data,
        "mode": path.stat().st_mode & 0o7777,
        "sha_a": hashlib.sha256(raw).hexdigest(),
        "sha_c": hashlib.sha256(data).hexdigest(),
    }


def _backup(root, name="t1"):
    bundle = root / ".knuaf-gui" / "edit-backup" / name
    bundle.mkdir(parents=True, exist_ok=True)
    return bundle


def _new_file(bundle, record):
    (bundle / ("new-%d" % record["n"])).write_bytes(record["new"])


def test_place_never_overwrites_an_existing_file(project):
    path = project / "sections" / "01.md"
    original = path.read_bytes()
    bundle = _backup(project)
    record = _record(project, b"new bytes")
    _new_file(bundle, record)
    with pytest.raises(FileExistsError):
        methods_edit._place(path, bundle / "new-0")
    assert path.read_bytes() == original


def test_an_outside_writer_before_displacement_is_preserved(project):
    record = _record(project, b"C\n")
    bundle = _backup(project)
    _new_file(bundle, record)
    stray = b"B: outside writer\n"
    (project / "sections" / "01.md").write_bytes(stray)

    with pytest.raises(RpcError) as caught:
        methods_edit._store_file(bundle, record)
    assert caught.value.code == "stale_view"
    methods_edit._revert([record], bundle)
    # 4-4-2 '비어 있음': 밀어낸 그 글이 그대로 제자리로 돌아온다(보존 이름은 뗀다).
    assert (project / "sections" / "01.md").read_bytes() == stray
    assert not (bundle / "displaced-1-0").exists()


def test_an_outside_writer_between_verify_and_place_is_preserved(project, monkeypatch):
    record = _record(project, b"C\n")
    bundle = _backup(project)
    _new_file(bundle, record)
    stray = b"B: slipped in between\n"
    real_place = methods_edit._place

    def place_with_interloper(path, src):
        path.write_bytes(stray)  # 확인과 놓기 사이에 남이 쓴 글
        return real_place(path, src)

    monkeypatch.setattr(methods_edit, "_place", place_with_interloper)
    with pytest.raises(RpcError) as caught:
        methods_edit._store_file(bundle, record)
    assert caught.value.code == "stale_view"
    monkeypatch.undo()
    methods_edit._revert([record], bundle)
    # 4-4-2 '파일이 있음': 그 글이 C 가 아니므로 그것을 제자리에 돌려놓고 A 는 보관한다.
    assert (project / "sections" / "01.md").read_bytes() == stray
    assert (bundle / "displaced-1-0").read_bytes() == record["raw"]


def test_an_outside_writer_after_place_is_preserved(project):
    record = _record(project, b"C\n")
    bundle = _backup(project)
    _new_file(bundle, record)
    methods_edit._store_file(bundle, record)
    assert (project / "sections" / "01.md").read_bytes() == b"C\n"
    stray = b"B: last writer wins\n"
    (project / "sections" / "01.md").write_bytes(stray)

    methods_edit._revert([record], bundle)  # apply 가 개정 불일치로 거절한 상황
    assert (project / "sections" / "01.md").read_bytes() == stray
    assert (bundle / "displaced-1-0").read_bytes() == record["raw"]


def test_a_folder_that_cannot_place_without_overwriting_refuses_the_save(project, monkeypatch):
    path = project / "sections" / "01.md"
    original = path.read_bytes()

    def no_link(src, dst):
        raise OSError(1, "하드 링크를 쓸 수 없음")

    monkeypatch.setattr(methods_edit.os, "link", no_link)
    with pytest.raises(RpcError) as caught:
        _call_edit(project)
    assert caught.value.code == "edit_failed"
    assert path.read_bytes() == original
    assert not [n for n in path.parent.iterdir() if n.name.startswith(".gg-edit-")]
    assert core.load(project)["revision"] == 1


def test_check_keys_keeps_every_target_shape():
    """§4-2 5: 절 ID 로 좁히면 `body`·규칙 ID 대상 문제를 놓친다."""

    class Fake:
        @staticmethod
        def checks(root, p):
            return [
                {"check_id": "draft_claim", "target": "sec-01", "reason": "r1"},
                {"check_id": "finance_gate", "target": "body", "reason": "r2"},
                {"check_id": "rule_location", "target": "rule-9", "reason": "r3"},
            ]

    assert methods_edit._check_keys(Fake, None, {}) == {
        ("draft_claim", "sec-01", "r1"),
        ("finance_gate", "body", "r2"),
        ("rule_location", "rule-9", "r3"),
    }


def test_a_failure_mid_displacement_leaves_every_manuscript_alone(two_sections, monkeypatch):
    before = {rel: (two_sections / rel).read_bytes() for rel in ("sections/01.md", "sections/02.md")}
    real = methods_edit._displace
    calls = {"n": 0}

    def flaky(path, dest):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(5, "이름 바꾸기 실패")
        real(path, dest)

    monkeypatch.setattr(methods_edit, "_displace", flaky)
    p = core.load(two_sections)
    with pytest.raises(RpcError) as caught:
        methods_edit.section_edit_batch(None, {
            "root": str(two_sections),
            "expected_revision": p["revision"],
            "edits": [
                {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
                {"section_id": "sec-02", "before_block": "농장A는 600평 규모다.",
                 "after_block": "농장A는 700평 규모다."},
            ],
        })
    assert caught.value.code == "edit_failed"
    assert {rel: (two_sections / rel).read_bytes() for rel in before} == before
    assert core.load(two_sections)["revision"] == p["revision"]


# ── 트랜잭션: 구획 경계는 `draft()` 와 같다 ────────────────────────────────


@pytest.mark.parametrize("text", [
    "# Ⅰ. 머리말\n\n%s\n본문 한 줄.\n%s\n" % (START, END),
    "# Ⅰ. 머리말\n\n## DRAFT\n\n본문 한 줄.\n\n## STATUS\n완료\n",
    "제목 없는 구형 원고\n\n본문 한 줄.\n",
])
def test_draft_span_matches_draft_for_every_manuscript_shape(text):
    start, end = methods_edit._draft_span(core, text)
    assert text[start:end].strip() == core.draft(text)


# ── Roh 1회째 반례 뒤집기 (§4-4-7 기대 결과 · §4-4-8 10) ───────────────────


def _has_bytes(root, needle):
    return any(needle in path.read_bytes() for path in root.rglob("*") if path.is_file())


@pytest.mark.parametrize("failure", ["occupied", "disk_full"])
def test_review_batch_failure_preserves_external_update(two_sections, monkeypatch, failure):
    """Roh 차단 1 — 묶음 둘째 파일에서 실패해도 손댄 첫 파일 자리의 남의 글 B1 은 남는다."""
    root = two_sections
    first = root / "sections" / "01.md"
    second = root / "sections" / "02.md"
    outsider = b"UNIQUE_EXTERNAL_STUDENT_UPDATE_B1"
    real_place = methods_edit._place
    injected = False

    def place(path, src):
        nonlocal injected
        if path == second and not injected:
            injected = True
            first.write_bytes(outsider)
            if failure == "occupied":
                second.write_bytes(b"UNIQUE_EXTERNAL_STUDENT_UPDATE_B2")
                raise FileExistsError("review: second path now occupied")
            raise OSError(28, "review: disk full")
        return real_place(path, src)

    monkeypatch.setattr(methods_edit, "_place", place)
    p = core.load(root)
    with pytest.raises(RpcError):
        methods_edit.section_edit_batch(None, {
            "root": str(root), "expected_revision": p["revision"],
            "edits": [
                {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
                {"section_id": "sec-02", "before_block": "농장A는 600평 규모다.",
                 "after_block": "농장A는 700평 규모다."},
            ],
        })
    assert injected
    # 기대(§4-4-7 1): 남의 글은 자리에 그대로, 원래 글 A1 은 보존 폴더에 보관·알림.
    assert first.read_bytes() == outsider
    assert _has_bytes(root, outsider)
    assert any(row["state"] == "aborted" for row in _ledger(root))
    backups = list((root / ".knuaf-gui" / "edit-backup").glob("*/displaced-1-*"))
    assert backups, "감춰 둔 원래 글이 보존 폴더에 남아야 한다"


def _expect_open_handle_refusal(root, path, original):
    """열린 핸들 때문에 저장이 거절됐을 때의 사실 — 원고 자리는 A 그대로다.

    윈도는 열려 있는 파일의 이름 바꾸기를 거절한다(WinError 32). 거절은 첫 밀어내기에서
    나므로 `core.apply` 단계(외부 글 B 를 쓰는 자리)에 닿지 않는다 — B 가 남는지가 아니라
    **원고를 건드리지 않았는지**를 확인한다. 개정 번호와 원장 끝줄도 함께 본다.
    """
    revision_before = core.load(root)["revision"]
    with path.open("r+b"):  # 다른 프로그램이 원고를 열어 둔 상태
        with pytest.raises(RpcError) as refused:
            methods_edit.section_edit(None, _params(root, before_block=BODY, after_block=TYPED))
    assert refused.value.code == "edit_failed"
    assert core.load(root)["revision"] == revision_before
    assert [row["state"] for row in _ledger(root)][-1] == "aborted"
    assert path.read_bytes() == original


def test_review_success_preserves_preopened_writer(two_sections, monkeypatch):
    """Roh 차단 2 — 성공한 저장이 미리 열어 둔 핸들이 쓴 B 를 지우지 않는다.

    맥: 저장은 끝나고, 그 핸들이 쓴 B 는 밀려난 원본 자리(보존 폴더)에 남는다.
    윈도: 저장은 첫 이름 바꾸기에서 `edit_failed` 로 닫히고 원고 A 는 손대지 않은 채 남는다
    — 어느 쪽도 남의 글을 지우지 않는다.
    """
    root = two_sections
    path = root / "sections" / "01.md"
    outsider = b"UNIQUE_PREOPENED_HANDLE_STUDENT_UPDATE_B"
    original = path.read_bytes()

    if sys.platform == "win32":
        _expect_open_handle_refusal(root, path, original)
        return

    real_apply = core.apply
    clock = {"n": 0}
    with path.open("r+b") as external:
        def apply(root_arg, change, expected):
            with external as handle:
                if clock["n"] == 0:
                    clock["n"] = 1
                    handle.seek(0)
                    handle.write(outsider)
                    handle.truncate()
                    handle.flush()
                    os.fsync(handle.fileno())
            return real_apply(root_arg, change, expected)

        monkeypatch.setattr(core, "apply", apply)
        result = methods_edit.section_edit(None, _params(root, before_block=BODY, after_block=TYPED))
        # 청소는 그 자리에서 돌지 않는다(10분 규칙) — 보존본에 B 가 남아 있어야 한다.
        assert result["revision"] == core.load(root)["revision"]
    assert _has_bytes(root, outsider), "저장이 미리 열어 둔 핸들의 글을 지웠다"


@pytest.mark.skipif(sys.platform == "win32", reason="실기기에서는 원래 윈도 갈래가 돈다")
def test_review_winerror_32_at_move_keeps_manuscript_untouched(two_sections, monkeypatch):
    """윈도 갈래를 맥에서도 밟는다 — 밀어내기가 WinError 32 로 거절되면 원고는 A 그대로.

    실기기 없이 윈도 조건을 만드는 주입이다: 플랫폼을 win32 로 두고 `_displace` 만 공유
    위반으로 실패시킨다. 저장·원복 코드는 제품 그대로다.
    """
    root = two_sections
    path = root / "sections" / "01.md"
    original = path.read_bytes()

    def displace(source, dest):
        error = PermissionError(13, "WinError 32: 다른 프로세스가 파일을 쓰고 있음")
        error.winerror = 32
        raise error

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(methods_edit, "_displace", displace)
    _expect_open_handle_refusal(root, path, original)


def test_review_refused_at_move_keeps_external_update(two_sections, monkeypatch):
    """§4-4-1 — 원고를 옮기기 직전에 남이 쓴 B 는 거절 뒤에도 지워지지 않는다.

    옮기기 직전은 맥과 윈도가 함께 지나는 마지막 지점이다(윈도는 바로 그 옮기기에서
    거절한다). 그 순간 B 가 자리에 생겼다면 지문이 어긋나 저장은 `stale_view` 로 닫히고,
    되돌리기는 B 를 자리에 그대로 놓는다.
    """
    root = two_sections
    path = root / "sections" / "01.md"
    outsider = b"UNIQUE_EXTERNAL_STUDENT_UPDATE_AT_MOVE_B"
    revision_before = core.load(root)["revision"]
    real_displace = methods_edit._displace
    injected = False

    def displace(source, dest):
        nonlocal injected
        if source == path and not injected:
            injected = True
            path.write_bytes(outsider)  # 옮기기 직전에 다른 프로그램이 쓴 글
        return real_displace(source, dest)

    monkeypatch.setattr(methods_edit, "_displace", displace)
    with pytest.raises(RpcError) as refused:
        methods_edit.section_edit(None, _params(root, before_block=BODY, after_block=TYPED))
    assert injected
    assert refused.value.code == "stale_view"
    # 남의 글은 자리에 그대로 돌아온다 — 덮어쓰지도 지우지도 않는다.
    assert path.read_bytes() == outsider
    assert _has_bytes(root, outsider)
    assert core.load(root)["revision"] == revision_before
    assert [row["state"] for row in _ledger(root)][-1] == "aborted"


def test_review_disk_full_restore_never_leaves_partial_manuscript(two_sections, monkeypatch):
    """Roh 차단 3 — 되돌리기가 실패하면 원고 자리는 전체 아니면 없음, 알림이 남는다."""
    root = two_sections
    path = root / "sections" / "01.md"
    original = path.read_bytes()

    def no_restore(path_arg, src):
        raise OSError(28, "review: disk full while restoring")

    # 놓기는 성공하고(원고 자리에서만) 되돌리기(이름 걸기)만 실패하는 경우 — 자리는 비고 글이
    # 보존 폴더에 통째로 있다. 저장 전 시험(probe)은 정상이어야 그 자리에 닿는다.
    real_place = methods_edit._place

    def place(target, src):
        if target == path:
            raise OSError(28, "review: disk full")
        return real_place(target, src)

    monkeypatch.setattr(methods_edit, "_restore_noclobber", no_restore)
    monkeypatch.setattr(methods_edit, "_place", place)
    with pytest.raises(RpcError) as pending:
        _call_edit(root)
    assert pending.value.code == "restore_pending"
    # 원고 자리는 통째로 있거나 비어 있다 — 반쪽(A1:)이면 안 된다.
    assert not path.exists() or path.read_bytes() == original
    assert pending.value.data["backup"]
    # 줄은 `writing` 그대로 남고, 목록은 그것을 숨기지 않고 알린다.
    assert [row["state"] for row in _ledger(root)][-1] == "writing"
    listed = methods_edit.section_edits(None, {"root": str(root)})
    assert any(n["kind"] == "restore_pending" for n in listed["notices"])


def test_review_process_exit_restores_or_exposes_interrupted_edit(tmp_path):
    """Roh 차단 4 — 밀어낸 직후 꺼져도 다음 입구가 원고 자리를 채운다."""
    import subprocess

    from conftest import SCRIPTS, write_section

    root = tmp_path / "crash"
    root.mkdir()
    core.init(root)
    write_section(root, "sections/01.md", "Ⅰ. 머리말", BODY)
    p = core.load(root)
    core.apply(root, {"request_id": "test:crash", "ops": [{"collection": "sections", "value": {
        "id": "sec-01", "title": "Ⅰ. 머리말", "order": 1, "path": "sections/01.md",
        "status": "drafting",
    }}]}, p["revision"])
    code = (
        "import os\n"
        "from pathlib import Path\n"
        "import gg_core as core\n"
        "from knuaf_sidecar import methods_edit\n"
        "root = Path(os.environ['CRASH_ROOT'])\n"
        "p = core.load(root)\n"
        "real = methods_edit._displace\n"
        "def stop(path, dest):\n"
        "    real(path, dest)\n"
        "    os._exit(73)\n"
        "methods_edit._displace = stop\n"
        "methods_edit.section_edit(None, {'root': str(root), 'id': 'sec-01',\n"
        "    'expected_revision': p['revision'],\n"
        "    'expected_draft_hash': p['sections']['sec-01']['draft_hash'],\n"
        "    'before_block': %r, 'after_block': %r})\n" % (BODY, TYPED)
    )
    proc = subprocess.run([sys.executable, "-c", code], env={
        **os.environ, "CRASH_ROOT": str(root),
        "PYTHONPATH": str(SCRIPTS) + os.pathsep + str(SIDECAR_DIR),
    }, check=False)
    assert proc.returncode == 73
    assert not (root / "sections" / "01.md").exists()  # 자리가 비었다
    listed = methods_edit.section_edits(None, {"root": str(root)})
    # 첫 입구가 §4-4-3 표 둘째 줄대로 되돌린다.
    assert (root / "sections" / "01.md").read_bytes() == original_bytes(root)
    assert any(n["kind"] == "restored" for n in listed["notices"])
    assert [row["state"] for row in _ledger(root)][-1] == "aborted"


def original_bytes(root):
    from conftest import END, START

    return ("# Ⅰ. 머리말\n\n%s\n%s\n%s\n" % (START, BODY, END)).encode()


def test_review_ledger_symlink_cannot_write_outside_the_project(tmp_path):
    """Roh 중요 5 — 원장이 바로가기면 논문 폴더 밖 파일에 쓰지 않고 거절한다."""
    root = tmp_path / "project"
    root.mkdir()
    target = tmp_path / "outside-protected.txt"
    original = b"Outside project data.\n"
    target.write_bytes(original)
    app_dir = root / ".knuaf-gui"
    app_dir.mkdir()
    try:
        (app_dir / "student-edits.jsonl").symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("이 파일 시스템은 바로가기를 만들지 못한다")
    with pytest.raises(RpcError) as caught:
        methods_edit._append_ledger(root, {"edit_id": "edit-review", "state": "writing"})
    assert caught.value.code == "ledger_unreadable"
    assert target.read_bytes() == original


def test_review_symlinked_app_folder_is_refused(tmp_path):
    """§4-4-8 8 — 앱 폴더 자체가 바로가기여도 거절한다."""
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "project2"
    root.mkdir()
    try:
        (root / ".knuaf-gui").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("이 파일 시스템은 바로가기를 만들지 못한다")
    with pytest.raises(RpcError) as caught:
        methods_edit._backup_root(root)
    assert caught.value.code == "ledger_unreadable"
    assert not list(outside.iterdir())


# ── 단계별 종료 → 복구가 §4-4-3 표와 같은 끝을 낸다 (§4-4-8 10) ──────────

CRASH_SCRIPT = '''
import os
from pathlib import Path
import gg_core as core
from knuaf_sidecar import methods_edit as m

root = Path(os.environ["CRASH_ROOT"])
stage = os.environ["CRASH_STAGE"]

def die(*_args, **_kwargs):
    os._exit(73)

def wrap(name, before=None):
    real = getattr(m, name)
    def inner(*args, **kwargs):
        # 저장 전 시험(⓪)은 그대로 통과시킨다 — 죽는 자리는 실제 저장 단계다.
        first = args[0] if args else None
        if first is not None and ".gg-" in Path(str(first)).name:
            return real(*args, **kwargs)
        if before is not None:
            before(*args, **kwargs)
        real(*args, **kwargs)
        os._exit(73)
    setattr(m, name, inner)

if stage == "01_new_file":
    wrap("_write_backup")
elif stage == "02_ledger":
    wrap("_append_ledger")
elif stage == "03_displace":
    wrap("_displace")
elif stage == "03_place":
    wrap("_place")
elif stage == "04_apply":
    real_apply = core.apply
    def stop(root_arg, change, expected):
        real_apply(root_arg, change, expected)
        os._exit(73)
    core.apply = stop
elif stage == "05_confirm":
    wrap("_mark_undone") if os.environ.get("CRASH_UNDO") else None
    if not os.environ.get("CRASH_UNDO"):
        wrap("_row")

p = core.load(root)
if os.environ.get("CRASH_UNDO"):
    m.section_edit_undo(None, {"root": str(root), "edit_id": os.environ["CRASH_EDIT"],
                               "expected_revision": p["revision"]})
else:
    m.section_edit(None, {"root": str(root), "id": "sec-01",
                          "expected_revision": p["revision"],
                          "expected_draft_hash": p["sections"]["sec-01"]["draft_hash"],
                          "before_block": os.environ["CRASH_BEFORE"],
                          "after_block": os.environ["CRASH_AFTER"]})
'''


def _crash_project(tmp_path, name="crash"):
    from conftest import write_section

    root = tmp_path / name
    root.mkdir()
    core.init(root)
    write_section(root, "sections/01.md", "Ⅰ. 머리말", BODY)
    write_section(root, "sections/02.md", "Ⅱ. 본문", "농장A는 600평 규모다.")
    p = core.load(root)
    core.apply(root, {"request_id": "test:crash", "ops": [
        {"collection": "sections", "value": {
            "id": "sec-01", "title": "Ⅰ. 머리말", "order": 1, "path": "sections/01.md",
            "status": "drafting",
        }},
        {"collection": "sections", "value": {
            "id": "sec-02", "title": "Ⅱ. 본문", "order": 2, "path": "sections/02.md",
            "status": "drafting",
        }},
    ]}, p["revision"])
    return root


def _run_crash(root, stage, env=None):
    import subprocess

    from conftest import SCRIPTS

    script = root.parent / ("crash-%s.py" % stage)
    script.write_text(CRASH_SCRIPT, encoding="utf-8")
    proc = subprocess.run([sys.executable, str(script)], env={
        **os.environ, "CRASH_ROOT": str(root), "CRASH_STAGE": stage,
        "CRASH_BEFORE": BODY, "CRASH_AFTER": TYPED,
        "PYTHONPATH": str(SCRIPTS) + os.pathsep + str(SIDECAR_DIR),
        **(env or {}),
    }, check=False)
    return proc.returncode


def _manuscript(root):
    return (root / "sections" / "01.md")


@pytest.mark.parametrize("stage,expect", [
    ("01_new_file", "A"),   # ① 에서 멈춤 — 원고 안 움직임
    ("02_ledger", "A"),     # ② 뒤 멈춤(원장 줄은 있다) — 원고 안 움직임
    ("03_displace", "A"),   # ③-1 뒤 — 복구가 돌려놓는다
    ("03_place", "A"),      # ③-3 뒤 — 복구가 내 글을 걷고 A 를 되돌린다
])
def test_crash_at_each_write_stage_leaves_the_original(tmp_path, stage, expect):
    root = _crash_project(tmp_path, stage)
    revision = core.load(root)["revision"]
    original = _manuscript(root).read_bytes()
    assert _run_crash(root, stage) == 73
    methods_edit.section_edits(None, {"root": str(root)})  # 입구가 복구한다
    # §4-4-3: 어느 단계에서 꺼져도 원고 자리는 A 전체이거나(복구 뒤) 복구가 채운다.
    assert _manuscript(root).read_bytes() == original
    assert core.load(root)["revision"] == revision  # 정본은 그대로(등록 전)
    states = [row["state"] for row in _ledger(root)]
    # 쪽지(②)를 적기 전에 멈춘 단계는 원장에 아무 줄도 남기지 않는다(움직인 것이 없다).
    assert states == [] or states[-1] in ("aborted", "plain", "pending")


def test_crash_after_registration_is_closed_as_pending(tmp_path):
    """④ 뒤(등록됨)·⑤ 전 — 파일은 손대지 않고 확정 줄을 `pending` 으로 채운다."""
    root = _crash_project(tmp_path, "confirm")
    assert _run_crash(root, "04_apply") == 73
    assert TYPED in _manuscript(root).read_text(encoding="utf-8")
    listed = methods_edit.section_edits(None, {"root": str(root)})
    assert _manuscript(root).read_bytes().endswith(b"\n")
    assert TYPED in _manuscript(root).read_text(encoding="utf-8")
    states = [row["state"] for row in _ledger(root)]
    assert states[-1] == "pending"
    assert listed["edits"] and listed["edits"][-1]["state"] == "pending"


def test_crash_before_the_confirmation_row_is_closed_once(tmp_path):
    """⑤ 전 — 파일은 C 그대로, 복구가 확정 줄을 `pending` 으로 채우고 다시 돌아도 안 더한다."""
    root = _crash_project(tmp_path, "confirm2")
    assert _run_crash(root, "05_confirm") == 73
    assert TYPED in _manuscript(root).read_text(encoding="utf-8")
    assert [row["state"] for row in _ledger(root)] == ["writing"]
    methods_edit.section_edits(None, {"root": str(root)})
    after_one = [row["state"] for row in _ledger(root)]
    assert after_one == ["writing", "pending"]
    methods_edit.section_edits(None, {"root": str(root)})
    assert [row["state"] for row in _ledger(root)] == after_one


def test_recovery_dying_again_ends_the_same_way(tmp_path):
    """복구 도중 또 꺼져도 다음에 같은 표로 이어 간다."""
    root = _crash_project(tmp_path, "recover")
    original = _manuscript(root).read_bytes()
    assert _run_crash(root, "03_place") == 73
    real = methods_edit._restore_noclobber
    methods_edit._restore_noclobber = lambda *a, **k: (_ for _ in ()).throw(OSError(5, "죽음"))
    try:
        stuck = methods_edit.section_edits(None, {"root": str(root)})
    finally:
        methods_edit._restore_noclobber = real
    # 못 돌려놓았으면 줄은 `writing` 그대로, 목록은 숨기지 않고 알린다.
    assert [row["state"] for row in _ledger(root)] == ["writing"]
    assert any(n["kind"] == "restore_pending" for n in stuck["notices"])
    methods_edit.section_edits(None, {"root": str(root)})
    assert _manuscript(root).read_bytes() == original
    assert [row["state"] for row in _ledger(root)][-1] == "aborted"


def test_backups_are_kept_forever_even_when_the_bytes_changed(tmp_path):
    """§4-5-1: 앱은 원고가 걸렸던 파일 이름을 지우지 않는다 — 지문이 달라도 남긴다."""
    root = _crash_project(tmp_path, "cleanup")
    p = core.load(root)
    result = _call_edit(root)
    assert result["revision"] == p["revision"] + 1
    bundles = list((root / ".knuaf-gui" / "edit-backup").iterdir())
    assert len(bundles) == 1
    displaced = bundles[0] / "displaced-1-0"
    displaced.write_bytes(b"A1: opened handle wrote later")
    assert not hasattr(methods_edit, "_cleanup"), "청소는 v0.6.4에 없다"
    methods_edit.section_edits(None, {"root": str(root)})
    assert displaced.exists(), "보존본을 지웠다"
    assert displaced.read_bytes() == b"A1: opened handle wrote later"


def test_backups_survive_repeated_entry_calls(tmp_path):
    """입구를 여러 번 불러도 보존 폴더는 그대로다(옛 10분 규칙은 없다)."""
    root = _crash_project(tmp_path, "window")
    _call_edit(root)
    bundle = next((root / ".knuaf-gui" / "edit-backup").iterdir())
    assert (bundle / "displaced-1-0").exists()
    rows = methods_edit._read_ledger(root)
    for row in rows:
        row["at"] = "2020-01-01T00:00:00+00:00"
    for _ in range(3):
        methods_edit.section_edits(None, {"root": str(root)})
    assert (bundle / "displaced-1-0").exists()
    assert (bundle / "new-0").exists()


# ── §4-5 범위 줄이기 · FIX3 D1~D6 ─────────────────────────────────────────


def test_a_successful_save_keeps_every_backup_file_even_after_an_hour(tmp_path):
    """D1 — 청소를 뺐으므로 '마지막 이름을 지워 B 를 잃는' 경로 자체가 없다."""
    root = _crash_project(tmp_path, "d1")
    _call_edit(root)
    bundle = next((root / ".knuaf-gui" / "edit-backup").iterdir())
    kept = sorted(child.name for child in bundle.iterdir())
    assert "new-0" in kept and "displaced-1-0" in kept
    # 열린 핸들이 나중에 쓴 B 는 보존본에 남는다(지우는 코드가 없다).
    (bundle / "displaced-1-0").write_bytes(b"B: opened handle wrote later")
    for _ in range(2):
        methods_edit.section_edits(None, {"root": str(root)})
    assert (bundle / "displaced-1-0").read_bytes() == b"B: opened handle wrote later"


def test_aborted_save_keeps_its_backup_folder(tmp_path):
    """D1 — 실패한 저장의 보존 폴더도 남는다(옛 청소는 aborted 도 지웠다)."""
    root = _crash_project(tmp_path, "d1b")
    assert _run_crash(root, "03_place") == 73
    methods_edit.section_edits(None, {"root": str(root)})
    assert [row["state"] for row in _ledger(root)][-1] == "aborted"
    bundles = list((root / ".knuaf-gui" / "edit-backup").iterdir())
    assert len(bundles) == 1
    # 복구가 A 를 제자리로 돌려놓아도, 앱이 쓴 `new-0` 은 지우지 않고 남긴다.
    assert (bundles[0] / "new-0").exists()


def test_undo_does_not_leave_a_phantom_lost_record(sidecar, project):
    """D2/FIX2① — 되돌리기를 빼도 `aborted` 건이 유령 '기록 유실'을 만들지 않는다."""
    p = core.load(project)
    params = _params(project, before_block=BODY, after_block=TYPED)
    stale = sidecar.call("section.edit", **{**params, "expected_revision": p["revision"] - 1})
    assert _code(stale) == "stale_view"
    listed = sidecar.ok("section.edits", root=str(project))["result"]
    assert not [row for row in listed["edits"] if row.get("lost_record")]


def test_recovery_without_canonical_or_backup_does_not_claim_restore(tmp_path):
    """§4-5-2 — 자리도 보존본도 없으면 돌려놓은 것이 아니다. 알림 없이 `aborted`."""
    root = _crash_project(tmp_path, "gone")
    p = core.load(root)
    _manuscript(root).unlink()
    methods_edit._append_ledger(root, {
        "edit_id": "edit-gone",
        "request_id": "app:student-edit:sec-01:1:deadbeefdead",
        "at": "2020-01-01T00:00:00+00:00",
        "revision_before": p["revision"],
        "revision_after": None,
        "edits": [{"section_id": "sec-01", "before_block": BODY, "after_block": TYPED}],
        "needs_check": None,
        "new_issues": [],
        "state": "writing",
        "files": [{"n": 0, "section_id": "sec-01", "path": "sections/01.md",
                   "sha_a": "0" * 64, "sha_c": "1" * 64}],
    })
    listed = methods_edit.section_edits(None, {"root": str(root)})
    assert not [n for n in listed["notices"] if n["kind"] == "restored"]
    states = [row["state"] for row in _ledger(root) if row["edit_id"] == "edit-gone"]
    assert states == ["writing", "aborted"]


# ── D3: `left` — 되돌리지 못했으면 조용히 닫지 않는다 ──────────────────────


def test_restore_file_reports_left_when_it_cannot_displace(tmp_path):
    """D3 — `displaced-2` 가 이미 있으면 참·거짓이 아니라 `left`(보존 폴더에 A)."""
    bundle = tmp_path / "b"
    bundle.mkdir()
    path = tmp_path / "01.md"
    path.write_bytes(b"C: installed")
    (bundle / "displaced-1-0").write_bytes(b"A: original")
    (bundle / "displaced-2-0").write_bytes(b"C: already displaced")
    assert methods_edit._restore_file(bundle, 0, path, "a" * 64, "c" * 64) == "left"
    assert path.read_bytes() == b"C: installed"
    assert (bundle / "displaced-1-0").read_bytes() == b"A: original"


def test_restore_file_reports_nothing_and_restored(tmp_path):
    bundle = tmp_path / "b2"
    bundle.mkdir()
    path = tmp_path / "02.md"
    assert methods_edit._restore_file(bundle, 0, path, "a" * 64, "c" * 64) == "nothing"
    (bundle / "displaced-1-0").write_bytes(b"A: original")
    assert methods_edit._restore_file(bundle, 0, path, "a" * 64, "c" * 64) == "restored"
    assert path.read_bytes() == b"A: original"


def test_recovery_announces_kept_when_the_seat_cannot_be_restored(tmp_path, monkeypatch):
    """D3 — 복구가 되돌리지 못하면 `aborted` + `left` + `kept` 알림(조용히 닫지 않는다)."""
    root = _crash_project(tmp_path, "left")
    assert _run_crash(root, "03_place") == 73
    real = methods_edit._restore_file
    monkeypatch.setattr(methods_edit, "_restore_file", lambda *a, **k: "left")
    listed = methods_edit.section_edits(None, {"root": str(root)})
    kept = [n for n in listed["notices"] if n["kind"] == "kept"]
    assert kept and kept[0]["path"]
    row = [r for r in _ledger(root) if r["state"] == "aborted"][-1]
    assert row["left"] is True
    assert real is not None


# ── D4: 알림은 학생이 볼 때까지 남는다 ────────────────────────────────────


def test_notice_survives_read_all_and_repeats_until_seen(tmp_path):
    """D4 — 첫 화면 읽기(`section.read_all`)가 복구해도 알림은 `section.edits`에 남는다."""
    root = _crash_project(tmp_path, "d4")
    assert _run_crash(root, "03_place") == 73

    from knuaf_sidecar.rpc import Server

    server = Server()
    # 실제 기동 순서 그대로 — methods_core 가 먼저 등록하고 methods_edit 이 감싼다.
    server.register("section.read_all", lambda ctx, params: [])
    methods_edit.register(server)
    fn, _write = server.methods["section.read_all"]
    fn(None, {"root": str(root)})  # 화면이 논문을 처음 그리는 입구

    first = methods_edit.section_edits(None, {"root": str(root)})
    assert [n["kind"] for n in first["notices"]] == ["restored"]
    again = methods_edit.section_edits(None, {"root": str(root)})
    assert [n["kind"] for n in again["notices"]] == ["restored"]

    edit_id = first["notices"][0]["edit_id"]
    methods_edit.section_edits_mark(None, {"root": str(root), "notices_seen": [edit_id]})
    after = methods_edit.section_edits(None, {"root": str(root)})
    assert not [n for n in after["notices"] if n["kind"] == "restored"]


def test_edits_mark_accepts_notices_seen_alone(sidecar, project):
    """D4 — `notices_seen` 만 보내도 받는다(화면 묶음이 그대로 쓴다)."""
    first = _ok(sidecar, project)
    marked = sidecar.ok("section.edits_mark", root=str(project),
                        notices_seen=[first["edit_id"]])["result"]
    assert marked["marked"] == [first["edit_id"]]
    assert _find(sidecar, project, first["edit_id"])["state"] == "plain"


# ── D5: 보존 경로는 쓰기 전에 검사한다 ────────────────────────────────────


def test_backup_root_symlink_is_refused_before_any_write(tmp_path):
    """D5 — `edit-backup` 이 폴더 밖을 가리키면 시험 파일도 만들지 않고 거절한다."""
    root = _crash_project(tmp_path, "d5")
    outside = tmp_path / "outside"
    outside.mkdir()
    backup = root / ".knuaf-gui" / "edit-backup"
    backup.parent.mkdir(parents=True, exist_ok=True)
    assert not backup.exists()  # 아직 저장한 적이 없다
    try:
        backup.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("이 파일 시스템은 바로가기를 만들지 못한다")

    with pytest.raises(RpcError) as caught:
        _call_edit(root)
    assert caught.value.code == "ledger_unreadable"
    assert list(outside.iterdir()) == [], "폴더 밖에 시험 파일을 썼다"


# ── D1/D2 잔재: 메서드·함수가 실제로 없어졌다 ─────────────────────────────


def test_removed_surfaces_are_really_gone():
    """§4-5-1 — 청소·되돌리기 코드가 남아 있으면 다시 새는 길이 된다."""
    for name in ("_cleanup", "_remove_name", "_mark_undone", "section_edit_undo", "CLEANUP_AFTER"):
        assert not hasattr(methods_edit, name), name
    server_names = set()
    from knuaf_sidecar.rpc import Server

    server = Server()
    methods_edit.register(server)
    server_names.update(server.methods)
    assert "section.edit_undo" not in server_names


# ── FIX4: 빈 원고 자리는 조용히 닫지 않는다 (§4-5-2 마지막 줄) ─────────────


def _writing_row(root, registered, seat_exists, new_is_c=False, extra_edits=None):
    """미완료 `writing` 줄 하나와 보존 폴더를 세운다. 등록 여부·자리·보존본을 손으로 고른다."""
    p = core.load(root)
    request_id = "app:student-edit:sec-01:%d:deadbeefdead" % p["revision"]
    if registered:
        core.apply(root, {"request_id": request_id, "ops": []}, p["revision"])
        p = core.load(root)
    edit_id = "edit-fix4-%s" % ("reg" if registered else "new")
    raw = ("# Ⅰ. 머리말\n\n%s\n%s\n%s\n" % (START, BODY, END)).encode()
    new = ("# Ⅰ. 머리말\n\n%s\n%s\n%s\n" % (START, TYPED, END)).encode()
    bundle = methods_edit._backup_root(root) / edit_id
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "new-0").write_bytes(new if new_is_c else b"some other bytes")
    path = root / "sections" / "01.md"
    if not seat_exists:
        path.unlink()
    methods_edit._append_ledger(root, {
        "edit_id": edit_id,
        "request_id": request_id,
        "at": "2020-01-01T00:00:00+00:00",
        "revision_before": p["revision"],
        "revision_after": None,
        "edits": [{"section_id": "sec-01", "before_block": BODY, "after_block": TYPED}],
        "needs_check": None,
        "new_issues": [],
        "state": "writing",
        "files": [{"n": 0, "section_id": "sec-01", "path": "sections/01.md",
                   "sha_a": hashlib.sha256(raw).hexdigest(),
                   "sha_c": hashlib.sha256(new).hexdigest()}],
        **(extra_edits or {}),
    })
    return edit_id, bundle


def test_a_registered_row_with_no_seat_and_no_matching_new_is_announced(tmp_path):
    """(가) 등록됨 + 자리 빔 + `new` 가 내 글 아님 → `pending` + `missing: true` + 알림."""
    root = _crash_project(tmp_path, "fix4reg")
    edit_id, bundle = _writing_row(root, registered=True, seat_exists=False)
    listed = methods_edit.section_edits(None, {"root": str(root)})
    assert [n["kind"] for n in listed["notices"]] == ["missing"]
    assert listed["notices"][0]["path"] == str(bundle)
    closing = [r for r in _ledger(root) if r["edit_id"] == edit_id][-1]
    assert closing["state"] == "pending"
    assert closing["missing"] is True
    assert "restore_pending" not in closing


def test_an_unregistered_row_with_no_seat_and_nothing_to_restore_is_announced(tmp_path):
    """(나) 미등록 + 자리 빔 + 돌려놓을 것 없음 → `aborted` + `missing: true` + 알림."""
    root = _crash_project(tmp_path, "fix4new")
    edit_id, bundle = _writing_row(root, registered=False, seat_exists=False)
    listed = methods_edit.section_edits(None, {"root": str(root)})
    assert [n["kind"] for n in listed["notices"]] == ["missing"]
    assert listed["notices"][0]["path"] == str(bundle)
    closing = [r for r in _ledger(root) if r["edit_id"] == edit_id][-1]
    assert closing["state"] == "aborted"
    assert closing["missing"] is True


def test_a_seat_that_still_has_someone_elses_text_is_not_called_missing(tmp_path):
    """자리에 파일이 있으면 '찾지 못함'이 아니다 — `kept`(A 는 보존 폴더에)."""
    root = _crash_project(tmp_path, "fix4seat")
    edit_id, bundle = _writing_row(root, registered=False, seat_exists=True)
    (root / "sections" / "01.md").write_bytes(b"B: outside writer")
    listed = methods_edit.section_edits(None, {"root": str(root)})
    kinds = [n["kind"] for n in listed["notices"]]
    assert "missing" not in kinds
    closing = [r for r in _ledger(root) if r["edit_id"] == edit_id][-1]
    assert closing.get("missing") is not True
    assert (bundle / "displaced-1-0").exists() is False  # 밀어낸 적이 없다


def test_missing_wins_over_kept_when_both_apply(tmp_path):
    """알림이 겹치면 더 급한 `missing` 하나만 싣는다(§4-5-2 참고)."""
    root = _crash_project(tmp_path, "fix4both")
    edit_id, bundle = _writing_row(root, registered=False, seat_exists=True)
    # 첫 파일은 자리에 남의 글이 있고(→ left/kept), 둘째 파일은 자리가 비었다(→ missing).
    second = root / "sections" / "02.md"
    raw2 = ("# Ⅱ. 본문\n\n%s\n%s\n%s\n" % (START, "농장A는 600평 규모다.", END)).encode()
    rows = methods_edit._read_ledger(root)
    row = [r for r in rows if r["edit_id"] == edit_id][-1]
    row["files"].append({"n": 1, "section_id": "sec-02", "path": "sections/02.md",
                         "sha_a": hashlib.sha256(raw2).hexdigest(),
                         "sha_c": hashlib.sha256(b"other").hexdigest()})
    methods_edit._append_ledger(root, row)
    second.unlink()

    listed = methods_edit.section_edits(None, {"root": str(root)})
    kinds = [n["kind"] for n in listed["notices"]]
    assert kinds == ["missing"]


# ── 화면 묶음 A 고침 1: sidecar 더하기 둘 (설계 §4-5-8 05·07) ──────────────


def test_batch_result_carries_each_section_draft_hash(two_sections):
    """05 — 묶음 결과에 절마다의 지문이 함께 온다(기존 `draft_hash` 는 첫 절 그대로)."""
    p = core.load(two_sections)
    r = methods_edit.section_edit_batch(None, {
        "root": str(two_sections), "expected_revision": p["revision"], "edits": [
            {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
            {"section_id": "sec-02", "before_block": "농장A는 600평 규모다.",
             "after_block": "농장A는 700평 규모다."},
        ],
    })
    after = core.load(two_sections)
    assert r["draft_hashes"] == {
        "sec-01": after["sections"]["sec-01"]["draft_hash"],
        "sec-02": after["sections"]["sec-02"]["draft_hash"],
    }
    # 기존 계약은 그대로 — 첫 절 지문.
    assert r["draft_hash"] == after["sections"]["sec-01"]["draft_hash"]


def test_ledger_and_edits_response_carry_recheck_before_submit(sidecar, project):
    """07 — `recheck_before_submit` 이 원장 줄과 `section.edits` 응답에 실린다."""
    _register_review(project)
    result = _ok(sidecar, project)  # 오타 한 글자 — needs_check=false, 검토는 낡는다
    assert result["needs_check"] is False
    assert result["recheck_before_submit"] is True
    row = next(r for r in _ledger(project) if r["edit_id"] == result["edit_id"] and r["state"] in ("plain", "pending"))
    assert row["recheck_before_submit"] is True
    listed = {r["edit_id"]: r for r in sidecar.ok("section.edits", root=str(project))["result"]["edits"]}
    assert listed[result["edit_id"]]["recheck_before_submit"] is True


def test_a_plain_save_without_stale_reviews_is_not_marked_recheck(sidecar, project):
    """07 — 점검이 필요 없는 저장은 `recheck_before_submit` 이 false 로 온다(거짓 안내 금지)."""
    result = _ok(sidecar, project)
    assert result["recheck_before_submit"] is False
    listed = {r["edit_id"]: r for r in sidecar.ok("section.edits", root=str(project))["result"]["edits"]}
    assert listed[result["edit_id"]]["recheck_before_submit"] is False
