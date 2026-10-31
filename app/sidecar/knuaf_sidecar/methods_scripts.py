"""Subprocess-backed methods for the CLI-only scripts (DOCX, Excel, Office, deps, Kordoc)."""
from __future__ import annotations

import sys
from pathlib import Path

from .rpc import RpcError
from .runner import project_python, run_script

TIMEOUTS = {"office": 120, "deps": 600, "kordoc": 240, "default": 120}


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


def _python_for(root: Path, needs_deps: bool):
    if not needs_deps:
        return sys.executable
    venv = project_python(root)
    if venv is None:
        raise RpcError("deps_not_ready", "프로젝트 .venv가 없음: deps.ensure 먼저", {"root": str(root)})
    return venv


def _run(ctx, params, script, argv, needs_deps=False, timeout_key="default", python=None):
    root = _root(params)
    _confine(root, params)
    py = python or _python_for(root, needs_deps)
    timeout = float(params.get("timeout") or TIMEOUTS[timeout_key])
    return run_script(ctx, py, _scripts_dir() / script, argv, cwd=root, timeout=timeout)



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


def deps_ensure(ctx, params):
    root = _root(params)
    base = params.get("base_python") or sys.executable
    argv = ["ensure", str(root)] + _flags(params, ("find_links", "no_index"))
    result = _run(ctx, params, "gg_deps.py", argv, timeout_key="deps", python=base)
    if result["ok"]:
        result["venv_python"] = project_python(root)
        ctx.emit("restart_required", {"venv_python": result["venv_python"]})
    return result


def deps_doctor(ctx, params):
    return _run(ctx, params, "gg_deps.py", ["doctor", str(_root(params))])


def kordoc_ensure(ctx, params):
    argv = ["ensure"] + _flags(params, ("cache_dir", "node", "pnpm", "kordoc", "timeout"))
    return _run(ctx, params, "gg_kordoc.py", argv, timeout_key="kordoc")


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
    ):
        server.register(name, fn, write=write)
