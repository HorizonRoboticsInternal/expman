"""Use TensorBoard's retained scalar observations for responsive overview charts."""

import hashlib
import math

from tensorboard import context
from tensorboard.data.provider import RunTagFilter

from expman.experiments import ExperimentRepository


def streams(repository, experiments):
    return [
        (
            experiment,
            str(directory.relative_to(repository.root)),
            str(directory.relative_to(experiment.path)),
        )
        for experiment in experiments
        for directory in experiment.run_dirs
    ]


def metric_preview(repository, native, experiments):
    if not experiments:
        return {"tags": [], "signature": "", "available_experiments": 0}
    native.initialize()
    if native.backend != "fast":
        raise ValueError(
            "Fast TensorBoard reader is required for Overview; "
            "start Expman with --tensorboard-loader fast"
        )
    selected = streams(repository, experiments)
    metadata = native.ingester.data_provider.list_scalars(
        context.RequestContext(),
        experiment_id="",
        plugin_name="scalars",
        run_tag_filter=RunTagFilter(runs=[run for _, run, _ in selected]),
    )
    tags, available, signature = set(), set(), []
    for experiment, run, prefix in selected:
        for tag, information in metadata.get(run, {}).items():
            tags.add(tag if prefix == "." else prefix + "/" + tag)
            available.add(experiment.id)
            signature.append((run, tag, information.max_step, information.max_wall_time))
    return {
        "tags": sorted(tags),
        "signature": hashlib.sha256(repr(sorted(signature)).encode()).hexdigest(),
        "available_experiments": len(available),
        "source": "tensorboard",
    }


def fast_metadata(repository, native, experiments, progress):
    native.initialize()
    if native.backend != "fast":
        raise ValueError("Fast TensorBoard reader is required")
    if hasattr(native.ingester, "wait_for_complete"):
        native.ingester.wait_for_complete(progress)
    selected = streams(repository, experiments)
    provider = native.ingester.data_provider
    metadata = provider.list_scalars(
        context.RequestContext(),
        experiment_id="",
        plugin_name="scalars",
        run_tag_filter=RunTagFilter(runs=[run for _, run, _ in selected]),
    )
    values = provider.read_scalars(
        context.RequestContext(),
        experiment_id="",
        plugin_name="scalars",
        downsample=1,
        run_tag_filter=RunTagFilter(runs=[run for _, run, _ in selected]),
    )
    result = {experiment.id: {} for experiment in experiments}
    for experiment, run, prefix in selected:
        for tag, information in metadata.get(run, {}).items():
            points = values.get(run, {}).get(tag, [])
            point = max(points, key=lambda value: value.step) if points else None
            name = tag if prefix == "." else prefix + "/" + tag
            result[experiment.id][name] = {
                "last": float(point.value) if point and math.isfinite(point.value) else None,
                "step": information.max_step,
                "count": None,
                "min": None,
                "max": None,
                "mean": None,
                "sampled": True,
            }
    return result


class TensorBoardScalars:
    def __init__(self, repository, native, experiments, tags, max_points, include_origins=False):
        native.initialize()
        if native.backend != "fast":
            raise ValueError("Fast TensorBoard reader is required for Overview")
        self.origins = {}
        if include_origins and hasattr(native.ingester.data_provider, "list_runs"):
            starts = {
                run.run_id: run.start_time
                for run in native.ingester.data_provider.list_runs(
                    context.RequestContext(), experiment_id=""
                )
                if run.start_time is not None and math.isfinite(run.start_time)
            }
            for experiment, run, _ in streams(repository, experiments):
                if run in starts:
                    self.origins[experiment.id] = min(
                        self.origins.get(experiment.id, starts[run]), starts[run]
                    )
        requested = []
        for experiment, run, prefix in streams(repository, experiments):
            for tag in tags:
                if prefix == ".":
                    requested.append((experiment.id, run, tag, tag))
                elif tag.startswith(prefix + "/"):
                    requested.append((experiment.id, run, tag[len(prefix) + 1 :], tag))
        data = (
            native.ingester.data_provider.read_scalars(
                context.RequestContext(),
                experiment_id="",
                plugin_name="scalars",
                downsample=max_points,
                run_tag_filter=RunTagFilter(
                    runs=[run for _, run, _, _ in requested],
                    tags=[tag for _, _, tag, _ in requested],
                ),
            )
            if requested
            else {}
        )
        self.metrics = {experiment.id: {} for experiment in experiments}
        for identifier, run, source_tag, tag in requested:
            points = data.get(run, {}).get(source_tag, [])
            if points:
                self.metrics[identifier][tag] = ExperimentRepository._clean(
                    [[point.step, point.value, point.wall_time] for point in points]
                )

    def load(self, experiment):
        return self.metrics[experiment.id]

    def run_origin(self, experiment):
        return self.origins.get(experiment.id)

    def load_metadata(self, experiment):
        return ExperimentRepository._summaries(self.metrics[experiment.id])
