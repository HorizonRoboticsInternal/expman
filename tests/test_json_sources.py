import json
import shutil
import threading
import time
from types import SimpleNamespace

import pytest

from expman.app import create_app
from expman.configs import config_paths, load_configs
from expman.json_metrics import JSONMetrics


def complete(client, path, identifier):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = client.get(f"{path}/{identifier}").json()
        if status["status"] in {"complete", "error", "cancelled"}:
            assert status["status"] == "complete", status
            return client.get(f"{path}/{identifier}/result").json()
        time.sleep(0.01)
    raise AssertionError(status)


def test_json_config_types_provenance_bom_and_exclusions(tmp_path):
    (tmp_path / "config.json").write_text(
        '\ufeff{"model":{"width":64},"model.width":128,"flag":true,"empty":null,"list":[1,"two"],"text":"plain"}'
    )
    (tmp_path / "extra.json").write_text('{"model":{"width":256}}')
    nested = tmp_path / "123"
    nested.mkdir()
    (nested / "hparams.json").write_text('{"seed":7}')
    flat, files, warnings = load_configs(tmp_path)
    assert not warnings
    assert flat["model.width"] == 64
    assert flat[r"model\.width"] == 128
    assert flat["flag"] is True and flat["empty"] is None
    assert flat["list"] == [1, "two"] and flat["text"] == "plain"
    assert flat["@extra.json::model.width"] == 256
    assert flat["@123/hparams.json::seed"] == 7
    assert files[0]["name"] == "config.json" and files[0]["primary"]
    (tmp_path / "config.yml").write_text("model:\n  width: 32\n")
    assert load_configs(tmp_path)[0]["model.width"] == 32
    assert load_configs(tmp_path)[0]["@config.json::model.width"] == 64
    assert "extra.json" not in [
        path.name for path in config_paths(tmp_path, {tmp_path / "extra.json"})
    ]


def test_hydra_json_fallback_and_malformed_source_visibility(tmp_path):
    hydra = tmp_path / ".hydra"
    hydra.mkdir()
    (hydra / "config.json").write_text('{"seed":3}')
    (tmp_path / "broken.json").write_text('{"value":1} trailing')
    flat, files, warnings = load_configs(tmp_path)
    assert flat["seed"] == 3
    assert files[0]["name"] == ".hydra/config.json"
    assert any(file["name"] == "broken.json" and "trailing" in file["content"] for file in files)
    assert any("broken.json" in warning for warning in warnings)


@pytest.fixture
def json_app(example_logs, tmp_path, client_factory):
    root = tmp_path / "logs"
    shutil.copytree(example_logs, root)
    app = create_app(root, tmp_path / "state.json", tensorboard_loader="python")
    with client_factory(app) as client:
        yield client, root


def test_summary_import_discovery_comparison_relationships_and_reload(json_app):
    client, root = json_app
    runs = client.get("/api/experiments").json()["experiments"]
    document = {
        "runs": [
            {
                "experiment": runs[0]["path"],
                "metrics": {
                    "accuracy": 0.9,
                    "nested": {"loss": 2.0},
                    "missing": None,
                    "flag": True,
                },
            },
            {"experiment_id": runs[1]["id"], "metrics": {"accuracy": 0.8}},
        ]
    }
    for run, record in zip(runs, document["runs"], strict=False):
        (root / run["path"] / "additional.json").write_text(json.dumps(record))
    loaded = client.put("/api/json-metrics", json={"paths": ["additional.json"]})
    assert loaded.status_code == 200, loaded.text
    assert loaded.json()["matched_experiments"] == 2
    assert loaded.json()["metric_values"] == 3
    tag = "JSON/additional/accuracy"
    selected = [item["id"] for item in runs[:2]]
    metrics = client.post("/api/metrics", json={"experiment_ids": selected}).json()
    assert tag in metrics["summary_tags"] and tag not in metrics["tags"]
    spec = {"id": "extra", "tag": tag, "mode": "latest"}
    rows = client.post(
        "/api/compare", json={"experiment_ids": selected, "scalar_rows": [spec]}
    ).json()["rows"]
    assert [cell["value"] for cell in rows[0]["cells"]] == [0.9, 0.8]
    result = client.post("/api/analysis", json={"experiment_ids": selected, "metric": tag}).json()
    assert result["summary_only"] is True
    assert all(not key.startswith("JSON/") for key in result["condition_keys"])
    assert all("additional.json" not in key for key in result["condition_keys"])
    assert all(not item["key"].startswith("JSON/") for item in result["associations"])
    assert [record["result"] for record in result["records"]] == [0.9, 0.8]
    assert all(
        record["first_step"] is None and record["last_step"] is None for record in result["records"]
    )
    assert (
        client.post(
            "/api/analysis", json={"experiment_ids": selected, "metric": tag, "reduction": "mean"}
        ).status_code
        == 400
    )
    assert client.get("/api/workspace").json()["state"]["json_metrics"] == ["additional.json"]
    assert create_app(
        root, client.app.state.store.path, tensorboard_loader="python"
    ).state.repository.json_sources.paths == ["additional.json"]


@pytest.mark.parametrize(
    "source", ["evaluation_metrics.json", "{experiment}/evaluation_metrics.json"]
)
def test_per_experiment_evaluation_files_support_aliases_and_null_metrics(json_app, source):
    client, root = json_app
    runs = client.get("/api/experiments").json()["experiments"]
    for index, run in enumerate(runs[:2]):
        (root / run["path"] / "evaluation_metrics.json").write_text(
            json.dumps(
                {
                    "experiment": "old-alias",
                    "status": "complete" if index == 0 else "waiting_for_training",
                    "metrics": {"Success rate": 83.5} if index == 0 else None,
                }
            )
        )
    (root / "evaluation_metrics.json").write_text("Not a shared metric source")
    response = client.put("/api/json-metrics", json={"paths": [source]})
    assert response.status_code == 200
    status = client.get("/api/json-metrics").json()
    assert status["metric_values"] == 1 and status["matched_experiments"] == 1
    assert not status["errors"] and not status["warnings"]
    tag = "JSON/evaluation_metrics/Success rate"
    refreshed = client.get("/api/experiments").json()["experiments"]
    assert refreshed[0]["metrics"][tag]["last"] == 83.5
    assert tag not in refreshed[1]["metrics"]
    assert not any("evaluation_metrics.json" in key for item in refreshed for key in item["config"])
    analysis = client.post(
        "/api/analysis", json={"experiment_ids": [item["id"] for item in refreshed], "metric": tag}
    ).json()
    assert all("evaluation_metrics" not in key for key in analysis["condition_keys"])
    discovered = client.post(
        "/api/metrics", json={"experiment_ids": [item["id"] for item in refreshed]}
    ).json()
    assert tag in discovered["summary_tags"]
    assert all("evaluation_metrics" not in key for key in discovered["config_keys"])


def test_summary_jobs_are_fast_and_invalidate_changed_json(json_app, monkeypatch):
    client, root = json_app
    runs = client.get("/api/experiments").json()["experiments"]
    path = root / runs[0]["path"] / "scores.json"
    path.write_text('{"accuracy":0.9}')
    assert client.put("/api/json-metrics", json={"paths": ["scores.json"]}).status_code == 200
    tag = "JSON/scores/accuracy"

    def forbidden(*args, **kwargs):
        raise AssertionError("JSON summaries must not load TensorBoard histories")

    monkeypatch.setattr(client.app.state.repository, "load", forbidden)
    monkeypatch.setattr(client.app.state.tensorboard, "initialize", forbidden)
    client.app.state.relationship_jobs.native.loader = "fast"
    request = {
        "experiment_ids": [runs[0]["id"], runs[1]["id"]],
        "scalar_rows": [{"id": "score", "tag": tag, "mode": "latest"}],
    }
    first = client.post("/api/compare/scalars/jobs", json=request).json()
    result = complete(client, "/api/compare/scalars/jobs", first["id"])
    assert result["rows"][0]["cells"] == [
        {"present": True, "value": 0.9},
        {"present": False, "value": None},
    ]
    relationship = client.post(
        "/api/relationships/jobs", json={"experiment_ids": request["experiment_ids"], "metric": tag}
    ).json()
    result = complete(client, "/api/relationships/jobs", relationship["id"])
    assert [record["result"] for record in result["records"]] == [0.9]
    path.write_text('{"accuracy":0.12345}')
    changed = client.post("/api/compare/scalars/jobs", json=request).json()
    assert changed["id"] != first["id"]
    assert (
        complete(client, "/api/compare/scalars/jobs", changed["id"])["rows"][0]["cells"][0]["value"]
        == 0.12345
    )


def test_json_loading_reports_progress_and_restores_sources_after_restart(
    json_app, monkeypatch, client_factory
):
    client, root = json_app
    runs = client.get("/api/experiments").json()["experiments"]
    (root / runs[0]["path"] / "scores.json").write_text('{"score":0.75}')
    entered, release = threading.Event(), threading.Event()
    decode = JSONMetrics._decode

    def slow_decode(*args):
        entered.set()
        assert release.wait(5)
        return decode(*args)

    monkeypatch.setattr(JSONMetrics, "_decode", staticmethod(slow_decode))
    original = client.get("/api/workspace").json()["state"]["json_metrics"]
    job = client.post("/api/json-metrics/jobs", json={"paths": ["scores.json"]}).json()
    try:
        assert entered.wait(3)
        progress = client.get(f"/api/json-metrics/jobs/{job['id']}").json()
        assert progress["status"] == "running"
        assert progress["percent"] < 100
        assert progress["stage"] == f"Loading JSON source 1 of {len(runs)}"
        assert progress["metric"] == f"{runs[0]['path']}/scores.json"
        assert client.get("/api/workspace").json()["state"]["json_metrics"] == original
    finally:
        release.set()
    result = complete(client, "/api/json-metrics/jobs", job["id"])
    assert result["metric_values"] == 1 and result["paths"] == ["scores.json"]
    assert client.get(f"/api/json-metrics/jobs/{job['id']}").json()["percent"] == 100
    monkeypatch.setattr(JSONMetrics, "_decode", staticmethod(decode))
    reopened = create_app(root, client.app.state.store.path, tensorboard_loader="python")
    with client_factory(reopened) as restored:
        status = restored.get("/api/json-metrics").json()
        assert status["paths"] == ["scores.json"] and status["metric_values"] == 1
        assert status["summary_tags"] == ["JSON/scores/score"]


def test_failed_json_loading_job_keeps_saved_sources(json_app):
    client, root = json_app
    original = client.get("/api/json-metrics").json()["paths"]
    run = client.get("/api/experiments").json()["experiments"][0]
    (root / run["path"] / "invalid.json").write_text('{"score":1} trailing')
    job = client.post("/api/json-metrics/jobs", json={"paths": ["invalid.json"]}).json()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = client.get(f"/api/json-metrics/jobs/{job['id']}").json()
        if status["status"] == "error":
            break
        time.sleep(0.01)
    assert status["status"] == "error" and "Extra data" in status["error"]
    assert client.get("/api/json-metrics").json()["paths"] == original


def test_invalid_metric_sources_preserve_registration_and_reject_traversal(json_app, tmp_path):
    client, root = json_app
    original = client.get("/api/json-metrics").json()["paths"]
    run = client.get("/api/experiments").json()["experiments"][0]
    (root / run["path"] / "broken.json").write_text('{"value":1} junk')
    response = client.put("/api/json-metrics", json={"paths": ["broken.json"]})
    assert response.status_code == 400 and "Extra data" in response.text
    assert client.get("/api/json-metrics").json()["paths"] == original
    for path in ["../outside.json", str(tmp_path / "outside.json")]:
        assert client.put("/api/json-metrics", json={"paths": [path]}).status_code == 400


def test_ambiguous_shared_names_do_not_bind_to_wrong_experiment(tmp_path):
    experiments = [
        SimpleNamespace(
            id=str(index), relative_path=f"{index}/run", path=tmp_path / str(index) / "run"
        )
        for index in range(2)
    ]
    (tmp_path / "archive").mkdir()
    (tmp_path / "archive" / "summary.json").write_text('{"run":{"score":1}}')
    report = JSONMetrics(tmp_path, ["archive/summary.json"]).collect(experiments)
    assert all(not values for values in report["metrics"].values())
    assert any("Ambiguous" in warning for warning in report["warnings"])
