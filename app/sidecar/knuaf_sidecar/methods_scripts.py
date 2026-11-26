"""Subprocess-backed methods for the CLI-only scripts (DOCX, Excel, Office, deps, Kordoc)."""
from __future__ import annotations

import sys
from pathlib import Path

from .rpc import RpcError
from . import deps_contract
from .runner import run_script

TIMEOUTS = {"office": 120, "deps": 600, "kordoc": 240, "default": 120}

# S-01 설계 3판 §3.3: 의존성 환경은 main 이 정한 앱 데이터 경로(`deps_venv`)만 쓴다. 논문 폴더의
# `.venv` 는 찾지 않는다. gg_deps.py 자식의 작업 디렉터리는 이 사이드카 폴더(앱 자원) — 폴더는 인자로만.
SIDECAR_DIR = Path(__file__).resolve().parent
DEPS_ENV = "KNUAF_DEPS_VENV"
# main(deps-env.ts noneEnvDir)이 환경 없음을 알리는 폴더 이름 — 앱 데이터 `_none`, 그 자리가 안전하지 않을 때는
# 만들 수 없는 고정 경로. 둘 다 설치 대상이 아니다.
NONE_NAMES = ("_none", "knuaf-deps-none")
# 형님 결정 D-A: 도우미(에이전트) env 에만 1 로 싣는 "공유 환경 설치 거부" 표시. 사이드카는 앱의 '준비하기'
# 경로라 설치해야 하므로 자식에 절대 물려주지 않는다. 스킬이 거부하면 code `deps_venv_readonly`.
READONLY_ENV = "KNUAF_DEPS_VENV_READONLY"


def _deps_child_env(deps_venv: str) -> dict:
    return {DEPS_ENV: deps_venv, READONLY_ENV: None}
_ENV_INTERPRETERS = (("bin", "python3"), ("bin", "python"), ("Scripts", "python.exe"))


def _env_python(env_dir: str):
    if not env_dir:
        return None
    for rel in _ENV_INTERPRETERS:
        cand = Path(env_dir).joinpath(*rel)
        if cand.is_file():
            return cand
    return None


def _deps_venv(params, root: Path) -> str:
    """main 의 판정값. 키가 없으면 폴더를 뒤지지 않고 실행 전에 닫는다(빈 값 = 신뢰 환경 없음)."""
    if "deps_venv" not in params:
        raise RpcError("deps_contract_missing", "의존성 환경 판정(deps_venv)이 없음 — 앱이 정해 넘겨야 함")
    value = params.get("deps_venv") or ""
    if not isinstance(value, str):
        raise RpcError("invalid_params", "deps_venv 는 문자열이어야 함")
    if value:
        env, base = Path(value).resolve(), root.resolve()
        if env == base or base in env.parents or env in base.parents:
            raise RpcError("deps_venv_untrusted", "의존성 환경과 논문 폴더가 겹침", {"deps_venv": value})
    return value


def _scripts_dir() -> Path:
    import gg_core

    return Path(gg_core.__file__).parent


def _root(params) -> Path:
    root = params.get("root")
    if not isinstance(root, str) or not root:
        raise RpcError("invalid_params", "root(작업 폴더) 필요")
    return Path(root)


# Paths the project owns — outputs and project-authored inputs — must stay inside
# the working folder. Params naming a user-supplied original (a native file-picker
# result, the school's XLSX template) may legitimately be absolute and are not here.
CONFINED = frozenset({
    "in", "input", "body", "out", "out_dir", "out_map", "map", "values",
    "report", "receipt", "receipts", "legacy_map", "reference_inventory", "template_receipt", "spec",
})


def _confine(root, params):
    """Reject project-owned paths that escape the working folder.

    methods_core routes every path through gg_core.local(); the script methods did
    not, so an `out` of "../../../thesis.docx" reached the CLI unchecked.
    """
    import gg_core

    for key in CONFINED.intersection(params):
        value = params[key]
        if value is None or isinstance(value, bool):
            continue
        for item in value if isinstance(value, (list, tuple)) else (value,):
            try:
                gg_core.local(root, str(item))
            except ValueError as e:
                raise RpcError("invalid_params", "%s: %s" % (key, e)) from e


def _flags(params, names, positional=()):
    """Build argv from params: positional keys first, then --kebab-case flags."""
    argv = []
    for key in positional:
        if key not in params:
            raise RpcError("invalid_params", "%s 필요" % key)
        value = str(params[key])
        if value.startswith("-"):
            # argparse would read this as an option instead of the file.
            raise RpcError("invalid_params", "%s 값이 '-'로 시작할 수 없음" % key)
        argv.append(value)
    for key in names:
        if key in params and params[key] is not None:
            value = params[key]
            flag = "--" + key.replace("_", "-")
            if value is True:
                argv.append(flag)
            elif isinstance(value, (list, tuple)):
                argv.append(flag)
                argv.extend(map(str, value))
            elif value is not False:
                argv.extend([flag, str(value)])
    return argv


def _python_for(root: Path, needs_deps: bool, params=None):
    if not needs_deps:
        return sys.executable
    venv = _env_python(_deps_venv(params or {}, root))
    if venv is None:
        raise RpcError("deps_not_ready", "의존성 환경이 아직 준비되지 않음: deps.ensure 먼저", {"root": str(root)})
    return venv


def _run(ctx, params, script, argv, needs_deps=False, timeout_key="default", python=None, cwd=None, env_extra=None):
    root = _root(params)
    _confine(root, params)
    py = python or _python_for(root, needs_deps, params)
    timeout = float(params.get("timeout") or TIMEOUTS[timeout_key])
    return run_script(ctx, py, _scripts_dir() / script, argv, cwd=cwd or root, timeout=timeout, env_extra=env_extra)



def _output_flags(params, *, project=False):
    """The project is the RPC root, never an independently supplied path."""
    argv = ["--project", str(_root(params))] if project else []
    if params.get("major_id") is not None:
        argv += ["--major", str(params["major_id"])]
    return argv

# --- gg.py paper / build_docx ------------------------------------------------


def paper_generate(ctx, params):
    argv = ["paper", str(_root(params))] + _flags(params, ("input", "out", "body"))
    argv += _output_flags(params)
    return _run(ctx, params, "gg.py", argv)


def docx_build(ctx, params):
    argv = [str(_root(params))]
    if "in" in params:
        argv += ["--in", str(params["in"])]
    # `no_toc` — 앱이 표지 정보 없이 본문만 묶을 때. 안내가 "겉표지·목차 없이"다(실기기 QA-03).
    argv += _flags(params, ("out", "font", "no_toc"))
    argv += _output_flags(params)
    return _run(ctx, params, "build_docx.py", argv, needs_deps=True)


# --- Excel -------------------------------------------------------------------


def _excel_params(ctx, params):
    """Explicit selection wins; otherwise use the student's registered workbook.

    No student path means the CLI must validate an explicit template choice and
    the major's survey evidence. A selected file failure never falls back.
    """
    if params.get("source"):
        return params
    from .methods_core import materials_list

    finance = materials_list(ctx, params)["current_finance"]
    selected = dict(params)
    selected.pop("source", None)
    if finance["provided"]:
        if not finance["path"]:
            raise RpcError("invalid_params", "선택한 재무 파일 경로가 없음")
        selected["source"] = finance["path"]
    return selected


def excel_create(ctx, params):
    params = _excel_params(ctx, params)
    argv = ["create"] + _flags(params, ("source", "out", "template_ref", "reference_inventory"))
    argv += _output_flags(params, project=True)
    return _run(ctx, params, "gg_excel_template.py", argv)


def excel_inspect(ctx, params):
    params = _excel_params(ctx, params)
    argv = ["inspect"] + _flags(params, ("source", "out_map", "report", "legacy_map", "template_ref", "reference_inventory"))
    if params.get("source") is None:
        argv += _output_flags(params, project=True)
    return _run(ctx, params, "gg_excel_template.py", argv)


def excel_clear(ctx, params):
    params = _excel_params(ctx, params)
    argv = ["clear"] + _flags(params, ("source", "map", "out", "receipt", "allow_missing", "template_ref", "reference_inventory"))
    argv += _output_flags(params, project=True)
    return _run(ctx, params, "gg_excel_template.py", argv)


def excel_fill(ctx, params):
    argv = _flags(params, ("template", "map", "values", "out", "receipt"))
    argv += _output_flags(params, project=True)
    return _run(ctx, params, "gg_excel_fill.py", argv)


def excel_formula_patch(ctx, params):
    argv = _flags(params, ("source", "map", "out", "receipt"))
    argv += _output_flags(params, project=True)
    return _run(ctx, params, "gg_excel_formula_patch.py", argv, needs_deps=True)


def excel_print(ctx, params):
    argv = _flags(params, ("source", "map", "out", "receipt"))
    argv += _output_flags(params, project=True)
    return _run(ctx, params, "gg_excel_print.py", argv, needs_deps=True)


# --- Office ------------------------------------------------------------------


def office_doctor(ctx, params):
    argv = ["doctor"] + _flags(params, ("workspace",))
    return _run(ctx, params, "gg_office.py", argv)


def office_word(ctx, params):
    argv = ["word"] + _flags(params, ("resources", "timeout", "workspace"), positional=("input",))
    argv += ["--out-dir", str(params.get("out_dir") or "")]
    argv += _output_flags(params, project=True) + ["--json"]
    return _run(ctx, params, "gg_office.py", argv, needs_deps=True, timeout_key="office")


def office_excel(ctx, params):
    argv = ["excel"] + _flags(params, ("resources", "template_receipt", "spec", "timeout", "workspace"), positional=("input",))
    argv += ["--out-dir", str(params.get("out_dir") or "")]
    argv += _output_flags(params, project=True) + ["--json"]
    return _run(ctx, params, "gg_office.py", argv, needs_deps=True, timeout_key="office")


def office_batch(ctx, params):
    inputs = params.get("inputs") or []
    if not inputs:
        raise RpcError("invalid_params", "inputs 필요")
    argv = ["batch", *map(str, inputs), "--out-dir", str(params.get("out_dir") or "")] + _flags(params, ("timeout", "workspace"))
    argv += _output_flags(params, project=True) + ["--json"]
    return _run(ctx, params, "gg_office.py", argv, needs_deps=True, timeout_key="office")


def office_verify_lineage(ctx, params):
    argv = ["verify-template-lineage", str(params.get("input") or "")] + _flags(params, ("receipts",))
    return _run(ctx, params, "gg_office.py", argv, needs_deps=True)


def office_jobs(ctx, params):
    argv = ["jobs"] + _flags(params, ("workspace",))
    return _run(ctx, params, "gg_office.py", argv)


def office_clean(ctx, params):
    jobs = params.get("jobs") or []
    if not jobs:
        raise RpcError("invalid_params", "jobs(삭제할 작업 ID 목록) 필요")
    argv = ["clean", "--job", *map(str, jobs)]
    argv += _flags(params, ("workspace",))
    return _run(ctx, params, "gg_office.py", argv)


# --- deps / kordoc -----------------------------------------------------------


# 스킬 계약(§3.1: KNUAF_DEPS_VENV 가 있으면 <폴더>/.venv 를 보지 않음, -m/-c 자식은 -I -X utf8 + cwd=환경)을
# 선언하지 않은 판이면 gg_deps 를 띄우지 않는다(deps_contract.require → deps_contract_unsupported). 고정 v0.6.5 는
# 선언이 없으므로 이 판에서는 준비·점검이 이 오류로 닫히는 것이 정상이다 — 판 올림(D-U) 뒤 열린다.
def deps_ensure(ctx, params):
    root = _root(params)
    target = _deps_venv(params, root)
    if not target:
        raise RpcError("deps_contract_missing", "준비할 의존성 환경 경로(deps_venv)가 비어 있음")
    if Path(target).name in NONE_NAMES:
        # B-01: "환경 없음" 표시 경로는 만들지 않는다 — 준비 대상은 키 폴더뿐이다.
        raise RpcError("deps_contract_missing", "'환경 없음' 경로(%s)는 준비 대상이 아님" % Path(target).name)
    deps_contract.require(_scripts_dir())
    base = params.get("base_python") or sys.executable
    argv = ["ensure", str(root)] + _flags(params, ("find_links", "no_index"))
    result = _run(ctx, params, "gg_deps.py", argv, timeout_key="deps", python=base,
                  cwd=SIDECAR_DIR, env_extra=_deps_child_env(target))
    if result["ok"]:
        vpy = _env_python(target)
        result["venv_python"] = str(vpy) if vpy else None
        ctx.emit("restart_required", {"venv_python": result["venv_python"]})
    return result


def deps_doctor(ctx, params):
    from .methods_core import project_deps_report

    root = _root(params)
    deps_venv = _deps_venv(params, root)
    deps_contract.require(_scripts_dir())
    result = _run(ctx, params, "gg_deps.py", ["doctor", str(root)], cwd=SIDECAR_DIR, env_extra=_deps_child_env(deps_venv))
    if result["ok"]:
        result["data"] = project_deps_report(result["data"])
    return result


def kordoc_ensure(ctx, params):
    argv = ["ensure"] + _flags(params, ("cache_dir", "node", "pnpm", "kordoc", "timeout"))
    return _run(ctx, params, "gg_kordoc.py", argv, timeout_key="kordoc")


# --- notices (재무 양식 알림) --------------------------------------------------

# 계약(knuaf.notices/1)이 허용하는 선택 값은 둘뿐이다 — 모르는 값을 그대로 넘기면
# argparse 가 exit 2 로 끝나 "실행 오류"와 "잘못된 값"이 화면에서 구별되지 않는다.
NOTICE_CHOICES = ("direct_tell", "footnote")

# 학생에게 보이는 실패 문구. `rejected` 는 도구의 정상 거절(이미 골랐음·정본 개정 충돌 등)이라
# RPC 오류가 아니라 결과로 돌려준다 — 화면이 고칠 것이 없고, 원인 코드가 그대로 남아야 한다.
NOTICE_REJECT_TEXT = {
    "choice_value_invalid": "고를 수 없는 값이에요",
    "notice_identity_unknown": "이 알림을 찾지 못했어요(이미 지워졌을 수 있어요)",
    "choice_not_offered": "이 알림은 선택을 받지 않아요",
    "source_ref_missing": "선택을 적을 자리를 정본에서 찾지 못했어요",
    "revision_conflict": "그사이 논문 폴더가 바뀌었어요. 화면을 새로 고친 뒤 다시 골라 주세요",
    "apply_rejected": "정본이 선택을 받아들이지 않았어요",
    # 확인(`gg_notices.py confirm`)의 거절 사유 — 계약 §2-2.
    "notice_stale": "알림을 본 뒤에 파일이 바뀌었어요. 다시 요청해 주시면 지금 상태로 다시 알려 드릴게요",
    "record_not_active": "이 알림은 이미 처리됐어요",
    "relayed_quote_missing": "학생에게서 받은 답을 함께 적어 주세요",
    "confirm_source_missing": "확인한 경로를 함께 알려 주세요",
    "confirm_source_invalid": "확인한 경로와 전달한 답이 서로 맞지 않아요",
    "record_unwritable": "지금은 기록을 남길 수 없어요. 잠시 뒤 다시 눌러 주세요",
    "lineage_id_collision": "기록 자리가 겹쳐 확인을 적지 못했어요. 다시 요청해 주세요",
}


def notices_choose(ctx, params):
    """`gg_notices.py choose` — 학생 선택을 정본에 적고 알림 파일을 다시 쓴다.

    앱은 정본도 알림 파일도 직접 쓰지 않는다(계약). 값은 화이트리스트로 먼저 막고,
    도구가 아직 동봉되지 않았으면 조용히 성공한 척하지 않고 한국어 실패를 돌려준다.
    """
    identity = params.get("identity")
    if not isinstance(identity, str) or not identity.strip():
        raise RpcError("invalid_params", "identity(알림 식별자) 필요")
    identity = identity.strip()
    if identity.startswith("-"):
        # argparse 가 값을 옵션으로 읽는다.
        raise RpcError("invalid_params", "identity 값이 '-'로 시작할 수 없음")
    value = params.get("value")
    if value not in NOTICE_CHOICES:
        raise RpcError("invalid_params", "value 는 direct_tell 또는 footnote 만 가능")
    root = _root(params)
    if not root.is_dir():
        raise RpcError("invalid_params", "작업 폴더가 없음: %s" % root)
    if not (_scripts_dir() / "gg_notices.py").is_file():
        raise RpcError("notices_script_missing", "알림 기록 도구(gg_notices.py)가 이 앱에 없어 선택을 적지 못했어요")
    # 하위 명령 → 폴더(위치 인자) → 플래그 순서. gg_notices.py 의 `choose` 하위 파서가 그 순서다.
    envelope = _run(ctx, params, "gg_notices.py", ["choose", str(root), "--identity", identity, "--value", value])
    if envelope.get("status") == "rejected":
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        reason = data.get("reason") or "apply_rejected"
        envelope["ok"] = False
        envelope["block_reason"] = NOTICE_REJECT_TEXT.get(reason, "선택을 적지 못했어요(%s)" % reason)
    return envelope


def notices_confirm(ctx, params):
    """`gg_notices.py confirm` — 바뀐 계산 칸 알림을 학생이 확인했다고 정본에 적는다.

    출처(`--by`)는 도구가 **필수로** 받는다(기본값 없음 — 없으면 `confirm_source_missing`).
    앱 단추 경로는 늘 `app_click` 하나이고, 전달 문장이 실려 오면 그 문장만 `--relayed-quote`
    로 넘긴다. 둘을 함께 넘기면 `confirm_source_invalid` 이므로 **한 갈래만** 고른다.
    """
    identity = params.get("identity")
    if not isinstance(identity, str) or not identity.strip():
        raise RpcError("invalid_params", "identity(알림 식별자) 필요")
    identity = identity.strip()
    if identity.startswith("-"):
        # argparse 가 값을 옵션으로 읽는다.
        raise RpcError("invalid_params", "identity 값이 '-'로 시작할 수 없음")
    quote = params.get("relayed_quote")
    if quote is not None:
        # 빈 문장은 "전달한 답 없음"과 구별되지 않는다 — 조용히 app_click 으로 내려가지 않는다.
        if not isinstance(quote, str) or not quote.strip():
            raise RpcError("invalid_params", "relayed_quote 는 비어 있지 않은 문자열이어야 함")
        quote = quote.strip()
    root = _root(params)
    if not root.is_dir():
        raise RpcError("invalid_params", "작업 폴더가 없음: %s" % root)
    if not (_scripts_dir() / "gg_notices.py").is_file():
        raise RpcError("notices_script_missing", "알림 기록 도구(gg_notices.py)가 이 앱에 없어 확인을 적지 못했어요")
    # 하위 명령 → 폴더(위치 인자) → 플래그 순서. gg_notices.py 의 `confirm` 하위 파서가 그 순서다.
    argv = ["confirm", str(root), "--identity", identity]
    argv += ["--relayed-quote", quote] if quote is not None else ["--by", "app_click"]
    envelope = _run(ctx, params, "gg_notices.py", argv)
    if envelope.get("status") == "rejected":
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        reason = data.get("reason") or "apply_rejected"
        envelope["ok"] = False
        envelope["block_reason"] = NOTICE_REJECT_TEXT.get(reason, "확인을 적지 못했어요(%s)" % reason)
    return envelope


def register(server):
    for name, fn, write in (
        ("paper.generate", paper_generate, True),
        ("docx.build", docx_build, False),
        ("excel.create", excel_create, False),
        ("excel.inspect", excel_inspect, False),
        ("excel.clear", excel_clear, False),
        ("excel.fill", excel_fill, False),
        ("excel.formula_patch", excel_formula_patch, False),
        ("excel.print", excel_print, False),
        ("office.doctor", office_doctor, False),
        ("office.word", office_word, False),
        ("office.excel", office_excel, False),
        ("office.batch", office_batch, False),
        ("office.verify_lineage", office_verify_lineage, False),
        ("office.jobs", office_jobs, False),
        ("office.clean", office_clean, False),
        ("deps.ensure", deps_ensure, True),
        ("deps.doctor", deps_doctor, False),
        ("kordoc.ensure", kordoc_ensure, True),
        ("notices.choose", notices_choose, True),
        ("notices.confirm", notices_confirm, True),
    ):
        server.register(name, fn, write=write)
