import shutil

from expman.app import create_app
from expman.demo import generate_demo


def test_named_views_preserve_snapshots_and_restore_all_page_settings(client, client_factory):
    original = {
        "tab": "configs",
        "selected": ["one", "two"],
        "selectionMode": "manual",
        "options": {"smoothing": 0.8},
        "configScalars": [{"id": "reward", "tag": "reward"}],
        "configurationExclusions": {"patterns": ["seed"], "files": ["hparams.yml"]},
        "time": {"threshold": 20},
        "combinedPlot": {"tags": ["a", "b"]},
    }
    created = client.post("/api/named-views", json={"name": "Review", "view": original})
    assert created.status_code == 201
    saved = created.json()
    identifier = saved["id"]
    assert saved["view"] == original
    assert client.get("/api/workspace").json()["state"]["view"]["namedView"] == identifier
    draft = {**original, "tab": "time", "time": {"threshold": 50}, "namedView": identifier}
    assert client.put("/api/view", json={"view": draft}).status_code == 200
    assert client.get("/api/named-views").json()[0] == saved
    loaded = client.post(f"/api/named-views/{identifier}/load").json()
    assert loaded == {**original, "namedView": identifier}
    state = client.get("/api/workspace").json()["state"]
    assert state["ignored_configs"] == ["seed"] and state["ignored_files"] == ["hparams.yml"]
    assert (
        client.put(
            f"/api/named-views/{identifier}", json={"name": "Review", "view": draft}
        ).status_code
        == 200
    )
    renamed = client.put(f"/api/named-views/{identifier}", json={"name": "Final review"}).json()
    assert renamed["view"]["time"] == {"threshold": 50}
    assert "namedView" not in renamed["view"]
    reopened = create_app(
        client.app.state.repository.root, client.app.state.store.path, tensorboard_loader="python"
    )
    with client_factory(reopened) as restored:
        assert restored.get("/api/named-views").json() == [renamed]
    assert client.delete(f"/api/named-views/{identifier}").json() == []
    assert client.get("/api/workspace").json()["state"]["view"]["time"] == {"threshold": 50}


def test_follow_filter_view_stores_rules_and_rescans_logs(tmp_path, client_factory):
    root = tmp_path / "logs"
    generate_demo(root, count=2)
    app = create_app(root, tensorboard_loader="python")
    with client_factory(app) as client:
        view = {
            "selectionMode": "filters",
            "selected": ["old"],
            "filters": [{"source": "path", "key": "path", "operator": "glob", "value": "exp*"}],
        }
        saved = client.post("/api/named-views", json={"name": "Follow", "view": view}).json()
        assert saved["view"]["selected"] == []
        source = tmp_path / "new"
        generate_demo(source, count=1)
        shutil.move(source / "exp000", root / "exp002")
        assert client.post(f"/api/named-views/{saved['id']}/load").status_code == 200
        assert len(client.get("/api/experiments").json()["experiments"]) == 3
        assert client.get("/api/named-views").json()[0] == saved
    other = tmp_path / "other"
    other.mkdir()
    assert create_app(other).state.store.read()["named_views"] == []


def test_invalid_named_view_updates_preserve_existing_snapshot(client):
    saved = client.post(
        "/api/named-views", json={"name": "Review", "view": {"tab": "overview"}}
    ).json()
    assert client.post("/api/named-views", json={"name": "REVIEW", "view": {}}).status_code == 409
    assert client.post("/api/named-views", json={"name": " ", "view": {}}).status_code == 400
    assert client.post("/api/named-views", json={"name": "Missing"}).status_code == 400
    assert (
        client.put(
            f"/api/named-views/{saved['id']}",
            json={"name": "Review", "view": {"large": "x" * 1024**2}},
        ).status_code
        == 400
    )
    assert client.post("/api/named-views/unknown/load").status_code == 404
    assert client.delete("/api/named-views/unknown").status_code == 404
    assert client.get("/api/named-views").json() == [saved]
