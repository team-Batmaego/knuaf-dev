# CI failures repair report

## Changes

- `tests/test_artifact_refresh.py:92`: compare preview text with `output.read_bytes().decode("utf-8")`. The assertion remains an exact equality; only the Windows universal-newline conversion in the expected value is removed.
- `.github/workflows/installer-e2e.yml:101`: set `KNUAF_PYTHON` to `${{ env.pythonLocation }}/bin/python` in the installed E2E step. `setup-python@v5` runs earlier in the macOS job and the helper consumes this variable. This workflow has no Windows installer-E2E job; Windows app E2E is in `ci.yml` and already sets `KNUAF_PYTHON` to its Windows `python.exe` path.
- `app/e2e/helpers.ts:21`: on `spawnSync` launch errors, include the Node error code and message. Other process failures still report stdout and stderr; exit and pass conditions are unchanged.

## Local verification

- Focused artifact test: `tests/test_artifact_refresh.py::test_registered_output_is_listed_from_canonical_managed_path` — **1 passed** on macOS.
- Windows newline behavior smoke: a CRLF file decoded from bytes preserved CRLF; `Path.read_text()` normalized to LF.
- Python selection smoke: with this worktree's `.venv-dev` absent, `KNUAF_PYTHON` was passed to helper subprocesses and successfully initialized a project. A missing interpreter produced an `ENOENT` diagnostic.
- Workflow YAML parsed with Ruby/Psych. Checked that `setup-python@v5` precedes installed E2E and that the step carries the expected `KNUAF_PYTHON` value. `actionlint` was unavailable.
- `pnpm -C app typecheck` — passed.
- `.venv-dev/bin/python -m ruff check .` — **All checks passed**.
- Active pre-commit gates passed: typecheck; pinned skill consumer **286 passed, 2 skipped**; pinned upstream **712 passed, 25 skipped, 3257 subtests passed**; staged skill **190 files**; root pytest **518 passed, 3 skipped**; harness selftest cache green. The root skips were the existing bundled runtime/wheelhouse test, real template test, and network Kordoc test.

## CI-only verification

- Native Windows 3.10/3.13 execution of the preview test is only verifiable in CI; local macOS checks do not exercise Windows `Path.write_text` translation.
- The macOS installer E2E execution after injecting runner Python is only verifiable in GitHub Actions; local smoke covered helper interpreter selection, not the installed app.
- No Windows job exists in `installer-e2e.yml`; `ci.yml` Windows app E2E already has an explicit `KNUAF_PYTHON`.

## Commit

- Implementation commit: `7d83464f8abfa17a80f58a5ab31bf26f18cff948` — `Fix Windows preview test and installer Python path`.
- This report is a separate documentation commit.
Not pushed.
