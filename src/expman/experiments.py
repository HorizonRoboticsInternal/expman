"""Discover experiments and read real TensorBoard scalar summaries lazily."""

import hashlib
import math
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
from tensorboard.util import tensor_util

from expman.configs import config_paths, load_configs
from expman.json_metrics import JSONMetrics


class _ScalarAccumulator(EventAccumulator):
    def _ProcessTensor(self, tag, wall_time, step, tensor):
        metadata = self.summary_metadata.get(tag)
        if metadata is not None and metadata.plugin_data.plugin_name not in {"scalars", ""}:
            return
        if any(dimension.size != 1 for dimension in tensor.tensor_shape.dim):
            return
        super()._ProcessTensor(tag, wall_time, step, tensor)


@dataclass
class Experiment:
    id: str
    path: Path
    relative_path: str
    run_dirs: list[Path] = field(default_factory=list)
    config: dict = field(default_factory=dict)
    config_files: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    summaries: dict = field(default_factory=dict)
    loaded: bool = False
    modified: float = 0


class ExperimentRepository:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.workspace_id = hashlib.sha256(str(self.root).encode()).hexdigest()[:16]
        self.experiments = {}
        self.lock = threading.RLock()
        self.cache = OrderedDict()
        self.summary_cache = {}
        self.max_cached_points = 2_000_000
        self.warnings = []
        self.last_scan = 0
        self.json_metric_files = set()
        self.json_sources = JSONMetrics(self.root)

    def scan(self):
        with self.lock:
            self.json_metric_files = self.json_sources.files()
            discovered, warnings, visited = {}, [], set()

            def walk_error(error):
                warnings.append(str(error))

            for directory, children, names in os.walk(
                self.root, followlinks=True, onerror=walk_error
            ):
                path = Path(directory)
                try:
                    info = path.stat()
                    identity = (info.st_dev, info.st_ino)
                except OSError as error:
                    warnings.append(str(error))
                    children[:] = []
                    continue
                if identity in visited:
                    children[:] = []
                    continue
                visited.add(identity)
                for name in children + names:
                    target = path / name
                    if target.is_symlink() and not target.exists():
                        warnings.append(f"Broken link: {target}")
                children[:] = sorted(
                    name
                    for name in children
                    if not name.startswith(".")
                    and name not in {"checkpoints", "wandb", "__pycache__"}
                )
                event_files = [
                    path / name for name in names if name.startswith("events.out.tfevents.")
                ]
                if not event_files:
                    continue
                ancestors = []
                candidate = path
                while candidate.is_relative_to(self.root):
                    if config_paths(candidate, self.json_metric_files):
                        ancestors.append(candidate)
                    if candidate == self.root:
                        break
                    candidate = candidate.parent
                primary = [
                    candidate
                    for candidate in ancestors
                    if any(
                        file.name in {"config.yaml", "config.yml", "config.json"}
                        for file in config_paths(candidate, self.json_metric_files)
                    )
                ]
                experiment_path = (primary or ancestors or [path])[0]
                relative = str(experiment_path.relative_to(self.root))
                experiment_id = hashlib.sha256(
                    f"{self.workspace_id}/{relative}".encode()
                ).hexdigest()[:16]
                if experiment_id not in discovered:
                    config, files, problems = load_configs(experiment_path, self.json_metric_files)
                    discovered[experiment_id] = Experiment(
                        id=experiment_id,
                        path=experiment_path,
                        relative_path=relative,
                        config=config,
                        config_files=files,
                        warnings=problems,
                    )
                experiment = discovered[experiment_id]
                experiment.run_dirs.append(path)
                for event_file in event_files:
                    try:
                        experiment.modified = max(experiment.modified, event_file.stat().st_mtime)
                    except OSError as error:
                        experiment.warnings.append(str(error))
            self.experiments = dict(
                sorted(discovered.items(), key=lambda pair: pair[1].relative_path)
            )
            self.warnings = warnings
            self.last_scan = time.time()
            self.cache = OrderedDict(
                (key, value) for key, value in self.cache.items() if key in discovered
            )
            self.summary_cache = {
                key: value for key, value in self.summary_cache.items() if key in discovered
            }
            return list(self.experiments.values())

    def get(self, experiment_id):
        if experiment_id not in self.experiments:
            raise KeyError(f"Unknown experiment: {experiment_id}")
        return self.experiments[experiment_id]

    def select(self, experiment_ids):
        return [self.get(experiment_id) for experiment_id in dict.fromkeys(experiment_ids)]

    @staticmethod
    def _fingerprint(experiment):
        identities = []
        for directory in experiment.run_dirs:
            for path in directory.glob("events.out.tfevents.*"):
                try:
                    status = path.stat()
                    identities.append(
                        (str(path), status.st_ino, status.st_mtime_ns, status.st_size)
                    )
                except OSError as error:
                    experiment.warnings.append(str(error))
        return tuple(sorted(identities))

    def load_metadata(self, experiment: Experiment):
        with self.lock:
            fingerprint = self._fingerprint(experiment)
            cached = self.summary_cache.get(experiment.id)
            if cached and cached[0] == fingerprint:
                experiment.summaries = cached[1]
                experiment.loaded = True
                return experiment.summaries
            self.load(experiment)
            return experiment.summaries

    def summary_metrics(self, experiment):
        return self.json_sources.collect(list(self.experiments.values()))["metrics"].get(
            experiment.id, {}
        )

    def is_summary_metric(self, tag):
        return self.json_sources.is_metric(tag)

    def load(self, experiment: Experiment):
        with self.lock:
            fingerprint = self._fingerprint(experiment)
            cached = self.cache.get(experiment.id)
            if cached and cached[0] == fingerprint:
                self.cache.move_to_end(experiment.id)
                experiment.metrics = cached[1]
                experiment.summaries = self._summaries(experiment.metrics)
                self.summary_cache[experiment.id] = (fingerprint, experiment.summaries)
                experiment.loaded = True
                return experiment.metrics
            metrics = {}
            for directory in experiment.run_dirs:
                try:
                    data = self._read(directory)
                    prefix = str(directory.relative_to(experiment.path))
                    for tag, points in data.items():
                        name = tag if prefix == "." else f"{prefix}/{tag}"
                        metrics[name] = points
                except (OSError, ValueError, RuntimeError) as error:
                    experiment.warnings.append(f"{directory.name}: {error}")
            experiment.metrics = metrics
            experiment.loaded = True
            experiment.summaries = self._summaries(metrics)
            self.summary_cache[experiment.id] = (fingerprint, experiment.summaries)
            self.cache[experiment.id] = (fingerprint, metrics)
            while (
                len(self.cache) > 1
                and sum(len(points) for _, data in self.cache.values() for points in data.values())
                > self.max_cached_points
            ):
                identifier, _ = self.cache.popitem(last=False)
                if identifier in self.experiments:
                    self.experiments[identifier].metrics = {}
            return metrics

    @staticmethod
    def _read(directory):
        accumulator = _ScalarAccumulator(
            str(directory),
            size_guidance={
                "scalars": 0,
                "tensors": 0,
                "images": 1,
                "histograms": 1,
                "compressedHistograms": 1,
                "audio": 1,
            },
        )
        accumulator.Reload()
        result = {}
        tags = accumulator.Tags()
        for tag in tags.get("scalars", []):
            result[tag] = ExperimentRepository._clean(
                [[event.step, event.value, event.wall_time] for event in accumulator.Scalars(tag)]
            )
        for tag in tags.get("tensors", []):
            metadata = accumulator.SummaryMetadata(tag)
            if metadata.plugin_data.plugin_name not in {"scalars", ""}:
                continue
            points = []
            for event in accumulator.Tensors(tag):
                try:
                    value = tensor_util.make_ndarray(event.tensor_proto)
                    if value.size == 1 and value.dtype.kind in "fiu":
                        points.append([event.step, float(value.reshape(-1)[0]), event.wall_time])
                except (ValueError, TypeError):
                    continue
            if points:
                result[tag] = ExperimentRepository._clean(points)
        return result

    @staticmethod
    def _clean(points):
        unique = {point[0]: point for point in points if all(math.isfinite(item) for item in point)}
        return np.asarray([unique[step] for step in sorted(unique)], dtype=float).reshape(-1, 3)

    @staticmethod
    def _summaries(metrics):
        summaries = {}
        for tag, points in metrics.items():
            if len(points):
                values = points[:, 1]
                summaries[tag] = {
                    "last": float(values[-1]),
                    "min": float(values.min()),
                    "max": float(values.max()),
                    "mean": float(values.mean()),
                    "step": int(points[-1][0]),
                    "count": len(values),
                }
        return summaries

    def describe(self, experiment, metadata, load=False):
        if load:
            self.load_metadata(experiment)
        return {
            "id": experiment.id,
            "name": metadata.get("name") or experiment.path.name,
            "path": experiment.relative_path,
            "config": experiment.config,
            "config_files": [item["name"] for item in experiment.config_files],
            "warnings": experiment.warnings,
            "metrics": experiment.summaries,
            "loaded": experiment.loaded,
            "modified": experiment.modified,
            "status": "recent" if time.time() - experiment.modified < 300 else "idle",
            "notes": metadata.get("notes", ""),
            "tags": metadata.get("tags", []),
            "archived": metadata.get("archived", False),
            "starred": metadata.get("starred", False),
        }
