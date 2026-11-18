import json
from types import SimpleNamespace

import numpy as np
import pytest

from expman.onsets import baseline_model, pearson, smooth_segments, sustained_change_analysis


def analyze(data, **options):
    repository = SimpleNamespace(load=lambda _: data)
    return sustained_change_analysis(
        repository,
        SimpleNamespace(id="test"),
        None,
        {
            "reference": "onset/reference",
            "start": 400,
            "end": 1000,
            "onset_smoothing": 10,
            "onset_duration": 20,
            **options,
        },
    )


def test_broad_changes_have_signed_correlations_onsets_and_delays(onset_signals):
    original = {tag: points.copy() for tag, points in onset_signals.items()}
    result = analyze(onset_signals)
    rows = {row["tag"]: row for row in result["rows"]}
    assert result["reference_result"]["status"] == "Detected"
    assert result["analysis"]["baseline_start"] == 100
    assert result["analysis"]["baseline_end"] == 400
    assert result["rows"][0]["tag"] == "onset/identical"
    assert rows["onset/early"]["related"] and rows["onset/late"]["related"]
    assert -80 < rows["onset/early"]["delay"] < -15
    assert 15 < rows["onset/late"]["delay"] < 80
    assert rows["onset/inverse"]["correlation"] < -0.8
    assert rows["onset/inverse"]["change_correlation"] < 0
    assert rows["onset/inverse"]["direction"] == "fall"
    assert rows["onset/inverse"]["delay"] < 0
    assert rows["onset/identical"]["correlation"] == pytest.approx(1)
    assert rows["onset/identical"]["delay"] == pytest.approx(0, abs=2)
    for tag, points in original.items():
        np.testing.assert_array_equal(points, onset_signals[tag])
    json.dumps(result, allow_nan=False)


def test_constants_drift_and_isolated_flags_do_not_have_sustained_onsets(onset_signals):
    rows = {row["tag"]: row for row in analyze(onset_signals)["rows"]}
    for tag in ("constant", "drift", "isolated"):
        assert rows[f"onset/{tag}"]["onset"] is None
        assert not rows[f"onset/{tag}"]["related"]
    assert rows["onset/constant"]["correlation"] is None
    assert rows["onset/constant"]["status"] == "Constant in change interval"
    binary = rows["onset/binary"]
    assert binary["binary"]
    assert binary["onset"] == 600
    assert 0 < binary["noise"] < 0.1


def test_baseline_fit_never_uses_the_future_change(onset_signals):
    points = onset_signals["onset/reference"]
    grid = np.arange(100, 1001, dtype=float)
    bounds = {"baseline_start": 100, "baseline_end": 400, "start": 400, "end": 1000}
    first = baseline_model(points[:, 0], points[:, 1], grid, bounds, 51)
    changed = points[:, 1].copy()
    changed[400:] += 1e8
    second = baseline_model(points[:, 0], changed, grid, bounds, 51)
    np.testing.assert_array_equal(first["baseline"], second["baseline"])
    assert first["noise"] == second["noise"]


def test_custom_baseline_end_keeps_automatic_baseline_before_it(onset_signals):
    result = analyze(onset_signals, onset_baseline_end=350)
    assert result["analysis"]["baseline_start"] == 50
    assert result["analysis"]["baseline_end"] == 350
    assert result["analysis"]["start"] == 400


def test_gaps_are_masked_and_gap_onsets_keep_recording_brackets(onset_signals):
    points = onset_signals["onset/reference"]
    mask = (points[:, 0] < 500) | (points[:, 0] >= 650)
    data = {**onset_signals, "onset/gapped": points[mask]}
    result = analyze(data)
    row = next(row for row in result["rows"] if row["tag"] == "onset/gapped")
    assert row["onset"] == 650
    assert row["status"] == "After recording gap"
    assert row["onset_bracket"] == [499, 650]
    curve = result["curves"]["onset/gapped"]
    assert any(value is None for value in curve["y"])
    assert len(set(curve["segments"]) - {-1}) == 2
    smoothed = smooth_segments(np.array([1.0, 2.0, 3.0, np.nan, 90.0, 100.0, 110.0]), 3)
    assert np.isnan(smoothed[3])
    assert smoothed[2] < 4 and smoothed[4] > 80


def test_sparse_records_do_not_gain_precision_through_interpolation(onset_signals):
    data = {
        **onset_signals,
        "onset/sparse": onset_signals["onset/reference"][::250],
        "onset/coarse": onset_signals["onset/reference"][::10],
    }
    result = analyze(data)
    rows = {row["tag"]: row for row in result["rows"]}
    assert rows["onset/sparse"]["status"] == "Insufficient baseline"
    assert rows["onset/sparse"]["onset"] is None
    assert rows["onset/sparse"]["correlation"] is None
    assert not rows["onset/sparse"]["related"]
    coarse = rows["onset/coarse"]
    assert coarse["onset_bracket"][0] <= coarse["onset"] <= coarse["onset_bracket"][1]
    assert coarse["onset_bracket"][1] - coarse["onset_bracket"][0] <= 10


def test_absent_reference_onset_leaves_all_delays_unavailable(onset_signals):
    points = onset_signals["onset/reference"].copy()
    points[:, 1] = 1
    result = analyze({**onset_signals, "onset/reference": points})
    assert result["reference_result"]["onset"] is None
    assert all(row["delay"] is None for row in result["rows"])
    assert any(row["onset"] is not None for row in result["rows"])


@pytest.mark.parametrize("axis", ["relative", "wall"])
def test_axis_units_preserve_the_same_observed_changes(onset_signals, axis):
    steps = analyze(onset_signals)
    origin = 1_790_000_000 if axis == "wall" else 0
    result = analyze(
        onset_signals,
        x_axis=axis,
        start=origin + 800,
        end=origin + 2000,
        onset_smoothing=20,
        onset_duration=40,
    )
    assert result["reference_result"]["onset"] == pytest.approx(
        origin + 2 * steps["reference_result"]["onset"]
    )
    assert result["analysis"]["resolution"] == 2


def test_numerical_and_display_work_is_bounded():
    x = np.arange(20_001, dtype=float)
    y = np.exp(-0.5 * ((x - 15_000) / 1000) ** 2)
    result = analyze({"onset/reference": np.column_stack((x, y, x))}, start=8000, end=20_000)
    assert result["analysis"]["grid_points"] <= 4096
    assert len(result["curves"]["onset/reference"]["x"]) <= 1001
    assert result["curves"]["onset/reference"]["source_points"] == len(x)
    assert result["reference_result"]["onset"] is not None
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize(
    "options",
    [
        {"reference": None},
        {"reference": "absent"},
        {"onset_baseline_start": 390, "onset_baseline_end": 395},
        {"onset_baseline_start": 500},
        {"onset_baseline_end": 401},
        {"end": 2000},
    ],
)
def test_unusable_reference_or_baseline_has_an_actionable_error(onset_signals, options):
    with pytest.raises(ValueError):
        analyze(onset_signals, **options)


def test_pearson_keeps_sign_and_requires_observed_variation():
    x = np.arange(20, dtype=float)
    assert pearson(x, -x)[0] == pytest.approx(-1)
    assert pearson(x, np.full(20, 0.1))[0] is None
    assert pearson(x[:5], x[:5]) == (None, 5)


def test_onset_jobs_progress_cache_and_direct_endpoint(client, monkeypatch, onset_signals):
    from test_jobs import wait_for_job

    identifier = client.get("/api/experiments").json()["experiments"][0]["id"]
    calls = []
    monkeypatch.setattr(
        client.app.state.repository,
        "load",
        lambda experiment: calls.append(experiment.id) or onset_signals,
    )
    request = {
        "kind": "onsets",
        "experiment_id": identifier,
        "reference": "onset/reference",
        "start": 400,
        "end": 1000,
        "onset_smoothing": 10,
        "onset_duration": 20,
        "include": ["onset/*"],
        "exclude": ["*/constant"],
    }
    started = client.post("/api/analysis/jobs", json=request)
    assert started.status_code == 202
    status = wait_for_job(client, started.json()["id"])
    assert status["status"] == "complete", status
    assert status["percent"] == 100
    result = client.get(f"/api/analysis/jobs/{started.json()['id']}/result").json()
    assert result["kind"] == "onsets"
    assert "onset/constant" not in result["curves"]
    assert result["rows"][0]["tag"] == "onset/identical"
    assert calls == [identifier]
    cached = client.post("/api/analysis/jobs", json={**request, "onset_sort": "onset"}).json()
    assert cached["id"] == started.json()["id"] and cached["reused"]
    assert calls == [identifier]
    changed = client.post("/api/analysis/jobs", json={**request, "onset_threshold": 8}).json()
    assert changed["id"] != cached["id"]
    assert wait_for_job(client, changed["id"])["status"] == "complete"
    direct = client.post("/api/onsets", json=request)
    assert direct.status_code == 200
    assert direct.json()["reference_result"]["onset"] == result["reference_result"]["onset"]


@pytest.mark.parametrize(
    "extra,status",
    [
        ({"reference": None}, 400),
        ({"onset_duration": 0}, 422),
        ({"onset_threshold": 0}, 422),
        ({"onset_min_correlation": 1.1}, 422),
        ({"onset_min_change_correlation": -0.1}, 422),
        ({"onset_smoothing": -1}, 422),
        ({"onset_baseline_start": 500, "onset_baseline_end": 400}, 400),
        ({"onset_baseline_end": 450}, 400),
    ],
)
def test_onset_request_validation(client, extra, status):
    identifier = client.get("/api/experiments").json()["experiments"][0]["id"]
    response = client.post(
        "/api/analysis/jobs",
        json={
            "kind": "onsets",
            "experiment_id": identifier,
            "reference": "train/loss",
            "start": 400,
            **extra,
        },
    )
    assert response.status_code == status
