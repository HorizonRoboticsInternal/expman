import time
from types import SimpleNamespace

import numpy as np
import pytest

from expman.config_scalars import scalar_comparison_rows


@pytest.mark.parametrize(
    "mode,reduction",
    [
        ("latest", "last"),
        ("latest_smoothed", "last_smoothed"),
        ("at_step", "at_step"),
        ("smoothed_at_step", "smoothed_at_step"),
    ],
)
def test_relationship_outcomes_match_configured_scalar_values(client, mode, reduction):
    identifiers = [item["id"] for item in client.get("/api/experiments").json()["experiments"]]
    spec = {"id": "outcome", "tag": "eval/reward", "mode": mode, "step": 100.5, "smoothing": 0.7}
    expected = client.post(
        "/api/compare", json={"experiment_ids": identifiers, "scalar_rows": [spec]}
    ).json()
    cells = next(row for row in expected["rows"] if row["kind"] == "scalar")["cells"]
    result = client.post(
        "/api/analysis",
        json={
            "experiment_ids": identifiers,
            "metric": spec["tag"],
            "reduction": reduction,
            "at_step": spec["step"],
            "smoothing": spec["smoothing"],
        },
    ).json()
    assert [record["result"] for record in result["records"]] == pytest.approx(
        [cell["value"] for cell in cells]
    )
    if "smoothed" in reduction:
        assert result["smoothing"] == spec["smoothing"]


def test_four_scalar_modes_interpolation_and_missing_data():
    calls = []

    def load(experiment):
        calls.append(experiment.id)
        return {"score": np.array([[0, 0, 10], [2, 4, 12], [4, 8, 14]], dtype=float)}

    specs = [
        {"id": mode, "tag": "score", "mode": mode, "step": 1, "smoothing": 0.5}
        for mode in ["latest", "latest_smoothed", "at_step", "smoothed_at_step"]
    ]
    specs += [
        {"id": "outside", "tag": "score", "mode": "at_step", "step": 5, "smoothing": 0},
        {"id": "missing", "tag": "other", "mode": "latest", "step": None, "smoothing": 0},
    ]
    result = scalar_comparison_rows(SimpleNamespace(load=load), [SimpleNamespace(id="run")], specs)
    assert [row["cells"][0]["value"] for row in result[:4]] == pytest.approx([8, 40 / 7, 2, 4 / 3])
    assert [row["cells"][0]["value"] for row in result[4:]] == [None, None]
    assert [row["cells"][0]["present"] for row in result] == [True] * 4 + [False] * 2
    assert calls == ["run"]


def test_latest_scalar_comparison_uses_only_cached_metadata():
    def forbidden(experiment):
        raise AssertionError("Latest values must not reload full time series")

    repository = SimpleNamespace(load=forbidden, load_metadata=lambda item: {"score": {"last": 7}})
    result = scalar_comparison_rows(
        repository,
        [SimpleNamespace(id="run")],
        [{"id": "last", "tag": "score", "mode": "latest", "step": None, "smoothing": 0.4}],
    )
    assert result[0]["cells"] == [{"present": True, "value": 7}]


def test_scalar_rows_compare_real_events_and_survive_config_exclusions(client):
    identifiers = [item["id"] for item in client.get("/api/experiments").json()["experiments"][:2]]
    specs = [
        {"id": mode, "tag": "train/loss", "mode": mode, "step": 45.5, "smoothing": 0.5}
        for mode in ["latest", "latest_smoothed", "at_step", "smoothed_at_step"]
    ]
    request = {"experiment_ids": identifiers, "scalar_rows": specs, "differences_only": True}
    result = client.post("/api/compare", json=request)
    assert result.status_code == 200, result.text
    rows = [row for row in result.json()["rows"] if row["kind"] == "scalar"]
    assert len(rows) == 4
    for index, identifier in enumerate(identifiers):
        points = client.app.state.repository.load(client.app.state.repository.get(identifier))[
            "train/loss"
        ]
        smoothed = [
            np.average(points[: index + 1, 1], weights=0.5 ** np.arange(index, -1, -1))
            for index in range(len(points))
        ]
        expected = [
            points[-1][1],
            smoothed[-1],
            (points[45][1] + points[46][1]) / 2,
            (smoothed[45] + smoothed[46]) / 2,
        ]
        assert [row["cells"][index]["value"] for row in rows] == pytest.approx(expected)
    client.put("/api/ignored-configs", json={"patterns": ["*"], "files": []})
    result = client.post("/api/compare", json=request).json()
    assert len(result["rows"]) == 4
    assert all(row["kind"] == "scalar" for row in result["rows"])
    assert [row["id"] for row in result["rows"]] == ["scalar:" + spec["id"] for spec in specs]


@pytest.mark.parametrize(
    "changes",
    [
        {"mode": "at_step"},
        {"smoothing": 1},
        {"smoothing": -1},
        {"tag": ""},
        {"mode": "unknown"},
        {"highlight": "different"},
        {"highlight_color": "pink"},
    ],
)
def test_invalid_scalar_definitions_are_rejected(client, changes):
    identifier = client.get("/api/experiments").json()["experiments"][0]["id"]
    spec = {"id": "value", "tag": "train/loss", "mode": "latest", **changes}
    assert (
        client.post(
            "/api/compare", json={"experiment_ids": [identifier], "scalar_rows": [spec]}
        ).status_code
        == 422
    )


def test_metadata_is_retained_after_raw_cache_eviction_and_refresh(client, monkeypatch):
    repository = client.app.state.repository
    repository.max_cached_points = 1
    original, reads = repository._read, []

    def counted(directory):
        reads.append(directory)
        return original(directory)

    monkeypatch.setattr(repository, "_read", counted)
    identifiers = [item["id"] for item in client.get("/api/experiments").json()["experiments"]]
    first = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert reads
    assert len(repository.cache) == 1
    count = len(reads)
    client.post("/api/refresh")
    second = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    assert first["tags"] == second["tags"]
    assert first["experiments"] == second["experiments"]
    assert len(reads) == count
    compared = client.post(
        "/api/compare",
        json={
            "experiment_ids": identifiers,
            "scalar_rows": [{"id": "last", "tag": "train/loss", "mode": "latest"}],
        },
    ).json()
    assert len(compared["rows"][0]["cells"]) == len(identifiers)
    assert len(reads) == count


def test_background_metric_discovery_progress_results_and_reuse(client):
    identifiers = [item["id"] for item in client.get("/api/experiments").json()["experiments"]]
    started = client.post("/api/metrics/jobs", json={"experiment_ids": identifiers})
    assert started.status_code == 202, started.text
    identifier = started.json()["id"]
    deadline = time.monotonic() + 5
    percentages = []
    while time.monotonic() < deadline:
        status = client.get("/api/metrics/jobs/" + identifier).json()
        percentages.append(status["percent"])
        if status["status"] in {"complete", "error"}:
            break
        time.sleep(0.01)
    assert status["status"] == "complete", status
    assert percentages == sorted(percentages)
    result = client.get("/api/metrics/jobs/" + identifier + "/result").json()
    assert "train/loss" in result["tags"]
    assert len(result["experiments"]) == len(identifiers)
    assert all(item["loaded"] for item in result["experiments"])
    repeated = client.post("/api/metrics/jobs", json={"experiment_ids": identifiers}).json()
    assert repeated["reused"] and repeated["id"] == identifier
    assert client.post("/api/metrics/jobs", json={"experiment_ids": []}).status_code == 400
