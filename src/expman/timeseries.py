"""Retrospective event timing and periodicity analysis on recorded observations."""

import math
import re
from fnmatch import translate

import numpy as np

from expman.analytics import downsample, series


def report(progress, percent, stage, metric=None):
    if progress:
        progress(percent, stage, metric)


def select_tags(available, tags=None, include=None, exclude=None):
    inclusions = [re.compile(translate(pattern)) for pattern in include or ["*"]]
    exclusions = [re.compile(translate(pattern)) for pattern in exclude or []]
    return [
        tag
        for tag in dict.fromkeys(available if tags is None else tags)
        if any(pattern.match(tag) for pattern in inclusions)
        and not any(pattern.match(tag) for pattern in exclusions)
    ]


def correlation_grid(first, second, shifts, minimum):
    valid_first, valid_second = np.isfinite(first), np.isfinite(second)
    first = np.where(
        valid_first,
        first - np.nansum(np.where(valid_first, first, 0)) / max(np.count_nonzero(valid_first), 1),
        0,
    )
    second = np.where(
        valid_second,
        second
        - np.nansum(np.where(valid_second, second, 0)) / max(np.count_nonzero(valid_second), 1),
        0,
    )
    mask_first, mask_second = valid_first.astype(float), valid_second.astype(float)
    indices = np.asarray(shifts) + len(first) - 1

    def cross(target, reference):
        return np.correlate(target, reference, mode="full")[indices]

    counts = np.rint(cross(mask_second, mask_first)).astype(int)
    divisor = np.maximum(counts, 1)
    sum_first, sum_second = cross(mask_second, first), cross(second, mask_first)
    variance_first = np.maximum(cross(mask_second, first * first) - sum_first**2 / divisor, 0)
    variance_second = np.maximum(cross(second * second, mask_first) - sum_second**2 / divisor, 0)
    denominator = np.sqrt(variance_first * variance_second)
    covariance = cross(second, first) - sum_first * sum_second / divisor
    valid = (counts >= minimum) & (denominator > 1e-24)
    coefficients = np.clip(
        np.divide(covariance, denominator, where=valid, out=np.zeros_like(covariance)), -1, 1
    )
    return [
        float(value) if keep else None for value, keep in zip(coefficients, valid, strict=True)
    ], counts.tolist()


def rolling_median(values, window):
    window = min(window, len(values) if len(values) % 2 else len(values) - 1)
    left, right = (window - 1) // 2, window // 2
    windows = np.lib.stride_tricks.sliding_window_view(values, window)
    result = np.empty(len(values))
    block_size = max(1, 1_000_000 // window)
    for start in range(0, len(windows), block_size):
        medians = np.median(windows[start : start + block_size], axis=1)
        result[start + left : start + left + len(medians)] = medians
    for index in [*range(left), *range(len(values) - right, len(values))]:
        result[index] = np.median(
            values[max(0, index - left) : min(len(values), index + right + 1)]
        )
    return result


def cadence(positions):
    differences = np.diff(positions)
    return float(np.median(differences[differences > 0])) if np.any(differences > 0) else 0.0


def rolling_mad(values, window, centers):
    window = min(window, len(values) if len(values) % 2 else len(values) - 1)
    left, right = (window - 1) // 2, window // 2
    windows = np.lib.stride_tricks.sliding_window_view(values, window)
    result = np.empty(len(values))
    block_size = max(1, 1_000_000 // window)
    for start in range(0, len(windows), block_size):
        block = windows[start : start + block_size]
        result[start + left : start + left + len(block)] = np.median(
            np.abs(block - centers[start + left : start + left + len(block), None]), axis=1
        )
    for index in [*range(left), *range(len(values) - right, len(values))]:
        context = values[max(0, index - left) : min(len(values), index + right + 1)]
        result[index] = np.median(np.abs(context - centers[index]))
    return result


def binary_context(values, window):
    indices = np.arange(len(values))
    left = np.maximum(indices - (window - 1) // 2, 0)
    right = np.minimum(indices + window // 2 + 1, len(values))
    counts = right - left - 1
    cumulative = np.concatenate(([0.0], np.cumsum(values)))
    ones = cumulative[right] - cumulative[left] - values
    return (ones + 0.5) / (counts + 1), counts


def cycle_neighbors(
    positions, values, targets, period, segments, context=8, measure_variation=True
):
    target_segments = segments[np.searchsorted(positions, targets)]
    samples = []
    for offset in [*range(-context, 0), *range(1, context + 1)]:
        desired = targets + offset * period
        right = np.clip(np.searchsorted(positions, desired), 1, len(positions) - 1)
        left = right - 1
        width = positions[right] - positions[left]
        fraction = (desired - positions[left]) / width
        sampled = values[left] + fraction * (values[right] - values[left])
        exact = desired == positions[right]
        valid = (desired >= positions[0]) & (desired <= positions[-1])
        valid &= segments[right] == target_segments
        valid &= exact | (segments[left] == target_segments)
        samples.append(np.where(valid, sampled, np.nan))
    samples = np.asarray(samples)
    counts = np.count_nonzero(np.isfinite(samples), axis=0)
    samples[0, counts == 0] = 0
    center = np.nanmedian(samples, axis=0)
    if not measure_variation:
        return center, None, counts
    mad = 1.4826 * np.nanmedian(np.abs(samples - center), axis=0)
    ordered = np.sort(samples, axis=0)
    columns = np.arange(len(targets))

    def quantile(fraction):
        locations = (np.maximum(counts, 1) - 1) * fraction
        low, high = np.floor(locations).astype(int), np.ceil(locations).astype(int)
        return ordered[low, columns] + (locations - low) * (
            ordered[high, columns] - ordered[low, columns]
        )

    lower, upper = quantile(0.1), quantile(0.9)
    return center, np.maximum(mad, (upper - lower) / 2.5631), counts


def repeating_cycle(positions, residual, values, binary):
    interval = cadence(positions)
    if len(positions) < 60 or not interval:
        return None
    segments = np.concatenate(([0], np.cumsum(np.diff(positions) > interval * 1.5)))
    boundaries = np.concatenate(([0], np.flatnonzero(np.diff(segments)) + 1, [len(positions)]))
    segment = int(np.argmax(np.diff(boundaries)))
    start, end = boundaries[segment : segment + 2]
    start = max(start, end - 16384)
    times, segment_residual = positions[start:end], residual[start:end]
    if len(times) < 60 or np.mean(np.abs(np.diff(times) - interval) <= interval * 0.05) < 0.98:
        return None
    lower, upper = np.quantile(segment_residual, [0.01, 0.99])
    clipped = np.clip(segment_residual, lower, upper)
    clipped -= clipped.mean()
    if np.sum(clipped**2) <= 1e-24:
        return None
    size = 1 << (2 * len(clipped) - 1).bit_length()
    transformed = np.fft.rfft(clipped, n=size)
    covariance = np.fft.irfft(transformed * transformed.conj(), n=size)
    lags = np.arange(1, min(len(clipped) // 6, 2048) + 2)
    cumulative = np.concatenate(([0], np.cumsum(clipped**2)))
    norms = np.sqrt(cumulative[-lags - 1] * (cumulative[-1] - cumulative[lags]))
    correlations = np.divide(covariance[lags], norms, out=np.zeros(len(lags)), where=norms > 0)
    peaks = (
        np.flatnonzero(
            (correlations[1:-1] >= 0.55)
            & (correlations[1:-1] > correlations[:-2])
            & (correlations[1:-1] >= correlations[2:])
        )
        + 1
    )
    indices = np.unique(np.linspace(0, len(positions) - 1, min(len(positions), 4096)).astype(int))
    models = []
    for candidate in peaks[:5]:
        lag = int(lags[candidate])
        period = lag * interval
        trend_window = min(2 * lag, 500)
        candidate_residual = residual if binary else values - rolling_median(values, trend_window)
        lower, upper = np.quantile(candidate_residual[start:end], [0.01, 0.99])
        local, _, _ = cycle_neighbors(
            positions,
            candidate_residual,
            positions[indices],
            interval,
            segments,
            measure_variation=False,
        )
        expected, _, counts = cycle_neighbors(
            positions,
            candidate_residual,
            positions[indices],
            period,
            segments,
            measure_variation=False,
        )
        valid = counts >= 5
        if np.mean(valid) < 0.8:
            continue
        observed = np.clip(candidate_residual[indices][valid], lower, upper)
        predicted = np.clip(expected[valid], lower, upper)
        variance = float(np.mean((observed - np.median(observed)) ** 2))
        error = float(np.mean((observed - predicted) ** 2))
        local_error = float(np.mean((observed - np.clip(local[valid], lower, upper)) ** 2))
        improvement = 1 - error / variance if variance else 0
        local_improvement = 1 - error / local_error if local_error else 0
        if improvement >= 0.5 and local_improvement >= 0.25:
            models.append(
                {
                    "period": period,
                    "lag": lag,
                    "interval": interval,
                    "segments": segments,
                    "correlation": float(correlations[candidate]),
                    "improvement": improvement,
                    "local_improvement": local_improvement,
                    "trend_window": None if binary else trend_window,
                    "cycles": float((times[-1] - times[0] + interval) / period),
                }
            )
    best = max((model["improvement"] * model["correlation"] for model in models), default=0)
    return next(
        (model for model in models if model["improvement"] * model["correlation"] >= best * 0.95),
        None,
    )


def periodic_baseline(positions, values, baseline, scale, binary, binary_window):
    residual = values - baseline
    model = repeating_cycle(positions, residual, values, binary)
    if model is None:
        return None
    expected, variation, counts = baseline.copy(), scale.copy(), np.zeros(len(values), dtype=int)
    if binary:
        grid = np.rint((positions - positions[0]) / model["interval"])
        if (
            np.max(np.abs(positions - positions[0] - grid * model["interval"]))
            > model["interval"] * 0.2
        ):
            return None
        groups = model["segments"] * model["lag"] + grid.astype(np.int64) % model["lag"]
        order = np.argsort(groups, kind="stable")
        boundaries = np.flatnonzero(np.diff(groups[order])) + 1
        for indices in np.split(order, boundaries):
            probability, context_counts = binary_context(values[indices], binary_window)
            valid = context_counts >= 5
            expected[indices[valid]] = probability[valid]
            counts[indices] = context_counts
        variation = np.sqrt(expected * (1 - expected))
        noise_floor = None
    else:
        trend = rolling_median(values, model["trend_window"])
        residual = values - trend
        for start in range(0, len(values), 4096):
            stop = start + 4096
            center, spread, context_counts = cycle_neighbors(
                positions,
                residual,
                positions[start:stop],
                model["period"],
                model["segments"],
            )
            counts[start:stop] = context_counts
            valid = context_counts >= 5
            expected[start:stop] = np.where(valid, trend[start:stop] + center, expected[start:stop])
            variation[start:stop] = np.where(valid, spread, variation[start:stop])
        adjusted = values - expected
        noise_floor = max(
            1e-12,
            float(np.median(np.abs(values))) * 1e-9,
            1.4826 * float(np.median(np.abs(adjusted - np.median(adjusted)))),
        )
        variation = np.maximum(variation, noise_floor)
    valid = counts >= 5
    return (
        expected,
        variation,
        noise_floor,
        valid,
        {key: value for key, value in model.items() if key not in {"segments", "interval", "lag"}}
        | {
            "adjusted_points": int(np.count_nonzero(valid)),
            "source_points": len(values),
            "context_cycles": 8 if not binary else None,
            "context_observations": {"min": int(counts[valid].min()), "max": int(counts.max())},
        },
        counts,
    )


def boundary_variation(positions, values, window):
    effective = min(window, len(values) if len(values) % 2 else len(values) - 1)
    left, right = (effective - 1) // 2, effective // 2
    targets = np.unique(
        np.concatenate((np.arange(left), np.arange(len(values) - right, len(values))))
    )
    result = np.zeros(len(values))
    if not len(targets):
        return result
    segments = np.concatenate(([0], np.cumsum(np.diff(positions) > cadence(positions) * 10)))
    offsets = np.array([*range(-8, 0), *range(1, 9)])
    neighbors = targets[None, :] + offsets[:, None]
    valid = (neighbors >= 0) & (neighbors < len(values))
    clipped = np.clip(neighbors, 0, len(values) - 1)
    valid &= segments[clipped] == segments[targets]
    samples = np.where(valid, values[clipped], np.nan)
    samples[0, ~np.any(valid, axis=0)] = 0
    center = np.nanmedian(samples, axis=0)
    result[targets] = 1.4826 * np.nanmedian(np.abs(samples - center), axis=0)
    return result


def detect_events(
    positions,
    values,
    window=31,
    threshold=5.0,
    detector="spike",
    polarity="both",
    separation=2,
    max_events=200,
    binary_window=1001,
    period_aware=True,
):
    raw_values = np.asarray(values, dtype=float)
    binary = bool(len(raw_values) and np.all((raw_values == 0) | (raw_values == 1)))
    metadata = {
        "data_type": "binary" if binary else "continuous",
        "score_type": "bernoulli" if binary else "mad",
        "context_window": binary_window if binary else window,
        "period_aware": period_aware,
        "periodic": None,
    }
    if len(values) < 5:
        return {
            **metadata,
            "events": [],
            "total": 0,
            "warning": "At least five observations are required",
        }
    offset = 1 if detector == "change" else 0
    if binary:
        probabilities, counts = binary_context(raw_values, binary_window)
        baseline = probabilities[offset:]
        residual = raw_values[offset:] - baseline
        scale = np.sqrt(baseline * (1 - baseline))
        noise_floor = None
        metadata["context_observations"] = {"min": int(counts.min()), "max": int(counts.max())}
    else:
        signal = np.diff(raw_values) if detector == "change" else raw_values.copy()
        baseline = rolling_median(signal, window)
        residual = signal - baseline
        global_noise = 1.4826 * float(np.median(np.abs(residual - np.median(residual))))
        floor = max(1e-12, float(np.median(np.abs(signal))) * 1e-9)
        noise_floor = max(global_noise, floor)
        scale = np.maximum(1.4826 * rolling_mad(signal, window, baseline), noise_floor)
    periodic_points = np.zeros(len(residual), dtype=bool)
    if period_aware:
        modeled = periodic_baseline(
            np.asarray(positions)[offset:],
            raw_values[offset:] if binary else signal,
            baseline,
            scale,
            binary,
            binary_window,
        )
        if modeled is not None:
            baseline, scale, noise_floor, periodic_points, metadata["periodic"], phase_counts = (
                modeled
            )
            if binary:
                context_counts = counts[offset:].copy()
                context_counts[periodic_points] = phase_counts[periodic_points]
                metadata["context_observations"] = {
                    "min": int(context_counts.min()),
                    "max": int(context_counts.max()),
                }
            residual = (raw_values[offset:] if binary else signal) - baseline
    boundary_points = np.zeros(len(residual), dtype=bool)
    if not binary:
        uncertainty = boundary_variation(np.asarray(positions)[offset:], signal, window)
        boundary_points = uncertainty > scale
        scale = np.maximum(scale, uncertainty)
    metadata["boundary_adjusted_points"] = int(np.count_nonzero(boundary_points))
    scores = residual / scale
    active = np.abs(scores) >= threshold
    if polarity == "up":
        active &= scores > 0
    elif polarity == "down":
        active &= scores < 0
    if detector == "change":
        if binary:
            active &= np.diff(raw_values) != 0
        interval = cadence(positions)
        if interval:
            active &= np.diff(positions) <= interval * 10
    indices = np.flatnonzero(active)
    breaks = np.diff(indices) > max(1, separation)
    if len(indices) > 1:
        breaks |= np.sign(scores[indices[:-1]]) != np.sign(scores[indices[1:]])
        interval = cadence(positions)
        if interval:
            breaks |= np.diff(np.asarray(positions)[indices + offset]) > interval * 10
    clusters = np.split(indices, np.flatnonzero(breaks) + 1)
    events = []
    for cluster in clusters:
        if not len(cluster):
            continue
        peak = int(cluster[np.argmax(np.abs(scores[cluster]))])
        direction = "up" if scores[peak] > 0 else "down"
        events.append(
            {
                "x": float(positions[peak + offset]),
                "start": float(positions[int(cluster[0]) + offset]),
                "end": float(positions[int(cluster[-1]) + offset]),
                "value": float(raw_values[peak + offset]),
                "baseline": float(baseline[peak]),
                "deviation": float(residual[peak]),
                "score": float(scores[peak]),
                "score_type": metadata["score_type"],
                "context_window": metadata["context_window"],
                "scale": float(scale[peak]),
                "period": metadata["periodic"]["period"] if periodic_points[peak] else None,
                "baseline_type": "periodic_phase" if periodic_points[peak] else "local",
                "boundary_context": bool(boundary_points[peak]),
                "direction": direction,
                "kind": ("rise" if direction == "up" else "fall")
                if detector == "change"
                else ("spike" if direction == "up" else "dip"),
            }
        )
    total = len(events)
    events = sorted(
        sorted(events, key=lambda item: -abs(item["score"]))[:max_events],
        key=lambda item: item["x"],
    )
    return {
        **metadata,
        "events": events,
        "total": total,
        "truncated": total > max_events,
        "noise_floor": noise_floor,
        "warning": "Baseline uses available neighboring observations without boundary padding; "
        "nearby variation limits confidence at boundaries; detection is retrospective",
    }


def match_events(reference, target, tolerance):
    candidates = sorted(
        (abs(second["x"] - first["x"]), first_index, second_index)
        for first_index, first in enumerate(reference)
        for second_index, second in enumerate(target)
        if abs(second["x"] - first["x"]) <= tolerance
    )
    used_reference, used_target, matches = set(), set(), []
    for _, first_index, second_index in candidates:
        if first_index in used_reference or second_index in used_target:
            continue
        used_reference.add(first_index)
        used_target.add(second_index)
        first, second = reference[first_index], target[second_index]
        matches.append(
            {
                "reference": first["x"],
                "target": second["x"],
                "delay": second["x"] - first["x"],
                "reference_kind": first["kind"],
                "target_kind": second["kind"],
            }
        )
    delays = [item["delay"] for item in matches]
    return {
        "matches": sorted(matches, key=lambda item: item["reference"]),
        "matched": len(matches),
        "unmatched_reference": len(reference) - len(matches),
        "unmatched_target": len(target) - len(matches),
        "median_delay": float(np.median(delays)) if delays else None,
        "mean_delay": float(np.mean(delays)) if delays else None,
    }


def resample(positions, values, grid):
    if not len(positions):
        return np.full(len(grid), np.nan)
    sampled = np.interp(grid, positions, values, left=np.nan, right=np.nan)
    interval = cadence(positions)
    if interval:
        for index in np.flatnonzero(np.diff(positions) > 10 * interval):
            sampled[(grid > positions[index]) & (grid < positions[index + 1])] = np.nan
    return sampled


def lagged_correlation(
    first_x, first_y, second_x, second_y, max_lag=100, grid_size=512, differences=True
):
    empty = {
        "lags": [],
        "correlations": [],
        "counts": [],
        "best_lag": None,
        "best_correlation": None,
        "zero_lag": None,
        "resolution": None,
    }
    if min(len(first_x), len(second_x)) < 8:
        return {**empty, "warning": "At least eight observations per curve are required"}
    start, end = max(first_x[0], second_x[0]), min(first_x[-1], second_x[-1])
    if end <= start:
        return {**empty, "warning": "No overlapping time range"}
    interval = max(cadence(first_x), cadence(second_x))
    count = min(grid_size, int((end - start) / interval) + 1) if interval else 0
    if count < 8:
        return {**empty, "warning": "Overlapping range is too short at the observed cadence"}
    grid = np.linspace(start, end, count)
    first = resample(first_x, first_y, grid)
    second = resample(second_x, second_y, grid)
    resolution = float(grid[1] - grid[0])
    if differences:
        first, second = np.diff(first), np.diff(second)
    if len(first) < 8:
        return {**empty, "warning": "Too few observations remain after differencing"}
    lag_steps = min(int(max_lag / resolution), len(first) - 8)
    minimum = max(8, len(first) // 4)
    shifts = np.arange(-lag_steps, lag_steps + 1)
    correlations, counts = correlation_grid(first, second, shifts, minimum)
    lags = (shifts * resolution).tolist()
    valid_indices = [
        index for index, coefficient in enumerate(correlations) if coefficient is not None
    ]
    best = (
        min(valid_indices, key=lambda index: (-abs(correlations[index]), abs(lags[index])))
        if valid_indices
        else None
    )
    return {
        "lags": lags,
        "correlations": correlations,
        "counts": counts,
        "best_lag": lags[best] if best is not None else None,
        "best_correlation": correlations[best] if best is not None else None,
        "zero_lag": correlations[lag_steps],
        "resolution": resolution,
        "minimum_overlap": minimum,
        "differences": differences,
        "warning": "Positive lag means target follows reference. Large gaps are masked. "
        "Grid spacing is not measured timing precision; "
        "shared trends and lag searches can mislead.",
    }


def prepare_signals(repository, experiment, tags, options, progress=None):
    report(progress, 1, "Loading scalar events")
    data = repository.load(experiment)
    tags = select_tags(data, tags, options.get("include"), options.get("exclude"))
    if not tags:
        raise ValueError("No scalar metrics match the inclusion and exclusion patterns")
    report(progress, 5, f"Preparing {len(tags)} curves")
    origin = min((points[0][2] for points in data.values() if len(points)), default=0)
    signals, missing = {}, []
    for tag in dict.fromkeys(tags):
        positions, values = series(data.get(tag, []), options.get("x_axis", "step"), origin=origin)
        mask = np.ones(len(positions), dtype=bool)
        if options.get("start") is not None:
            mask &= positions >= options["start"]
        if options.get("end") is not None:
            mask &= positions <= options["end"]
        positions, values = positions[mask], values[mask]
        if len(positions):
            signals[tag] = (positions, values)
        else:
            missing.append(tag)
    return signals, missing


def event_analysis(repository, experiment, tags, options, progress=None):
    signals, missing = prepare_signals(repository, experiment, tags, options, progress)
    detections, curves, timeline = {}, {}, []
    for tag, (positions, values) in signals.items():
        detected = detect_events(
            positions,
            values,
            options.get("window", 31),
            options.get("threshold", 5),
            options.get("detector", "spike"),
            options.get("polarity", "both"),
            options.get("separation", 2),
            binary_window=options.get("binary_window", 1001),
            period_aware=options.get("period_aware", True),
        )
        detections[tag] = detected
        timeline.extend({"tag": tag, **event} for event in detected["events"])
        indices = downsample(positions, 2000, values)
        curves[tag] = {
            "x": positions[indices].tolist(),
            "y": values[indices].tolist(),
            "source_points": len(positions),
            "cadence": cadence(positions),
        }
        report(progress, 5 + 45 * len(curves) / max(len(signals), 1), "Detecting events", tag)
    reference = options.get("reference") or max(
        signals, key=lambda tag: detections[tag]["total"], default=None
    )
    if reference and reference not in signals:
        raise ValueError("Reference metric has no observations in this window")
    pairs = []
    for tag in signals:
        if tag == reference:
            continue
        pairs.append(
            {
                "reference": reference,
                "target": tag,
                "events": match_events(
                    detections[reference]["events"],
                    detections[tag]["events"],
                    options.get("tolerance", 10),
                ),
                "correlation": lagged_correlation(
                    *signals[reference],
                    *signals[tag],
                    options.get("max_lag", 100),
                    differences=options.get("differences", True),
                ),
            }
        )
        report(
            progress, 50 + 49 * len(pairs) / max(len(signals) - 1, 1), "Comparing event timing", tag
        )
    return {
        "experiment_id": experiment.id,
        "settings": options,
        "reference": reference,
        "curves": curves,
        "detections": detections,
        "timeline": sorted(timeline, key=lambda item: (item["x"], item["tag"])),
        "pairs": pairs,
        "missing_metrics": missing,
        "note": "Temporal association is not causation. Positive delay means the target follows "
        "the reference. Event matching is nearest-first, one-to-one within tolerance.",
    }


def fit_frequency(positions, values, frequency, detrend=True):
    times = np.asarray(positions, dtype=float)
    values = np.asarray(values, dtype=float)
    baseline = np.column_stack(
        [np.ones(len(times)), (times - times.mean()) / max(float(np.ptp(times)), 1)]
    )
    if not detrend:
        baseline = baseline[:, :1]
    residual = values - baseline @ np.linalg.lstsq(baseline, values, rcond=None)[0]
    total = float(residual @ residual)
    if total <= max(1e-24, float(values @ values) * 1e-20):
        return {"power": 0.0, "amplitude": 0.0, "phase": 0.0}
    angular = 2 * np.pi * frequency * times
    basis = np.column_stack([np.sin(angular), np.cos(angular)])
    projected = basis - baseline @ np.linalg.lstsq(baseline, basis, rcond=None)[0]
    coefficients = np.linalg.lstsq(projected, residual, rcond=None)[0]
    error = residual - projected @ coefficients
    return {
        "power": float(np.clip(1 - (error @ error) / total, 0, 1)),
        "amplitude": float(np.hypot(*coefficients)),
        "phase": float(np.arctan2(coefficients[1], coefficients[0])),
    }


def fit_frequencies(positions, values, frequencies, detrend=True):
    times, values = np.asarray(positions, dtype=float), np.asarray(values, dtype=float)
    trend = (times - times.mean()) / max(float(np.ptp(times)), 1)
    trend_norm = float(trend @ trend)
    residual = values - values.mean()
    if detrend and trend_norm:
        residual = residual - trend * float(trend @ residual) / trend_norm
    total = float(residual @ residual)
    fits = []
    if total <= max(1e-24, float(values @ values) * 1e-20):
        return [{"power": 0.0, "amplitude": 0.0, "phase": 0.0} for _ in frequencies]
    for start in range(0, len(frequencies), 32):
        angular = 2 * np.pi * np.outer(times, frequencies[start : start + 32])
        sine, cosine = np.sin(angular), np.cos(angular)
        sine -= sine.mean(axis=0)
        cosine -= cosine.mean(axis=0)
        if detrend and trend_norm:
            sine -= np.outer(trend, np.einsum("i,ij->j", trend, sine) / trend_norm)
            cosine -= np.outer(trend, np.einsum("i,ij->j", trend, cosine) / trend_norm)
        ss = np.einsum("ij,ij->j", sine, sine)
        cc = np.einsum("ij,ij->j", cosine, cosine)
        sc = np.einsum("ij,ij->j", sine, cosine)
        ys, yc = np.einsum("i,ij->j", residual, sine), np.einsum("i,ij->j", residual, cosine)
        determinant = ss * cc - sc**2
        valid = determinant > np.maximum(ss * cc * 1e-12, 1e-24)
        first = np.divide(ys * cc - yc * sc, determinant, out=np.zeros_like(ss), where=valid)
        second = np.divide(yc * ss - ys * sc, determinant, out=np.zeros_like(ss), where=valid)
        powers = np.clip((first * ys + second * yc) / total, 0, 1)
        fits.extend(
            {
                "power": float(power),
                "amplitude": float(np.hypot(a, b)),
                "phase": float(np.arctan2(b, a)),
            }
            for power, a, b in zip(powers, first, second, strict=True)
        )
    return fits


def periodic_spectrum(
    positions, values, min_period=None, max_period=None, frequencies=384, detrend=True
):
    if len(positions) < 16 or np.ptp(positions) <= 0:
        return {
            "periods": [],
            "powers": [],
            "peaks": [],
            "warning": "At least 16 observations are required",
        }
    original_count = len(positions)
    indices = np.unique(np.linspace(0, len(positions) - 1, min(len(positions), 4096)).astype(int))
    positions, values = np.asarray(positions)[indices], np.asarray(values)[indices]
    duration, interval = float(np.ptp(positions)), cadence(positions)
    lower = min_period if min_period is not None else interval * 2.5
    upper = min(max_period if max_period is not None else duration / 2, duration / 2)
    if lower <= 0 or upper <= lower:
        return {
            "periods": [],
            "powers": [],
            "peaks": [],
            "warning": "Search requires at least two observable cycles and a valid period range",
        }
    frequency_grid = np.linspace(1 / upper, 1 / lower, frequencies)
    fits = fit_frequencies(positions, values, frequency_grid, detrend)
    powers = np.array([fit["power"] for fit in fits])
    candidates = [
        index
        for index in range(len(powers))
        if powers[index] > 0
        and (index == 0 or powers[index] >= powers[index - 1])
        and (index == len(powers) - 1 or powers[index] >= powers[index + 1])
    ]
    peaks = []
    for index in sorted(candidates, key=lambda item: -powers[item]):
        frequency = float(frequency_grid[index])
        if any(abs(frequency - peak["frequency"]) < 1 / duration for peak in peaks):
            continue
        period = 1 / frequency
        peaks.append(
            {
                "period": period,
                "frequency": frequency,
                **fits[index],
                "cycles": duration / period,
                "period_resolution": period**2 / duration,
            }
        )
        if len(peaks) == 5:
            break
    return {
        "periods": (1 / frequency_grid).tolist(),
        "powers": powers.tolist(),
        "peaks": peaks,
        "duration": duration,
        "cadence": interval,
        "source_points": original_count,
        "analyzed_points": len(positions),
        "sampled": original_count > len(positions),
        "min_period": lower,
        "max_period": upper,
        "frequency_resolution": 1 / duration,
        "warning": "Explained variation is not a significance probability. Cadence-based search "
        "bounds are a heuristic for uneven timestamps, not a universal Nyquist limit. "
        "Check harmonics, aliasing, trends, and the number of observed cycles.",
    }


def autocorrelation(positions, values, detrend=True):
    if len(positions) < 16:
        return {"lags": [], "correlations": [], "counts": []}
    count = min(512, len(positions))
    grid = np.linspace(positions[0], positions[-1], count)
    baseline = np.column_stack(
        [np.ones(len(positions)), np.asarray(positions) - np.mean(positions)]
    )
    if not detrend:
        baseline = baseline[:, :1]
    residual = values - baseline @ np.linalg.lstsq(baseline, values, rcond=None)[0]
    sampled = resample(positions, residual, grid)
    correlations, counts = correlation_grid(sampled, sampled, np.arange(count // 2), 8)
    return {
        "lags": (np.arange(len(correlations)) * (grid[1] - grid[0])).tolist(),
        "correlations": correlations,
        "counts": counts,
        "resolution": float(grid[1] - grid[0]),
    }


def periodicity_analysis(repository, experiment, tags, options, progress=None):
    signals, missing = prepare_signals(repository, experiment, tags, options, progress)
    result, warnings = {}, []
    minimum, maximum = options.get("min_period"), options.get("max_period")
    for tag, (positions, values) in signals.items():
        report(progress, 5 + 85 * len(result) / max(len(signals), 1), "Searching for cycles", tag)
        spectrum = periodic_spectrum(
            positions,
            values,
            minimum,
            maximum,
            options.get("frequencies", 384),
            options.get("detrend", True),
        )
        detected = detect_events(
            positions, values, binary_window=options.get("binary_window", 1001), period_aware=False
        )
        intervals = np.diff([event["x"] for event in detected["events"]])
        windowed = []
        if options.get("windowed") and len(positions) >= 64:
            width = float(np.ptp(positions)) / 3
            for start in np.linspace(positions[0], positions[-1] - width, 5):
                report(
                    progress,
                    5 + 85 * (len(result) + len(windowed) / 6) / max(len(signals), 1),
                    "Analyzing moving windows",
                    tag,
                )
                mask = (positions >= start) & (positions <= start + width)
                windowed.append(
                    {
                        "start": float(start),
                        "end": float(start + width),
                        "spectrum": periodic_spectrum(
                            positions[mask],
                            values[mask],
                            minimum,
                            maximum,
                            128,
                            options.get("detrend", True),
                        ),
                    }
                )
        result[tag] = {
            "spectrum": spectrum,
            "autocorrelation": autocorrelation(positions, values, options.get("detrend", True)),
            "windows": windowed,
            "event_intervals": intervals.tolist(),
            "median_event_interval": float(np.median(intervals)) if len(intervals) else None,
            "event_interval_cv": float(np.std(intervals) / np.mean(intervals))
            if len(intervals) and np.mean(intervals)
            else None,
        }
    reference = options.get("reference") or max(
        signals,
        key=lambda tag: max(result[tag]["spectrum"]["powers"], default=0),
        default=None,
    )
    if reference and reference not in signals:
        raise ValueError("Reference metric has no observations in this window")
    reference_peaks = result[reference]["spectrum"]["peaks"] if reference else []
    period = options.get("phase_period") or (
        reference_peaks[0]["period"] if reference_peaks else None
    )
    phases = []
    if period and reference:
        first_x, first_y = signals[reference]
        indices = np.unique(np.linspace(0, len(first_x) - 1, min(len(first_x), 4096)).astype(int))
        first_fit = fit_frequency(
            first_x[indices], first_y[indices], 1 / period, options.get("detrend", True)
        )
        for index, (tag, (positions, values)) in enumerate(signals.items()):
            report(progress, 90 + 9 * index / max(len(signals), 1), "Comparing phases", tag)
            if np.ptp(positions) < 2 * period:
                warnings.append(f"{tag}: fewer than two cycles at the phase comparison period")
                continue
            indices = np.unique(
                np.linspace(0, len(positions) - 1, min(len(positions), 4096)).astype(int)
            )
            fitted = fit_frequency(
                positions[indices], values[indices], 1 / period, options.get("detrend", True)
            )
            phase_difference = (first_fit["phase"] - fitted["phase"] + math.pi) % (
                2 * math.pi
            ) - math.pi
            meaningful = min(first_fit["power"], fitted["power"]) >= 0.1
            phases.append(
                {
                    "tag": tag,
                    "period": period,
                    **fitted,
                    "meaningful": meaningful,
                    "delay": phase_difference * period / (2 * math.pi) if meaningful else None,
                }
            )
    return {
        "experiment_id": experiment.id,
        "settings": options,
        "reference": reference,
        "metrics": result,
        "phase_period": period,
        "phases": phases,
        "missing_metrics": missing,
        "warnings": warnings,
        "note": "Candidate cycles are descriptive, not proof of periodicity. Phase delays are "
        "modulo one period; positive delay means target follows reference. Fits use "
        "original timestamps, with disclosed point limits. "
        "Long gaps are masked in autocorrelation.",
    }
