"""Canonical writes must refuse a competing v2 owner without losing student bytes."""
import pytest

import gg_core as core


def test_competing_writer_preserves_canonical_and_release_allows_next_write(project):
    before = (project / "project.json").read_bytes()
    with core.Lock(project):
        with pytest.raises(ValueError):
            core.apply(project, {"request_id": "competing", "ops": []}, 1)
        assert (project / "project.json").read_bytes() == before
    core.apply(project, {"request_id": "after-release", "ops": []}, 1)
    assert core.load(project)["revision"] == 2
    assert "after-release" in core.load(project)["requests"]
