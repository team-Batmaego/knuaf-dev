"""Installed guidance must resolve and agree with the deployed canonical contract.

The one-hop reference layout, maker wording and retired private APIs are not contracts.
"""
import re

import pytest

from conftest import SCRIPTS

SKILL_DIR = SCRIPTS.parent
REFS = SKILL_DIR / "references"
SKILL = SKILL_DIR / "SKILL.md"
RETIRED_LEDGERS = (
    "00_config.md", "00_interview.md", "00_interview_log.md", "01_assumptions.md",
    "02_receipts.jsonl", "03_sources.md", "04_research_log.md",
)
# An explicit destination, not a filename mention, establishes the write target.
FILE_NAME = r"[\w./-]+\.(?:jsonl|json|md|txt)"
DESTINATION = re.compile(
    rf"(?P<file>{FILE_NAME})[`*\])]*\s*"
    r"(?:(?:맨\s*)?(?:앞|뒤|끝|안|내부)\s*)?(?:에|로)(?:는|도|만)?(?!부터)"
)
WRITE_NOUNS = ("기록", "저장", "작성", "기입", "입력", "추가", "갱신", "등록", "생성", "업데이트")
WRITE_ACTION = re.compile(
    rf"(?<![가-힣])(?P<verb>{'|'.join(WRITE_NOUNS)}|"
    r"덮어쓰|덮어써|덧붙|남기|남긴|남겨|적|쓰|쓴|써)(?P<ending>[가-힣]*)"
)
NEGATED_WRITE = re.compile(
    r"^\s*(?:하?지(?:는|도)?\s*(?:않|말)|(?:하)?면\s*안|(?:해|어)?서는\s*안|"
    r"(?:하)?기?\s*금지|(?:할|을)\s*수\s*없)"
)
WRITE_COLUMNS = {"저장위치", "기록위치", "기록대상", "쓰기대상", "작성대상"}
MD_LINK = re.compile(r"\]\(([^)]+\.md(?:#[^)]*)?)\)")


def skill_docs():
    return [SKILL, *sorted(REFS.rglob("*.md"))]


def retired_write_directives(text):
    """Recognize explicit Korean write destinations; reads/preservation remain legal."""
    found = []
    destinations = list(DESTINATION.finditer(text))
    for index, target in enumerate(destinations):
        name = target["file"].rsplit("/", 1)[-1]
        if name not in RETIRED_LEDGERS:
            continue
        # A following destination owns its own verb (old-file read -> project.json write).
        end = destinations[index + 1].start() if index + 1 < len(destinations) else len(text)
        clause = re.split(r"[.!?;。]|\n\s*\n|\n(?=\s*(?:[-*+] |#{1,6} |\|))",
                          text[target.end():end], maxsplit=1)[0]
        for action in WRITE_ACTION.finditer(clause):
            ending = action["ending"]
            if (action["verb"] in WRITE_NOUNS and ending
                    and not ending.startswith(("하", "한", "할", "해", "함"))):
                continue
            # Noun mentions and completed/passive records do not order a new write.
            if ending in {"이", "은", "을", "의", "으로", "한", "했다", "했던", "된", "되어",
                          "혀", "힌", "인", "여", "여진"}:
                continue
            if NEGATED_WRITE.match(clause[action.start("ending"):]):
                continue
            found.append((text.count("\n", 0, target.start()) + 1, name))
            break

    # Tables explicitly headed "저장 위치" etc. also direct writes, unlike "보존 대상".
    columns = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.lstrip().startswith("|"):
            columns = []
            continue
        cells = line.strip().strip("|").split("|")
        headers = [re.sub(r"[`*\s]", "", cell) for cell in cells]
        selected = [index for index, header in enumerate(headers) if header in WRITE_COLUMNS]
        if selected:
            columns = selected
            continue
        for index in columns:
            if index < len(cells):
                for path in re.findall(FILE_NAME, cells[index]):
                    name = path.rsplit("/", 1)[-1]
                    if name in RETIRED_LEDGERS:
                        found.append((number, name))
    return sorted(set(found))


def test_guidance_does_not_direct_writes_to_retired_ledgers():
    violations = [
        (doc.relative_to(SKILL_DIR).as_posix(), line, name)
        for doc in skill_docs()
        for line, name in retired_write_directives(doc.read_text(encoding="utf-8"))
    ]
    assert not violations, f"Retired ledger write targets (document, line, file): {violations}"


@pytest.mark.parametrize("name", RETIRED_LEDGERS)
def test_every_retired_ledger_is_rejected_as_a_new_record_target(name):
    assert retired_write_directives(f"새 답변을 `{name}`에 기록한다.") == [(1, name)]


@pytest.mark.parametrize("text", [
    "학생이 고른 문체는 `00_interview.md`에 기록하고 전 장에 적용한다.",
    "그 과정을 `00_interview_log.md`에 남긴다.",
    "원문은 `00_interview_log.md`에 그대로 남기는 것이 전제다.",
    "별칭을 `04_research_log.md` 맨 앞에 기록한다.",
    "답변을 [원장](00_interview.md)에 **추가한다**.",
    "답변은 `00_interview.md`에\n그대로 적는다.",
    "결과를 `02_receipts.jsonl`로 저장한다.",
    "기존 `00_interview.md`에 쓰지 말고 새 답변을 추가한다.",
    "| 답변 | 저장 위치 |\n|---|---|\n| 문체 | `00_interview.md` |",
])
def test_write_directive_forms_are_rejected(text):
    assert retired_write_directives(text), text


@pytest.mark.parametrize("text", [
    "`00_interview.md`를 읽어 이전 답변을 확인한다.",
    "`00_config.md`의 `exemplar_hwp`를 읽는다.",
    "`03_sources.md`와 학생 파일은 바이트 보존이며 어떤 명령도 갱신하지 않는다.",
    "`03_sources.md`에는 새로 기록하지 않는다.",
    "`00_interview.md`에 쓰지 말고 그대로 보존한다.",
    "`00_interview.md`에 기록 금지.",
    "`00_interview.md`에 기록하면 안 된다.",
    "`00_interview.md`에 남기지 않는다.",
    "`00_interview.md`에 저장된 내용을 읽는다.",
    "`00_interview.md`에 기록한 문체를 참고한다.",
    "`00_interview.md`에 기록이 남아 있다.",
    "`00_interview.md`에 입력값이 있는지 읽어 확인한다.",
    "`00_interview.md`에 기록했던 답변을 읽는다.",
    "`00_interview.md`에 저장소 경로가 적혀 있다.",
    "`00_interview.md`에 있는 답변을 읽고 `project.json`에 기록한다.",
    "`00_interview.md`로부터 읽은 답변을 `project.json`에 저장한다.",
    "`project.json`에 기록하고 `00_interview.md`는 보존한다.",
    "| 보존 대상 | 처리 |\n|---|---|\n| `00_interview.md` | 읽기 전용 |",
])
def test_read_preserve_and_negative_write_forms_remain_allowed(text):
    assert retired_write_directives(text) == [], text


def test_no_dangling_markdown_reference():
    missing = []
    for doc in skill_docs():
        text = doc.read_text(encoding="utf-8")
        for raw in MD_LINK.findall(text):
            if raw.startswith(("http://", "https://")) or "*" in raw:
                continue
            path = raw.split("#", 1)[0]
            target = SKILL_DIR / path if path.startswith("references/") else doc.parent / path
            if not target.is_file() and not (SKILL_DIR / path).is_file():
                missing.append((doc.relative_to(SKILL_DIR).as_posix(), raw))
    assert not missing, missing


def test_canonical_writes_do_not_reintroduce_or_overwrite_flat_file_ledgers(project):
    import gg_core as core

    retired = RETIRED_LEDGERS
    assert not any((SKILL_DIR / name).exists() for name in retired)
    core.apply(project, {"request_id": "canonical-only", "ops": [
        {"collection": "tasks", "value": {"id": "canonical-task", "title": "Canonical task"}},
    ]}, 1)
    assert core.load(project)["revision"] == 2
    assert not any((project / name).exists() for name in retired)

    # Existing student files are evidence, never a second canonical store or a write target.
    for name in retired:
        (project / name).write_bytes(b"student evidence; not the canonical store\n")
    before = {name: (project / name).read_bytes() for name in retired}
    core.apply(project, {"request_id": "preserve-flat-inputs", "ops": [
        {"collection": "tasks", "value": {"id": "canonical-task", "title": "Updated canonical task"}},
    ]}, 2)
    current = core.load(project)
    assert current["revision"] == 3
    assert current["tasks"]["canonical-task"]["title"] == "Updated canonical task"
    assert current["facts"]["fact-area"]["value"] == "600"
    assert {name: (project / name).read_bytes() for name in retired} == before


@pytest.mark.parametrize("field,constant", [("kind", "KINDS"), ("answer_state", "STATES"), ("verification", "VERIFY")])
def test_documented_fact_enums_match_the_deployed_contract(field, constant):
    import gg_core as core

    text = (REFS / "mid-work-questions.md").read_text(encoding="utf-8")
    rows = [line.split("|") for line in text.splitlines() if line.startswith("|")]
    entries = [cells[2] for cells in rows if len(cells) > 2 and cells[1].strip() == f"`{field}`"]
    assert len(entries) == 1, (field, entries)
    documented = set(re.findall(r"`([^`]+)`", entries[0]))
    assert documented == getattr(core, constant)
