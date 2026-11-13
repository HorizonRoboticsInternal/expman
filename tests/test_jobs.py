import threading
import time
from types import SimpleNamespace

import pytest

from expman.jobs import AnalysisJobs
from expman.timeseries import select_tags


def wait_for_job(client, identifier, path="/api/analysis/jobs"):
    deadline = time.monotonic() + 5
    percentages = []
    while time.monotonic() < deadline:
        response = client.get(f"{path}/{identifier}")
        assert response.status_code == 200, response.text
        status = response.json()
        percentages.append(status["percent"])
        if status["status"] in {"complete", "error", "cancelled"}:
            assert percentages == sorted(percentages)
            return status
        time.sleep(0.01)
    raise AssertionError("Background analysis did not finish")


def test_relationship_grouping_options_and_cached_outcomes(client, monkeypatch):
    repository = client.app.state.repository
    selected = list(repository.experiments.values())
    for index, item in enumerate(selected):
        item.config["numeric_condition"] = [1, 1.0, 2, 2.0, 3, 3][index]
        if index < 5:
            item.config["nullable_condition"] = [1, 1.0, 2, 2.0, None][index]
    request = {
        "experiment_ids": [item.id for item in selected],
        "metric": "eval/reward",
        "condition_scope": "all",
    }
    automatic = client.post("/api/analysis", json=request).json()
    numeric = next(item for item in automatic["associations"] if item["key"] == "numeric_condition")
    assert numeric["kind"] == "numeric" and "spearman" in numeric
    assert automatic["condition_types"]["numeric_condition"] == "numeric"
    forced = client.post(
        "/api/analysis", json={**request, "categorical_conditions": ["numeric_condition"]}
    ).json()
    categorical = next(
        item for item in forced["associations"] if item["key"] == "numeric_condition"
    )
    assert categorical["kind"] == "categorical" and "spearman" not in categorical
    assert [group["count"] for group in categorical["groups"]] == [2, 2, 2]
    assert [group["value"] for group in categorical["groups"]] == ["1", "2", "3"]
    default = next(
        item for item in automatic["associations"] if item["key"] == "nullable_condition"
    )
    assert default["count"] == 5
    assert any(group["value"] == "null" for group in default["groups"])
    merged_request = {
        **request,
        "categorical_conditions": ["numeric_condition"],
        "missing_conditions": ["nullable_condition"],
    }
    merged = client.post("/api/analysis", json=merged_request).json()
    association = next(
        item for item in merged["associations"] if item["key"] == "nullable_condition"
    )
    assert association["count"] == 6
    missing = next(group for group in association["groups"] if group.get("missing"))
    assert missing["value"] == "(missing or null)" and missing["count"] == 2
    assert missing["null_merged"] is True
    values = [record["result"] for record in merged["records"]]
    average = sum(values) / len(values)
    total = sum((value - average) ** 2 for value in values)
    between = sum(
        2 * ((values[index] + values[index + 1]) / 2 - average) ** 2 for index in [0, 2, 4]
    )
    assert association["eta_squared"] == pytest.approx(between / total)
    separate = client.post(
        "/api/analysis", json={**merged_request, "separate_null_conditions": ["nullable_condition"]}
    ).json()
    separate_groups = next(
        item for item in separate["associations"] if item["key"] == "nullable_condition"
    )["groups"]
    assert next(group for group in separate_groups if group.get("missing"))["count"] == 1
    assert next(group for group in separate_groups if group["value"] == "null")["count"] == 1
    assert merged["records"] == automatic["records"] == separate["records"]

    def forbidden(*args, **kwargs):
        raise AssertionError("Changing condition grouping must reuse loaded outcomes")

    monkeypatch.setattr(repository, "_read", forbidden)
    first = client.post("/api/relationships/jobs", json=request).json()
    assert wait_for_job(client, first["id"], "/api/relationships/jobs")["status"] == "complete"
    assert client.post("/api/relationships/jobs", json=request).json()["id"] == first["id"]
    changed = client.post("/api/relationships/jobs", json=merged_request).json()
    assert changed["id"] != first["id"]
    assert wait_for_job(client, changed["id"], "/api/relationships/jobs")["status"] == "complete"
    assert client.get(f"/api/relationships/jobs/{changed['id']}/result").json() == merged


def test_missing_category_does_not_merge_literal_strings(client):
    selected = list(client.app.state.repository.experiments.values())
    for item, value in zip(
        selected, ["(missing or null)", "(missing or null)", "null", None], strict=False
    ):
        item.config["condition"] = value
    result = client.post(
        "/api/analysis",
        json={
            "experiment_ids": [item.id for item in selected],
            "metric": "eval/reward",
            "missing_conditions": ["condition"],
        },
    ).json()
    groups = next(item for item in result["associations"] if item["key"] == "condition")["groups"]
    assert len(groups) == 3
    assert next(item for item in groups if item.get("missing"))["count"] == 3
    assert next(item for item in groups if item["value"] == '"(missing or null)"')["count"] == 2
    assert next(item for item in groups if item["value"] == '"null"')["count"] == 1


@pytest.mark.parametrize("kind", ["events", "periodicity"])
def test_all_curves_default_progress_and_result_reuse(client, kind):
    experiment = client.get("/api/experiments").json()["experiments"][0]["id"]
    tags = client.post("/api/metrics", json={"experiment_ids": [experiment]}).json()["tags"]
    request = {"experiment_id": experiment, "kind": kind}
    response = client.post("/api/analysis/jobs", json=request)
    assert response.status_code == 202
    identifier = response.json()["id"]
    status = wait_for_job(client, identifier)
    assert status["status"] == "complete", status
    assert status["percent"] == 100
    result = client.get(f"/api/analysis/jobs/{identifier}/result").json()
    assert set(result["curves" if kind == "events" else "metrics"]) == set(tags)
    assert result["reference"] in tags
    repeated = client.post("/api/analysis/jobs", json=request).json()
    assert repeated["reused"] is True
    assert repeated["id"] == identifier


def test_analysis_patterns_and_validation(client):
    experiment = client.get("/api/experiments").json()["experiments"][0]["id"]
    request = {"experiment_id": experiment, "include": ["train/*"], "exclude": ["*loss*"]}
    started = client.post("/api/analysis/jobs", json=request).json()
    status = wait_for_job(client, started["id"])
    assert status["status"] == "complete", status
    result = client.get(f"/api/analysis/jobs/{started['id']}/result").json()
    assert all(tag.startswith("train/") and "loss" not in tag for tag in result["curves"])
    assert result["curves"]
    unmatched = client.post("/api/analysis/jobs", json={**request, "exclude": ["*"]}).json()
    status = wait_for_job(client, unmatched["id"])
    assert status["status"] == "error"
    assert "No scalar metrics match" in status["error"]
    assert client.get(f"/api/analysis/jobs/{unmatched['id']}/result").status_code == 400
    assert client.get("/api/analysis/jobs/missing").status_code == 404
    assert (
        client.post("/api/analysis/jobs", json={**request, "start": 5, "end": 1}).status_code == 400
    )
    assert client.post("/api/analysis/jobs", json={**request, "kind": "unknown"}).status_code == 422
    assert (
        client.post("/api/analysis/jobs", json={**request, "include": ["x" * 513]}).status_code
        == 422
    )


def test_globs_are_case_sensitive_and_exclusions_win():
    tags = ["train/loss", "train/reward", "train/loss2", "eval/loss", "Train/loss", "steps"]
    assert select_tags(tags) == tags
    assert select_tags(tags, include=["train/*"], exclude=["*loss?"]) == [
        "train/loss",
        "train/reward",
    ]
    assert select_tags(tags, include=["[et]*"], exclude=["*reward"]) == [
        "train/loss",
        "train/loss2",
        "eval/loss",
    ]
    assert select_tags(tags, tags=["steps", "steps", "missing"]) == ["steps", "missing"]


@pytest.mark.parametrize("threshold", [50, 1000])
def test_event_threshold_above_thirty_is_accepted(client, threshold):
    experiment = client.get("/api/experiments").json()["experiments"][0]["id"]
    response = client.post(
        "/api/analysis/jobs", json={"experiment_id": experiment, "threshold": threshold}
    )
    assert response.status_code == 202, response.text
    status = wait_for_job(client, response.json()["id"])
    assert status["status"] == "complete", status
    result = client.get(f"/api/analysis/jobs/{response.json()['id']}/result").json()
    assert result["settings"]["threshold"] == threshold
    assert all(abs(event["score"]) >= threshold for event in result["timeline"])
    invalid = client.post(
        "/api/analysis/jobs", json={"experiment_id": experiment, "threshold": 0.5}
    )
    assert invalid.status_code == 422


def test_binary_context_request_validation_and_result_metadata(client):
    experiment = client.get("/api/experiments").json()["experiments"][0]["id"]
    request = {"experiment_id": experiment, "binary_window": 2001}
    started = client.post("/api/analysis/jobs", json=request)
    assert started.status_code == 202, started.text
    assert wait_for_job(client, started.json()["id"])["status"] == "complete"
    result = client.get(f"/api/analysis/jobs/{started.json()['id']}/result").json()
    assert result["settings"]["binary_window"] == 2001
    assert all("score_type" in detected for detected in result["detections"].values())
    assert all(event["score_type"] in {"mad", "bernoulli"} for event in result["timeline"])
    for invalid in [0, 30, 100002, 1000.5]:
        response = client.post("/api/analysis/jobs", json={**request, "binary_window": invalid})
        assert response.status_code == 422


def test_period_aware_scoring_defaults_and_cache_identity(client):
    experiment = client.get("/api/experiments").json()["experiments"][0]["id"]
    request = {"experiment_id": experiment, "include": ["train/*"]}
    default = client.post("/api/analysis/jobs", json=request).json()
    assert wait_for_job(client, default["id"])["status"] == "complete"
    result = client.get(f"/api/analysis/jobs/{default['id']}/result").json()
    assert result["settings"]["period_aware"] is True
    assert all(item["period_aware"] for item in result["detections"].values())
    disabled = client.post("/api/analysis/jobs", json={**request, "period_aware": False}).json()
    assert disabled["id"] != default["id"]
    assert wait_for_job(client, disabled["id"])["status"] == "complete"
    result = client.get(f"/api/analysis/jobs/{disabled['id']}/result").json()
    assert all(
        item["periodic"] is None and item["period_aware"] is False
        for item in result["detections"].values()
    )
    repeated = client.post("/api/analysis/jobs", json={**request, "period_aware": True}).json()
    assert repeated["id"] == default["id"] and repeated["reused"]


def test_cancellation_queue_bounds_and_fingerprint_invalidation(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []

    def controlled_analysis(repository, experiment, tags, options, progress):
        calls.append(experiment.id)
        progress(10, "Loading")
        entered.set()
        assert release.wait(3)
        progress(50, "Analyzing", "train/loss")
        return {"curves": {"train/loss": []}}

    monkeypatch.setattr("expman.jobs.event_analysis", controlled_analysis)
    event_file = tmp_path / "events.out.tfevents.example"
    event_file.write_bytes(b"before")
    experiment = SimpleNamespace(id="example", run_dirs=[tmp_path])
    manager = AnalysisJobs(SimpleNamespace(), max_results=4)
    try:
        first = manager.start("events", experiment, {"experiment_id": experiment.id})
        assert entered.wait(2)
        assert manager.start("events", experiment, {"experiment_id": experiment.id})["reused"]
        second = manager.start("events", experiment, {"threshold": 2})
        manager.start("events", experiment, {"threshold": 3})
        with pytest.raises(ValueError, match="already queued"):
            manager.start("events", experiment, {"threshold": 4})
        assert manager.cancel(second["id"])["status"] == "cancelled"
        manager.cancel(first["id"])
        release.set()
        deadline = time.monotonic() + 3
        while manager.status(first["id"])["status"] != "cancelled" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert manager.status(first["id"])["status"] == "cancelled"
        event_file.write_bytes(b"after change")
        changed = manager.start("events", experiment, {"experiment_id": experiment.id})
        assert changed["id"] != first["id"]
        assert not changed["reused"]
    finally:
        release.set()
        manager.close()


def test_completed_result_cache_is_bounded_and_invalidates_changed_logs(tmp_path, monkeypatch):
    monkeypatch.setattr("expman.jobs.event_analysis", lambda *args: {"curves": {}})
    experiment = SimpleNamespace(id="example", run_dirs=[tmp_path])
    manager = AnalysisJobs(SimpleNamespace(), max_results=2)

    def complete(options):
        job = manager.start("events", experiment, options)
        deadline = time.monotonic() + 2
        while manager.status(job["id"])["status"] != "complete" and time.monotonic() < deadline:
            time.sleep(0.005)
        assert manager.status(job["id"])["status"] == "complete"
        return job["id"]

    try:
        first = complete({"threshold": 1})
        complete({"threshold": 2})
        complete({"threshold": 3})
        with pytest.raises(KeyError):
            manager.status(first)
        old = complete({"threshold": 3})
        (tmp_path / "events.out.tfevents.new").write_bytes(b"new data")
        assert complete({"threshold": 3}) != old
        assert len(manager.jobs) <= 2
    finally:
        manager.close()


@pytest.mark.parametrize(
    "reduction", ["last", "last_smoothed", "best", "mean", "at_step", "smoothed_at_step"]
)
def test_relationship_job_matches_full_outcomes_and_associations(client, reduction):
    identifiers = [run["id"] for run in client.get("/api/experiments").json()["experiments"]]
    request = {
        "experiment_ids": identifiers,
        "metric": "eval/reward",
        "reduction": reduction,
        "at_step": 100,
        "start_step": 50,
        "end_step": 200,
    }
    expected = client.post("/api/analysis", json=request).json()
    response = client.post("/api/relationships/jobs", json=request)
    assert response.status_code == 202, response.text
    identifier = response.json()["id"]
    assert wait_for_job(client, identifier, "/api/relationships/jobs")["status"] == "complete"
    result = client.get(f"/api/relationships/jobs/{identifier}/result").json()
    assert result == expected
    reused = client.post("/api/relationships/jobs", json=request).json()
    assert reused["reused"] and reused["id"] == identifier


def test_relationship_cache_tracks_configs_exclusions_and_names(client):
    identifiers = [run["id"] for run in client.get("/api/experiments").json()["experiments"]]
    request = {"experiment_ids": identifiers, "metric": "eval/reward"}

    def complete():
        job = client.post("/api/relationships/jobs", json=request).json()
        assert wait_for_job(client, job["id"], "/api/relationships/jobs")["status"] == "complete"
        return job, client.get(f"/api/relationships/jobs/{job['id']}/result").json()

    original, _ = complete()
    client.patch(f"/api/experiments/{identifiers[0]}", json={"name": "Renamed"})
    renamed, result = complete()
    assert renamed["id"] != original["id"]
    assert (
        next(record for record in result["records"] if record["id"] == identifiers[0])["name"]
        == "Renamed"
    )
    client.put("/api/ignored-configs", json={"patterns": ["*"], "files": []})
    excluded, result = complete()
    assert excluded["id"] != renamed["id"]
    assert all(not record["config"] for record in result["records"])
    client.put("/api/ignored-configs", json={"patterns": [], "files": []})
    repository = client.app.state.repository
    repository.get(identifiers[0]).config["new_condition"] = "changed"
    _, result = complete()
    assert result["records"][0]["config"]["new_condition"] == "changed"
    for invalid in [{"reduction": "at_step"}, {"start_step": 5, "end_step": 1}]:
        assert (
            client.post("/api/relationships/jobs", json={**request, **invalid}).status_code == 400
        )
    assert client.get("/api/relationships/jobs/absent").status_code == 404


def test_relationship_cancel_does_not_block_configurations(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def controlled(options, progress):
        progress(10, "Reading selected metric")
        entered.set()
        assert release.wait(3)
        progress(50, "Computing outcomes")
        return {}

    manager = client.app.state.relationship_jobs
    monkeypatch.setattr(manager, "_relationships", controlled)
    identifiers = [run["id"] for run in client.get("/api/experiments").json()["experiments"]]
    try:
        job = client.post(
            "/api/relationships/jobs", json={"experiment_ids": identifiers, "metric": "eval/reward"}
        ).json()
        assert entered.wait(1)
        assert client.post("/api/compare", json={"experiment_ids": identifiers}).status_code == 200
        assert (
            client.post(f"/api/relationships/jobs/{job['id']}/cancel").json()["status"]
            == "cancelling"
        )
        release.set()
        assert wait_for_job(client, job["id"], "/api/relationships/jobs")["status"] == "cancelled"
        assert client.get(f"/api/relationships/jobs/{job['id']}/result").status_code == 400
    finally:
        release.set()


@pytest.mark.parametrize(
    "differences_only,query", [(True, "model"), (False, ""), (True, "no-such-path")]
)
def test_relationship_scope_matches_configuration_filters(client, differences_only, query):
    identifiers = [run["id"] for run in client.get("/api/experiments").json()["experiments"]]
    client.put("/api/ignored-configs", json={"patterns": ["timestamp"], "files": ["hparams.yml"]})
    rows = client.post(
        "/api/compare", json={"experiment_ids": identifiers, "differences_only": differences_only}
    ).json()["rows"]
    eligible = sorted(row["key"] for row in rows if query.lower() in row["key"].lower())
    request = {
        "experiment_ids": identifiers,
        "metric": "eval/reward",
        "condition_scope": "configurations",
        "configuration_differences_only": differences_only,
        "configuration_query": query,
    }
    started = client.post("/api/relationships/jobs", json=request)
    assert started.status_code == 202, started.text
    identifier = started.json()["id"]
    assert wait_for_job(client, identifier, "/api/relationships/jobs")["status"] == "complete"
    scoped = client.get(f"/api/relationships/jobs/{identifier}/result").json()
    assert scoped["condition_scope"] == "configurations"
    assert scoped["condition_keys"] == eligible
    assert all(item["key"] in eligible for item in scoped["associations"])
    all_configs = client.post("/api/analysis", json={**request, "condition_scope": "all"}).json()
    assert all_configs["records"] == scoped["records"]
    assert "timestamp" not in all_configs["condition_keys"]
    assert all(item["key"] in all_configs["condition_keys"] for item in all_configs["associations"])
    assert scoped == client.post("/api/analysis", json=request).json()
