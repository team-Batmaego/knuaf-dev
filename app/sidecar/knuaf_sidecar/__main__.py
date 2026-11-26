"""python -m knuaf_sidecar [--scripts-dir S]"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def default_scripts_dir() -> Path:
    env = os.environ.get("KNUAF_SCRIPTS_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for base in (here.parents[2] / "resources" / "skill" / "scripts",  # app checkout
                 here.parents[2] / "skill" / "scripts"):              # packaged resources/
        if (base / "gg_core.py").is_file():
            return base
    return here.parents[2] / "resources" / "skill" / "scripts"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="knuaf_sidecar")
    ap.add_argument("--scripts-dir", default=None)
    ap.add_argument("--interpreter-kind", default="unknown", help="bundled|venv|custom (informational)")
    a = ap.parse_args(argv)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if sys.version_info < (3, 10):
        sys.stdout.write('{"id": null, "error": {"code": "python_too_old", "message": "Python 3.10 이상 필요"}}\n')
        return 2
    # S-01 §3.3-1: 같은 프로세스 doctor.all 이 쓰는 의존성 환경. main 이 기동 env 로 싣는다 — 빠졌으면
    # 빈 값(신뢰 환경 없음)으로 고정해 폴더 .venv 로 떨어지지 않게 한다. 실행 중에는 바꾸지 않는다.
    os.environ.setdefault("KNUAF_DEPS_VENV", "")
    # D-A: READONLY 는 도우미 전용이다. 사이드카(=앱의 '준비하기')가 우연히 물려받아 설치를 거부당하지 않게 지운다.
    os.environ.pop("KNUAF_DEPS_VENV_READONLY", None)
    scripts = Path(a.scripts_dir) if a.scripts_dir else default_scripts_dir()
    if not (scripts / "gg_core.py").is_file():
        sys.stdout.write('{"id": null, "error": {"code": "scripts_missing", "message": "%s"}}\n' % scripts)
        return 2
    sys.path.insert(0, str(scripts))
    from . import methods_core, methods_edit, methods_scripts
    from .rpc import Server

    server = Server()
    methods_core.register(server)
    methods_scripts.register(server)
    methods_edit.register(server)
    server.register("sys.hello", lambda ctx, params: methods_core.sys_hello(ctx, {**params, "interpreter_kind": a.interpreter_kind}))
    server.write({"id": None, "event": "ready", "data": {"scripts_dir": str(scripts), "python": sys.executable}})
    server.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
