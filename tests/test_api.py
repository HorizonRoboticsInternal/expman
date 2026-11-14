import io
import re
import threading
import time
import wave
from urllib.parse import urljoin

import numpy as np
from PIL import Image
from tensorboard.backend.event_processing.data_ingester import LocalDataIngester


def selected(client):
    runs = client.get("/api/experiments").json()["experiments"]
    return runs, [run["id"] for run in runs]


def wait_for_tensorboard(client):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = client.get("/api/tensorboard/status").json()
        if status["ready"]:
            if status.get("backend") != "fast":
                return
            tags = client.get("/tensorboard/data/plugin/scalars/tags").json()
            if len(tags) == len(client.app.state.repository.experiments):
                return
        assert not status["error"], status
        time.sleep(0.02)
    raise AssertionError("TensorBoard did not finish indexing test logs")


def test_frontend_and_local_assets(client):
    assert client.get("/").status_code == 200
    assert "Experiment workbench" in client.get("/").text
    assert 'id="panel-dialog"' in client.get("/").text
    assert 'aria-labelledby="panel-dialog-title"' in client.get("/").text
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/panels.js").status_code == 200
    assert client.get("/static/combined.js").status_code == 200
    assert client.get("/static/signals.js").status_code == 200
    assert client.get("/static/configurations.js").status_code == 200
    assert client.get("/static/appearance.js").status_code == 200
    assert client.get("/static/filters.js").status_code == 200
    script = client.get("/static/filters.js")
    assert script.headers["cache-control"] == "no-cache"
    assert 'filter.operator === "not_contains"' in script.text
    cached = client.get("/static/filters.js", headers={"If-None-Match": script.headers["etag"]})
    assert cached.status_code == 304
    assert cached.headers["cache-control"] == "no-cache"
    assert client.get("/static/style.css").status_code == 200
    assert client.get("/assets/plotly.min.js").status_code == 200
    assert "Correlated events" in client.get("/design").text


def test_real_scalar_ingestion_and_config_comparison(client):
    runs, identifiers = selected(client)
    response = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert "train/loss" in response["tags"]
    assert "optimizer.learning_rate" in response["config_keys"]
    assert all(run["metrics"]["train/loss"]["count"] == 400 for run in response["experiments"])
    compared = client.post("/api/compare", json={"experiment_ids": identifiers}).json()
    assert any(row["key"] == "model.architecture" for row in compared["rows"])
    assert not any(row["key"] == "optimizer.weight_decay" for row in compared["rows"])
    assert len(compared["experiments"]) == len(runs)


def test_refresh_preserves_cached_scalar_metadata(client):
    _, identifiers = selected(client)
    before = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert client.post("/api/refresh").status_code == 200
    after = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert after["tags"] == before["tags"]
    assert all(run["loaded"] for run in after["experiments"])
    assert [run["metrics"] for run in after["experiments"]] == [
        run["metrics"] for run in before["experiments"]
    ]


def test_refresh_revision_tracks_sources_without_counting_scan_or_cache_changes(
    tmp_path, client_factory
):
    import os

    from tensorboard.summary.writer.event_file_writer import EventFileWriter

    from expman.app import create_app
    from expman.demo import generate_demo

    root = tmp_path / "logs"
    generate_demo(root, count=1)
    app = create_app(root, tmp_path / "state.json", tensorboard_loader="python")
    with client_factory(app) as client:
        workspace = client.get("/api/workspace").json()
        revision = workspace["revision"]
        assert revision
        runs, identifiers = selected(client)
        client.post("/api/metrics", json={"experiment_ids": identifiers})
        response = client.post("/api/refresh").json()
        assert response["revision"] == revision
        assert response["last_scan"] > workspace["last_scan"]
        (root / "broken").symlink_to(root / "missing")
        response = client.post("/api/refresh").json()
        assert response["revision"] == revision
        assert len(response["warnings"]) == 1
        client.patch("/api/experiments/" + identifiers[0], json={"name": "Renamed"})
        response = client.post("/api/refresh").json()
        assert response["revision"] == revision
        assert response["experiments"][0]["name"] == "Renamed"
        config = root / "exp000" / "config.yaml"
        config.write_text(config.read_text() + "\nextra: true\n")
        response = client.post("/api/refresh").json()
        assert response["revision"] != revision
        revision = response["revision"]
        before = set((root / "exp000").glob("events.out.tfevents.*"))
        EventFileWriter(str(root / "exp000")).close()
        new_event = (set((root / "exp000").glob("events.out.tfevents.*")) - before).pop()
        os.utime(new_event, (runs[0]["modified"], runs[0]["modified"]))
        response = client.post("/api/refresh").json()
        assert response["experiments"][0]["modified"] == runs[0]["modified"]
        assert response["revision"] != revision
        metrics = root / "exp000" / "evaluation_metrics.json"
        metrics.write_text('{"metrics": {"score": 1}}')
        assert (
            client.put("/api/json-metrics", json={"paths": ["evaluation_metrics.json"]}).status_code
            == 200
        )
        revision = client.post("/api/refresh").json()["revision"]
        metrics.write_text('{"metrics": {"score": 12}}')
        response = client.post("/api/refresh").json()
        assert response["revision"] != revision
        assert client.post("/api/refresh").json()["revision"] == response["revision"]


def test_group_curves_match_independent_numpy_mean(client):
    _, identifiers = selected(client)
    chosen = identifiers[:3]
    response = client.post("/api/curves", json={"experiment_ids": chosen, "tags": ["train/loss"]})
    assert response.status_code == 200
    individual = response.json()["curves"]["train/loss"]
    expected = np.mean([curve["y"] for curve in individual], axis=0)
    grouped = client.post(
        "/api/curves",
        json={"experiment_ids": chosen, "tags": ["train/loss"], "combine_selected": True},
    ).json()["curves"]["train/loss"]
    assert len(grouped) == 1
    np.testing.assert_allclose(grouped[0]["y"], expected)
    assert set(grouped[0]["count"]) == {3}


def test_groups_annotations_exclusions_and_exports(client):
    runs, identifiers = selected(client)
    saved = client.post("/api/groups", json={"name": "Baseline", "experiment_ids": identifiers[:3]})
    assert saved.status_code == 201
    group_id = saved.json()["id"]
    assert (
        client.put(
            "/api/groups/" + group_id, json={"name": "Updated", "experiment_ids": identifiers[:2]}
        ).status_code
        == 200
    )
    annotated = client.patch(
        "/api/experiments/" + identifiers[0],
        json={"name": "Reference", "notes": "Stable", "starred": True, "tags": ["baseline"]},
    ).json()
    assert annotated["starred"] and annotated["notes"] == "Stable"
    outcomes = client.post(
        "/api/analysis", json={"experiment_ids": [identifiers[0]], "metric": "train/loss"}
    ).json()
    assert outcomes["records"][0]["name"] == "Reference"
    result = client.put(
        "/api/ignored-configs", json={"patterns": ["seed", "timestamp", "optimizer.*"], "files": []}
    )
    assert result.status_code == 200
    comparison = client.post("/api/compare", json={"experiment_ids": identifiers}).json()
    assert all(
        not row["key"].startswith("optimizer.") and row["key"] != "seed"
        for row in comparison["rows"]
    )
    metrics = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert "seed" not in metrics["config_keys"]
    exported = client.get(
        "/api/export/scalars.csv", params={"ids": identifiers[0], "tag": "train/loss"}
    )
    assert exported.status_code == 200
    assert len(exported.text.splitlines()) == 401
    assert client.get("/api/export/workspace.json").json()["ignored_configs"]
    restored = client.put("/api/ignored-configs", json={"patterns": [], "files": []})
    assert restored.status_code == 200
    comparison = client.post("/api/compare", json={"experiment_ids": identifiers}).json()
    assert any(row["key"] == "optimizer.learning_rate" for row in comparison["rows"])
    assert any(row["key"] == "seed" for row in comparison["rows"])
    metrics = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert "seed" in metrics["config_keys"]
    assert client.delete("/api/groups/" + group_id).status_code == 200
    assert client.delete("/api/groups/" + group_id).status_code == 404
    assert client.get("/api/experiments/" + identifiers[0]).json()["name"] == "Reference"
    assert runs[0]["name"] != "Reference"


def test_experiment_annotations_do_not_wait_for_metric_loading(client, monkeypatch):
    runs, identifiers = selected(client)
    repository = client.app.state.repository

    def forbidden(*args, **kwargs):
        raise AssertionError(
            "Experiment annotations must not load scalar histories or JSON metrics"
        )

    monkeypatch.setattr(repository, "load_metadata", forbidden)
    monkeypatch.setattr(repository, "load", forbidden)
    monkeypatch.setattr(repository.json_sources, "collect", forbidden)
    path = "/api/experiments/" + identifiers[0]
    details = client.get(path)
    assert details.status_code == 200
    assert details.json()["files"]
    assert details.json()["config"] == runs[0]["config"]
    annotation = {
        "name": "Reference",
        "starred": True,
        "archived": True,
        "tags": ["baseline"],
        "notes": "Keep this run",
    }
    response = client.patch(path, json=annotation)
    assert response.status_code == 200
    for field, value in annotation.items():
        assert response.json()[field] == client.get(path).json()[field] == value
    assert client.patch(path, json={"starred": False, "archived": False}).status_code == 200
    restored = client.get(path).json()
    assert not restored["starred"] and not restored["archived"]


def test_outcomes_events_and_periodicity(client):
    _, identifiers = selected(client)
    outcomes = client.post(
        "/api/analysis",
        json={
            "experiment_ids": identifiers,
            "metric": "eval/reward",
            "reduction": "at_step",
            "at_step": 100,
        },
    )
    assert outcomes.status_code == 200
    assert len(outcomes.json()["records"]) == 6
    assert outcomes.json()["associations"]
    event_request = {
        "experiment_id": identifiers[0],
        "tags": ["train/grad_norm", "train/loss"],
        "reference": "train/grad_norm",
        "threshold": 5,
        "max_lag": 12,
        "tolerance": 8,
    }
    events = client.post("/api/events", json=event_request)
    assert events.status_code == 200
    data = events.json()
    assert len(data["timeline"]) >= 6
    assert data["pairs"][0]["events"]["median_delay"] == 4
    periodic = client.post(
        "/api/periodicity",
        json={
            "experiment_id": identifiers[0],
            "tags": ["system/gpu_utilization"],
            "min_period": 20,
            "max_period": 80,
            "windowed": True,
        },
    )
    assert periodic.status_code == 200
    assert (
        abs(
            periodic.json()["metrics"]["system/gpu_utilization"]["spectrum"]["peaks"][0]["period"]
            - 40
        )
        < 1
    )
    assert len(periodic.json()["metrics"]["system/gpu_utilization"]["windows"]) == 5


def test_validation_and_unknown_ids(client):
    _, identifiers = selected(client)
    assert client.get("/api/experiments/unknown").status_code == 404
    assert client.post("/api/metrics", json={"experiment_ids": ["unknown"]}).status_code == 404
    assert (
        client.post(
            "/api/curves",
            json={"experiment_ids": identifiers, "tags": ["train/loss"], "smoothing": 1},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/analysis", json={"metric": "train/loss", "reduction": "at_step"}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/events",
            json={"experiment_id": identifiers[0], "tags": ["train/loss"], "start": 5, "end": 2},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/periodicity",
            json={
                "experiment_id": identifiers[0],
                "tags": ["train/loss"],
                "min_period": 10,
                "max_period": 1,
            },
        ).status_code
        == 400
    )
    assert (
        client.post("/api/groups", json={"name": "Empty", "experiment_ids": []}).status_code == 400
    )


def test_native_tensorboard_plugins(client):
    frontend = client.get("/tensorboard/")
    assert frontend.status_code == 200
    wait_for_tensorboard(client)
    scripts = re.findall(r'<script[^>]*src="([^"]+)"', frontend.text)
    assert scripts
    for script in scripts:
        assert client.get(urljoin("/tensorboard/", script)).status_code == 200
    plugins = client.get("/tensorboard/data/plugins_listing")
    assert plugins.status_code == 200
    assert "scalars" in plugins.json()
    scalars = client.get("/tensorboard/data/plugin/scalars/tags")
    assert scalars.status_code == 200
    assert any("train/loss" in metrics for metrics in scalars.json().values())
    for plugin in ["images", "histograms", "text", "audio"]:
        response = client.get(f"/tensorboard/data/plugin/{plugin}/tags")
        assert response.status_code == 200, response.text
        assert response.json()


def test_native_tensorboard_serves_actual_media_and_scalar_values(client):
    assert client.get("/tensorboard/").status_code == 200
    wait_for_tensorboard(client)
    prefix = "/tensorboard/data/plugin/"
    scalar = client.get(prefix + "scalars/scalars", params={"run": "exp000", "tag": "train/loss"})
    assert scalar.status_code == 200
    assert len(scalar.json()) == 400
    assert scalar.json()[0][1] == 0
    assert scalar.json()[-1][1] == 399
    images = client.get(prefix + "images/tags").json()
    run = next(iter(images))
    tag = next(iter(images[run]))
    entries = client.get(prefix + "images/images", params={"run": run, "tag": tag}).json()
    response = client.get(prefix + "images/individualImage?" + entries[0]["query"])
    assert response.status_code == 200
    image = Image.open(io.BytesIO(response.content))
    assert image.size == (1, 1)
    image.verify()
    audio_tags = client.get(prefix + "audio/tags").json()
    run = next(iter(audio_tags))
    tag = next(iter(audio_tags[run]))
    entries = client.get(prefix + "audio/audio", params={"run": run, "tag": tag}).json()
    response = client.get(prefix + "audio/individualAudio?" + entries[0]["query"])
    assert response.status_code == 200
    with wave.open(io.BytesIO(response.content)) as audio:
        assert audio.getframerate() == 8000
        assert audio.getnchannels() == 1
        assert audio.getnframes() == 800
    histogram = client.get(
        prefix + "histograms/histograms", params={"run": "exp000", "tag": "weights"}
    )
    assert histogram.status_code == 200
    assert histogram.json()
    text_tags = client.get(prefix + "text/tags").json()
    run = next(iter(text_tags))
    tag = next(iter(text_tags[run]))
    text = client.get(prefix + "text/text", params={"run": run, "tag": tag})
    assert text.status_code == 200
    assert "Reproducible Expman example run" in text.text


def test_native_tensorboard_graphs_and_embeddings(client):
    assert client.get("/tensorboard/").status_code == 200
    wait_for_tensorboard(client)
    graph = client.get("/tensorboard/data/plugin/graphs/graph", params={"run": "exp000"})
    assert graph.status_code == 200
    assert "Placeholder" in graph.text and "Identity" in graph.text
    prefix = "/tensorboard/data/plugin/projector/"
    runs = client.get(prefix + "runs")
    assert runs.status_code == 200
    assert "exp000" in runs.json()
    info = client.get(prefix + "info", params={"run": "exp000"})
    assert info.status_code == 200
    assert info.json()["embeddings"][0]["tensorName"] == "demo_embedding"
    tensor = client.get(prefix + "tensor", params={"run": "exp000", "name": "demo_embedding"})
    assert tensor.status_code == 200
    np.testing.assert_allclose(np.frombuffer(tensor.content, dtype=np.float32), [0, 0, 1, 0, 0, 1])
    metadata = client.get(prefix + "metadata", params={"run": "exp000", "name": "demo_embedding"})
    assert metadata.status_code == 200
    assert "origin" in metadata.text


def test_native_frontend_is_served_while_logs_are_still_indexing(
    example_logs, tmp_path, client_factory, monkeypatch
):
    release = threading.Event()
    start = LocalDataIngester.start

    def paused_start(ingester):
        release.wait(5)
        start(ingester)

    monkeypatch.setattr(LocalDataIngester, "start", paused_start)
    from expman.app import create_app

    application = create_app(example_logs, tmp_path / "state.json", tensorboard_loader="python")
    with client_factory(application) as client:
        try:
            frontend = client.get("/tensorboard/")
            assert frontend.status_code == 200
            status = client.get("/api/tensorboard/status").json()
            assert status["phase"] == "indexing"
            assert not status["ready"]
        finally:
            release.set()
        wait_for_tensorboard(client)
