from types import SimpleNamespace

import numpy as np
import pytest

from expman.timeseries import (
    autocorrelation,
    correlation_grid,
    cycle_neighbors,
    detect_events,
    fit_frequencies,
    fit_frequency,
    lagged_correlation,
    match_events,
    periodic_spectrum,
    periodicity_analysis,
    resample,
    rolling_mad,
    rolling_median,
)


@pytest.mark.parametrize("detrend", [True, False])
def test_batched_frequency_fits_match_independent_least_squares(detrend):
    generator = np.random.default_rng(51)
    positions = np.sort(generator.uniform(0, 200, 310))
    values = (
        2 + positions * 0.03 + np.sin(positions * 0.3) + generator.normal(0, 0.1, len(positions))
    )
    frequencies = np.linspace(0.01, 0.2, 75)
    batched = fit_frequencies(positions, values, frequencies, detrend)
    for frequency, actual in zip(frequencies, batched, strict=True):
        expected = fit_frequency(positions, values, frequency, detrend)
        assert actual == pytest.approx(expected, abs=1e-10)


def test_batched_lag_correlations_match_pairwise_pearson_with_missing_points():
    generator = np.random.default_rng(50)
    first, second = generator.normal(size=(2, 100))
    first[20:30], second[50:61] = np.nan, np.nan
    shifts = np.arange(-30, 31)
    coefficients, counts = correlation_grid(first, second, shifts, 8)
    for shift, coefficient, count in zip(shifts, coefficients, counts, strict=True):
        left, right = (
            (first[:-shift], second[shift:])
            if shift > 0
            else (first[-shift:], second[:shift])
            if shift < 0
            else (first, second)
        )
        valid = np.isfinite(left) & np.isfinite(right)
        assert count == np.count_nonzero(valid)
        assert coefficient == pytest.approx(np.corrcoef(left[valid], right[valid])[0, 1], abs=1e-12)


def test_event_order_and_matching():
    positions = np.arange(150)
    first, second = np.ones(150), np.ones(150)
    first[[30, 70, 110]] = 10
    second[[34, 74, 114]] = 10
    first_events = detect_events(positions, first)["events"]
    second_events = detect_events(positions, second)["events"]
    assert [event["x"] for event in first_events] == [30, 70, 110]
    matched = match_events(first_events, second_events, 6)
    assert matched["matched"] == 3
    assert matched["median_delay"] == 4
    assert match_events(first_events, second_events, 2)["matched"] == 0
    assert detect_events(positions, np.ones(150))["events"] == []


def test_dips_changes_and_one_to_one_matches():
    positions = np.arange(100)
    values = np.ones(100)
    values[40] = -5
    assert detect_events(positions, values, polarity="down")["events"][0]["kind"] == "dip"
    assert detect_events(positions, values, polarity="up")["events"] == []
    values[40:] = 6
    change = detect_events(positions, values, detector="change")["events"]
    assert change[0]["x"] == 40
    reference = [{"x": 10, "kind": "spike"}, {"x": 12, "kind": "spike"}]
    assert match_events(reference, [{"x": 11, "kind": "spike"}], 5)["matched"] == 1


@pytest.mark.parametrize("state", [0, 1])
def test_binary_constant_and_balanced_flags_do_not_create_artificial_outliers(state):
    positions = np.arange(2000)
    for values in [np.full(2000, state), np.arange(2000) % 2]:
        result = detect_events(positions, values, threshold=5)
        assert result["data_type"] == "binary"
        assert result["score_type"] == "bernoulli"
        assert result["context_window"] == 1001
        assert result["noise_floor"] is None
        assert result["events"] == []


@pytest.mark.parametrize("direction", [1, -1])
def test_binary_rare_states_have_finite_long_context_scores_and_preserve_steps(direction):
    positions = np.arange(2001) * 5
    values = np.zeros(2001) if direction == 1 else np.ones(2001)
    values[1000] = 1 if direction == 1 else 0
    result = detect_events(positions, values, threshold=15)
    assert len(result["events"]) == 1
    event = result["events"][0]
    assert event["x"] == 5000
    assert event["score"] == pytest.approx(direction * np.sqrt(2001))
    assert event["score_type"] == "bernoulli"
    assert event["context_window"] == 1001
    assert event["score"] == pytest.approx(event["deviation"] / event["scale"])
    assert result["context_observations"] == {"min": 500, "max": 1000}
    assert detect_events(positions, values, threshold=50)["events"] == []
    assert detect_events(positions, values, threshold=15, binary_window=31)["events"] == []


def test_binary_changes_respect_polarity_and_logging_gaps():
    positions = np.arange(2001, dtype=float)
    values = np.zeros(2001)
    values[1000] = 1
    result = detect_events(positions, values, detector="change")
    assert [event["x"] for event in result["events"]] == [1000]
    assert result["events"][0]["kind"] == "rise"
    assert detect_events(positions, values, detector="change", polarity="down")["events"] == []
    positions[1000:] += 10000
    assert detect_events(positions, values, detector="change")["events"] == []


def test_short_contexts_and_continuous_boundaries_use_only_observed_values():
    assert rolling_median(np.array([0, 10, 20, 30, 40]), 3).tolist() == [5, 10, 20, 30, 35]
    samples = np.array([0, 10, 20, 30, 40])
    assert rolling_mad(samples, 3, rolling_median(samples, 3)).tolist() == [5, 10, 10, 10, 5]
    assert rolling_median(np.arange(7) * 10, 4).tolist() == [10, 15, 25, 35, 45, 50, 55]
    values = np.ones(60)
    values[1] = 1e8
    events = detect_events(np.arange(60), values, threshold=50)["events"]
    assert any(event["x"] == 1 and event["score"] > 50 for event in events)


def test_smooth_turning_points_do_not_collapse_local_noise_scale():
    positions = np.arange(2000, dtype=float)
    values = 0.5 + 0.02 * np.sin(positions / 150)
    assert (
        detect_events(positions, values, window=101, threshold=10, period_aware=False)["events"]
        == []
    )
    values[850] += 2
    result = detect_events(positions, values, window=101, threshold=10, period_aware=False)
    assert any(event["x"] == 850 and event["score"] > 10 for event in result["events"])


@pytest.mark.parametrize("window", [31, 101])
@pytest.mark.parametrize("period_aware", [False, True])
def test_boundary_scoring_allows_ordinary_startup_variation(window, period_aware):
    positions = np.arange(1000, dtype=float)
    values = 0.9 + 0.02 * np.sin(positions / 20) + 0.04 * (positions % 10 == 0)
    values[:8] = [
        -0.38045144,
        0.44146645,
        0.67039502,
        0.76883394,
        0.8252548,
        0.85231662,
        0.86860853,
        0.88094985,
    ]
    result = detect_events(
        positions, values, window=window, threshold=10, period_aware=period_aware
    )
    assert result["boundary_adjusted_points"] > 0
    assert not any(event["x"] == 1 for event in result["events"])


@pytest.mark.parametrize("position", [1, 198])
@pytest.mark.parametrize("period_aware", [False, True])
def test_boundary_uncertainty_preserves_genuine_extremes(position, period_aware):
    positions = np.arange(200, dtype=float)
    values = np.ones(200)
    values[position] = 1e8
    result = detect_events(positions, values, window=101, threshold=50, period_aware=period_aware)
    assert any(event["x"] == position and event["score"] > 50 for event in result["events"])


@pytest.mark.parametrize("detector", ["spike", "change"])
def test_periodic_fluctuation_preserves_unusual_peaks_and_off_phase_anomalies(detector):
    positions = np.arange(2000, dtype=float)
    values = np.full(2000, 2.0)
    peaks = np.arange(0, 2000, 10)
    values[peaks] += 5 + 0.4 * np.sin(peaks / 70)
    values[822] = 1e8
    values[850] += 40
    options = {"threshold": 8, "window": 101, "detector": detector}
    raw = detect_events(positions, values, period_aware=False, **options)
    adjusted = detect_events(positions, values, **options)
    assert raw["total"] >= 190
    assert adjusted["periodic"]["period"] == pytest.approx(10)
    assert adjusted["periodic"]["improvement"] > 0.9
    assert adjusted["periodic"]["adjusted_points"] == len(positions) - (detector == "change")
    assert adjusted["total"] <= 4
    assert {822, 850}.issubset({event["x"] for event in adjusted["events"]})
    event = next(event for event in adjusted["events"] if event["x"] == 822)
    assert event["baseline"] == pytest.approx(2 if detector == "spike" else 0)
    assert event["baseline_type"] == "periodic_phase"
    assert event["score"] == pytest.approx(event["deviation"] / event["scale"])
    assert event["period"] == 10


def test_normal_cycle_variation_is_included_in_the_phase_score():
    positions = np.arange(2000, dtype=float)
    values = np.full(2000, 2.0)
    peaks = np.arange(0, 2000, 10)
    values[peaks] += 5 + 0.4 * np.sin(peaks / 70)
    result = detect_events(positions, values, threshold=8)
    assert result["periodic"]["period"] == 10
    assert result["events"] == []


def test_cycle_discovery_separates_warmup_trend_from_recurring_peaks():
    positions = np.arange(2000, dtype=float)
    trend = 300 - 250 * np.exp(-positions / 30)
    values = trend + 5 * (positions % 10 == 0)
    result = detect_events(positions, values, window=101, threshold=10)
    assert result["periodic"]["period"] == 10
    assert all(event["x"] < 150 for event in result["events"])
    assert detect_events(positions, trend, window=101)["periodic"] is None


def test_binary_periodic_probability_uses_long_phase_context_without_self_leakage():
    positions = np.arange(3000, dtype=float)
    values = (positions % 10 == 0).astype(float)
    values[1500], values[1505] = 0, 1
    result = detect_events(positions, values, threshold=15)
    assert result["periodic"]["period"] == 10
    assert result["periodic"]["context_observations"]["max"] == 299
    assert result["context_observations"] == {"min": 299, "max": 299}
    assert result["context_window"] == 1001
    assert [event["x"] for event in result["events"]] == [1500, 1505]
    assert [event["score"] for event in result["events"]] == pytest.approx(
        [-np.sqrt(599), np.sqrt(599)]
    )
    assert result["events"][0]["baseline"] == pytest.approx(299.5 / 300)


def test_periodic_neighbors_do_not_cross_a_logging_gap():
    positions = np.concatenate((np.arange(300), np.arange(1000, 1300))).astype(float)
    values = np.where(positions < 300, 2, 100) + np.where(positions % 10 == 0, 5, 0)
    segments = (positions >= 1000).astype(int)
    baseline, scale, counts = cycle_neighbors(
        positions, values, np.array([290, 1000]), 10, segments
    )
    assert baseline.tolist() == [7, 105]
    assert counts.tolist() == [8, 8]
    assert scale.tolist() == [0, 0]


@pytest.mark.parametrize("layout", ["leading_gap", "trailing_gap", "long_curve"])
@pytest.mark.parametrize("detector", ["spike", "change"])
def test_periodic_discovery_keeps_full_signals_when_using_a_subsegment(layout, detector):
    positions = (
        np.concatenate((np.arange(100), np.arange(1000, 2000)))
        if layout == "leading_gap"
        else np.concatenate((np.arange(1000), np.arange(2000, 2100)))
        if layout == "trailing_gap"
        else np.arange(16_480)
    ).astype(float)
    values = 2 + 5 * (positions % 10 == 0).astype(float)
    values[[50, -50]] += 1e8
    original = values.copy()
    result = detect_events(positions, values, window=101, threshold=20, detector=detector)
    assert result["periodic"]["period"] == 10
    assert result["periodic"]["source_points"] == len(positions) - (detector == "change")
    assert result["periodic"]["adjusted_points"] > len(positions) * 0.8
    assert {positions[50], positions[-50]} <= {event["x"] for event in result["events"]}
    assert len(result["events"]) <= 6
    np.testing.assert_array_equal(values, original)


def test_unreliable_periods_preserve_local_event_scoring():
    generator = np.random.default_rng(124)
    positions = np.cumsum(generator.uniform(0.3, 1.7, 500))
    values = np.sin(positions * 0.3) + generator.normal(0, 0.1, 500)
    values[300] = 100
    adjusted = detect_events(positions, values)
    raw = detect_events(positions, values, period_aware=False)
    assert adjusted["periodic"] is None
    assert adjusted["events"] == raw["events"]
    assert any(event["x"] == positions[300] for event in adjusted["events"])


def test_periodicity_retains_unadjusted_repeated_event_intervals():
    positions = np.arange(500, dtype=float)
    values = 2 + 5 * (positions % 10 == 0)
    experiment = SimpleNamespace(id="periodic")
    repository = SimpleNamespace(
        load=lambda _: {"pulse": np.column_stack((positions, values, positions))}
    )
    assert detect_events(positions, values)["events"] == []
    result = periodicity_analysis(
        repository, experiment, ["pulse"], {"min_period": 8, "max_period": 12}
    )
    assert result["metrics"]["pulse"]["median_event_interval"] == 10
    assert len(result["metrics"]["pulse"]["event_intervals"]) > 40


def test_adjacent_opposite_events_and_observation_gaps_stay_separate():
    positions = np.arange(100, dtype=float)
    values = np.zeros(100)
    values[40], values[41] = 10, -8
    events = detect_events(positions, values)["events"]
    assert [(event["x"], event["kind"]) for event in events] == [(40, "spike"), (41, "dip")]
    values[41] = 8
    positions[41:] += 1000
    events = detect_events(positions, values)["events"]
    assert [event["x"] for event in events] == [40, 1041]


def test_positive_lag_means_target_follows_reference():
    positions = np.arange(300, dtype=float)
    generator = np.random.default_rng(29)
    reference = generator.normal(size=300)
    target = np.concatenate([np.zeros(7), reference[:-7]])
    result = lagged_correlation(positions, reference, positions, target, max_lag=15)
    assert result["best_lag"] == pytest.approx(7)
    assert result["best_correlation"] == pytest.approx(1)
    assert lagged_correlation(positions, np.ones(300), positions, np.ones(300))["best_lag"] is None


def test_long_gaps_are_not_interpolated():
    positions = np.array([0, 1, 2, 3, 100, 101, 102, 103])
    sampled = resample(positions, positions * 2, np.array([1, 50, 101]))
    assert sampled[0] == 2
    assert np.isnan(sampled[1])
    assert sampled[2] == 202


def test_uneven_sinusoid_spectrum_and_phase():
    generator = np.random.default_rng(42)
    positions = np.sort(generator.uniform(0, 400, size=650))
    values = 20 + 0.02 * positions + 3 * np.sin(2 * np.pi * positions / 40)
    spectrum = periodic_spectrum(positions, values, min_period=20, max_period=80, frequencies=512)
    assert spectrum["peaks"][0]["period"] == pytest.approx(40, rel=0.01)
    assert spectrum["peaks"][0]["power"] > 0.99
    assert spectrum["peaks"][0]["amplitude"] == pytest.approx(3, rel=0.02)
    shifted = 3 * np.sin(2 * np.pi * (positions - 5) / 40)
    reference = fit_frequency(positions, values, 1 / 40)
    target = fit_frequency(positions, shifted, 1 / 40)
    delay = (reference["phase"] - target["phase"]) * 40 / (2 * np.pi)
    assert delay == pytest.approx(5)


def test_trend_and_short_series_do_not_claim_periodicity():
    positions = np.arange(100, dtype=float)
    assert periodic_spectrum(positions, 4 + 2 * positions)["peaks"] == []
    assert periodic_spectrum(positions[:5], positions[:5])["peaks"] == []
    assert periodic_spectrum(positions, positions, min_period=70)["peaks"] == []


def test_autocorrelation_repeats_at_the_period():
    positions = np.arange(400, dtype=float)
    values = np.sin(2 * np.pi * positions / 40)
    result = autocorrelation(positions, values, detrend=False)
    assert result["correlations"][40] == pytest.approx(1)
    assert result["correlations"][20] == pytest.approx(-1)


def test_multiple_frequencies_and_noise_are_described_without_false_certainty():
    positions = np.arange(1000, dtype=float)
    values = 2 * np.sin(2 * np.pi * positions / 40) + np.sin(2 * np.pi * positions / 100)
    spectrum = periodic_spectrum(positions, values, 20, 200, frequencies=512)
    assert spectrum["peaks"][0]["period"] == pytest.approx(40, rel=0.01)
    assert any(abs(peak["period"] - 100) < 2 for peak in spectrum["peaks"])
    noise = np.random.default_rng(8).normal(size=1000)
    result = periodic_spectrum(positions, noise, 10, 100, frequencies=256)
    assert max(result["powers"]) < 0.1
    assert "not a significance probability" in result["warning"]


def test_windowed_analysis_detects_a_changing_period():
    positions = np.arange(600, dtype=float)
    values = np.sin(2 * np.pi * positions / np.where(positions < 300, 20, 40))
    points = [
        [position, value, position * 2] for position, value in zip(positions, values, strict=True)
    ]
    repository = SimpleNamespace(load=lambda experiment: {"signal": points})
    result = periodicity_analysis(
        repository,
        SimpleNamespace(id="changing"),
        ["signal"],
        {"min_period": 10, "max_period": 80, "windowed": True},
    )
    windows = result["metrics"]["signal"]["windows"]
    assert windows[0]["spectrum"]["peaks"][0]["period"] == pytest.approx(20, rel=0.02)
    assert windows[-1]["spectrum"]["peaks"][0]["period"] == pytest.approx(40, rel=0.02)
