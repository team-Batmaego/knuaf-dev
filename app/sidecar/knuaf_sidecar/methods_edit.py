"""뷰어 직접 수정 — 원고 한 문단 저장 (설계 §4·§5).

규칙집의 공개 함수(`load`·`local`·`draft`·`digest`·`checks`·`apply`·`atomic`)만 쓴다.
비공개 함수(`_guarded`·`_apply_locked`)에 기대지 않는다 — 규칙집 판이 바뀌어도 깨지지 않게.

원고를 **덮어쓰지 않는다**(§4-2 6). 지금 파일을 보존 폴더로 밀어내고(그 순간의 바이트를
통째로 잡는다), 새 글은 "자리에 파일이 있으면 실패"하는 방식으로 놓는다. 그래서 어떤
순서로 남이 끼어들어도 누군가의 글이 지워지는 단계가 없다.

원장(§5)은 `<논문 폴더>/.knuaf-gui/student-edits.jsonl` 에 한 줄씩 덧붙인다. 원장을 못
쓰면 원고도 고치지 않는다(닫힌 쪽으로 실패).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .methods_core import _core, _root
from .rpc import RpcError

LEDGER_DIR = ".knuaf-gui"
LEDGER_NAME = "student-edits.jsonl"
BACKUP_DIR = "edit-backup"
REQUEST_PREFIX = "app:student-edit:"
CONFIRMED_STATES = ("plain", "pending", "sent", "undone")
MARK_STATES = ("sent", "pending")
# §8-1: 시작 때 한 번 찔러 보고, 없으면 `section.edit` 계열을 아예 등록하지 않는다
# (화면은 `methods.list` 를 보고 단추를 숨긴다).
REQUIRED = ("load", "local", "draft", "digest", "checks", "apply", "atomic", "START", "END")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ledger_path(root: Path) -> Path:
    return Path(root) / LEDGER_DIR / LEDGER_NAME


def _read_ledger(root: Path) -> list[dict]:
    """원장을 읽는다. 못 읽으면 **저장 중단**이 답이다(§5 fail-closed).

    깨진 줄은 건너뛰되 지우지 않는다 — 지우면 그 고침의 전·후 글이 영영 사라진다.
    """
    path = _ledger_path(root)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as error:
        raise RpcError("ledger_unreadable", "고침 기록을 읽지 못했어요: %s" % error) from error
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and isinstance(row.get("edit_id"), str) and row["edit_id"]:
            rows.append(row)
    return rows


def _append_ledger(root: Path, row: dict) -> None:
    path = _ledger_path(root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as error:
        raise RpcError("ledger_unreadable", "고침 기록을 쓰지 못했어요: %s" % error) from error


def _latest(rows: list[dict]) -> dict:
    """`edit_id` 별 마지막 줄 — 상태 변경은 줄을 덧붙이는 방식이라 마지막이 정본."""
    out: dict[str, dict] = {}
    for row in rows:
        out[row["edit_id"]] = row
    return out


def _split_blocks(text: str) -> list[str]:
    """`app/src/shared/paper.ts` 의 `splitBlocks` 와 같은 규칙(빈 줄 경계, 펜스 보호)."""
    blocks: list[str] = []
    cur: list[str] = []
    fence: str | None = None
    for line in text.split("\n"):
        m = re.match(r"^\s*(```|~~~)", line)
        if m:
            fence = None if fence else m.group(1)
        if not fence and not line.strip():
            joined = "\n".join(cur).strip()
            if joined:
                blocks.append(joined)
            cur = []
            continue
        cur.append(line)
    joined = "\n".join(cur).strip()
    if joined:
        blocks.append(joined)
    return blocks


# ── 원고 구획과 쓰기 ─────────────────────────────────────────────────────────


def _draft_span(core, text: str) -> tuple[int, int]:
    """`draft()` 가 돌려주는 구획의 `(start, end)` — `text[start:end].strip() == draft(text)`.

    규칙집 `draft()` 와 **같은 규칙**이다(마커형은 두 마커 사이, 구형은 `## DRAFT` 줄
    다음부터 `## STATUS|INPUT|RESEARCH|FACTS|OPEN` 또는 파일 끝). 구획 밖 글자는 앱이
    건드리지 않으므로, 이 경계를 잘못 잡으면 조용히 남의 글을 지운다 — 그래서 매번 단언한다.
    """
    start_marker, end_marker = core.START, core.END
    if start_marker in text or end_marker in text:
        if (
            text.count(start_marker) != 1
            or text.count(end_marker) != 1
            or text.index(start_marker) > text.index(end_marker)
        ):
            raise RpcError("draft_unregistered", "DRAFT 경계가 손상됐어요.")
        start = text.index(start_marker) + len(start_marker)
        end = text.index(end_marker)
    else:
        m = re.search(
            r"^##\s+DRAFT[^\n]*\n(.*?)(?=^##\s+(?:STATUS|INPUT|RESEARCH|FACTS|OPEN)\b|\Z)",
            text,
            re.M | re.S,
        )
        start, end = (m.start(1), m.end(1)) if m else (0, len(text))
    if core.draft(text) != text[start:end].strip():
        raise RpcError("draft_unregistered", "DRAFT 구획 경계를 확인하지 못했어요.")
    return start, end


def _place_noclobber(path: Path, data: bytes, mode: int) -> None:
    """`path` 에 새 파일을 놓는다 — **자리에 파일이 있으면 실패**(덮어쓰지 않음).

    임시 파일에 다 쓴 뒤 하드 링크로 자리에 붙인다. 링크는 원자적이고, 이미 있으면
    `FileExistsError` 다. 하드 링크를 못 하는 파일 시스템이면 그대로 실패한다 — 그때는
    직접 수정을 하지 않는 것이 설계다(§4-2 7).
    """
    fd = None
    tmp = None
    try:
        fd, tmp_name = tempfile.mkstemp(prefix=".gg-edit-", dir=path.parent)
        tmp = Path(tmp_name)
        with os.fdopen(fd, "wb") as handle:
            fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.link(tmp, path)
    finally:
        if fd is not None:
            os.close(fd)
        if tmp is not None and tmp.exists():
            tmp.unlink()


def _displace(path: Path, dest: Path) -> None:
    """지금 파일을 보존 폴더로 옮긴다 — 그 순간의 바이트가 통째로 잡힌다."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(path, dest)


def _write_exclusive(path: Path, data: bytes, mode: int) -> None:
    """`O_CREAT|O_EXCL` 로 새 파일을 만든다 — 자리에 있으면 실패(덮어쓰지 않음).

    하드 링크를 못 쓰는 폴더의 **되돌리기 전용** 마지막 수단이다. 새로 만드는 것이라
    남의 파일을 지우지 않는다. 다만 쓰는 도중의 내용이 보일 수 있어서 저장(놓기)에는
    쓰지 않는다 — 놓기는 `_place_noclobber` 만 한다.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def _restore_noclobber(path: Path, src: Path) -> None:
    """보존본을 제자리에 돌려놓는다 — 자리에 이미 있으면 실패(남의 글을 지우지 않는다).

    하드 링크가 안 되는 폴더에서도 **원고를 보존 폴더에 가둔 채 끝내지 않는다** —
    `O_EXCL` 로 새로 만드는 쪽으로 물러선다.
    """
    data = src.read_bytes()
    mode = src.stat().st_mode & 0o7777
    try:
        _place_noclobber(path, data, mode)
    except FileExistsError:
        raise
    except OSError:
        _write_exclusive(path, data, mode)
    src.unlink()


def _probe_noclobber(dirs: set[Path], backup_root: Path) -> None:
    """'있으면 실패' 놓기가 이 폴더에서 실제로 되는지 **저장 전에** 시험한다(§4-2 7).

    안 되는 폴더(하드 링크 불가 네트워크 공유 등)면 원고가 한 번도 움직이지 않은 채
    `edit_failed` 로 끝난다 — 밀어낸 뒤에 실패하는 경로를 만들지 않는다. 보존 폴더가
    다른 볼륨이면 밀어내기(`os.replace`)가 원자적이지 않으므로 그것도 여기서 닫는다.
    """
    try:
        backup_root.mkdir(parents=True, exist_ok=True)  # 원장 폴더와 같은 곳(같은 디스크)
    except OSError as error:
        raise RpcError("ledger_unreadable", "고침 기록을 남길 수 없어요: %s" % error) from error
    for directory in dirs:
        if directory.stat().st_dev != backup_root.stat().st_dev:
            raise RpcError(
                "edit_failed",
                "원고와 보존 폴더가 다른 디스크에 있어요 — 덮어쓰지 않고 저장할 수 없어요.",
            )
        probe = directory / (".gg-edit-probe-%s" % uuid.uuid4().hex[:8])
        try:
            _place_noclobber(probe, b"", 0o600)
        except FileExistsError:
            continue
        except OSError as error:
            raise RpcError(
                "edit_failed",
                "이 폴더에서는 덮어쓰지 않고 저장할 수 없어요(하드 링크 불가): %s" % error,
            ) from error
        finally:
            try:
                probe.unlink()
            except OSError:
                pass


# ── §2-2 판정 도우미 ────────────────────────────────────────────────────────


def _check_keys(core, root: Path, p: dict) -> set[tuple[str, str, str]]:
    """검사 결과 전체를 비교 가능한 집합으로. 절 ID 로 좁히지 않는다 — `rule_location`
    대상은 규칙 ID, 본문-재무 대조는 `body`·사실 ID 라 좁히면 놓친다."""
    return {(r["check_id"], str(r["target"]), r["reason"]) for r in core.checks(root, p)}


def _numbers(text: str) -> list[str]:
    """글 안의 숫자 나열 — 쉼표·소수점은 그대로 두고 비교한다.

    주장으로 등록되지 않은 수치까지 잡는 그물이라(`2,000`→`3,000` 같은 조용한 변경),
    `splitBlocks` 로 문단을 나눈 뒤가 아니라 **고친 문단 그대로** 본다.
    """
    return re.findall(r"\d[\d,.]*", text)


def _quotes_in(core, root: Path, p: dict, section_id: str, block: str) -> bool:
    """그 문단 안에 이 절의 주장 인용문이나 규칙 적용 위치 인용문이 하나라도 있었나."""
    entry = p["sections"].get(section_id) or {}
    for claim in entry.get("claims") or []:
        quote = claim.get("quote") if isinstance(claim, dict) else None
        if quote and quote in block:
            return True
    for rule in p.get("rules", {}).values():
        for location in rule.get("locations") or []:
            if not isinstance(location, dict) or location.get("section_id") != section_id:
                continue
            quote = location.get("quote")
            if quote and quote in block:
                return True
    return False


def _stale_count(before_stale: dict[str, bool], after: dict) -> int:
    """새로 낡은 검토 수. 판정에는 넣지 않고 알림용으로만 싣는다(§2-2)."""
    return sum(
        1
        for rid, review in after.get("reviews", {}).items()
        if review.get("stale") and not before_stale.get(rid)
    )


def _normalize(raw: str) -> tuple[str, list[int]]:
    """`\\r\\n`/`\\r` → `\\n` 로 바꾼 글과, 정규 위치 → 원본 위치 대응표.

    규칙집은 원고를 `read_text()` 로 읽어 줄바꿈을 이미 `\\n` 으로 바꾼다(정본 지문도
    그 글에서 나온다). 저장할 때 원래 줄바꿈을 지키려면 원본 위치로 되돌릴 수 있어야
    해서 대응표를 함께 만든다.
    """
    out: list[str] = []
    index: list[int] = []
    i = 0
    while i < len(raw):
        if raw[i] == "\r":
            out.append("\n")
            index.append(i)
            i += 2 if raw.startswith("\r\n", i) else 1
            continue
        out.append(raw[i])
        index.append(i)
        i += 1
    index.append(len(raw))
    return "".join(out), index




class _Manuscript:
    """한 절의 원고 바이트. 고침은 **메모리에서만** 누적되고 `write()` 때 디스크로 간다."""

    def __init__(self, core, root: Path, p: dict, sid: str, expected_draft_hash):
        entry = p["sections"].get(sid)
        if entry is None:
            raise RpcError("not_found", "절 없음: %s" % sid)
        if expected_draft_hash is not None and entry.get("draft_hash") != expected_draft_hash:
            raise RpcError("stale_view", "그사이 글이 바뀌었어요. 다시 골라 주세요.")
        self.core = core
        self.path = core.local(root, entry["path"])
        try:
            self.raw_bytes = self.path.read_bytes()
            self.raw = self.raw_bytes.decode("utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise RpcError("edit_failed", "원고를 읽지 못했어요: %s" % error) from error
        self.text, self.index = _normalize(self.raw)
        if core.digest(core.draft(self.text)) != entry.get("draft_hash"):
            raise RpcError(
                "draft_unregistered",
                "이 장은 앱 밖에서 고친 내용이 있어요. 도우미에게 먼저 확인받아 주세요.",
            )
        self.start, self.end = _draft_span(core, self.text)
        # 원본 위치는 여기서 한 번만 잡는다 — 고친 글의 길이가 달라지면 정규 위치로는
        # 더 이상 원본을 가리키지 못한다.
        self.start_raw, self.end_raw = self.index[self.start], self.index[self.end]

    def replace(self, before_block: str, after_block: str) -> str:
        """문단 하나를 바꾼다. 구획 밖 글자·문단 수·마커 수가 그대로인지 매번 확인한다."""
        span = self.text[self.start:self.end]
        if span.count(before_block) != 1:
            raise RpcError("ambiguous", "고칠 문단을 본문에서 하나로 찾지 못했어요.")
        new_span = span.replace(before_block, after_block, 1)
        new_text = self.text[:self.start] + new_span + self.text[self.end:]
        if len(_split_blocks(self.core.draft(new_text))) != len(
            _split_blocks(self.core.draft(self.text))
        ):
            raise RpcError("edit_failed", "고친 결과가 문단 경계를 깨뜨려요.")
        for marker in (self.core.START, self.core.END):
            if new_text.count(marker) != self.text.count(marker):
                raise RpcError("edit_failed", "고친 결과가 DRAFT 경계를 바꿔요.")
        old_span, old_text = self.text[self.start:self.end], self.text
        self.text = new_text
        self.end = self.start + len(new_span)
        if self.text[:self.start] != old_text[:self.start] or self.text[self.end:] != old_text[self.start + len(old_span):]:
            self.text = old_text
            raise RpcError("edit_failed", "구획 밖 글자가 바뀌었어요.")
        return new_span

    def bytes(self) -> bytes:
        """저장할 바이트 — 원본의 줄바꿈 방식(CRLF/LF)을 그대로 지킨다."""
        span = self.text[self.start:self.end]
        if "\r\n" in self.raw[self.start_raw:self.end_raw]:
            span = span.replace("\n", "\r\n")
        return (self.raw[:self.start_raw] + span + self.raw[self.end_raw:]).encode("utf-8")


def _request_id(items: list[dict]) -> str:
    """`app:student-edit:<절>:<개정 전>:<전후 지문 12자>` — 정본 이력에 누가 고쳤는지 남는다."""
    payload = [{"section_id": i["section_id"], "before": i["before_block"], "after": i["after_block"]} for i in items]
    fingerprint = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()[:12]
    heads = "+".join(sorted({i["section_id"] for i in items}))
    return "%s%s:%s:%s" % (REQUEST_PREFIX, heads, items[0]["revision_before"], fingerprint)


# ── 저장 한 번 ──────────────────────────────────────────────────────────────


def _write_manuscripts(records: list[dict], backup: Path) -> None:
    """원고들을 밀어내고 새 글을 놓는다 — 어느 단계도 남의 글을 덮어쓰지 않는다."""
    for record in records:
        record["backup"] = backup / ("displaced-1-%s" % record["section_id"])
    for record in records:
        _displace(record["path"], record["backup"])


def _verify_displaced(records: list[dict]) -> None:
    """밀어낸 바이트가 읽어 둔 A 와 같은지 본다. 다르면 `stale_view` — 원복은 `_revert` 몫."""
    for record in records:
        if record["backup"].read_bytes() != record["raw"]:
            raise RpcError("stale_view", "그사이 글이 바뀌었어요. 다시 골라 주세요.")


def _place(records: list[dict]) -> None:
    """새 글 C 를 자리에 놓는다. 자리에 이미 있으면(남이 썼다) `stale_view`."""
    placed = []
    for record in records:
        try:
            _place_noclobber(record["path"], record["new"], record["mode"])
        except FileExistsError:
            for done in placed:
                try:
                    done["path"].unlink()
                except OSError:
                    pass
            raise RpcError("stale_view", "그사이 글이 바뀌었어요. 다시 골라 주세요.") from None
        except OSError as error:
            for done in placed:
                try:
                    done["path"].unlink()
                except OSError:
                    pass
            raise RpcError("edit_failed", "덮어쓰지 않고 저장할 수 없어요: %s" % error) from error
        placed.append(record)


def _revert(records: list[dict], backup: Path) -> None:
    """`not_committed`/`indeterminate` 에서 원고를 되돌린다 — 밀어내기로, 덮어쓰지 않고.

    지금 자리에 있는 것이 내가 놓은 C 와 똑같을 때만 A 를 돌려놓는다. C 가 아니면(남이
    썼다) 그것을 보존하고 손을 뗀다 — 어느 갈래에서도 누군가의 바이트가 지워지지 않는다.
    """
    for record in records:
        if not record["backup"].exists():
            continue  # 밀어내기 전에 멈췄다 — 이 원고는 손대지 않았다
        current = backup / ("displaced-2-%s" % record["section_id"])
        if not record["path"].exists():
            # 내 글이 아직 안 놓였거나 남이 지웠다 — A 를 자리에 돌려놓는다(있으면 실패).
            try:
                _restore_noclobber(record["path"], record["backup"])
            except OSError:
                pass
            continue
        try:
            _displace(record["path"], current)
        except OSError:
            continue
        try:
            mine = current.read_bytes() == record["new"]
        except OSError:
            mine = False
        if not mine:
            # 남의 글 — 그대로 제자리에 돌려놓고 끝낸다.
            try:
                _restore_noclobber(record["path"], current)
            except OSError:
                pass
            continue
        try:
            _restore_noclobber(record["path"], record["backup"])
        except OSError:
            try:
                _restore_noclobber(record["path"], current)
            except OSError:
                pass


def _commit(core, root: Path, items: list[dict], expected_revision: int,
            record: bool = True) -> dict:
    """고침 묶음 하나를 정본에 저장한다(한 개정). 실패하면 아무것도 남기지 않는다."""
    p = core.load(root)
    rows = _read_ledger(root)  # 못 읽으면 여기서 멈춘다(닫힌 쪽 실패)
    # 요청 ID 는 **고치기 전** 개정을 담는다. 그래서 두 번째 호출(개정이 이미 올라간
    # 뒤)도 같은 ID 로 계산된다 — 개정 대조보다 먼저 중복을 본다.
    request_id = _request_id([dict(i, revision_before=expected_revision) for i in items])
    replay = _replay(core, root, p, rows, request_id)
    if replay is not None:
        return replay
    if p["revision"] != expected_revision:
        raise RpcError("stale_view", "그사이 글이 바뀌었어요. 다시 골라 주세요.")
    seen = set()
    for item in items:
        key = (item["section_id"], item["before_block"])
        if key in seen:
            raise RpcError("invalid_params", "같은 문단을 한 묶음에 두 번 고칠 수 없어요.")
        seen.add(key)
        if not item["before_block"].strip() or not item["after_block"].strip():
            raise RpcError("invalid_params", "고치기 전·후 문단이 비어 있어요.")
        if item["before_block"] == item["after_block"]:
            raise RpcError("invalid_params", "바뀐 글자가 없어요.")

    edit_id = "edit-%s" % uuid.uuid4().hex[:16]
    before_checks = _check_keys(core, root, p)
    before_reviews = {rid: bool(r.get("stale")) for rid, r in p.get("reviews", {}).items()}

    manuscripts: dict[str, _Manuscript] = {}
    for item in items:
        sid = item["section_id"]
        if sid not in manuscripts:
            manuscripts[sid] = _Manuscript(core, root, p, sid, item.get("expected_draft_hash"))
        manuscripts[sid].replace(item["before_block"], item["after_block"])

    records = [
        {
            "section_id": sid,
            "path": ms.path,
            "raw": ms.raw_bytes,
            "new": ms.bytes(),
            "mode": ms.path.stat().st_mode & 0o7777,
        }
        for sid, ms in manuscripts.items()
    ]
    backup_root = root / LEDGER_DIR / BACKUP_DIR
    backup = backup_root / edit_id
    _probe_noclobber({record["path"].parent for record in records}, backup_root)

    _append_ledger(root, {
        "edit_id": edit_id,
        "at": _now(),
        "revision_before": p["revision"],
        "revision_after": None,
        "edits": [
            {"section_id": i["section_id"], "before_block": i["before_block"], "after_block": i["after_block"]}
            for i in items
        ],
        "needs_check": None,
        "new_issues": [],
        "state": "writing",
        "request_id": request_id,
    })

    try:
        _write_manuscripts(records, backup)
        _verify_displaced(records)
        _place(records)
    except RpcError as error:
        _revert(records, backup)
        _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id))
        raise error
    except OSError as error:
        _revert(records, backup)
        _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id))
        raise RpcError("edit_failed", "덮어쓰지 않고 저장할 수 없어요: %s" % error) from error

    ops = [{"collection": "sections", "value": dict(p["sections"][sid])} for sid in manuscripts]
    change = {"request_id": request_id, "ops": ops}
    cleanup_warning = None
    try:
        new_p = core.apply(root, change, p["revision"])
    except Exception as error:  # noqa: BLE001 - commit_state decides, never the type
        new_p, cleanup_warning = _recover(
            core, root, error, records, backup, p, manuscripts, edit_id, items, request_id
        )
    # 확정 — 보존 폴더는 이것만 지운다(거절·이상에서는 남긴다).
    if cleanup_warning is None:
        try:
            shutil.rmtree(backup)
        except OSError:
            cleanup_warning = "보존 폴더를 지우지 못했어요."

    after_checks = _check_keys(core, root, new_p)
    new_issues = [
        {"check_id": cid, "reason": reason}
        for (cid, _target, reason) in sorted(after_checks - before_checks)
    ]
    numbers_changed = any(
        _numbers(i["before_block"]) != _numbers(i["after_block"]) for i in items
    )
    quotes_touched = any(
        _quotes_in(core, root, p, i["section_id"], i["before_block"]) for i in items
    )
    blocking = [i for i in new_issues if i["check_id"] != "dependency_revision"]
    needs_check = bool(blocking) or numbers_changed or quotes_touched
    reviews_staled = _stale_count(before_reviews, new_p)
    recheck = reviews_staled > 0 or any(
        i["check_id"] == "dependency_revision" for i in new_issues
    )
    if record:
        _append_ledger(root, _row(
            p, edit_id, items, "pending" if needs_check else "plain", new_issues,
            needs_check, revision_after=new_p["revision"], request_id=request_id,
        ))
    result = {
        "revision": new_p["revision"],
        "draft_hash": new_p["sections"][items[0]["section_id"]]["draft_hash"],
        "needs_check": needs_check,
        "new_issues": new_issues,
        "reviews_staled": reviews_staled,
        "recheck_before_submit": recheck,
        "edit_id": edit_id,
    }
    if cleanup_warning:
        result["cleanup_warning"] = cleanup_warning
    return result


def _replay(core, root: Path, p: dict, rows: list[dict], request_id: str) -> dict | None:
    """같은 요청을 두 번 보내면 **한 번만** 반영한다(§4-2: 요청 ID 중복 제거).

    두 번째 호출은 파일을 다시 쓰지 않고, 원장에 남은 그 요청의 결과를 그대로 돌려준다 —
    첫 호출이 이미 저장했으므로 `before_block` 은 본문에 없다.
    """
    if request_id not in (p.get("requests") or {}):
        return None
    for row in _latest(rows).values():
        if row.get("request_id") == request_id and row.get("state") in CONFIRMED_STATES:
            return {
                "revision": row.get("revision_after") if row.get("revision_after") is not None else p["revision"],
                "draft_hash": p["sections"][row["edits"][0]["section_id"]]["draft_hash"] if row.get("edits") else None,
                "needs_check": bool(row.get("needs_check")),
                "new_issues": row.get("new_issues") or [],
                "reviews_staled": 0,
                "recheck_before_submit": False,
                "edit_id": row["edit_id"],
                "replayed": True,
            }
    return None


def _row(p: dict, edit_id: str, items: list[dict], state: str, new_issues,
         needs_check, revision_after=None, request_id=None) -> dict:
    """원장 한 줄. 상태 변경도 **같은 `edit_id` 로 덧붙인다** — 앞 줄은 지우지 않는다."""
    return {
        "edit_id": edit_id,
        "request_id": request_id,
        "at": _now(),
        "revision_before": p["revision"],
        "revision_after": revision_after,
        "edits": [
            {"section_id": i["section_id"], "before_block": i["before_block"], "after_block": i["after_block"]}
            for i in items
        ],
        "needs_check": needs_check,
        "new_issues": new_issues,
        "state": state,
    }


def _commit_state(core, root: Path, error: Exception, expected: int, request_id: str | None = None) -> str:
    """`apply` 실패의 확정 여부. 예외 종류가 아니라 **저장된 정본을 다시 읽어** 정한다."""
    if isinstance(error, getattr(core, "OperationError", ())):
        state = error.result.get("commit_state")
        if state in ("not_committed", "committed_cleanup_pending", "indeterminate"):
            return state
    try:
        current = json.loads((root / "project.json").read_bytes())
    except (OSError, ValueError):
        return "indeterminate"
    revision = current.get("revision")
    if type(revision) is not int:
        return "indeterminate"
    if revision == expected:
        return "not_committed"
    if revision > expected and (request_id is None or request_id in (current.get("requests") or {})):
        return "committed_cleanup_pending"
    return "indeterminate"


def _recover(core, root, error, records, backup, p, manuscripts, edit_id, items, request_id):
    """`apply` 실패를 §4-2 7 대로 처분한다: 되돌릴 것만 되돌리고, 나머지는 그대로 둔다."""
    state = _commit_state(core, root, error, p["revision"], request_id)
    if state == "committed_cleanup_pending":
        return core.load(root), "정리만 남았어요: %s" % error
    if state == "not_committed":
        _revert(records, backup)
        _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id))
        raise RpcError("edit_failed", "그사이 글이 바뀌어 저장하지 못했어요. 다시 골라 주세요.") from error
    # indeterminate — 정본을 다시 읽어 내 글 지문인지 본다. 읽지 못하면 손대지 않고 알린다.
    try:
        current = core.load(root)
        mine = all(
            current["sections"][sid]["draft_hash"] == core.digest(core.draft(ms.text))
            for sid, ms in manuscripts.items()
        )
    except Exception:  # noqa: BLE001 - 판정 불가는 되돌리지 않는 쪽이 안전하다
        raise RpcError("indeterminate", "저장 여부를 확인하지 못했어요. 원고를 그대로 두었어요.") from error
    if mine:
        return current, "정리만 남았어요: %s" % error
    _revert(records, backup)
    _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id))
    raise RpcError("edit_failed", "그사이 글이 바뀌어 저장하지 못했어요. 다시 골라 주세요.") from error


# ── 공개 메서드 ─────────────────────────────────────────────────────────────


def section_edit(ctx, params):
    core = _core()
    root = _root(params)
    sid = params.get("id")
    if not isinstance(sid, str) or not sid:
        raise RpcError("invalid_params", "id(절) 필요")
    before_block = params.get("before_block")
    after_block = params.get("after_block")
    if not isinstance(before_block, str) or not isinstance(after_block, str):
        raise RpcError("invalid_params", "before_block·after_block 필요")
    revision = params.get("expected_revision")
    if type(revision) is not int:
        raise RpcError("invalid_params", "expected_revision(정수) 필요")
    item = {
        "section_id": sid,
        "before_block": before_block,
        "after_block": after_block,
        "expected_draft_hash": params.get("expected_draft_hash"),
    }
    return _commit(core, root, [item], revision)


def section_edit_batch(ctx, params):
    core = _core()
    root = _root(params)
    edits = params.get("edits")
    if not isinstance(edits, list) or not edits:
        raise RpcError("invalid_params", "edits(고침 목록) 필요")
    revision = params.get("expected_revision")
    if type(revision) is not int:
        raise RpcError("invalid_params", "expected_revision(정수) 필요")
    items = []
    for edit in edits:
        if not isinstance(edit, dict):
            raise RpcError("invalid_params", "edits 원소는 객체여야 해요")
        sid = edit.get("section_id")
        before_block = edit.get("before_block")
        after_block = edit.get("after_block")
        if not isinstance(sid, str) or not sid:
            raise RpcError("invalid_params", "section_id 필요")
        if not isinstance(before_block, str) or not isinstance(after_block, str):
            raise RpcError("invalid_params", "before_block·after_block 필요")
        items.append({
            "section_id": sid,
            "before_block": before_block,
            "after_block": after_block,
            "expected_draft_hash": edit.get("expected_draft_hash"),
        })
    return _commit(core, root, items, revision)


def section_edit_undo(ctx, params):
    core = _core()
    root = _root(params)
    edit_id = params.get("edit_id")
    if not isinstance(edit_id, str) or not edit_id:
        raise RpcError("invalid_params", "edit_id 필요")
    revision = params.get("expected_revision")
    if type(revision) is not int:
        raise RpcError("invalid_params", "expected_revision(정수) 필요")
    p = core.load(root)
    rows = _latest(_read_ledger(root))
    row = rows.get(edit_id)
    if row is None:
        raise RpcError("not_found", "고침 기록 없음: %s" % edit_id)
    if row.get("state") not in ("plain", "pending", "sent"):
        raise RpcError("invalid_params", "이 고침은 되돌릴 수 없어요.")
    items = []
    for edit in reversed(row.get("edits") or []):
        sid = edit["section_id"]
        entry = p["sections"].get(sid)
        if entry is None:
            raise RpcError("not_found", "절 없음: %s" % sid)
        text = core.draft(core.local(root, entry["path"]).read_text(encoding="utf-8"))
        if text.count(edit["after_block"]) != 1:
            raise RpcError("ambiguous", "이 문장은 그 뒤에 다시 바뀌어서 되돌릴 수 없어요.")
        items.append({
            "section_id": sid,
            "before_block": edit["after_block"],
            "after_block": edit["before_block"],
            "expected_draft_hash": None,
        })
    result = _commit(core, root, items, revision, record=False)
    _append_ledger(root, _row(
        p, edit_id, row.get("edits") or [], "undone", row.get("new_issues") or [],
        row.get("needs_check"), revision_after=result["revision"],
        request_id=row.get("request_id"),
    ))
    result["undone_edit_id"] = edit_id
    return result


def _sections_of_request(request_id: str) -> list[str]:
    """`app:student-edit:<절>[+<절>]:<개정>:<지문>` → `[<절>, …]`(모르면 빈 목록)."""
    rest = request_id[len(REQUEST_PREFIX):]
    head = rest.split(":", 1)[0]
    return sorted({part for part in head.split("+") if part})


def section_edits(ctx, params):
    """고침 목록 — 원장 + 정본 요청 원장 대조(유실 복구). 읽기 전용.

    `remaining_issues` 는 그 고침이 만든 문제 중 **지금도 남아 있는 것**이다. `checks()` 는
    통과 행을 내지 않으므로 사유 글자로 맞춘다 — 대상은 규칙 ID·`body`·사실 ID 로 달라
    대상까지 맞추면 남은 문제를 놓친다.
    """
    core = _core()
    root = _root(params)
    p = core.load(root)
    rows = _latest(_read_ledger(root))
    live = {(r["check_id"], r["reason"]) for r in core.checks(root, p)}
    out = []
    for edit_id, row in sorted(rows.items(), key=lambda kv: kv[1].get("at") or ""):
        state = row.get("state")
        if state not in CONFIRMED_STATES:
            continue  # `writing`(쓰는 중)·`aborted`(저장 안 됨)는 목록에 없다
        out.append({
            "edit_id": edit_id,
            "at": row.get("at"),
            "state": state,
            "revision_before": row.get("revision_before"),
            "revision_after": row.get("revision_after"),
            "edits": row.get("edits") or [],
            "section_ids": sorted({e["section_id"] for e in (row.get("edits") or [])}),
            "needs_check": row.get("needs_check"),
            "new_issues": row.get("new_issues") or [],
            "remaining_issues": [
                issue for issue in (row.get("new_issues") or [])
                if (issue.get("check_id"), issue.get("reason")) in live
            ],
            "answered": state == "sent" and row.get("turn_done") is True,
        })
    confirmed = set()
    for row in rows.values():
        if row.get("state") not in CONFIRMED_STATES:
            continue
        confirmed.add(row["edit_id"])
        if row.get("request_id"):
            confirmed.add(row["request_id"])
    for request_id, entry in sorted((p.get("requests") or {}).items()):
        if not request_id.startswith(REQUEST_PREFIX) or request_id in confirmed:
            continue
        # 정본에는 있는데 원장에 확정 줄이 없다(줄 손상·`writing` 에서 멈춤·파일 삭제).
        out.append({
            "edit_id": request_id,
            "at": None,
            "state": "pending",
            "revision_before": None,
            "revision_after": entry.get("revision"),
            "edits": [],
            # 재확인 메모에 `<장 제목>` 이 필요하다 — 요청 ID 꼬리에서 절 ID 를 읽어 준다.
            "section_ids": _sections_of_request(request_id),
            "needs_check": True,
            "new_issues": [],
            "remaining_issues": [],
            "answered": False,
            "lost_record": True,
        })
    return out


def section_edits_mark(ctx, params):
    """보냄/되돌림 표시. 정본을 건드리지 않으므로 `write=True` 가 아니다(§5)."""
    root = _root(params)
    edit_ids = params.get("edit_ids")
    state = params.get("state")
    if not isinstance(edit_ids, list) or not all(isinstance(i, str) and i for i in edit_ids):
        raise RpcError("invalid_params", "edit_ids(문자열 목록) 필요")
    if state not in MARK_STATES:
        raise RpcError("invalid_params", "state는 sent|pending")
    rows = _latest(_read_ledger(root))
    missing = [i for i in edit_ids if i not in rows]
    if missing:
        raise RpcError("not_found", "고침 기록 없음: %s" % ", ".join(missing))
    turn_done = params.get("turn_done") is True
    for edit_id in edit_ids:
        row = dict(rows[edit_id])
        row["state"] = state
        row["at"] = _now()
        if turn_done:
            row["turn_done"] = True
        _append_ledger(root, row)
    return {"marked": edit_ids, "state": state}


def register(server):
    """§8-1: 시작 때 필요한 공개 함수를 한 번 찔러 보고, 없으면 등록하지 않는다."""
    import gg_core

    if any(not hasattr(gg_core, name) for name in REQUIRED):
        return
    server.register("section.edit", section_edit, write=True)
    server.register("section.edit_batch", section_edit_batch, write=True)
    server.register("section.edit_undo", section_edit_undo, write=True)
    server.register("section.edits", section_edits)
    server.register("section.edits_mark", section_edits_mark)
