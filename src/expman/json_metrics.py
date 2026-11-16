"""Read registered JSON summary metrics without inventing observation histories."""

import json
import math
import threading
from collections import OrderedDict
from pathlib import Path


class JSONMetrics:
    def __init__(self, root, paths=()):
        self.root = Path(root).resolve()
        self.paths = []
        for entry in paths:
            if not isinstance(entry, str):
                raise ValueError("JSON metric paths must be strings")
            entry = entry.strip()
            if not entry:
                continue
            path = Path(entry).expanduser()
            if path.is_absolute():
                try:
                    entry = path.resolve().relative_to(self.root).as_posix()
                except ValueError as error:
                    raise ValueError(
                        "JSON metric files must be inside the log directory"
                    ) from error
            if ".." in Path(entry).parts or not entry.endswith(".json"):
                raise ValueError("Use JSON paths inside the log directory, without '..'")
            if entry not in self.paths:
                self.paths.append(entry)
        self.prefixes = [
            "JSON/" + path.replace("{experiment}/", "").removesuffix(".json") + "/"
            for path in self.paths
        ]
        if len(set(self.prefixes)) != len(self.prefixes):
            raise ValueError("Use distinct JSON filenames for each metric source")
        self.cache = OrderedDict()
        self.lock = threading.RLock()

    def is_metric(self, tag):
        return any(tag.startswith(prefix) for prefix in self.prefixes)

    def _per_experiment(self, entry):
        return "{experiment}" in entry or Path(entry).name == entry

    def files(self):
        result = set()
        for entry in self.paths:
            pattern = (
                entry.replace("{experiment}", "**") if "{experiment}" in entry else "**/" + entry
            )
            candidates = (
                self.root.glob(pattern) if self._per_experiment(entry) else [self.root / entry]
            )
            for path in candidates:
                if path.is_file() and path.resolve().is_relative_to(self.root):
                    result.add(path)
        return result

    def collect(self, experiments, progress=None):
        with self.lock:
            return self._collect(experiments, progress)

    def _collect(self, experiments, progress=None):
        result = {item.id: {} for item in experiments}
        warnings, errors = [], []
        total = sum(len(experiments) if self._per_experiment(entry) else 1 for entry in self.paths)
        checked = 0
        identities = {}
        for item in experiments:
            for identity in {item.id, item.relative_path, str(item.path), item.path.name}:
                identities.setdefault(identity, set()).add(item.id)
        signature = tuple((item.id, str(item.path)) for item in experiments)
        for entry, prefix in zip(self.paths, self.prefixes, strict=True):
            sources = (
                [
                    (
                        self.root / entry.replace("{experiment}", item.relative_path)
                        if "{experiment}" in entry
                        else item.path / entry,
                        item.id,
                    )
                    for item in experiments
                ]
                if self._per_experiment(entry)
                else [(self.root / entry, None)]
            )
            found = False
            for path, implicit in sources:
                checked += 1
                if progress:
                    progress(
                        80 * (checked - 1) / max(total, 1),
                        f"Loading JSON source {checked} of {total}",
                        str(path.relative_to(self.root)),
                    )
                if not path.resolve().is_relative_to(self.root):
                    errors.append(f"{entry}: path resolves outside the log directory")
                    continue
                if not path.is_file():
                    continue
                found = True
                if implicit is None:
                    owners = [item for item in experiments if path.parent.is_relative_to(item.path)]
                    implicit = (
                        max(owners, key=lambda item: len(item.path.parts)).id if owners else None
                    )
                try:
                    status = path.stat()
                except OSError as error:
                    errors.append(f"{entry}: {error}")
                    continue
                key = (
                    str(path),
                    status.st_ino,
                    status.st_mtime_ns,
                    status.st_size,
                    status.st_ctime_ns,
                    signature,
                    implicit,
                )
                cached = self.cache.pop(key, None)
                if cached is None:
                    try:
                        if status.st_size > 8 * 1024 * 1024:
                            raise ValueError("metric source exceeds the 8 MiB limit")
                        document = json.loads(path.read_text(encoding="utf-8-sig"))
                        cached = self._decode(document, prefix, identities, implicit)
                    except (OSError, UnicodeError, ValueError, RecursionError) as error:
                        cached = ({}, [], [str(error)])
                self.cache[key] = cached
                while len(self.cache) > 512 or (
                    len(self.cache) > 1 and sum(item[3] for item in self.cache) > 64 * 1024 * 1024
                ):
                    self.cache.popitem(last=False)
                values, notices, failures = cached
                for identifier, metrics in values.items():
                    result[identifier].update(metrics)
                relative = str(path.relative_to(self.root))
                warnings.extend(f"{relative}: {message}" for message in notices)
                errors.extend(f"{relative}: {message}" for message in failures)
            if not found:
                warnings.append(f"{entry}: no matching metric files found")
        if progress:
            progress(80, f"Checked {checked} JSON sources")
        return {
            "metrics": result,
            "warnings": sorted(set(warnings)),
            "errors": sorted(set(errors)),
            "paths": self.paths,
        }

    @staticmethod
    def _decode(document, prefix, identities, implicit):
        result, warnings = {}, []
        if not isinstance(document, (dict, list)):
            raise ValueError("Expected an object or list of experiment summary records")
        if isinstance(document, dict) and any(
            isinstance(document.get(key), (dict, list)) for key in ["runs", "experiments"]
        ):
            records = document.get("runs", document.get("experiments"))
        elif isinstance(document, dict) and any(
            isinstance(document.get(key), (str, int))
            for key in ["experiment", "experiment_id", "path", "run"]
        ):
            records = [document]
        elif implicit is not None:
            records = [{"experiment_id": implicit, "metrics": document.get("metrics", document)}]
        else:
            records = document
        if isinstance(records, dict):
            records = [
                {
                    "experiment": key,
                    "metrics": value.get("metrics", value) if isinstance(value, dict) else value,
                }
                for key, value in records.items()
            ]
        if not isinstance(records, list):
            raise ValueError("Expected runs/experiments to contain summary records")
        skipped, matched = 0, 0
        for record in records:
            if not isinstance(record, dict):
                warnings.append("Skipped a summary record that is not an object")
                continue
            identity = next(
                (
                    record[key]
                    for key in ["experiment_id", "experiment", "path", "run"]
                    if key in record
                ),
                None,
            )
            matches = identities.get(str(identity), set())
            if implicit is not None:
                if not matches or implicit in matches:
                    matches = {implicit}
                else:
                    warnings.append(f"{identity}: record conflicts with its experiment folder")
                    continue
            if len(matches) != 1:
                warnings.append(
                    f"{'Ambiguous' if matches else 'Unmatched'} experiment {identity!r}; "
                    "use its relative path or stable ID"
                )
                continue
            identifier = next(iter(matches))
            matched += 1
            payload = record.get("metrics")
            if payload is None:
                continue
            if not isinstance(payload, dict):
                warnings.append(f"{identity}: metrics must be an object")
                continue

            def visit(value, name, identifier=identifier, identity=identity):
                nonlocal skipped
                if isinstance(value, dict):
                    for key, item in value.items():
                        visit(item, name + "/" + str(key) if name else str(key))
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    try:
                        value = float(value)
                    except OverflowError:
                        skipped += 1
                        return
                    if not math.isfinite(value):
                        skipped += 1
                        return
                    tag = prefix + name
                    target = result.setdefault(identifier, {})
                    if tag in target:
                        warnings.append(f"{identity}: duplicate metric {name!r} was skipped")
                        return
                    target[tag] = {
                        "last": value,
                        "min": value,
                        "max": value,
                        "mean": value,
                        "count": 1,
                        "step": None,
                        "summary_only": True,
                    }
                else:
                    skipped += 1

            visit(payload, "")
        if skipped:
            warnings.append(f"Skipped {skipped} missing or nonnumeric summary values")
        if not result and not matched:
            warnings.append("No numeric summaries matched discovered experiments")
        return result, warnings, []


class SummaryScalars:
    def __init__(self, base, summaries, prefixes):
        self.base, self.summaries, self.prefixes = base, summaries, prefixes

    def is_summary_metric(self, tag):
        return any(tag.startswith(prefix) for prefix in self.prefixes)

    def summary_metrics(self, experiment):
        return self.summaries.get(experiment.id, {})

    def load(self, experiment):
        return self.base.load(experiment) if self.base else {}

    def load_metadata(self, experiment):
        from expman.experiments import ExperimentRepository

        native = (
            self.base.load_metadata(experiment)
            if self.base and hasattr(self.base, "load_metadata")
            else ExperimentRepository._summaries(self.load(experiment))
        )
        if set(native) & set(self.summary_metrics(experiment)):
            raise ValueError("A JSON summary metric conflicts with a TensorBoard tag")
        return {**native, **self.summary_metrics(experiment)}
