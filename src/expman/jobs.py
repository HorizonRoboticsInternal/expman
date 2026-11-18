"""Bounded background analysis, progress, cancellation, and event-aware reuse."""

import json
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import CancelledError, ThreadPoolExecutor
from dataclasses import replace
from types import SimpleNamespace

from expman.analytics import analyze, curve_payload
from expman.config_scalars import scalar_comparison_rows
from expman.fast_reader import FullScalarReader
from expman.json_metrics import SummaryScalars
from expman.onsets import sustained_change_analysis
from expman.tensorboard_data import TensorBoardScalars, fast_metadata
from expman.timeseries import event_analysis, periodicity_analysis


class AnalysisJobs:
    def __init__(
        self,
        repository,
        max_results=4,
        max_bytes=64 * 1024 * 1024,
        native=None,
        max_active=3,
        json_loader=None,
    ):
        self.repository = repository
        self.native = native
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="Expman-analysis")
        self.lock = threading.RLock()
        self.jobs = OrderedDict()
        self.max_results = max_results
        self.max_bytes = max_bytes
        self.max_active = max_active
        self.histories = OrderedDict()
        self.json_loader = json_loader

    @staticmethod
    def fingerprint(experiment):
        files = []
        for directory in experiment.run_dirs:
            for path in directory.glob("events.out.tfevents.*"):
                try:
                    status = path.stat()
                    files.append((str(path), status.st_ino, status.st_mtime_ns, status.st_size))
                except OSError:
                    continue
        return sorted(files)

    def _prune(self):
        completed = [job for job in self.jobs.values() if job["finished"] is not None]
        size = sum(job["bytes"] for job in completed)
        while completed and (
            len(completed) > self.max_results
            or (len(completed) > 1 and size > self.max_bytes)
            or time.time() - completed[0]["finished"] > 1200
        ):
            job = completed.pop(0)
            size -= job["bytes"]
            self.jobs.pop(job["id"], None)

    def start(self, kind, experiment, options):
        key = (
            uuid.uuid4().hex
            if kind == "json-metrics"
            else json.dumps([kind, options, self.fingerprint(experiment)], sort_keys=True)
        )
        with self.lock:
            self._prune()
            for job in self.jobs.values():
                if job["key"] == key and job["status"] in {"queued", "running", "complete"}:
                    return {**self.status(job["id"]), "reused": True}
            if sum(job["finished"] is None for job in self.jobs.values()) >= self.max_active:
                raise ValueError("Analyses are already queued or running; cancel one first")
            identifier = uuid.uuid4().hex
            job = {
                "id": identifier,
                "key": key,
                "kind": kind,
                "experiment_id": experiment.id,
                "status": "queued",
                "percent": 0,
                "stage": "Waiting for analysis worker",
                "metric": None,
                "error": None,
                "created": time.time(),
                "finished": None,
                "cancel": threading.Event(),
                "result": None,
                "bytes": 0,
            }
            self.jobs[identifier] = job
            job["future"] = self.executor.submit(self._run, job, experiment, options)
            return {**self.status(identifier), "reused": False}

    def _run(self, job, experiment, options):
        def progress(percent, stage, metric=None):
            if job["cancel"].is_set():
                raise CancelledError
            with self.lock:
                job.update(
                    status="running",
                    percent=max(job["percent"], min(percent, 99)),
                    stage=stage,
                    metric=metric,
                )

        try:
            progress(0, "Starting analysis")
            if job["kind"] == "json-metrics":
                result = self.json_loader(options["paths"], progress)
            elif job["kind"] == "all-curves":
                selected = self.repository.select(options["experiment_ids"])
                with FullScalarReader(
                    self.repository, selected, options["cache_dir"], progress
                ) as reader:
                    source = TensorBoardScalars(
                        self.repository,
                        reader,
                        selected,
                        options["settings"]["tags"],
                        2**31 - 1,
                        include_origins=True,
                    )
                    result = {
                        "curves": curve_payload(
                            source,
                            selected,
                            options["settings"]["tags"],
                            options["state"],
                            {**options["settings"], "max_points": 2**31 - 1},
                        ),
                        "source": "all-values",
                        "client_smoothing": options["settings"].get("client_smoothing", False),
                    }
            elif job["kind"] == "relationships":
                result = self._relationships(options, progress)
            elif job["kind"] == "comparison":
                selected = self.repository.select(options["experiment_ids"])
                prefixes = options.get("summary_prefixes", [])
                native_specs = [
                    spec
                    for spec in options["scalar_rows"]
                    if not any(spec["tag"].startswith(prefix) for prefix in prefixes)
                ]
                tags = [spec["tag"] for spec in native_specs]
                if not tags:
                    source = None
                elif all(spec["mode"] == "latest" for spec in native_specs):
                    if self.native and self.native.loader != "python":
                        self.native.initialize()
                        if hasattr(self.native.ingester, "wait_for_complete"):
                            self.native.ingester.wait_for_complete(progress)
                        source = TensorBoardScalars(self.repository, self.native, selected, tags, 1)
                    else:
                        source = self.repository
                else:
                    source = self._history_source(selected, tags, options["cache_dir"], progress)
                source = SummaryScalars(source, options.get("json_summaries", {}), prefixes)
                result = {
                    "experiment_ids": options["experiment_ids"],
                    "rows": scalar_comparison_rows(
                        source, selected, options["scalar_rows"], progress
                    ),
                }
            elif job["kind"] == "metrics":
                selected = self.repository.select(options["experiment_ids"])
                metadata = (
                    fast_metadata(self.repository, self.native, selected, progress)
                    if self.native
                    else {}
                )
                if not self.native:
                    for index, item in enumerate(selected):
                        progress(
                            99 * index / len(selected),
                            f"Loading experiment {index + 1} of {len(selected)}",
                            item.relative_path,
                        )
                        metadata[item.id] = self.repository.load_metadata(item)
                result = {"experiment_ids": options["experiment_ids"], "metadata": metadata}
            else:
                analyze = {
                    "events": event_analysis,
                    "periodicity": periodicity_analysis,
                    "onsets": sustained_change_analysis,
                }[job["kind"]]
                result = analyze(
                    self.repository, experiment, options.get("tags"), options, progress
                )
            progress(99, "Preparing results")
            size = len(json.dumps(result, separators=(",", ":"), allow_nan=False).encode())
            with self.lock:
                if job["cancel"].is_set():
                    raise CancelledError
                job.update(
                    result=result,
                    bytes=size,
                    status="complete",
                    percent=100,
                    stage="Complete",
                    metric=None,
                )
        except CancelledError:
            with self.lock:
                job.update(status="cancelled", stage="Cancelled", metric=None)
        except Exception as error:
            with self.lock:
                job.update(status="error", error=str(error), stage="Analysis failed", metric=None)
        finally:
            with self.lock:
                job["finished"] = time.time()
                self._prune()

    def _relationships(self, options, progress):
        selected = [
            replace(item, config=options["configurations"][item.id], config_files=[])
            for item in self.repository.select(options["experiment_ids"])
        ]
        settings = options["settings"]
        tag = settings["metric"]
        latest = (
            settings["reduction"] == "last"
            and settings["start_step"] is None
            and settings["end_step"] is None
        )
        fast = self.native and self.native.loader != "python"
        prefixes = options.get("summary_prefixes", [])
        if any(tag.startswith(prefix) for prefix in prefixes):
            source = SummaryScalars(None, options.get("json_summaries", {}), prefixes)
        elif not fast:
            source = self.repository
        elif latest:
            progress(5, "Waiting for indexed scalar data", tag)
            self.native.initialize()
            if hasattr(self.native.ingester, "wait_for_complete"):
                self.native.ingester.wait_for_complete(progress)
            progress(40, "Reading latest outcomes", tag)
            source = TensorBoardScalars(self.repository, self.native, selected, [tag], 1)
            nonfinite = [
                item
                for item in selected
                if tag in source.load(item) and not len(source.load(item)[tag])
            ]
            if nonfinite:
                history = self._history_source(nonfinite, [tag], options["cache_dir"], progress)
                for item in nonfinite:
                    source.metrics[item.id] = history.load(item)
        else:
            source = self._history_source(selected, [tag], options["cache_dir"], progress)
        result = analyze(
            source,
            selected,
            tag,
            [],
            settings["reduction"],
            settings["direction"],
            [],
            settings["start_step"],
            settings["end_step"],
            settings["at_step"],
            progress=progress,
            complete_history=not (fast and latest),
            condition_keys=options["condition_keys"],
            smoothing=settings["smoothing"],
            categorical_conditions=settings.get("categorical_conditions", []),
            missing_conditions=settings.get("missing_conditions"),
            separate_null_conditions=settings.get("separate_null_conditions", []),
            excluded_missing_conditions=settings.get("excluded_missing_conditions", []),
        )
        result["condition_scope"] = settings["condition_scope"]
        for record in result["records"]:
            record["name"] = options["names"][record["id"]]
        return result

    def _history_source(self, selected, tags, cache_dir, progress):
        key = json.dumps([(item.id, self.fingerprint(item)) for item in selected], sort_keys=True)
        cached = self.histories.pop(
            key, {"tags": set(), "metrics": {item.id: {} for item in selected}}
        )
        missing = set(tags) - cached["tags"]
        if missing:
            with FullScalarReader(self.repository, selected, cache_dir, progress) as reader:
                source = TensorBoardScalars(
                    self.repository, reader, selected, sorted(missing), 2**31 - 1
                )
                for item in selected:
                    cached["metrics"][item.id].update(source.load(item))
            cached["tags"].update(missing)
        self.histories[key] = cached

        def size():
            return sum(
                points.nbytes
                for entry in self.histories.values()
                for metrics in entry["metrics"].values()
                for points in metrics.values()
            )

        while self.histories and (len(self.histories) > 2 or size() > 128 * 1024 * 1024):
            self.histories.popitem(last=False)
        return SimpleNamespace(load=lambda item: cached["metrics"][item.id])

    def status(self, identifier):
        with self.lock:
            job = self.jobs[identifier]
            return {
                key: job[key]
                for key in (
                    "id",
                    "kind",
                    "experiment_id",
                    "status",
                    "percent",
                    "stage",
                    "metric",
                    "error",
                )
            } | {"elapsed": (job["finished"] or time.time()) - job["created"]}

    def result(self, identifier):
        with self.lock:
            job = self.jobs[identifier]
            if job["status"] != "complete":
                raise ValueError("Analysis result is not ready")
            return job["result"]

    def cancel(self, identifier):
        with self.lock:
            job = self.jobs[identifier]
            if job["finished"] is None:
                job["cancel"].set()
                if job["future"].cancel():
                    job.update(status="cancelled", stage="Cancelled", finished=time.time())
                else:
                    job.update(status="cancelling", stage="Cancelling after the current operation")
            return self.status(identifier)

    def close(self):
        with self.lock:
            for job in self.jobs.values():
                job["cancel"].set()
        self.executor.shutdown(wait=False, cancel_futures=True)
