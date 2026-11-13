"""Explicit scalar rows for experiment configuration comparisons."""

import numpy as np

from expman.analytics import series
from expman.configs import canonical


def scalar_comparison_rows(repository, experiments, specifications, progress=None):
    cells = {spec["id"]: [] for spec in specifications}
    for index, experiment in enumerate(experiments):
        if progress:
            progress(
                99 * index / len(experiments),
                f"Reading scalar values for experiment {index + 1} of {len(experiments)}",
                experiment.relative_path,
            )
        is_summary = getattr(repository, "is_summary_metric", lambda tag: False)
        extra = (
            repository.summary_metrics(experiment) if hasattr(repository, "summary_metrics") else {}
        )
        requires_series = any(
            spec["mode"] != "latest" and not is_summary(spec["tag"]) for spec in specifications
        )
        requires_metadata = any(not is_summary(spec["tag"]) for spec in specifications)
        summaries = (
            repository.load_metadata(experiment)
            if not requires_series and requires_metadata
            else {}
        )
        data = repository.load(experiment) if requires_series else {}
        prepared = {}
        for spec in specifications:
            points = data.get(spec["tag"], [])
            mode = spec["mode"]
            value = None
            if is_summary(spec["tag"]):
                value = extra.get(spec["tag"], {}).get("last") if mode == "latest" else None
            elif not requires_series:
                value = summaries.get(spec["tag"], {}).get("last")
            elif len(points):
                if mode == "latest":
                    value = float(points[-1][1])
                else:
                    smoothing = spec["smoothing"] if "smoothed" in mode else 0
                    key = (spec["tag"], smoothing)
                    if key not in prepared:
                        prepared[key] = series(points, smoothing=smoothing)
                    positions, values = prepared[key]
                    if mode == "latest_smoothed":
                        value = float(values[-1])
                    elif positions[0] <= spec["step"] <= positions[-1]:
                        value = float(np.interp(spec["step"], positions, values))
            cells[spec["id"]].append({"present": value is not None, "value": value})
    return [
        {
            "id": "scalar:" + spec["id"],
            "kind": "scalar",
            "key": spec["tag"],
            "scalar": spec,
            "different": len({canonical(cell) for cell in cells[spec["id"]]}) > 1,
            "ignored": False,
            "cells": cells[spec["id"]],
        }
        for spec in specifications
    ]
