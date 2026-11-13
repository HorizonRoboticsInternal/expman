import json
import shutil
from pathlib import Path

from expman.app import create_app
from expman.experiments import ExperimentRepository
from expman.paths import user_directory
from expman.store import StateStore


def test_default_storage_locations_and_view_roundtrip(example_logs, tmp_path, client_factory):
    root = tmp_path / "logs"
    shutil.copytree(example_logs, root)
    application = create_app(root)
    expected = root / ".expman" / "state.json"
    assert application.state.store.path == expected
    with client_factory(application) as client:
        workspace = client.get("/api/workspace").json()
        assert workspace["state_file"] == str(expected)
        assert workspace["settings_file"] == str(tmp_path / "user-data" / "settings.json")
        view = {
            "tab": "overview",
            "panels": ["train/loss"],
            "showAllPanels": True,
            "panelSize": "large",
            "logYPanels": ["train/loss"],
            "options": {"ignoreOutliers": True},
            "time": {"binary_window": 2001, "period_aware": False},
            "baseline": "saved-experiment",
            "associationScope": "configurations",
            "relationshipMetric": "eval/reward",
            "relationshipReduction": "smoothed_at_step",
            "relationshipSmoothing": 0.8,
            "categoricalConditions": ["batch_size"],
            "missingConditions": ["robot.mode"],
            "separateNullConditions": ["robot.mode"],
            "parallelKeysConfigured": True,
            "diffOnly": False,
            "configQuery": "robot",
            "configFullNames": True,
            "configColumnWidths": {"experiment-name": 320, "config:seed": 88},
            "configOrder": ["config:seed"],
            "configScalars": [
                {
                    "id": "latest",
                    "tag": "train/loss",
                    "mode": "latest",
                    "step": None,
                    "smoothing": 0.4,
                    "highlight": "smallest",
                    "highlight_color": "#fbcfe8",
                }
            ],
        }
        assert client.put("/api/view", json={"view": view}).json() == view
        assert expected.exists()
        settings = client.put("/api/settings", json={"auto_refresh": True}).json()
        assert settings["auto_refresh"]
        assert settings["appearance"]["text_color"] == "#000000"
    reopened = create_app(root)
    assert reopened.state.store.read()["view"] == view
    assert reopened.state.settings_store.read()["auto_refresh"]
    assert json.loads((tmp_path / "user-data" / "settings.json").read_text()) == settings


def test_user_home_default_and_override(tmp_path, monkeypatch):
    monkeypatch.delenv("EXPMAN_HOME")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    assert user_directory() == tmp_path / "home" / ".expman"
    monkeypatch.setenv("EXPMAN_HOME", str(tmp_path / "environment"))
    assert user_directory() == tmp_path / "environment"
    assert user_directory(tmp_path / "explicit") == tmp_path / "explicit"


def test_migrate_only_matching_workspace_and_preserve_source(example_logs, tmp_path, monkeypatch):
    root = tmp_path / "logs"
    shutil.copytree(example_logs, root)
    previous_cwd = tmp_path / "previous-working-directory"
    previous_cwd.mkdir()
    monkeypatch.chdir(previous_cwd)
    namespace = ExperimentRepository(root).workspace_id
    source = previous_cwd / ".expman" / "state.json"
    previous = StateStore(source, namespace)
    previous.update(
        lambda state: state.update(ignored_files=["hparams.yml"], view={"tab": "configs"})
    )
    other = StateStore(source, "unrelated-root")
    other.update(lambda state: state.update(ignored_files=["private.yaml"]))
    backup = source.read_bytes()
    application = create_app(root)
    assert application.state.store.read()["ignored_files"] == ["hparams.yml"]
    assert application.state.store.read()["view"] == {"tab": "configs"}
    assert source.read_bytes() == backup
    document = json.loads((root / ".expman" / "state.json").read_text())
    assert set(document["workspaces"]) == {namespace}
    assert "unrelated-root" not in document["workspaces"]
    previous.update(lambda state: state.update(ignored_files=["changed-in-legacy.yaml"]))
    assert create_app(root).state.store.read()["ignored_files"] == ["hparams.yml"]


def test_explicit_state_file_does_not_import_legacy(example_logs, tmp_path, monkeypatch):
    root = tmp_path / "logs"
    shutil.copytree(example_logs, root)
    monkeypatch.chdir(tmp_path)
    namespace = ExperimentRepository(root).workspace_id
    source = StateStore(tmp_path / ".expman" / "state.json", namespace)
    source.update(lambda state: state.update(ignored_files=["hparams.yml"]))
    custom = tmp_path / "custom" / "state.json"
    application = create_app(root, custom)
    assert application.state.store.path == custom
    assert application.state.store.read()["ignored_files"] == []
    assert not (root / ".expman" / "state.json").exists()


def test_state_location_is_independent_of_working_directory(tmp_path, monkeypatch):
    root = tmp_path / "logs"
    root.mkdir()
    first = create_app(root)
    first.state.store.update(lambda state: state.update(ignored_configs=["seed"]))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    second = create_app(root)
    assert second.state.store.path == first.state.store.path
    assert second.state.store.read()["ignored_configs"] == ["seed"]
    assert not (elsewhere / ".expman").exists()


def test_workspace_views_separate_but_user_settings_shared(tmp_path, client_factory):
    first_root, second_root = tmp_path / "first", tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first = create_app(first_root)
    with client_factory(first) as client:
        assert client.put("/api/view", json={"view": {"tab": "configs"}}).status_code == 200
        assert client.put("/api/settings", json={"auto_refresh": True}).status_code == 200
    second = create_app(second_root)
    assert second.state.store.read()["view"] == {}
    assert second.state.settings_store.read()["auto_refresh"]
    assert second.state.settings_store.read()["appearance"]["text_color"] == "#000000"
    assert first.state.store.path != second.state.store.path


def test_failed_settings_write_preserves_previous_data(client, monkeypatch):
    assert client.put("/api/settings", json={"auto_refresh": True}).status_code == 200
    store = client.app.state.settings_store
    previous = store.path.read_bytes()

    def fail_replace(*arguments):
        raise PermissionError("read-only storage")

    monkeypatch.setattr("expman.store.os.replace", fail_replace)
    response = client.put("/api/settings", json={"auto_refresh": False})
    assert response.status_code == 503
    assert "Check directory permissions" in response.json()["detail"]
    assert store.path.read_bytes() == previous
    assert store.read() == json.loads(previous)


def test_appearance_preferences_roundtrip_and_independent_settings_updates(client):
    default = client.get("/api/settings").json()
    assert default["appearance"]["text_color"] == "#000000"
    custom = {
        **default["appearance"],
        "font_family": "georgia",
        "font_size": 17,
        "text_color": "#eeeeee",
        "background_color": "#111111",
        "surface_color": "#222222",
        "difference_color": "#448855",
        "scalar_color": "#ffaaee",
    }
    response = client.put("/api/settings", json={"appearance": custom})
    assert response.status_code == 200
    assert response.json()["appearance"] == custom
    updated = client.put("/api/settings", json={"auto_refresh": True}).json()
    assert updated["appearance"] == custom
    stored = json.loads(client.app.state.settings_store.path.read_text())
    assert stored == updated
    reset = client.put("/api/settings", json={"appearance": default["appearance"]}).json()
    assert reset["appearance"]["text_color"] == "#000000"
    assert reset["auto_refresh"]


def test_invalid_appearance_is_rejected_without_changing_settings(client):
    original = client.get("/api/settings").json()
    for appearance in [
        {"text_color": "red; display:none"},
        {"font_size": 100},
        {"font_family": "url(https://example.invalid/font)"},
        {"difference_color": "green"},
        {"scalar_color": "pink"},
    ]:
        assert client.put("/api/settings", json={"appearance": appearance}).status_code == 422
    assert client.get("/api/settings").json() == original
