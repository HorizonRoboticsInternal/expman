"""Curve aggregation and descriptive condition/outcome relationships."""

from collections import defaultdict

import numpy as np

from expman.configs import active_config, canonical, ignored

_MISSING_CONDITION = object()


def outcome(
    points,
    reduction="last",
    direction="max",
    start_step=None,
    end_step=None,
    at_step=None,
    smoothing=0.4,
):
    if reduction in {"last_smoothed", "smoothed_at_step"} and len(points):
        positions, values = series(points, smoothing=smoothing)
        points = np.column_stack((positions, values))
        reduction = "at_step" if reduction == "smoothed_at_step" else "last"
    if reduction == "at_step":
        if not len(points) or at_step is None or at_step < points[0][0] or at_step > points[-1][0]:
            return None
        return float(
            np.interp(at_step, [point[0] for point in points], [point[1] for point in points])
        )
    points = [
        point
        for point in points
        if (start_step is None or point[0] >= start_step)
        and (end_step is None or point[0] <= end_step)
    ]
    if not len(points):
        return None
    values = np.array([point[1] for point in points], dtype=float)
    if reduction == "best":
        return float(values.min() if direction == "min" else values.max())
    if reduction == "mean":
        return float(values.mean())
    if reduction == "min":
        return float(values.min())
    if reduction == "max":
        return float(values.max())
    return float(values[-1])


def series(points, x_axis="step", smoothing=0.0, origin=None, value_column=1):
    if not len(points):
        return np.empty(0), np.empty(0)
    origin = points[0][2] if origin is None else origin
    if not smoothing:
        data = np.asarray(points)
        positions = data[:, 0] if x_axis == "step" else data[:, 2]
        if x_axis == "relative":
            positions = positions - origin
        if np.all(np.diff(positions) > 0):
            return positions, data[:, value_column]
        unique, reversed_indices = np.unique(positions[::-1], return_index=True)
        return unique, data[len(positions) - 1 - reversed_indices, value_column]
    unique = {}
    previous, count = 0.0, 0
    constant = all(point[value_column] == points[0][value_column] for point in points)
    for point in points:
        step, value, wall_time = point[0], point[value_column], point[2]
        if constant or not np.isfinite(value):
            smoothed = value
        else:
            previous = smoothing * previous + (1 - smoothing) * value
            count += 1
            smoothed = previous / (1 - smoothing**count if smoothing != 1 else 1)
        position = step if x_axis == "step" else wall_time
        if x_axis == "relative":
            position -= origin
        unique[position] = smoothed
    positions = sorted(unique)
    return np.array(positions), np.array([unique[position] for position in positions])


def downsample(positions, max_points, values=None):
    if len(positions) <= max_points:
        return np.arange(len(positions))
    if values is None or max_points < 4:
        return np.unique(np.linspace(0, len(positions) - 1, max_points).astype(int))
    indices = [0, len(positions) - 1]
    for bucket in np.array_split(np.arange(1, len(positions) - 1), (max_points - 2) // 2):
        indices.extend([bucket[np.argmin(values[bucket])], bucket[np.argmax(values[bucket])]])
    return np.unique(indices)


def aggregate(members, max_points=2000, band="std", alignment="overlap"):
    members = [(positions, values) for positions, values in members if len(positions)]
    if not members:
        return {"x": [], "y": [], "lower": [], "upper": [], "count": []}
    grid = np.unique(np.concatenate([positions for positions, _ in members]))
    if alignment == "overlap":
        start = max(positions[0] for positions, _ in members)
        end = min(positions[-1] for positions, _ in members)
        grid = grid[(grid >= start) & (grid <= end)]
    if not len(grid):
        return {"x": [], "y": [], "lower": [], "upper": [], "count": []}
    counts = np.zeros(len(grid), dtype=int)
    mean = np.zeros(len(grid))
    squared_deviation = np.zeros(len(grid))
    minimum = np.full(len(grid), np.inf)
    maximum = np.full(len(grid), -np.inf)
    for positions, values in members:
        sampled = np.interp(grid, positions, values, left=np.nan, right=np.nan)
        valid = np.isfinite(sampled)
        counts[valid] += 1
        difference = sampled[valid] - mean[valid]
        mean[valid] += difference / counts[valid]
        squared_deviation[valid] += difference * (sampled[valid] - mean[valid])
        minimum[valid] = np.minimum(minimum[valid], sampled[valid])
        maximum[valid] = np.maximum(maximum[valid], sampled[valid])
    deviation = np.sqrt(np.maximum(squared_deviation / counts, 0))
    valid_band = np.ones(len(grid), dtype=bool)
    if band == "sem":
        valid_band = counts >= 2
        deviation = np.divide(deviation, np.sqrt(np.maximum(counts - 1, 1)))
    lower, upper = mean - deviation, mean + deviation
    if band == "range":
        lower, upper = minimum, maximum
    indices = downsample(grid, max_points, mean)
    return {
        "x": grid[indices].tolist(),
        "y": mean[indices].tolist(),
        "lower": [float(lower[index]) if valid_band[index] else None for index in indices],
        "upper": [float(upper[index]) if valid_band[index] else None for index in indices],
        "count": counts[indices].tolist(),
        "source_points": len(grid),
        "sampled": len(indices) < len(grid),
    }


def curve_groups(experiments, state, options):
    patterns = state["ignored_configs"]
    groups = []
    group_by = options.get("group_by")
    if group_by:
        group_by = [group_by] if isinstance(group_by, str) else group_by
        if any(ignored(key, patterns) for key in group_by):
            raise ValueError("This configuration key is ignored; restore it before grouping")
        configurations = {
            item.id: active_config(item, patterns, state.get("ignored_files", []))
            for item in experiments
        }
        buckets = defaultdict(list)
        for experiment in experiments:
            config = configurations[experiment.id]
            cell = [{"present": key in config, "value": config.get(key)} for key in group_by]
            buckets[canonical(cell)].append(experiment)
        for index, (_, members) in enumerate(sorted(buckets.items())):
            config = configurations[members[0].id]
            label = ", ".join(
                f"{key} = {canonical(config[key]) if key in config else '(missing)'}"
                for key in group_by
            )
            groups.append((f"auto-{index}", label, members))
    elif options.get("group_ids"):
        if set(options["group_ids"]) - {group["id"] for group in state["groups"]}:
            raise ValueError("Unknown group selected")
        selected = {experiment.id: experiment for experiment in experiments}
        for group in state["groups"]:
            if group["id"] in options["group_ids"]:
                members = [
                    selected[identifier]
                    for identifier in group["experiment_ids"]
                    if identifier in selected
                ]
                if members:
                    groups.append((group["id"], group["name"], members))
    elif options.get("combine_selected"):
        groups = [("selected", "Selected experiments", experiments)]
    else:
        groups = [
            (
                experiment.id,
                state["experiments"].get(experiment.id, {}).get("name") or experiment.path.name,
                [experiment],
            )
            for experiment in experiments
        ]
    return groups


def curve_payload(repository, experiments, tags, state, options):
    groups = curve_groups(experiments, state, options)
    prepared, elapsed, original, origins = {}, {}, {}, {}
    client_smoothing = options.get("client_smoothing", False)
    for experiment in experiments:
        data = repository.load(experiment)
        indexed_origin = (
            repository.run_origin(experiment) if hasattr(repository, "run_origin") else None
        )
        origin = (
            indexed_origin
            if indexed_origin is not None
            else min((points[0][2] for points in data.values() if len(points)), default=0)
        )
        origins[experiment.id] = origin
        prepared[experiment.id] = {
            tag: data[tag]
            if client_smoothing
            else series(
                data[tag], options.get("x_axis", "step"), options.get("smoothing", 0), origin
            )
            for tag in tags
            if tag in data and len(data[tag])
        }
        if client_smoothing:
            continue
        elapsed[experiment.id] = {}
        original[experiment.id] = {}
        for tag in prepared[experiment.id]:
            original[experiment.id][tag] = series(
                data[tag], options.get("x_axis", "step"), 0, origin
            )
            positions, timestamps = series(
                data[tag], options.get("x_axis", "step"), 0, origin, value_column=2
            )
            elapsed[experiment.id][tag] = (positions, timestamps - origin)
    result = {}
    for tag in tags:
        traces = []
        for identifier, name, members in groups:
            available = [experiment for experiment in members if tag in prepared[experiment.id]]
            if not available:
                continue
            if client_smoothing:
                traces.append(
                    {
                        "id": identifier,
                        "name": name,
                        "member_ids": [item.id for item in available],
                        "eligible_member_ids": [item.id for item in members],
                        "missing_members": len(members) - len(available),
                        "members": [
                            {
                                "id": item.id,
                                "origin": float(origins[item.id]),
                                "points": np.asarray(prepared[item.id][tag]).tolist(),
                            }
                            for item in available
                        ],
                    }
                )
                continue
            curves = [prepared[experiment.id][tag] for experiment in available]
            combined = aggregate(
                curves,
                options.get("max_points", 2000),
                options.get("band", "std"),
                options.get("alignment", "overlap"),
            )
            grid = np.asarray(combined["x"], dtype=float)
            aligned = {}
            for key, observations in (("elapsed", elapsed), ("original_y", original)):
                total = np.zeros(len(grid))
                count = np.zeros(len(grid), dtype=int)
                for experiment in available:
                    positions, values = observations[experiment.id][tag]
                    sampled = np.interp(grid, positions, values, left=np.nan, right=np.nan)
                    valid = np.isfinite(sampled)
                    total[valid] += sampled[valid]
                    count[valid] += 1
                aligned[key] = [
                    float(value / contributors) if contributors else None
                    for value, contributors in zip(total, count, strict=True)
                ]
            traces.append(
                {
                    "id": identifier,
                    "name": name,
                    "member_ids": [item.id for item in available],
                    "missing_members": len(members) - len(available),
                    **aligned,
                    "elapsed_kind": "mean" if len(available) > 1 else "individual",
                    **combined,
                }
            )
        result[tag] = traces
    return result


def ranks(values):
    array = np.asarray(values)
    _, inverse, counts = np.unique(array, return_inverse=True, return_counts=True)
    starts = np.cumsum(counts) - counts
    return (starts + (counts - 1) / 2)[inverse]


def correlation(first, second):
    if len(first) < 3 or np.ptp(first) == 0 or np.ptp(second) == 0:
        return None
    return float(np.corrcoef(first, second)[0, 1])


def analyze(
    repository,
    experiments,
    tag,
    patterns,
    reduction="last",
    direction="max",
    file_patterns=(),
    start_step=None,
    end_step=None,
    at_step=None,
    progress=None,
    complete_history=True,
    condition_keys=None,
    smoothing=0.4,
    categorical_conditions=(),
    missing_conditions=None,
    separate_null_conditions=(),
    excluded_missing_conditions=(),
):
    records = []
    summary_only = hasattr(repository, "is_summary_metric") and repository.is_summary_metric(tag)
    if summary_only and (reduction != "last" or start_step is not None or end_step is not None):
        raise ValueError("JSON summary metrics support Final value without a step window")
    for index, experiment in enumerate(experiments):
        if progress:
            progress(
                50 + 25 * index / max(1, len(experiments)),
                "Computing outcomes",
                experiment.relative_path,
            )
        data = {} if summary_only else repository.load(experiment)
        points = data.get(tag, [])
        score = (
            repository.summary_metrics(experiment).get(tag, {}).get("last")
            if summary_only
            else outcome(points, reduction, direction, start_step, end_step, at_step, smoothing)
        )
        if score is not None:
            records.append(
                {
                    "id": experiment.id,
                    "name": experiment.path.name,
                    "result": score,
                    "first_step": points[0][0] if complete_history and len(points) else None,
                    "last_step": points[-1][0] if len(points) else None,
                    "config": active_config(experiment, patterns, file_patterns),
                }
            )
    keys = sorted({key for record in records for key in record["config"]})
    if condition_keys is not None:
        keys = sorted(set(condition_keys))
    categorical_conditions = set(categorical_conditions)
    missing_conditions = (
        set(keys) if missing_conditions is None else set(missing_conditions).intersection(keys)
    )
    missing_conditions.difference_update(excluded_missing_conditions)
    separate_null_conditions = set(separate_null_conditions)
    condition_types = {}
    associations = []
    for index, key in enumerate(keys):
        if progress:
            progress(75 + 23 * index / max(1, len(keys)), "Computing condition associations", key)
        include_missing = key in missing_conditions
        merge_null = include_missing and key not in separate_null_conditions
        pairs = [
            (
                _MISSING_CONDITION
                if key not in record["config"] or (merge_null and record["config"][key] is None)
                else record["config"][key],
                record["result"],
            )
            for record in records
            if include_missing or key in record["config"]
        ]
        observed = [value for value, _ in pairs if value is not _MISSING_CONDITION]
        numeric_values = bool(observed) and all(
            isinstance(value, (int, float)) and not isinstance(value, bool) for value in observed
        )
        numeric = (
            bool(pairs)
            and key not in categorical_conditions
            and all(
                isinstance(value, (int, float)) and not isinstance(value, bool)
                for value, _ in pairs
            )
        )
        condition_types[key] = "numeric" if numeric else "categorical"

        def category(value):
            if value is _MISSING_CONDITION:
                return _MISSING_CONDITION
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            return canonical(value)

        if len(pairs) < 3 or len({category(value) for value, _ in pairs}) < 2:
            continue
        values = np.array([score for _, score in pairs])
        entry = {"key": key, "count": len(pairs), "kind": "numeric" if numeric else "categorical"}
        if numeric:
            condition = np.array([value for value, _ in pairs], dtype=float)
            pearson = correlation(condition, values)
            spearman = correlation(ranks(condition), ranks(values))
            entry.update(
                pearson=pearson, spearman=spearman, association=abs(spearman or 0), groups=[]
            )
        else:
            buckets = defaultdict(list)
            for value, score in pairs:
                buckets[category(value)].append(score)
            if len(buckets) == len(pairs) or len(buckets) > max(12, len(pairs) // 2):
                continue
            total = float(np.sum((values - values.mean()) ** 2))
            between = sum(
                len(scores) * (np.mean(scores) - values.mean()) ** 2 for scores in buckets.values()
            )
            eta_squared = float(between / total) if total else 0
            entry.update(
                eta_squared=eta_squared,
                association=float(np.sqrt(max(0, eta_squared))),
                groups=[
                    {
                        "value": ("(missing or null)" if merge_null else "(missing)")
                        if label is _MISSING_CONDITION
                        else label,
                        **(
                            {"missing": True, "null_merged": merge_null}
                            if label is _MISSING_CONDITION
                            else {}
                        ),
                        "mean": float(np.mean(scores)),
                        "std": float(np.std(scores)),
                        "count": len(scores),
                    }
                    for label, scores in sorted(
                        buckets.items(),
                        key=lambda item: (
                            item[0] is _MISSING_CONDITION,
                            float(item[0])
                            if numeric_values and item[0] is not _MISSING_CONDITION
                            else str(item[0]),
                        ),
                    )
                ],
            )
        associations.append(entry)
    associations.sort(key=lambda item: (-item["association"], item["key"]))
    return {
        "metric": tag,
        "summary_only": summary_only,
        "reduction": reduction,
        "smoothing": smoothing if "smoothed" in reduction else 0,
        "direction": direction,
        "records": records,
        "start_step": start_step,
        "end_step": end_step,
        "at_step": at_step,
        "associations": associations,
        "condition_keys": keys,
        "condition_types": condition_types,
        "categorical_conditions": sorted(categorical_conditions.intersection(keys)),
        "missing_conditions": sorted(missing_conditions),
        "separate_null_conditions": sorted(separate_null_conditions.intersection(keys)),
        "missing_metric": len(experiments) - len(records),
        "note": "Descriptive associations, not causal effects. "
        "Missing conditions are excluded unless included as a category; "
        "null merges with missing by default when enabled. "
        "Numeric ranking uses absolute Spearman correlation; categorical ranking uses sqrt(eta²). "
        "Small samples, confounding, and multiple comparisons can produce misleading associations."
        + (
            ""
            if complete_history
            else " Final outcomes use latest observations; first steps are not loaded."
        ),
    }
