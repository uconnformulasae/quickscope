"""AiM pull progress snapshot for the session picker."""

from services import aim_pull_progress


def test_pull_progress_idle_by_default():
    aim_pull_progress.end_pull()
    snap = aim_pull_progress.snapshot()
    assert snap["active"] is False
    assert snap["phase"] == "idle"
    assert snap["bytes_received"] == 0


def test_pull_progress_tracks_current_file():
    aim_pull_progress.begin_pull(["a.xrk", "b.xrk"])
    aim_pull_progress.start_file(1, "a.xrk", 1000)
    aim_pull_progress.update_download(250, 1000)
    snap = aim_pull_progress.snapshot()
    assert snap["active"] is True
    assert snap["filename"] == "a.xrk"
    assert snap["file_index"] == 1
    assert snap["bytes_received"] == 250
    assert snap["bytes_total"] == 1000
    aim_pull_progress.end_pull()


def test_indexing_status_outlives_the_device_pull():
    # Arrange
    aim_pull_progress.begin_pull(["a.xrk"])
    aim_pull_progress.start_file(1, "a.xrk", 1000)
    aim_pull_progress.update_download(1000, 1000)
    aim_pull_progress.set_index_status("a.xrk", "running")

    # Act: the device is released before parsing finishes.
    aim_pull_progress.end_pull()

    # Assert
    snap = aim_pull_progress.snapshot()
    assert snap["active"] is False
    assert snap["indexing"] == {"a.xrk": "running"}
    aim_pull_progress.clear_indexing()
