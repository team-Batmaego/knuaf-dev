import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "resources" / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gg_core  # noqa: E402
from knuaf_sidecar.methods_core import artifact_list, artifact_preview  # noqa: E402


def test_root_word_and_build_outputs(tmp_path):
    gg_core.init(tmp_path)
    review = tmp_path / "build" / "7" / "review"
    review.mkdir(parents=True)
    (review / "검토용.md").write_text("# 검토", encoding="utf-8")
    (tmp_path / "검토용_초안.docx").write_bytes(b"word")
    (tmp_path / "재무.xlsx").write_bytes(b"excel")
    (tmp_path / ".숨김.docx").write_bytes(b"hidden")
    (tmp_path / "sources").mkdir(exist_ok=True)
    (tmp_path / "sources" / "참고.docx").write_bytes(b"source")
    params = {"root": str(tmp_path)}
    paths = {item["path"]: item["kind"] for item in artifact_list(None, params)["items"]}
    assert paths["build/7/review/검토용.md"] == "md"
    assert paths["검토용_초안.docx"] == "docx"
    assert paths["재무.xlsx"] == "xlsx"
    assert ".숨김.docx" not in paths
    assert "sources/참고.docx" not in paths
    assert artifact_preview(None, {**params, "path": "build/7/review/검토용.md"})["text"] == "# 검토"
