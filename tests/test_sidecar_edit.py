"""§11 뷰어 직접 수정 시험 — sidecar `section.edit` 계열과 밀어내기 저장(§4-2·§5).

두 층으로 나눈다.
- 프로토콜 층: 진짜 sidecar 프로세스를 띄워 JSON-lines 로 부른다(배선·오류 코드 포함).
- 트랜잭션 층: `apply` 실패 갈래와 끼어들기 순서는 실제로 재현하기 어려워서 같은
  프로세스에서 `methods_edit` 의 저장 단계를 직접 몬다. 주입한 실패만 다르고 파일
  조작은 제품 코드 그대로다.
"""
import json
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
    assert flags["section.edit_undo"] is True
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

    listed = {row["edit_id"]: row for row in sidecar.ok("section.edits", root=str(root))["result"]}
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


def test_a_stale_review_blocks_the_submission_candidate_even_after_undo(sidecar, project):
    _register_review(project)
    assert not [r for r in core.gate(project, core.load(project)) if r["check_id"] == "review_content"]
    first = _ok(sidecar, project)
    p = core.load(project)
    assert p["reviews"]["rev-01"]["stale"] is True
    blocked = [r for r in core.gate(project, p) if r["check_id"] == "review_content"]
    assert blocked and {r["status"] for r in blocked} == {"blocked"}

    undone = sidecar.ok("section.edit_undo", root=str(project), edit_id=first["edit_id"],
                        expected_revision=first["revision"])["result"]
    # 되돌려도 절 개정이 올라갔으므로 검토는 저절로 살아나지 않는다(§7 한계 2).
    assert core.load(project)["reviews"]["rev-01"]["stale"] is True
    assert undone["revision"] == first["revision"] + 1


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


def test_undo_restores_the_block_and_blocks_the_same_edit_again(sidecar, project):
    original = (project / "sections" / "01.md").read_bytes()
    first = _ok(sidecar, project)
    undone = sidecar.ok("section.edit_undo", root=str(project), edit_id=first["edit_id"],
                        expected_revision=first["revision"])["result"]
    assert undone["revision"] == first["revision"] + 1
    assert undone["undone_edit_id"] == first["edit_id"]
    assert (project / "sections" / "01.md").read_bytes() == original

    states = [row["state"] for row in _ledger(project) if row["edit_id"] == first["edit_id"]]
    assert states[-1] == "undone"
    # 되돌린 뒤 같은 편집을 다시 하려면 새 개정으로 다시 읽어야 한다.
    again = _edit(sidecar, project, expected_revision=first["revision"])
    assert _code(again) == "stale_view"
    # 같은 건을 두 번 되돌릴 수 없다.
    twice = sidecar.call("section.edit_undo", root=str(project), edit_id=first["edit_id"],
                         expected_revision=undone["revision"])
    assert _code(twice) == "invalid_params"


def test_undo_refuses_when_the_block_changed_since(sidecar, project):
    first = _ok(sidecar, project)
    # 그 문단을 다시 고친다(새 개정).
    second = _ok(sidecar, project, before=TYPED, after="농장A의 재배 면적은 600평입니다.")
    r = sidecar.call("section.edit_undo", root=str(project), edit_id=first["edit_id"],
                     expected_revision=second["revision"])
    assert _code(r) == "ambiguous"
    assert "600평입니다." in (project / "sections" / "01.md").read_text(encoding="utf-8")


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
    rows = sidecar.ok("section.edits", root=str(root))["result"]
    return next(row for row in rows if row["edit_id"] == edit_id)


def test_a_confirmed_request_without_a_ledger_row_is_revived_as_lost(sidecar, project):
    first = _ok(sidecar, project)
    (project / ".knuaf-gui" / "student-edits.jsonl").unlink()
    rows = sidecar.ok("section.edits", root=str(project))["result"]
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
    rows = sidecar.ok("section.edits", root=str(project))["result"]
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

    undone = sidecar.ok("section.edit_undo", root=str(two_sections), edit_id=r["edit_id"],
                        expected_revision=r["revision"])["result"]
    assert undone["revision"] == r["revision"] + 1
    assert BODY in (two_sections / "sections" / "01.md").read_text(encoding="utf-8")
    assert "600평" in (two_sections / "sections" / "02.md").read_text(encoding="utf-8")


def test_batch_undo_is_all_or_nothing(sidecar, two_sections):
    p = core.load(two_sections)
    r = sidecar.ok("section.edit_batch", root=str(two_sections), expected_revision=p["revision"], edits=[
        {"section_id": "sec-01", "before_block": BODY, "after_block": TYPED},
        {"section_id": "sec-02", "before_block": "농장A는 600평 규모다.",
         "after_block": "농장A는 700평 규모다."},
    ])["result"]
    # 그 뒤 한 장을 다시 고친다 — 묶음의 한 건이 지금 본문과 안 맞는다.
    again = _ok(sidecar, two_sections, "sec-02", "농장A는 700평 규모다.", "농장A는 800평 규모다.")
    before = {rel: (two_sections / rel).read_bytes() for rel in ("sections/01.md", "sections/02.md")}
    bad = sidecar.call("section.edit_undo", root=str(two_sections), edit_id=r["edit_id"],
                       expected_revision=again["revision"])
    assert _code(bad) == "ambiguous"
    assert {rel: (two_sections / rel).read_bytes() for rel in before} == before
    assert core.load(two_sections)["revision"] == again["revision"]


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
    backups = list((project / ".knuaf-gui" / "edit-backup").glob("*/displaced-1-sec-01"))
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


def _record(root, data):
    path = root / "sections" / "01.md"
    return {
        "section_id": "sec-01",
        "path": path,
        "raw": path.read_bytes(),
        "new": data,
        "mode": path.stat().st_mode & 0o7777,
    }


def _backup(root, name="t1"):
    return root / ".knuaf-gui" / "edit-backup" / name


def test_place_never_overwrites_an_existing_file(project):
    path = project / "sections" / "01.md"
    original = path.read_bytes()
    with pytest.raises(FileExistsError):
        methods_edit._place_noclobber(path, b"new bytes", 0o644)
    assert path.read_bytes() == original
    assert not [n for n in path.parent.iterdir() if n.name.startswith(".gg-edit-")]


def test_an_outside_writer_before_displacement_is_preserved(project):
    record = _record(project, b"C\n")
    backup = _backup(project)
    stray = b"B: outside writer\n"
    (project / "sections" / "01.md").write_bytes(stray)

    methods_edit._write_manuscripts([record], backup)
    with pytest.raises(RpcError) as caught:
        methods_edit._verify_displaced([record])
    assert caught.value.code == "stale_view"
    methods_edit._revert([record], backup)
    assert (project / "sections" / "01.md").read_bytes() == stray


def test_an_outside_writer_between_verify_and_place_is_preserved(project):
    record = _record(project, b"C\n")
    backup = _backup(project)
    methods_edit._write_manuscripts([record], backup)
    methods_edit._verify_displaced([record])
    stray = b"B: slipped in between\n"
    (project / "sections" / "01.md").write_bytes(stray)

    with pytest.raises(RpcError) as caught:
        methods_edit._place([record])
    assert caught.value.code == "stale_view"
    methods_edit._revert([record], backup)
    assert (project / "sections" / "01.md").read_bytes() == stray
    assert (backup / "displaced-1-sec-01").read_bytes() == record["raw"]


def test_an_outside_writer_after_place_is_preserved(project):
    record = _record(project, b"C\n")
    backup = _backup(project)
    methods_edit._write_manuscripts([record], backup)
    methods_edit._verify_displaced([record])
    methods_edit._place([record])
    assert (project / "sections" / "01.md").read_bytes() == b"C\n"
    stray = b"B: last writer wins\n"
    (project / "sections" / "01.md").write_bytes(stray)

    methods_edit._revert([record], backup)  # apply 가 개정 불일치로 거절한 상황
    assert (project / "sections" / "01.md").read_bytes() == stray
    assert (backup / "displaced-1-sec-01").read_bytes() == record["raw"]


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
