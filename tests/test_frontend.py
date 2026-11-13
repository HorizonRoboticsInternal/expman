import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(
    shutil.which("node") is None, reason="Node is optional for frontend logic tests"
)
def test_all_panels_are_accessible_and_page_requests_are_bounded():
    script = Path(__file__).with_name("test_panels.cjs")
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is optional for frontend tests")
def test_browser_smoothing_matches_tensorboard_and_backend_groups(client, tmp_path):
    identifiers = [run["id"] for run in client.get("/api/experiments").json()["experiments"][:3]]
    cases = []
    for axis in ["step", "relative", "wall"]:
        request = {
            "experiment_ids": identifiers,
            "tags": ["train/loss"],
            "combine_selected": True,
            "x_axis": axis,
            "max_points": 40,
        }
        raw = client.post("/api/curves", json={**request, "client_smoothing": True}).json()
        assert raw["client_smoothing"]
        assert len(raw["curves"]["train/loss"][0]["members"][0]["points"]) > 40
        for weight in [0, 0.9]:
            for band in ["std", "sem", "range"]:
                for alignment in ["union", "overlap"]:
                    options = {
                        "x_axis": axis,
                        "smoothing": weight,
                        "band": band,
                        "alignment": alignment,
                        "max_points": 40,
                    }
                    expected = client.post("/api/curves", json={**request, **options}).json()
                    cases.append(
                        {
                            "curves": raw["curves"]["train/loss"],
                            "options": options,
                            "expected": expected["curves"]["train/loss"],
                        }
                    )
    fixture = tmp_path / "browser-smoothing.json"
    fixture.write_text(json.dumps(cases))
    result = subprocess.run(
        ["node", str(Path(__file__).with_name("test_smoothing.cjs")), str(fixture)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    shutil.which("node") is None, reason="Node is optional for frontend logic tests"
)
def test_appearance_and_named_filter_frontend_helpers():
    script = Path(__file__).with_name("test_preferences.cjs")
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is optional for frontend tests")
def test_parallel_coordinates_preserve_missing_conditions_and_brushing():
    script = Path(__file__).with_name("test_relationships.cjs")
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is optional for frontend tests")
def test_grouped_overview_and_all_curve_analysis_rendering():
    script = Path(__file__).with_name("test_ui.cjs")
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is optional for frontend tests")
def test_comparison_group_and_relationship_ui_with_real_api_data(client, tmp_path):
    runs = client.get("/api/experiments").json()["experiments"]
    identifiers = [run["id"] for run in runs]
    client.patch("/api/experiments/" + identifiers[0], json={"name": "Reference run"})
    metrics = client.post("/api/metrics", json={"experiment_ids": identifiers}).json()
    comparison = client.post(
        "/api/compare", json={"experiment_ids": identifiers, "differences_only": False}
    ).json()
    group = client.post(
        "/api/groups", json={"name": "Three seeds", "experiment_ids": identifiers[:3]}
    ).json()
    metric = "eval/reward"
    curves = client.post(
        "/api/curves",
        json={"experiment_ids": identifiers, "tags": [metric], "group_ids": [group["id"]]},
    ).json()
    client.put("/api/ignored-configs", json={"patterns": ["timestamp"], "files": []})
    ignored = client.post(
        "/api/compare", json={"experiment_ids": identifiers, "differences_only": False}
    ).json()
    analysis = client.post(
        "/api/analysis", json={"experiment_ids": identifiers, "metric": metric}
    ).json()
    fixture = {
        "workspace": client.get("/api/workspace").json(),
        "runs": client.get("/api/experiments").json()["experiments"],
        "ids": identifiers,
        "metrics": metrics,
        "comparison": comparison,
        "ignored": ignored,
        "curves": curves,
        "analysis": analysis,
        "metric": metric,
    }
    fixture_path = tmp_path / "workflow-responses.json"
    fixture_path.write_text(json.dumps(fixture))
    script = Path(__file__).with_name("test_ui.cjs")
    result = subprocess.run(
        ["node", str(script), str(fixture_path)], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stdout + result.stderr
