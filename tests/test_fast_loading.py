import copy
import io
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest
from tensorboard.backend.event_processing.data_ingester import LocalDataIngester

from expman.analytics import analyze, curve_payload
from expman.app import create_app
from expman.experiments import Experiment
from expman.native import NativeTensorBoard
from expman.tensorboard_data import TensorBoardScalars


def test_curve_elapsed_uses_indexed_start_without_reading_other_scalar_histories(tmp_path):
    experiment = Experiment(
        "run", tmp_path / "run", "run", run_dirs=[tmp_path / "run", tmp_path / "run" / "eval"]
    )
    calls = []

    class Provider:
        def list_runs(self, ctx, **kwargs):
            calls.append("metadata")
            return [
                SimpleNamespace(run_id="run", start_time=1000),
                SimpleNamespace(run_id="run/eval", start_time=990),
            ]

        def read_scalars(self, ctx, **kwargs):
            calls.append("scalars")
            assert kwargs["run_tag_filter"].runs == {"run"}
            return {
                "run": {
                    "loss": [
                        SimpleNamespace(step=0, value=1, wall_time=1010),
                        SimpleNamespace(step=1, value=2, wall_time=1020),
                    ]
                }
            }

    native = SimpleNamespace(
        initialize=lambda: None, backend="fast", ingester=SimpleNamespace(data_provider=Provider())
    )
    source = TensorBoardScalars(
        SimpleNamespace(root=tmp_path), native, [experiment], ["loss"], 1000, include_origins=True
    )
    curve = curve_payload(
        source,
        [experiment],
        ["loss"],
        {"ignored_configs": [], "experiments": {}, "groups": []},
        {"x_axis": "step"},
    )["loss"][0]
    assert curve["elapsed"] == [20, 30]
    assert curve["original_y"] == curve["y"] == [1, 2]
    assert calls == ["metadata", "scalars"]


def finish(client, path, identifier):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = client.get(f"{path}/{identifier}").json()
        if status["status"] in {"complete", "error", "cancelled"}:
            assert status["status"] == "complete", status
            return client.get(f"{path}/{identifier}/result").json()
        time.sleep(0.01)
    raise AssertionError(status)


def install_fast_provider(monkeypatch):
    def start(native, board):
        flags = copy.copy(board.flags)
        flags.reload_task, flags.reload_interval = "blocking", 0
        flags.samples_per_plugin = {"scalars": 0}
        local = LocalDataIngester(flags)
        local.start()
        return SimpleNamespace(data_provider=local.data_provider, _stdin_handle=io.BytesIO())

    monkeypatch.setattr(NativeTensorBoard, "_start_fast", start)


def test_overview_reads_all_selected_runs_with_independent_step_ranges(tmp_path):
    experiments = [
        Experiment(
            id=f"exp{index:03d}",
            path=tmp_path / f"exp{index:03d}",
            relative_path=f"exp{index:03d}",
            run_dirs=[tmp_path / f"exp{index:03d}"],
        )
        for index in range(26)
    ]
    data = {
        item.relative_path: {
            "loss": [
                SimpleNamespace(step=index * 10 + step, value=float(step), wall_time=1000 + step)
                for step in [0, 1]
            ]
        }
        for index, item in enumerate(experiments)
        if index < 20 or index == 25
    }
    requested = []

    class Provider:
        def read_scalars(self, context, *, run_tag_filter, **kwargs):
            requested.extend(run_tag_filter.runs)
            return {run: data[run] for run in run_tag_filter.runs if run in data}

    native = SimpleNamespace(
        initialize=lambda: None, backend="fast", ingester=SimpleNamespace(data_provider=Provider())
    )
    selected = experiments[:25]
    source = TensorBoardScalars(SimpleNamespace(root=tmp_path), native, selected, ["loss"], 2000)
    result = curve_payload(
        source,
        selected,
        ["loss"],
        {"ignored_configs": [], "ignored_files": [], "experiments": {}, "groups": []},
        {"alignment": "overlap"},
    )
    assert set(requested) == {item.relative_path for item in selected}
    assert {curve["id"] for curve in result["loss"]} == {item.id for item in selected[:20]}
    assert all(len(curve["x"]) == 2 for curve in result["loss"])


def test_fast_metadata_overview_and_latest_reuse_shared_provider(
    example_logs, tmp_path, client_factory, monkeypatch
):
    install_fast_provider(monkeypatch)
    app = create_app(example_logs, tmp_path / "state.json")

    def forbidden(*arguments):
        raise AssertionError("Fast loading must not parse events through repository._read")

    monkeypatch.setattr(app.state.repository, "_read", forbidden)
    monkeypatch.setattr("expman.jobs.FullScalarReader", forbidden)
    with client_factory(app) as client:
        identifiers = [
            item["id"] for item in client.get("/api/experiments").json()["experiments"][:2]
        ]
        metadata_job = client.post("/api/metrics/jobs", json={"experiment_ids": identifiers}).json()
        metadata = finish(client, "/api/metrics/jobs", metadata_job["id"])
        assert "train/loss" in metadata["tags"]
        preview = client.post("/api/metrics/preview", json={"experiment_ids": identifiers}).json()
        assert preview["available_experiments"] == 2
        assert preview["tags"] == metadata["tags"]
        curves = client.post(
            "/api/curves",
            json={"experiment_ids": identifiers, "tags": ["train/loss"], "source": "tensorboard"},
        ).json()
        assert curves["source"] == "tensorboard"
        assert len(curves["curves"]["train/loss"]) == 2
        spec = {
            "id": "loss",
            "tag": "train/loss",
            "mode": "latest",
            "highlight": "smallest",
            "highlight_color": "#fbcfe8",
        }
        job = client.post(
            "/api/compare/scalars/jobs", json={"experiment_ids": identifiers, "scalar_rows": [spec]}
        )
        assert job.status_code == 202, job.text
        result = finish(client, "/api/compare/scalars/jobs", job.json()["id"])
        assert result["rows"][0]["scalar"]["highlight"] == "smallest"
        assert [cell["value"] for cell in result["rows"][0]["cells"]] == pytest.approx(
            [item["metrics"]["train/loss"]["last"] for item in metadata["experiments"]]
        )


def test_relationships_latest_and_history_use_fast_provider(
    example_logs, tmp_path, client_factory, monkeypatch
):
    install_fast_provider(monkeypatch)
    app = create_app(example_logs, tmp_path / "state.json")
    repository = app.state.repository
    selected = repository.select(list(repository.experiments)[:3])
    settings = [
        {"reduction": "last"},
        {"reduction": "best"},
        {"reduction": "mean"},
        {"reduction": "at_step", "at_step": 100},
        {"reduction": "last", "end_step": 150},
        {"reduction": "last_smoothed", "smoothing": 0.8},
        {"reduction": "smoothed_at_step", "at_step": 100.5, "smoothing": 0.7},
        {"reduction": "smoothed_at_step", "at_step": 250, "smoothing": 0.4},
    ]
    expected = [analyze(repository, selected, "eval/reward", [], **options) for options in settings]

    def forbidden(*arguments):
        raise AssertionError("Relationship jobs must use the fast provider")

    monkeypatch.setattr(repository, "load", forbidden)
    monkeypatch.setattr("expman.jobs.FullScalarReader", forbidden)
    lifecycle = []

    class Reader:
        backend = "fast"

        def __init__(self, repo, experiments, cache_dir, progress):
            assert [item.id for item in experiments] == [item.id for item in selected]
            lifecycle.append("open")
            self.ingester = app.state.tensorboard.ingester

        def initialize(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            lifecycle.append("close")

    with client_factory(app) as client:
        for index, options in enumerate(settings):
            if index == 1:
                monkeypatch.setattr("expman.jobs.FullScalarReader", Reader)
            started = client.post(
                "/api/relationships/jobs",
                json={
                    "experiment_ids": [item.id for item in selected],
                    "metric": "eval/reward",
                    **options,
                },
            )
            assert started.status_code == 202, started.text
            result = finish(client, "/api/relationships/jobs", started.json()["id"])
            assert [record["result"] for record in result["records"]] == pytest.approx(
                [record["result"] for record in expected[index]["records"]]
            )
            assert result["associations"] == expected[index]["associations"]
            if index == 0:
                assert all(record["first_step"] is None for record in result["records"])
                assert not lifecycle
            else:
                assert result["records"] == expected[index]["records"]
                assert lifecycle == ["open", "close"]
        scoped = client.post(
            "/api/relationships/jobs",
            json={
                "experiment_ids": [item.id for item in selected],
                "metric": "eval/reward",
                "reduction": "last_smoothed",
                "smoothing": 0.8,
                "condition_scope": "configurations",
                "configuration_query": "model.architecture",
                "configuration_differences_only": False,
            },
        ).json()
        result = finish(client, "/api/relationships/jobs", scoped["id"])
        assert result["condition_keys"] == ["model.architecture"]
        assert lifecycle == ["open", "close"]


def test_configuration_table_available_while_scalar_history_job_is_running(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []

    def history(selected, tags, cache_dir, progress):
        calls.append(tags)
        entered.set()
        assert release.wait(5)
        return client.app.state.repository

    manager = client.app.state.comparison_jobs
    monkeypatch.setattr(manager, "_history_source", history)
    identifiers = [item["id"] for item in client.get("/api/experiments").json()["experiments"][:2]]
    spec = {"id": "smooth", "tag": "train/loss", "mode": "latest_smoothed", "smoothing": 0.4}
    try:
        started = client.post(
            "/api/compare/scalars/jobs", json={"experiment_ids": identifiers, "scalar_rows": [spec]}
        )
        assert started.status_code == 202
        assert entered.wait(2)
        response = client.post(
            "/api/compare", json={"experiment_ids": identifiers, "scalar_rows": []}
        )
        assert response.status_code == 200
        assert response.json()["rows"]
        assert (
            client.get("/api/compare/scalars/jobs/" + started.json()["id"]).json()["status"]
            == "running"
        )
    finally:
        release.set()
    assert finish(client, "/api/compare/scalars/jobs", started.json()["id"])["rows"]
    assert len(calls) == 1


def test_full_history_cache_reuses_modes_and_invalidates_changed_events(client, monkeypatch):
    repository = client.app.state.repository
    selected = list(repository.experiments.values())[:2]
    native_reads = []

    class Reader:
        def __init__(self, *arguments):
            native_reads.append(True)

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            return False

    class Data:
        def __init__(self, repository, reader, selected, tags, max_points):
            self.repository = repository

        def load(self, item):
            return self.repository.load(item)

    monkeypatch.setattr("expman.jobs.FullScalarReader", Reader)
    monkeypatch.setattr("expman.jobs.TensorBoardScalars", Data)
    version = [0]
    monkeypatch.setattr(
        client.app.state.comparison_jobs, "fingerprint", lambda item: [(item.id, version[0])]
    )
    manager = client.app.state.comparison_jobs
    source = manager._history_source(selected, ["train/loss"], "/unused", lambda *args: None)
    assert len(source.load(selected[0])["train/loss"]) == 400
    manager._history_source(selected, ["train/loss"], "/unused", lambda *args: None)
    assert len(native_reads) == 1
    version[0] += 1
    manager._history_source(selected, ["train/loss"], "/unused", lambda *args: None)
    assert len(native_reads) == 2


@pytest.mark.parametrize("tags", [["dense"], ["dense", "sparse"]])
def test_load_all_panel_keeps_every_observation_and_releases_reader(client, monkeypatch, tags):
    lifecycle = []

    class Reader:
        def __init__(self, *arguments):
            pass

        def __enter__(self):
            lifecycle.append("start")
            return self

        def __exit__(self, *arguments):
            lifecycle.append("close")

    class Data:
        def __init__(self, *arguments, include_origins=False):
            pass

        def load(self, item):
            return {
                "dense": np.column_stack(
                    (np.arange(2505), np.sin(np.arange(2505)), np.arange(2505) + 1000)
                ),
                "sparse": np.column_stack(
                    (
                        np.arange(0, 2505, 2),
                        np.cos(np.arange(0, 2505, 2)),
                        np.arange(0, 2505, 2) + 1000,
                    )
                ),
            }

    monkeypatch.setattr("expman.jobs.FullScalarReader", Reader)
    monkeypatch.setattr("expman.jobs.TensorBoardScalars", Data)
    identifier = client.get("/api/experiments").json()["experiments"][0]["id"]
    response = client.post(
        "/api/curves/all/jobs",
        json={
            "experiment_ids": [identifier],
            "tags": tags,
            "source": "tensorboard",
            "smoothing": 0.8,
        },
    )
    assert response.status_code == 202, response.text
    result = finish(client, "/api/curves/all/jobs", response.json()["id"])
    curve = result["curves"]["dense"][0]
    assert len(curve["x"]) == 2505
    np.testing.assert_allclose(curve["original_y"], np.sin(np.arange(2505)))
    assert curve["y"][1] == pytest.approx(np.sin(1) / 1.8)
    assert not curve["sampled"]
    assert result["source"] == "all-values"
    if "sparse" in tags:
        sparse = result["curves"]["sparse"][0]
        assert sparse["x"] == list(range(0, 2505, 2))
        np.testing.assert_allclose(sparse["original_y"], np.cos(np.arange(0, 2505, 2)))
        identifiers = [
            item["id"] for item in client.get("/api/experiments").json()["experiments"][:2]
        ]
        rejected = client.post(
            "/api/curves/all/jobs", json={"experiment_ids": identifiers, "tags": tags}
        )
        assert rejected.status_code == 400
    assert lifecycle == ["start", "close"]
