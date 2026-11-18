"""Compare sustained departures from preceding baselines across scalar curves."""

import math

import numpy as np

from expman.analytics import downsample
from expman.timeseries import cadence, prepare_signals, report, resample, rolling_median


def smooth_segments(values, window):
    result = np.full(len(values), np.nan)
    edges = np.diff(np.concatenate(([False], np.isfinite(values), [False])).astype(int))
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1), strict=True):
        result[start:end] = rolling_median(values[start:end], window)
    return result


def pearson(first, second, minimum=8):
    valid = np.isfinite(first) & np.isfinite(second)
    count = int(np.count_nonzero(valid))
    if count < minimum:
        return None, count
    first, second = first[valid], second[valid]
    if np.ptp(first) == 0 or np.ptp(second) == 0:
        return None, count
    first, second = first - first.mean(), second - second.mean()
    denominator = float(np.linalg.norm(first) * np.linalg.norm(second))
    return (
        (float(np.clip(np.dot(first, second) / denominator, -1, 1)), count)
        if denominator > 1e-24
        else (None, count)
    )


def analysis_bounds(positions, options):
    first, last = float(positions[0]), float(positions[-1])
    end = options.get("end") if options.get("end") is not None else last
    start = options.get("start")
    if start is None:
        start = options.get("onset_baseline_end")
    if start is None:
        start = first + (end - first) / 4
    baseline_end = options.get("onset_baseline_end")
    baseline_end = start if baseline_end is None else baseline_end
    baseline_start = options.get("onset_baseline_start")
    if baseline_start is None:
        baseline_start = (
            max(first, baseline_end - (end - start) / 2)
            if options.get("start") is not None
            else first
        )
    if not first <= start < end <= last:
        raise ValueError("The change interval must lie within the reference curve's recorded range")
    if not baseline_start < baseline_end <= start:
        raise ValueError(
            "The baseline must end at or before the change interval and have positive duration"
        )
    return {
        "start": start,
        "end": end,
        "baseline_start": baseline_start,
        "baseline_end": baseline_end,
    }


def baseline_model(positions, values, grid, bounds, window):
    raw = resample(positions, values, grid)
    smoothed = smooth_segments(raw, window)
    baseline_mask = (grid >= bounds["baseline_start"]) & (grid < bounds["baseline_end"])
    recorded_baseline = (positions >= bounds["baseline_start"]) & (
        positions < bounds["baseline_end"]
    )
    recorded_focus = (positions >= bounds["start"]) & (positions <= bounds["end"])
    model = {
        "raw": raw,
        "smooth": smoothed,
        "baseline": np.full(len(grid), np.nan),
        "noise": None,
        "baseline_points": int(np.count_nonzero(recorded_baseline)),
        "focus_points": int(np.count_nonzero(recorded_focus)),
        "cadence": cadence(positions),
        "binary": bool(np.all((values == 0) | (values == 1))),
    }
    baseline_values = raw[baseline_mask]
    valid = np.isfinite(baseline_values)
    if model["baseline_points"] < 8 or np.count_nonzero(valid) < 8:
        return model
    if model["binary"]:
        observations = values[recorded_baseline]
        probability = float((np.sum(observations) + 0.5) / (len(observations) + 1))
        model["baseline"][:] = probability
        model["noise"] = math.sqrt(probability * (1 - probability))
    else:
        centered = (grid - bounds["baseline_end"]) / max(
            bounds["baseline_end"] - bounds["baseline_start"], 1e-12
        )
        design = np.column_stack((np.ones(len(grid)), centered))
        coefficients = np.linalg.lstsq(
            design[baseline_mask][valid], baseline_values[valid], rcond=None
        )[0]
        for _ in range(3):
            residual = baseline_values[valid] - design[baseline_mask][valid] @ coefficients
            center = np.median(residual)
            scale = max(1e-12, 1.4826 * float(np.median(np.abs(residual - center))))
            keep = np.abs(residual - center) <= 4.5 * scale
            if np.all(keep) or np.count_nonzero(keep) < 8:
                break
            coefficients = np.linalg.lstsq(
                design[baseline_mask][valid][keep], baseline_values[valid][keep], rcond=None
            )[0]
        trend = design @ coefficients
        residual = smooth_segments(baseline_values - trend[baseline_mask], window)[valid]
        center = float(np.median(residual))
        model["smooth"] = trend + smooth_segments(raw - trend, window)
        model["baseline"] = trend + center
        model["noise"] = max(
            1e-12,
            1.4826 * float(np.median(np.abs(residual - center))),
            float(np.median(np.abs(baseline_values[valid]))) * 1e-9,
        )
    return model


def sustained_onset(positions, model, grid, bounds, threshold, duration, direction=None):
    result = {
        "onset": None,
        "onset_bracket": None,
        "direction": None,
        "status": "No sustained change",
    }
    if model["noise"] is None:
        return {**result, "status": "Insufficient baseline"}
    focus = (grid >= bounds["start"]) & (grid <= bounds["end"])
    residual = model["smooth"] - model["baseline"]
    valid = focus & np.isfinite(residual)
    if model["focus_points"] < 3 or np.count_nonzero(valid) < 3:
        return {**result, "status": "Insufficient observations"}
    if direction is None:
        deviations = residual[valid]
        direction = 1 if deviations[np.argmax(np.abs(deviations))] >= 0 else -1
    result["direction"] = "rise" if direction > 0 else "fall"
    active = valid & (direction * residual > threshold * model["noise"])
    edges = np.diff(np.concatenate(([False], active, [False])).astype(int))
    resolution = float(grid[1] - grid[0])
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1), strict=True):
        if (end - start) * resolution + 1e-9 < duration:
            continue
        left, right = float(grid[start]), float(min(grid[end - 1], bounds["end"]))
        supporting = positions[(positions >= left) & (positions <= right)]
        if (
            len(supporting) < 3
            or supporting[-1] - supporting[0] + model["cadence"] + 1e-9 < duration
        ):
            continue
        index = int(np.searchsorted(positions, left))
        upper = min(index, len(positions) - 1)
        after_gap = start > 0 and not np.isfinite(model["smooth"][start - 1])
        lower = upper if positions[upper] == left and not after_gap else max(0, upper - 1)
        return {
            **result,
            "onset": left,
            "onset_bracket": [float(positions[lower]), float(positions[upper])],
            "status": "Active at interval start"
            if left < bounds["start"] + resolution
            else "After recording gap"
            if after_gap
            else "Detected",
        }
    return result


def curve_payload(positions, model, grid, onset, limit):
    indices = downsample(grid, limit, np.nan_to_num(model["smooth"]))
    if onset is not None:
        indices = np.unique(np.append(indices, np.searchsorted(grid, onset)))
    finite = np.isfinite(model["smooth"])
    segments = np.cumsum(np.concatenate(([True], np.diff(finite.astype(int)) != 0)))

    def values(array):
        return [float(item) if np.isfinite(item) else None for item in array[indices]]

    return {
        "x": grid[indices].tolist(),
        "y": values(model["smooth"]),
        "raw": values(model["raw"]),
        "baseline": values(model["baseline"]),
        "segments": np.where(finite[indices], segments[indices], -1).tolist(),
        "source_points": len(positions),
        "cadence": model["cadence"],
    }


def sustained_change_analysis(repository, experiment, tags, options, progress=None):
    reference = options.get("reference")
    if not reference:
        raise ValueError("Choose a reference curve for sustained-change analysis")
    signals, missing = prepare_signals(
        repository, experiment, tags, {**options, "start": None, "end": None}, progress
    )
    if reference not in signals:
        raise ValueError("The reference must match the included curves and have observations")
    ref_x, ref_y = signals[reference]
    bounds = analysis_bounds(ref_x, options)
    cadences = [value for x, _ in signals.values() if (value := cadence(x)) > 0]
    resolution = max(
        cadence(ref_x),
        float(np.median(cadences)) if cadences else 0,
        (bounds["end"] - bounds["baseline_start"]) / 4095,
    )
    if resolution <= 0:
        raise ValueError("The reference needs distinct observation times")
    count = min(4096, int(round((bounds["end"] - bounds["baseline_start"]) / resolution)) + 1)
    grid = bounds["baseline_start"] + np.arange(count) * resolution
    grid = grid[grid <= bounds["end"] + resolution * 1e-9]
    focus = (grid >= bounds["start"]) & (grid <= bounds["end"] + resolution * 1e-9)
    if len(grid) < 16 or np.count_nonzero(focus) < 8:
        raise ValueError(
            "The change interval needs at least eight observations at the shared cadence"
        )
    window = min(501, max(1, int(round(options.get("onset_smoothing", 50) / resolution))))
    window += window % 2 == 0
    threshold, duration = options.get("onset_threshold", 5), options.get("onset_duration", 50)
    report(progress, 7, "Fitting reference baseline", reference)
    ref_model = baseline_model(ref_x, ref_y, grid, bounds, window)
    if ref_model["noise"] is None:
        raise ValueError("The reference baseline needs at least eight recorded observations")
    if ref_model["focus_points"] < 8:
        raise ValueError("The reference change interval needs at least eight recorded observations")
    ref_onset = sustained_onset(ref_x, ref_model, grid, bounds, threshold, duration)
    ref_direction = 1 if ref_onset["direction"] != "fall" else -1
    limit = max(8, min(1000, 500_000 // max(1, len(signals))))
    curves = {reference: curve_payload(ref_x, ref_model, grid, ref_onset["onset"], limit)}
    rows = []
    minimum = max(8, int(np.count_nonzero(focus)) // 4)
    for index, (tag, (positions, values)) in enumerate(signals.items()):
        report(progress, 8 + 90 * index / max(1, len(signals)), "Comparing sustained changes", tag)
        if tag == reference:
            continue
        model = baseline_model(positions, values, grid, bounds, window)
        first, second = ref_model["smooth"][focus], model["smooth"][focus]
        coefficient, overlap = pearson(first, second, minimum)
        change_coefficient, change_overlap = pearson(np.diff(first), np.diff(second), minimum)
        if model["focus_points"] < 8:
            coefficient = change_coefficient = None
        direction = ref_direction * (1 if coefficient is None or coefficient >= 0 else -1)
        onset = sustained_onset(positions, model, grid, bounds, threshold, duration, direction)
        if coefficient is None and onset["status"] == "No sustained change":
            onset["status"] = (
                "Insufficient overlap" if overlap < minimum else "Constant in change interval"
            )
        related = (
            coefficient is not None
            and change_coefficient is not None
            and abs(coefficient) >= options.get("onset_min_correlation", 0.7)
            and abs(change_coefficient) >= options.get("onset_min_change_correlation", 0.15)
        )
        rows.append(
            {
                "tag": tag,
                "correlation": coefficient,
                "change_correlation": change_coefficient,
                "overlap_points": overlap,
                "change_points": change_overlap,
                "related": related,
                "delay": onset["onset"] - ref_onset["onset"]
                if onset["onset"] is not None and ref_onset["onset"] is not None
                else None,
                **onset,
                **{
                    key: model[key]
                    for key in ("baseline_points", "focus_points", "cadence", "binary", "noise")
                },
            }
        )
        curves[tag] = curve_payload(positions, model, grid, onset["onset"], limit)
    rows.sort(
        key=lambda row: (
            -abs(row["correlation"]) if row["correlation"] is not None else math.inf,
            row["tag"],
        )
    )
    return {
        "experiment_id": experiment.id,
        "kind": "onsets",
        "reference": reference,
        "settings": options,
        "reference_result": {
            **ref_onset,
            "cadence": ref_model["cadence"],
            "noise": ref_model["noise"],
            "baseline_points": ref_model["baseline_points"],
        },
        "rows": rows,
        "curves": curves,
        "missing_metrics": missing,
        "analysis": {
            **bounds,
            "resolution": resolution,
            "grid_points": len(grid),
            "smoothing_points": window,
            "smoothing_span": window * resolution,
            "sustain_span": duration,
            "threshold": threshold,
            "related_curves": sum(row["related"] for row in rows),
        },
        "note": "Onsets are retrospective sustained departures from a preceding baseline. "
        "Negative delay means target onset precedes reference onset. Correlations describe "
        "association, not causation; recording cadence and smoothing limit timing precision.",
    }
