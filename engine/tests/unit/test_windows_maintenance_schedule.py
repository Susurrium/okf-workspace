from pathlib import Path


def test_windows_feed_sync_is_separate_from_daily_maintenance_and_retries() -> None:
    root = Path(__file__).resolve().parents[3]
    install = (root / "deploy" / "windows" / "install.ps1").read_text(
        encoding="utf-8-sig"
    )
    maintenance = (root / "deploy" / "windows" / "maintenance.ps1").read_text(
        encoding="utf-8-sig"
    )
    feed_sync = (root / "deploy" / "windows" / "feed-sync.ps1").read_text(
        encoding="utf-8-sig"
    )
    uninstall = (root / "deploy" / "windows" / "uninstall.ps1").read_text(
        encoding="utf-8-sig"
    )

    assert "$maintenanceTrigger = New-ScheduledTaskTrigger -Daily -At '02:30'" in install
    assert "$feedSyncTrigger = New-ScheduledTaskTrigger -Daily -At '06:50'" in install
    assert "New-ScheduledTaskSettingsSet" in install
    assert "-StartWhenAvailable" in install
    assert "-RestartCount 3" in install
    assert "-RestartInterval (New-TimeSpan -Minutes 10)" in install
    assert "-Settings $feedSyncSettings" in install
    assert "OKF Workspace Feed Sync" in install
    assert "feed sync" not in maintenance.casefold()
    assert "feed sync all" in feed_sync.casefold()
    assert "OKF Workspace Feed Sync" in uninstall
