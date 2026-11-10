"""뷰어 직접 수정 — 원고 한 문단 저장 (설계 §4·§5).

규칙집의 공개 함수(`load`·`local`·`draft`·`digest`·`checks`·`apply`·`atomic`)만 쓴다.
비공개 함수(`_guarded`·`_apply_locked`)에 기대지 않는다 — 규칙집 판이 바뀌어도 깨지지 않게.

원고를 **덮어쓰지 않는다**(§4-2 6). 지금 파일을 보존 폴더로 밀어내고(그 순간의 바이트를
통째로 잡는다), 새 글은 "자리에 파일이 있으면 실패"하는 방식으로 놓는다. 그래서 어떤
순서로 남이 끼어들어도 누군가의 글이 지워지는 단계가 없다.

파일 다루는 차례·원복·보존 폴더 지우기는 **§4-4가 정본**이다. 원칙 넷:

- **P1 지문이 같을 때만 지운다.** 원고 자리·보존 폴더의 파일은 그 바이트가 내가 적어 둔
  지문(A=`sha_a` 또는 C=`sha_c`)과 같을 때만 지운다. 다르면 남의 글이다 — 보관하고 알린다.
- **P2 옮기기 시작한 뒤에는 글자를 새로 쓰지 않는다.** 공간이 드는 일(C 임시 파일, 원장
  `writing` 줄, 보존 폴더)은 원고를 움직이기 전에 끝낸다. 그 뒤로는 이름 바꾸기·이름
  걸기(하드 링크)·이름 떼기뿐이다.
- **P3 자리가 비는 순간은 기록에 남는다.** 밀어내기 전에 원장에 `writing` 줄과 파일
  목록·지문을 적고, 모든 입구(`section.read_all`·`section.edits`·세 편집 메서드)에서
  미완료 줄을 먼저 정리한다.
- **P4 되돌리는 길은 하나다.** 놓기 실패·`apply` 거절·재시작 복구가 모두 `_restore_file`
  하나를 쓴다.

원장(§5)은 `<논문 폴더>/.knuaf-gui/student-edits.jsonl` 에 한 줄씩 덧붙인다. 원장을 못
쓰면 원고도 고치지 않는다(닫힌 쪽으로 실패). 원장·보존 폴더 경로는 논문 폴더 안이고
바로가기(심볼릭 링크)가 아니어야 한다(§4-4-4).
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .methods_core import _core, _root
from .rpc import RpcError

LEDGER_DIR = ".knuaf-gui"
LEDGER_NAME = "student-edits.jsonl"
BACKUP_DIR = "edit-backup"
REQUEST_PREFIX = "app:student-edit:"
CONFIRMED_STATES = ("plain", "pending", "sent", "undone")
# 원장이 끝맺은 줄 전부 — `done`(되돌리기 작업 줄)·`aborted`(저장 안 됨)도 포함한다.
TERMINAL_STATES = CONFIRMED_STATES + ("done", "aborted")
MARK_STATES = ("sent", "pending")
# §8-1: 시작 때 한 번 찔러 보고, 없으면 `section.edit` 계열을 아예 등록하지 않는다
# (화면은 `methods.list` 를 보고 단추를 숨긴다).
REQUIRED = ("load", "local", "draft", "digest", "checks", "apply", "atomic", "START", "END")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ledger_path(root: Path) -> Path:
    # 원장 파일 자체가 바로가기면 폴더 검사로는 못 잡는다 — 파일까지 같은 검사를 건다.
    return _contained(root, "%s/%s" % (LEDGER_DIR, LEDGER_NAME))


def _contained(root: Path, name: str) -> Path:
    """`root` 안의 경로인지 확인하고 절대 경로를 돌려준다 — 바로가기는 거절한다.

    원고 경로는 규칙집 `core.local` 이 이미 가둔다. 원장·보존 폴더는 앱이 만드는
    경로라 그 검사를 안 거치므로 **같은 수준으로** 확인한다(§4-4-4). 바로가기(심볼릭
    링크)면 논문 폴더 밖 파일에 글이 적힐 수 있어서 한 칸이라도 걸리면 거절한다.
    """
    base = Path(root).resolve()
    target = base / name
    # 경로 성분 가운데 바로가기가 하나라도 있으면 거절(없는 성분은 만들 것이므로 통과).
    probe = base
    for part in Path(name).parts:
        probe = probe / part
        if probe.is_symlink():
            raise RpcError("ledger_unreadable", "앱 폴더가 바로가기예요: %s" % part)
    try:
        resolved = target.resolve()
    except OSError as error:
        raise RpcError("ledger_unreadable", "앱 폴더 경로를 확인하지 못했어요: %s" % error) from error
    if resolved != base and not resolved.is_relative_to(base):
        raise RpcError("ledger_unreadable", "앱 폴더 밖 경로는 쓸 수 없어요: %s" % name)
    return target


def _app_dir(root: Path) -> Path:
    """앱 소유 폴더(`.knuaf-gui`) — 논문 폴더 안, 바로가기 아님."""
    return _contained(root, LEDGER_DIR)


def _backup_root(root: Path) -> Path:
    """보존 폴더 뿌리 — 앱 소유 폴더 안."""
    return _app_dir(root) / BACKUP_DIR


def _check_backup(bundle: Path) -> Path:
    """보존 폴더 안의 경로인지 확인한다 — 그 안의 **모든 파일**에 같은 검사를 건다."""
    bundle = Path(bundle)
    if bundle.is_symlink():
        raise RpcError("ledger_unreadable", "보존 폴더가 바로가기예요: %s" % bundle.name)
    parent = bundle.parent
    if parent.is_symlink():
        raise RpcError("ledger_unreadable", "보존 상위 폴더가 바로가기예요: %s" % parent.name)
    return bundle


def _bundle_path(root: Path, edit_id: str) -> Path:
    """`<보존 뿌리>/<edit_id>` — 이름에 경로 구분자가 들어오면 거절한다."""
    if not edit_id or "/" in edit_id or "\\" in edit_id or edit_id in (".", ".."):
        raise RpcError("invalid_params", "보존 폴더 이름이 올바르지 않아요: %r" % edit_id)
    return _check_backup(_backup_root(root) / edit_id)


def _file_name(prefix: str, n: int) -> str:
    """보존 폴더 안 파일 이름 — 절 ID 대신 순번을 쓴다(§4-4-1)."""
    return "%s-%d" % (prefix, n)


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


def _displace(path: Path, dest: Path) -> None:
    """지금 파일을 보존 폴더로 옮긴다 — 그 순간의 바이트가 통째로 잡힌다."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(path, dest)


def _restore_noclobber(path: Path, src: Path) -> None:
    """보존본을 제자리에 돌려놓는다 — **이름 걸기 + 보존 이름 떼기**(§4-4-2).

    글자를 새로 쓰지 않으므로 반쯤 쓰인 원고가 생길 수 없고 디스크 공간도 들지 않는다
    (P2). 자리에 이미 파일이 있으면 `FileExistsError` — 남의 글을 지우지 않는다.
    이름 걸기가 안 되는 폴더면 그대로 올린다(삼키지 않는다 — `restore_pending`).
    """
    os.link(src, path)
    src.unlink()


def _remove_name(path: Path, sha: str) -> bool:
    """지문이 `sha` 인 파일 이름만 뗀다(P1). 다르면 남의 글이라 손대지 않고 `False`."""
    try:
        if hashlib.sha256(Path(path).read_bytes()).hexdigest() != sha:
            return False
    except OSError:
        return False
    try:
        Path(path).unlink()
    except OSError:
        return False
    return True


def _probe_noclobber(dirs: set[Path], backup_root: Path) -> None:
    """'있으면 실패' 놓기가 실제로 되는지 **저장 전에** 시험한다(§4-2 7).

    실제 놓기와 같은 모양으로 시험한다 — 보존 폴더에 만든 파일에 원고 자리 이름을 걸고
    떼는 것. 두 폴더가 같은 디스크가 아니면 밀어내기(`os.replace`)도 링크도 원자적이지
    않으므로 그것도 여기서 닫는다. 안 되는 폴더면 원고가 한 번도 움직이지 않은 채
    `edit_failed` 로 끝난다.
    """
    try:
        backup_root.mkdir(parents=True, exist_ok=True)  # 원장 폴더와 같은 곳(같은 디스크)
    except OSError as error:
        raise RpcError("ledger_unreadable", "고침 기록을 남길 수 없어요: %s" % error) from error
    probe = backup_root / (".gg-probe-%s" % uuid.uuid4().hex[:8])
    try:
        _write_backup(probe, b"", 0o600)
    except OSError as error:
        raise RpcError("ledger_unreadable", "고침 기록을 남길 수 없어요: %s" % error) from error
    try:
        for directory in dirs:
            if directory.stat().st_dev != backup_root.stat().st_dev:
                raise RpcError(
                    "edit_failed",
                    "원고와 보존 폴더가 다른 디스크에 있어요 — 덮어쓰지 않고 저장할 수 없어요.",
                )
            target = directory / (".gg-edit-probe-%s" % uuid.uuid4().hex[:8])
            try:
                _place(target, probe)
            except FileExistsError:
                continue
            except OSError as error:
                raise RpcError(
                    "edit_failed",
                    "이 폴더에서는 덮어쓰지 않고 저장할 수 없어요(하드 링크 불가): %s" % error,
                ) from error
            finally:
                try:
                    target.unlink()
                except OSError:
                    pass
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


CLEANUP_AFTER = timedelta(minutes=10)
RESTORED_NOTICE = "앱이 갑자기 꺼져서 마지막 고침이 저장되지 않았어요. 원고는 고치기 전 그대로예요."
KEPT_NOTICE = "다른 프로그램이 같은 장을 동시에 고쳤어요. 그 내용은 지우지 않고 따로 보관했어요."
RESTORE_PENDING_NOTICE = (
    "원고를 제자리에 돌려놓지 못했어요. 디스크 공간을 확인하고 앱을 다시 켜 주세요. "
    "원고는 보관 폴더에 그대로 있어요."
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha_of(path: Path) -> str | None:
    try:
        return _sha(Path(path).read_bytes())
    except OSError:
        return None


def _matches(path: Path, sha) -> bool:
    return isinstance(sha, str) and _sha_of(path) == sha


def _write_backup(path: Path, data: bytes, mode: int) -> None:
    """보존 폴더 안에 글자를 새로 쓴다 — ①·②에서만 쓴다(P2).

    앱만 쓰는 폴더라 임시 파일 → 이름 바꾸기로 놓는다. 자리에 있는 것은 내가 방금
    만든 `new-<n>` 뿐이다.
    """
    path = Path(path)
    fd, tmp_name = tempfile.mkstemp(prefix=".gg-new-", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def _place(path: Path, src: Path) -> None:
    """`src` 에 원고 자리 이름을 건다 — 자리에 이미 있으면 `FileExistsError`(§4-4-2).

    이름 걸기(하드 링크)는 원자적이고 공간이 들지 않는다. 글자를 쓰지 않으므로 반쯤 쓰인
    원고가 생길 수 없다(P2).
    """
    os.link(src, path)


def _discard_bundle(bundle: Path) -> None:
    """①·②에서 실패했을 때 보존 폴더를 이름으로 지운다 — 전부 내가 방금 만든 것."""
    for child in Path(bundle).glob("new-*"):
        try:
            child.unlink()
        except OSError:
            pass
    try:
        Path(bundle).rmdir()
    except OSError:
        pass


def _store_file(bundle: Path, record: dict) -> None:
    """파일 하나: ③-1 밀어내기 → ③-2 지문 확인 → ③-3 새 글 놓기(§4-4-1).

    어느 단계에서 실패해도 지우지 않는다 — 정리는 `_revert` 하나가 맡는다(P4).
    """
    displaced = bundle / _file_name("displaced-1", record["n"])
    _displace(record["path"], displaced)
    if not _matches(displaced, record["sha_a"]):
        raise RpcError("stale_view", "그사이 글이 바뀌었어요. 다시 골라 주세요.")
    try:
        _place(record["path"], bundle / _file_name("new", record["n"]))
    except FileExistsError:
        raise RpcError("stale_view", "그사이 글이 바뀌었어요. 다시 골라 주세요.") from None


def _restore_file(bundle: Path, n: int, path: Path, sha_a: str, sha_c: str) -> bool:
    """파일 한 개 되돌리기 — **유일한 원복 절차**(§4-4-2). 글자를 새로 쓰지 않는다.

    자리에 있는 것이 내가 놓은 C(`sha_c`)일 때만 A 를 돌려놓는다. C 가 아니면(남이 썼다)
    그것을 제자리에 돌려놓고 손을 뗀다. 돌려놓기 자체가 실패하면 `OSError` 를 그대로
    올린다 — 삼키지 않는다(부르는 쪽이 `restore_pending` 으로 알린다).
    """
    first = bundle / _file_name("displaced-1", n)
    second = bundle / _file_name("displaced-2", n)
    if not first.exists():
        return False  # 밀어낸 적 없다 — 아무것도 돌려놓지 않았다(알릴 것도 없다)
    if not path.exists():
        # 자리가 비었다. 되돌리던 중 꺼져 남의 글이 displaced-2 에 있으면 그것이 더 새 글이다.
        if second.exists() and not _matches(second, sha_c):
            _restore_noclobber(path, second)
        else:
            _restore_noclobber(path, first)
        return True
    if second.exists():
        return False  # 이미 되돌리던 중 — 자리의 글은 남의 것이니 손대지 않는다
    _displace(path, second)
    if _matches(second, sha_c):
        _restore_noclobber(path, first)  # 내 글만 걷어 내고 A 복귀
        return True
    _restore_noclobber(path, second)  # 남의 글을 제자리에 돌려놓는다
    return False


def _revert(records: list[dict], bundle: Path) -> None:
    """손댄 파일 전부를 4-4-2 로 되돌린다. 실패는 삼키지 않고 `restore_pending`."""
    failed: list[str] = []
    for record in records:
        try:
            _restore_file(bundle, record["n"], record["path"], record["sha_a"], record["sha_c"])
        except OSError:
            failed.append(record["rel"])
    if failed:
        raise RpcError(
            "restore_pending",
            RESTORE_PENDING_NOTICE,
            data={"restore_pending": failed, "backup": str(bundle)},
        )


def _recover_pending(core, root: Path) -> list[dict]:
    """§4-4-3 복구 — 끝줄이 없는 `writing` 줄을 디스크 사실만 보고 닫는다.

    여러 번 돌아도 결과가 같고 `apply` 를 부르지 않는다. 학생에게 묻지 않는다. 복구가
    실패하면 줄을 `writing` 으로 둔 채 `restore_pending` 알림만 남긴다.
    """
    try:
        rows = _read_ledger(root)
    except RpcError:
        return [{"kind": "restore_pending", "message": RESTORE_PENDING_NOTICE, "path": str(_backup_root(root))}]
    notices: list[dict] = []
    for row in _latest(rows).values():
        if row.get("state") != "writing":
            continue
        try:
            notices.extend(_recover_one(core, root, row, rows))
        except RpcError as error:
            notices.append({
                "kind": "restore_pending",
                "message": RESTORE_PENDING_NOTICE,
                "path": str(error.data.get("backup") if isinstance(error.data, dict) else _backup_root(root)),
                "edit_id": row.get("edit_id"),
            })
    return notices


def _recover_one(core, root: Path, row: dict, rows: list[dict]) -> list[dict]:
    """`writing` 줄 하나를 §4-4-3 표대로 처분하고 끝줄을 적는다."""
    edit_id = row["edit_id"]
    bundle = _bundle_path(root, edit_id)
    files = [f for f in (row.get("files") or []) if isinstance(f, dict) and type(f.get("n")) is int]
    try:
        p = core.load(root)
    except Exception:  # noqa: BLE001 - 판정 불가면 손대지 않고 줄을 그대로 둔다
        raise RpcError("indeterminate", "정본을 읽지 못했어요.", data={"backup": str(bundle)}) from None
    registered = bool(row.get("request_id")) and row["request_id"] in (p.get("requests") or {})
    restored = False
    kept = False
    for entry in files:
        n = entry["n"]
        try:
            path = core.local(root, entry.get("path"))
        except (ValueError, TypeError):
            continue
        sha_a, sha_c = entry.get("sha_a"), entry.get("sha_c")
        new = bundle / _file_name("new", n)
        if not path.exists():
            try:
                if registered and _matches(new, sha_c):
                    _restore_noclobber(path, new)  # 등록 뒤 남이 지운 드문 경우
                    restored = True
                elif not registered:
                    restored = _restore_file(bundle, n, path, sha_a, sha_c) or restored
            except OSError:
                raise RpcError("restore_pending", RESTORE_PENDING_NOTICE,
                               data={"backup": str(bundle)}) from None
            continue
        if registered:
            continue  # 등록됐으면 파일은 손대지 않는다(내 글이든 남의 글이든 정본이 정본)
        if _matches(path, sha_a):
            continue  # 밀어내기 전에 멈췄거나 이미 돌려놓았다
        if _matches(path, sha_c):
            try:
                restored = _restore_file(bundle, n, path, sha_a, sha_c) or restored
            except OSError:
                raise RpcError("restore_pending", RESTORE_PENDING_NOTICE,
                               data={"backup": str(bundle)}) from None
            continue
        kept = True  # 남이 그사이 씀 — 보존본은 보관
    # 되돌리기 작업 줄의 정상 끝 상태는 `done` 이다(§4-3·§4-4-8 6 '같은 순서').
    if registered:
        state = "done" if row.get("undo_of") else "pending"
    else:
        state = "aborted"
    notice = None
    if not registered and kept:
        notice = {"kind": "kept", "message": KEPT_NOTICE, "path": str(bundle), "edit_id": edit_id}
    elif not registered and restored:
        notice = {"kind": "restored", "message": RESTORED_NOTICE, "edit_id": edit_id}
    closing = dict(row, state=state, at=_now(), kept=kept)
    if registered:
        closing["revision_after"] = closing.get("revision_after") or p.get("revision")
    if notice is not None:
        closing["notice"] = notice
    _append_ledger(root, closing)
    if registered and row.get("undo_of"):
        _mark_undone(root, rows, row, p.get("revision"))
    return [notice] if notice is not None else []


def _mark_undone(root: Path, rows: list[dict], undo_row: dict, revision_after) -> None:
    """되돌리기 작업 줄의 대상 건을 `undone` 으로 적는다 — 저장이 끝난 다음(§4-4-1 ⑤)."""
    target = _latest(rows).get(undo_row.get("undo_of"))
    if target is None or target.get("state") == "undone":
        return
    _append_ledger(root, dict(target, state="undone", at=_now(), revision_after=revision_after))


def _cleanup(root: Path, rows: list[dict]) -> list[dict]:
    """§4-4-4 청소 — 끝줄이 적힌 지 10분이 지난 건만, 지문이 같은 파일만 지운다(P1)."""
    notices: list[dict] = []
    now = datetime.now(timezone.utc)
    for edit_id, row in _latest(rows).items():
        if row.get("state") not in TERMINAL_STATES or row.get("cleaned"):
            continue
        when = row.get("at")
        try:
            closed = datetime.fromisoformat(str(when))
        except (TypeError, ValueError):
            continue
        if now - closed < CLEANUP_AFTER:
            continue
        try:
            bundle = _bundle_path(root, edit_id)
        except RpcError:
            continue
        files = [f for f in (row.get("files") or []) if isinstance(f, dict) and type(f.get("n")) is int]
        kept_any = not files and bundle.is_dir()
        for entry in files:
            n = entry["n"]
            for name, sha in ((_file_name("new", n), None),
                              (_file_name("displaced-1", n), entry.get("sha_a")),
                              (_file_name("displaced-2", n), entry.get("sha_c"))):
                target = bundle / name
                if not target.exists():
                    continue
                if sha is None:
                    try:
                        target.unlink()  # 앱만 만드는 이름이라 지문을 안 본다
                    except OSError:
                        kept_any = True
                elif not _remove_name(target, sha):
                    kept_any = True
        if bundle.is_dir():
            try:
                bundle.rmdir()
            except OSError:
                kept_any = True
        notice = None
        if kept_any and bundle.is_dir():
            notice = {"kind": "kept", "message": KEPT_NOTICE, "path": str(bundle), "edit_id": edit_id}
            notices.append(notice)
        closing = dict(row, cleaned_at=_now(), cleaned=True, kept=kept_any)
        if notice is not None:
            closing["notice"] = notice
        _append_ledger(root, closing)
    return notices


def _commit(core, root: Path, items: list[dict], expected_revision: int,
            undo_of: str | None = None) -> dict:
    """고침 묶음 하나를 정본에 저장한다(한 개정). 차례는 §4-4-1 그대로."""
    _recover_and_clean(core, root)  # ⓪ 미완료 줄부터 정리(P3)
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

    records = []
    for n, (sid, ms) in enumerate(manuscripts.items()):
        new = ms.bytes()
        entry = p["sections"][sid]
        records.append({
            "n": n,
            "section_id": sid,
            "path": ms.path,
            "rel": entry["path"],
            "raw": ms.raw_bytes,
            "new": new,
            "mode": ms.path.stat().st_mode & 0o7777,
            "sha_a": _sha(ms.raw_bytes),
            "sha_c": _sha(new),
        })
    backup_root = _backup_root(root)
    _probe_noclobber({record["path"].parent for record in records}, backup_root)
    bundle = _bundle_path(root, edit_id)
    try:
        bundle.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        raise RpcError("ledger_unreadable", "고침 기록을 남길 수 없어요: %s" % error) from error
    # ① 짐 싸기 — 글자를 쓰는 일은 여기서 다 끝난다(P2).
    try:
        for record in records:
            _write_backup(bundle / _file_name("new", record["n"]), record["new"], record["mode"])
    except OSError as error:
        _discard_bundle(bundle)
        raise RpcError("edit_failed", "덮어쓰지 않고 저장할 수 없어요: %s" % error) from error
    # ② 쪽지 — 자리를 비우기 **전에** 원장에 적는다.
    try:
        _append_ledger(root, {
            "edit_id": edit_id,
            "at": _now(),
            "revision_before": p["revision"],
            "revision_after": None,
            "edits": [
                {"section_id": i["section_id"], "before_block": i["before_block"],
                 "after_block": i["after_block"]}
                for i in items
            ],
            "needs_check": None,
            "new_issues": [],
            "state": "writing",
            "request_id": request_id,
            "undo_of": undo_of,
            "files": [
                {"n": r["n"], "section_id": r["section_id"], "path": r["rel"],
                 "sha_a": r["sha_a"], "sha_c": r["sha_c"]}
                for r in records
            ],
        })
    except RpcError:
        _discard_bundle(bundle)
        raise
    # ③ 파일마다 밀고-확인-놓기.
    try:
        for record in records:
            _store_file(bundle, record)
    except RpcError as error:
        _abort(core, root, p, edit_id, items, records, bundle, request_id, undo_of, error)
    except OSError as error:
        _abort(core, root, p, edit_id, items, records, bundle, request_id, undo_of,
               RpcError("edit_failed", "덮어쓰지 않고 저장할 수 없어요: %s" % error))
    # ④ 등록 — 묶음도 한 개정.
    ops = [{"collection": "sections", "value": dict(p["sections"][sid])} for sid in manuscripts]
    change = {"request_id": request_id, "ops": ops}
    cleanup_warning = None
    try:
        new_p = core.apply(root, change, p["revision"])
    except Exception as error:  # noqa: BLE001 - commit_state decides, never the type
        new_p, cleanup_warning = _recover(
            core, root, error, records, bundle, p, manuscripts, edit_id, items, request_id, undo_of,
        )

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
    # ⑤ 마무리 — 보존 폴더는 지우지 않는다(청소 몫).
    state = "done" if undo_of else ("pending" if needs_check else "plain")
    _append_ledger(root, _row(
        p, edit_id, items, state, new_issues, needs_check,
        revision_after=new_p["revision"], request_id=request_id,
        files=[{"n": r["n"], "section_id": r["section_id"], "path": r["rel"],
                "sha_a": r["sha_a"], "sha_c": r["sha_c"]} for r in records],
        undo_of=undo_of,
    ))
    if undo_of:
        _mark_undone(root, _read_ledger(root), {"edit_id": edit_id, "undo_of": undo_of}, new_p["revision"])
    result = {
        "revision": new_p["revision"],
        "draft_hash": new_p["sections"][items[0]["section_id"]]["draft_hash"],
        "needs_check": needs_check,
        "new_issues": new_issues,
        "reviews_staled": reviews_staled,
        "recheck_before_submit": recheck,
        "edit_id": edit_id,
    }
    if undo_of:
        result["undone_edit_id"] = undo_of
    if cleanup_warning:
        result["cleanup_warning"] = cleanup_warning
    return result


def _abort(core, root, p, edit_id, items, records, bundle, request_id, undo_of, error):
    """③ 실패 — 손댄 파일 전부를 되돌리고 `aborted`. 되돌리기가 실패하면 `restore_pending`."""
    try:
        _revert(records, bundle)
    except RpcError as pending:
        raise pending from error  # 줄은 `writing` 그대로 — 다음 입구가 다시 시도한다
    _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id,
                             files=[{"n": r["n"], "section_id": r["section_id"], "path": r["rel"],
                                     "sha_a": r["sha_a"], "sha_c": r["sha_c"]} for r in records],
                             undo_of=undo_of))
    raise error


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
         needs_check, revision_after=None, request_id=None, files=None, undo_of=None) -> dict:
    """원장 한 줄. 상태 변경도 **같은 `edit_id` 로 덧붙인다** — 앞 줄은 지우지 않는다."""
    row = {
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
    if files is not None:
        row["files"] = files
    if undo_of is not None:
        row["undo_of"] = undo_of
    return row


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


def _recover(core, root, error, records, bundle, p, manuscripts, edit_id, items, request_id, undo_of=None):
    """`apply` 실패를 §4-2 7 대로 처분한다: 되돌릴 것만 되돌리고, 나머지는 그대로 둔다."""
    state = _commit_state(core, root, error, p["revision"], request_id)
    if state == "committed_cleanup_pending":
        return core.load(root), "정리만 남았어요: %s" % error
    if state == "not_committed":
        try:
            _revert(records, bundle)
        except RpcError:
            raise  # 줄은 writing 그대로 — 다음 입구가 다시 시도한다(§4-4-2)
        _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id,
                                 files=[{"n": r["n"], "section_id": r["section_id"], "path": r["rel"],
                                         "sha_a": r["sha_a"], "sha_c": r["sha_c"]} for r in records],
                                 undo_of=undo_of))
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
    try:
        _revert(records, bundle)
    except RpcError:
        raise
    _append_ledger(root, _row(p, edit_id, items, "aborted", [], None, request_id=request_id,
                             files=[{"n": r["n"], "section_id": r["section_id"], "path": r["rel"],
                                     "sha_a": r["sha_a"], "sha_c": r["sha_c"]} for r in records],
                             undo_of=undo_of))
    raise RpcError("edit_failed", "그사이 글이 바뀌어 저장하지 못했어요. 다시 골라 주세요.") from error


# ── 공개 메서드 ─────────────────────────────────────────────────────────────
def _guard(ctx):
    """복구·청소는 `write_lock` 안에서 돈다 — 읽기 메서드 입구에서도(§4-4-3)."""
    lock = getattr(getattr(ctx, "server", None), "write_lock", None)
    return lock if lock is not None else contextlib.nullcontext()


def _recover_and_clean(core, root: Path) -> list[dict]:
    """모든 입구가 먼저 부르는 한 줄 — 미완료 줄 복구(§4-4-3) 뒤 청소(§4-4-4)."""
    notices = _recover_pending(core, root)
    try:
        rows = _read_ledger(root)
    except RpcError:
        return notices
    notices.extend(_cleanup(root, rows))
    return notices




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
    _recover_and_clean(core, root)  # ⓪ 미완료 줄부터 정리(P3)
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
    # 되돌리기도 저장 한 건이다 — 자기 `writing` 줄을 `done` 으로 닫고, 대상 건 `undone` 은
    # 그 다음에 적는다(§4-3·§4-4-1 ⑤). 도중에 꺼지면 §4-4-3 복구가 같은 순서로 마무리한다.
    return _commit(core, root, items, revision, undo_of=edit_id)


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
    with _guard(ctx):
        notices = _recover_and_clean(core, root)
        p = core.load(root)
        rows = _latest(_read_ledger(root))
        live = {(r["check_id"], r["reason"]) for r in core.checks(root, p)}
    out = []
    for edit_id, row in sorted(rows.items(), key=lambda kv: kv[1].get("at") or ""):
        state = row.get("state")
        if state not in CONFIRMED_STATES:
            continue  # `writing`(쓰는 중)·`aborted`(저장 안 됨)는 목록에 없다
        if row.get("undo_of"):
            continue  # 되돌리기 작업 줄(`done`)은 목록에 안 보인다(§4-4-8 6)
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
        if row.get("state") not in TERMINAL_STATES:
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
    notices.extend(_stuck_notices(rows))
    return {"edits": out, "notices": notices}


def _stuck_notices(rows: dict[str, dict]) -> list[dict]:
    """`writing` 으로 남은 건을 숨기지 않고 알린다(§4-4-8 7)."""
    out = []
    for edit_id, row in rows.items():
        if row.get("state") == "writing":
            out.append({
                "kind": "restore_pending",
                "message": RESTORE_PENDING_NOTICE,
                "path": None,
                "edit_id": edit_id,
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


def _wrap_read_all(server):
    """`section.read_all` 앞에 복구·청소를 건다(§4-4-3 '모든 입구').

    화면이 논문을 처음 그릴 때 부르는 메서드라, 학생이나 AI 가 무엇을 하기 전에 빈 원고
    자리가 메워진다. 읽기 메서드지만 복구는 이름 걸기뿐이므로 `write_lock` 안에서 돌린다.
    등록을 가로채는 이유: `methods_core.py` 는 이 묶음 소유 파일이 아니다.
    """
    entry = server.methods.get("section.read_all")
    if entry is None:
        return
    fn, write = entry

    def read_all(ctx, params):
        core = _core()
        with _guard(ctx):
            _recover_and_clean(core, _root(params))
        return fn(ctx, params)

    server.register("section.read_all", read_all, write=write)


def register(server):
    """§8-1: 시작 때 필요한 공개 함수를 한 번 찔러 보고, 없으면 등록하지 않는다."""
    import gg_core

    if any(not hasattr(gg_core, name) for name in REQUIRED):
        return
    _wrap_read_all(server)
    server.register("section.edit", section_edit, write=True)
    server.register("section.edit_batch", section_edit_batch, write=True)
    server.register("section.edit_undo", section_edit_undo, write=True)
    server.register("section.edits", section_edits)
    server.register("section.edits_mark", section_edits_mark)
