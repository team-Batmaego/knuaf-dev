"""audit H10 + GUI prerequisite: lineage (project_id/parent_hash), history, restore."""
import json

import pytest

import gg_core as core




def test_history_lists_snapshots_and_current(project):
    hist = core.history(project)
    assert hist[0]["revision"] == 0 and hist[0]["snapshot_ok"] is True
    assert hist[-1]["current"] is True and hist[-1]["revision"] == 1


def test_restore_creates_new_revision_and_preserves_current_snapshot(project):
    out = core.restore(project, 0, 1)
    assert out["revision"] == 2 and out["restored_from"] == 0
    p = core.load(project)
    assert p["revision"] == 2 and p["sections"] == {} and p["facts"] == {}
    assert (project / "migration" / "revision-1.json").exists()
    assert [h["revision"] for h in p["history"]] == [0, 1]
    # the section file itself is untouched
    assert (project / "sections" / "01.md").exists()
    # and we can go forward again
    core.restore(project, 1, 2)
    assert core.load(project)["sections"]["sec-01"]["title"] == "Ⅰ. 머리말"


def test_restore_refuses_tampered_snapshot(project):
    snap = project / "migration" / "revision-0.json"
    data = json.loads(snap.read_text(encoding="utf-8"))
    data["issues"] = ["tampered"]
    snap.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        core.restore(project, 0, 1)


def test_restore_refuses_stale_expected_revision_and_held_lock(project):
    with pytest.raises(ValueError):
        core.restore(project, 0, 5)
    before = (project / "project.json").read_bytes()
    with core.Lock(project):
        with pytest.raises(ValueError):
            core.restore(project, 0, 1)
    assert (project / "project.json").read_bytes() == before
