"""gg_school_paper: the first artifact a student gets, and the input to build_docx.

The contract that matters here is honesty about missing values: SKILL.md says
unsupplied values stay `[확인 필요]`. A regression that turns a missing number
into 0 or an empty cell would put an invented figure in a submitted thesis.
"""
import json
import re

import pytest

from conftest import bound_test_context, parse_json, run_gg, run_script

import gg_school_paper as sp

@pytest.fixture
def paper_text(tmp_path):
    """Exercise the public publication entrypoint, including canonical major authorization."""
    import gg_core as core

    bound_test_context(tmp_path)

    def publish(spec):
        spec = dict(spec)
        body = spec.pop("body_markdown", None)
        source = tmp_path / "paper.json"
        source.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        result = core.paper(tmp_path, "paper.json", source.read_bytes(), "build/paper.md",
                            major_id="specialty_crops", body_markdown=body)
        return (tmp_path / result["path"]).read_text(encoding="utf-8")

    return publish


# --- years(): the 5-year plan window is derived, not supplied -----------------

def test_years_derives_a_five_year_window_from_the_writing_year():
    writing, start, end, span = sp.years({"writing_year": 2026, "start_year": 2027})
    assert (writing, start, end) == (2026, 2027, 2031)
    assert span == [2027, 2028, 2029, 2030, 2031]


@pytest.mark.parametrize("bad", [None, "2026", 2026.0, True, 1899, 2101, {}])
def test_years_refuses_a_writing_year_it_cannot_trust(bad):
    """A wrong base year silently shifts every table in the plan."""
    with pytest.raises(ValueError, match="작성연도"):
        sp.years({"writing_year": bad})


# --- need(): missing stays missing -------------------------------------------

def test_need_takes_the_first_supplied_key():
    assert sp.need({"a": "", "b": "  ", "c": "값"}, "a", "b", "c") == "값"


@pytest.mark.parametrize("spec", [{}, {"a": None}, {"a": ""}, {"a": "   "}, None, 42, ""])
def test_need_falls_back_to_the_pending_marker_never_to_blank(spec):
    got = sp.need(spec, "a")
    assert got == sp.PENDING == "[확인 필요]"
    assert got not in ("", "0", "None")


def test_need_accepts_a_bare_string_as_the_value():
    assert sp.need("직접 값", "a") == "직접 값"


# --- the generated skeleton ---------------------------------------------------

MINIMAL = {"title": "테스트 논문", "student": "홍길동", "department": "특용작물전공",
           "advisor": "김교수", "writing_year": 2026, "start_year": 2027,
           "school_profile": {"school": "Synthetic school", "department": "Synthetic department",
                              "mode": "school", "layout": "forms_1_to_4"}}


def test_paper_emits_the_six_school_chapters_in_order(paper_text, ):
    out = paper_text(MINIMAL)
    chapters = ["Ⅰ. 머리말", "Ⅱ. 외부환경분석", "Ⅲ. 영농계획수립",
                "Ⅳ. 재무계획", "Ⅴ. 맺음말 및 발전방향", "Ⅵ. 참고문헌"]
    positions = [out.find(c) for c in chapters]
    assert all(p >= 0 for p in positions), dict(zip(chapters, positions))
    assert positions == sorted(positions), "장 순서가 어긋남"


def test_paper_keeps_supplied_values_and_marks_the_rest_pending(paper_text, ):
    out = paper_text(MINIMAL)
    for supplied in ("테스트 논문", "김교수"):
        assert supplied in out
    # A minimal spec supplies almost nothing, so the skeleton must be full of
    # explicit markers rather than blanks a reader could mistake for real data.
    assert out.count(sp.PENDING) > 50


def test_paper_never_invents_a_submission_date(paper_text, ):
    out = paper_text(MINIMAL)
    assert not re.search(r"20\d{2}\s*년\s*\d{1,2}\s*월", out), "제출일을 지어냄"


def test_paper_refuses_a_spec_without_a_writing_year(paper_text, ):
    with pytest.raises(ValueError, match="작성연도"):
        paper_text({k: v for k, v in MINIMAL.items() if k != "writing_year"})


# --- tables the school form fixes ---------------------------------------------

def test_table_renders_a_pipe_table_build_docx_can_parse():
    md = sp.table(["가", "나"], [[1, 2], ["a", "b"]])
    rows = md.splitlines()
    assert rows[0] == "|가|나|"
    assert rows[1] == "|---|---|"
    assert rows[2] == "|1|2|"
    assert all(r.startswith("|") and r.endswith("|") for r in rows)


def test_disaster_table_keeps_every_school_category_even_when_unanswered():
    md = sp.disaster_table({})
    for category in sp.DISASTER:
        assert category in md, category
    assert sp.PENDING in md


def test_climate_table_keeps_every_school_row_and_season_even_when_unanswered():
    """The school form fixes these rows; an unanswered one stays visible."""
    md = sp.climate_table({})
    for row in sp.CLIMATE:
        assert row in md, row
    for season in sp.SHORT_SEASONS:
        assert season in md, season
    assert sp.PENDING in md


def test_submitted_date_is_printed_when_supplied(paper_text, ):
    """Guards the pair above: the date is absent because it was not given,
    not because the generator drops it."""
    out = paper_text({**MINIMAL, "submitted": "2026년 12월"})
    assert "2026년 12월" in out


# --- the caller's own body --------------------------------------------------
#
# The generated skeleton is the 2020 Ⅰ–Ⅵ 목차. A student who wrote to the 2026
# 강의자료 목차 (Ⅰ머리말/Ⅱ농장현황/…/Ⅶ참고문헌) used to have no way to reach a
# submittable DOCX: running the generator rearranged their chapters, and
# bypassing it dropped the whole frontmatter (겉표지·제출면·인준서·목차).

SCHOOL = dict(MINIMAL)
OWN_BODY = "\n".join([
    "Ⅰ. 머리말", "", "딸기를 주작목으로 정한 이유를 적는다.", "",
    "Ⅱ. 농장현황", "", "경영주와 가족 노동력을 적는다.", "",
    "Ⅶ. 참고문헌 및 인터넷 참고 사이트", "", "[보류: 인용이 확정된 뒤 등재합니다]", "",
])
LEGACY_CHAPTERS = ("Ⅱ. 외부환경분석", "Ⅲ. 영농계획수립", "Ⅳ. 재무계획",
                   "Ⅴ. 맺음말 및 발전방향", "Ⅵ. 참고문헌")


def test_paper_keeps_the_frontmatter_when_the_caller_brings_its_own_body(paper_text, ):
    out = paper_text({**SCHOOL, "body_markdown": OWN_BODY})
    for form in ("겉표지", "표제면", "제출서", "인준서", "목차"):
        assert form in out, form
    assert "테스트 논문" in out, "겉표지의 제목이 사라짐"
    for line in OWN_BODY.strip().splitlines():
        assert line in out, line
    # The 2020 skeleton must not reappear alongside the student's chapters.
    for chapter in LEGACY_CHAPTERS:
        assert chapter not in out, chapter




def test_paper_with_its_own_body_still_refuses_to_invent_frontmatter_values(paper_text, ):
    """지도교수·제출연월이 비어 있으면 표시만 하고 지어내지 않는다."""
    spec = {k: v for k, v in SCHOOL.items() if k != "advisor"}
    out = paper_text({**spec, "body_markdown": OWN_BODY})
    assert "지도교수 " + sp.PENDING in out
    assert not re.search(r"20\d{2}\s*년\s*\d{1,2}\s*월", out), "제출일을 지어냄"


@pytest.mark.parametrize("bad", ["", "   ", "\n\n\ufeff \n"])
def test_paper_refuses_an_empty_body_instead_of_emitting_a_frontmatter_only_file(paper_text, bad):
    """빈 본문으로 DOCX 가 나오면 호출자는 그것을 완료로 읽는다."""
    with pytest.raises(ValueError, match="비어 있음"):
        paper_text({**SCHOOL, "body_markdown": bad})


@pytest.mark.parametrize("bad", ["Ⅱ. 농장현황\n\n본론부터", "요약\n\nⅠ. 머리말"])
def test_paper_refuses_a_body_that_does_not_start_at_the_first_chapter(paper_text, bad):
    with pytest.raises(ValueError, match="머리말"):
        paper_text({**SCHOOL, "body_markdown": bad})


@pytest.mark.parametrize("bad", [42, ["Ⅰ. 머리말"], {"text": "Ⅰ. 머리말"}])
def test_paper_refuses_a_body_that_is_not_text(paper_text, bad):
    with pytest.raises(ValueError):
        paper_text({**SCHOOL, "body_markdown": bad})


def test_paper_refuses_a_body_without_the_frontmatter_it_would_be_missing(paper_text, ):
    """앞머리를 만들 수 없는 모드에서는 본문만 돌려주지 않는다."""
    with pytest.raises(ValueError, match="school_profile"):
        paper_text({**MINIMAL, "body_markdown": OWN_BODY, "school_profile": {}})


def test_paper_accepts_a_markdown_heading_as_the_first_chapter(paper_text, ):
    out = paper_text({**SCHOOL, "body_markdown": "# Ⅰ. 머리말\n\n첫 문단.\n"})
    assert "첫 문단." in out


# --- the same road through both CLIs -----------------------------------------

def _write_inputs(folder):
    bound_test_context(folder)
    (folder / "paper.json").write_text(
        json.dumps({"title": "T", "writing_year": 2026, "start_year": 2027, "school_profile": SCHOOL["school_profile"]}, ensure_ascii=False),
        encoding="utf-8",
    )
    merged = folder / "build" / "19" / "review" / "검토용.md"
    merged.parent.mkdir(parents=True, exist_ok=True)
    merged.write_text(OWN_BODY, encoding="utf-8")
    return "build/19/review/검토용.md"


def test_gg_paper_accepts_a_merged_body_file(empty_folder):
    body = _write_inputs(empty_folder)
    r = run_gg(empty_folder, "paper", "--input", "paper.json", "--body", body,
               "--out", "build/본문.md", "--major", "specialty_crops", cwd=empty_folder, timeout=60)
    assert r.returncode == 0, "stdout=%r stderr=%r" % (r.stdout, r.stderr)
    out = (empty_folder / "build" / "본문.md").read_text(encoding="utf-8")
    assert "겉표지" in out and "인준서" in out
    assert "Ⅱ. 농장현황" in out
    assert "Ⅲ. 영농계획수립" not in out


def test_gg_paper_reports_a_reason_for_an_empty_body_file(empty_folder):
    _write_inputs(empty_folder)
    (empty_folder / "비었음.md").write_text("", encoding="utf-8")
    r = run_gg(empty_folder, "paper", "--input", "paper.json", "--body", "비었음.md",
               "--out", "build/본문.md", "--major", "specialty_crops", cwd=empty_folder, timeout=60)
    assert r.returncode == 2
    assert parse_json(r.stdout)["commit_state"] == "not_committed"
    assert not (empty_folder / "build" / "본문.md").exists(), "빈 본문으로 산출물을 남김"


def test_school_paper_script_accepts_the_same_body_file(empty_folder):
    body = _write_inputs(empty_folder)
    r = run_script("gg_school_paper.py", empty_folder, "--input", "paper.json",
                   "--body", body, "--out", "build/본문.md", "--major", "specialty_crops", timeout=60)
    assert r.returncode == 0, "stdout=%r stderr=%r" % (r.stdout, r.stderr)
    out = (empty_folder / "build" / "본문.md").read_text(encoding="utf-8")
    assert "겉표지" in out and "Ⅱ. 농장현황" in out
    assert "Ⅲ. 영농계획수립" not in out


# BOM 이 붙은 본문 파일(윈도우 편집기에서 흔하다)이 "Ⅰ. 머리말로 시작하지 않는다"로
# 거절되면 학생은 눈에 보이지 않는 한 글자 때문에 막힌다. BOM 은 지우고 받는다.
def test_a_body_with_a_bom_is_accepted(paper_text):
    text = paper_text({**SCHOOL, "body_markdown": "\ufeffⅠ. 머리말\n\n본문입니다.\n"})
    assert "본문입니다." in text and "\ufeff" not in text
