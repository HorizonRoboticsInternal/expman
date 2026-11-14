"""HTTP API and bundled browser application."""

import csv
import io
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, JsonValue, model_validator

from expman.analytics import analyze, curve_payload
from expman.config_scalars import scalar_comparison_rows
from expman.configs import active_config, compare
from expman.experiments import Experiment, ExperimentRepository
from expman.filters import matches
from expman.jobs import AnalysisJobs
from expman.json_metrics import JSONMetrics
from expman.native import NativeTensorBoard
from expman.paths import migrate_legacy_state, user_directory, workspace_state_path
from expman.store import StateStore
from expman.tensorboard_data import TensorBoardScalars, fast_metadata, metric_preview
from expman.timeseries import event_analysis, periodicity_analysis


class RevalidatedStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


class Selection(BaseModel):
    experiment_ids: list[str] = Field(default_factory=list, max_length=2000)


class ScalarComparisonSpec(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    tag: str = Field(min_length=1, max_length=4000)
    mode: Literal["latest", "latest_smoothed", "at_step", "smoothed_at_step"] = "latest"
    step: float | None = Field(default=None, allow_inf_nan=False)
    smoothing: float = Field(default=0.4, ge=0, le=0.999, allow_inf_nan=False)
    highlight: Literal["none", "largest", "smallest"] = "none"
    highlight_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")

    @model_validator(mode="after")
    def require_step(self):
        if self.mode in {"at_step", "smoothed_at_step"} and self.step is None:
            raise ValueError("A training step is required for this scalar comparison")
        return self


class CompareRequest(Selection):
    differences_only: bool = True
    show_ignored: bool = False
    scalar_rows: list[ScalarComparisonSpec] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_scalar_rows(self):
        if len({row.id for row in self.scalar_rows}) != len(self.scalar_rows):
            raise ValueError("Scalar comparison row IDs must be unique")
        return self


class CurveRequest(Selection):
    tags: list[str] = Field(max_length=32)
    group_by: str | list[str] | None = None
    group_ids: list[str] = Field(default_factory=list)
    x_axis: Literal["step", "relative", "wall"] = "step"
    smoothing: float = Field(default=0, ge=0, le=0.999)
    client_smoothing: bool = False
    band: Literal["std", "sem", "range"] = "std"
    alignment: Literal["overlap", "union"] = "overlap"
    max_points: int = Field(default=2000, ge=2, le=20000)
    combine_selected: bool = False
    source: Literal["raw", "tensorboard"] = "raw"


class AnalysisRequest(Selection):
    metric: str
    reduction: Literal[
        "last", "last_smoothed", "best", "min", "max", "mean", "at_step", "smoothed_at_step"
    ] = "last"
    smoothing: float = Field(default=0.4, ge=0, le=0.999, allow_inf_nan=False)
    direction: Literal["min", "max"] = "max"
    start_step: float | None = Field(default=None, allow_inf_nan=False)
    end_step: float | None = Field(default=None, allow_inf_nan=False)
    at_step: float | None = Field(default=None, allow_inf_nan=False)
    condition_scope: Literal["all", "configurations"] = "all"
    configuration_differences_only: bool = True
    configuration_query: str = Field(default="", max_length=4000)
    categorical_conditions: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(
        default_factory=list, max_length=2000
    )
    missing_conditions: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(
        default_factory=list, max_length=2000
    )
    separate_null_conditions: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(
        default_factory=list, max_length=2000
    )

    def validate_outcome_window(self):
        if self.reduction in {"at_step", "smoothed_at_step"} and self.at_step is None:
            raise ValueError("Specify a target step for the fixed-step outcome")
        if (
            self.start_step is not None
            and self.end_step is not None
            and self.start_step > self.end_step
        ):
            raise ValueError("The start step must not exceed the end step")
        return self


class IgnoreRequest(BaseModel):
    patterns: list[str] = Field(max_length=1000)
    files: list[str] = Field(default_factory=list, max_length=1000)


class JSONMetricsRequest(BaseModel):
    paths: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(
        default_factory=list, max_length=100
    )


class GroupRequest(Selection):
    name: str = Field(min_length=1, max_length=120)


class AnnotationRequest(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=20000)
    tags: list[str] | None = Field(default=None, max_length=100)
    archived: bool | None = None
    starred: bool | None = None


class TimeSeriesRequest(BaseModel):
    experiment_id: str
    binary_window: int = Field(default=1001, ge=31, le=100001)
    tags: list[str] | None = Field(default=None, min_length=1, max_length=10000)
    include: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(
        default_factory=lambda: ["*"], max_length=100
    )
    exclude: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(
        default_factory=list, max_length=100
    )
    reference: str | None = None
    x_axis: Literal["step", "relative", "wall"] = "step"
    start: float | None = Field(default=None, allow_inf_nan=False)
    end: float | None = Field(default=None, allow_inf_nan=False)


class EventRequest(TimeSeriesRequest):
    period_aware: bool = True
    window: int = Field(default=31, ge=5, le=501)
    threshold: float = Field(default=5, ge=1, allow_inf_nan=False)
    detector: Literal["spike", "change"] = "spike"
    polarity: Literal["both", "up", "down"] = "both"
    separation: int = Field(default=2, ge=1, le=100)
    tolerance: float = Field(default=10, ge=0, allow_inf_nan=False)
    max_lag: float = Field(default=100, ge=0, allow_inf_nan=False)
    differences: bool = True


class PeriodicityRequest(TimeSeriesRequest):
    min_period: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    max_period: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    phase_period: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    frequencies: int = Field(default=384, ge=64, le=1024)
    detrend: bool = True
    windowed: bool = False


class AnalysisJobRequest(EventRequest, PeriodicityRequest):
    kind: Literal["events", "periodicity"] = "events"


class ViewRequest(BaseModel):
    view: dict = Field(default_factory=dict)


class NamedViewRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    view: dict | None = None


class AppearanceSettings(BaseModel):
    font_family: Literal["system", "arial", "georgia", "monospace"] = "system"
    font_size: int = Field(default=13, ge=10, le=22)
    text_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    background_color: str = Field(default="#f7f8fc", pattern=r"^#[0-9a-fA-F]{6}$")
    surface_color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    accent_color: str = Field(default="#4668e8", pattern=r"^#[0-9a-fA-F]{6}$")
    border_color: str = Field(default="#e7eaf1", pattern=r"^#[0-9a-fA-F]{6}$")
    difference_color: str = Field(default="#dcfce7", pattern=r"^#[0-9a-fA-F]{6}$")
    scalar_color: str = Field(default="#fbcfe8", pattern=r"^#[0-9a-fA-F]{6}$")


class SettingsRequest(BaseModel):
    auto_refresh: bool | None = None
    appearance: AppearanceSettings | None = None


class FilterPredicate(BaseModel):
    source: Literal["config", "path"] = "config"
    key: str = Field(min_length=1, max_length=4000)
    operator: Literal[
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "not_contains",
        "glob",
        "exists",
        "missing",
    ]
    value: JsonValue = None

    @model_validator(mode="after")
    def validate_numeric_operator(self):
        if self.operator in {"gt", "gte", "lt", "lte"} and (
            not isinstance(self.value, (int, float)) or isinstance(self.value, bool)
        ):
            raise ValueError("Numeric comparisons require a numeric value")
        json.dumps(self.value, allow_nan=False)
        return self


class NamedFilterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    filters: list[FilterPredicate] = Field(min_length=1, max_length=100)


def create_app(
    logdir: str | Path,
    state_file: str | Path | None = None,
    user_data_dir: str | Path | None = None,
    tensorboard_loader: str = "fast",
):
    repository = ExperimentRepository(Path(logdir))
    if not repository.root.is_dir():
        raise ValueError(f"Log directory does not exist: {repository.root}")
    user_dir = user_directory(user_data_dir)
    store = StateStore(workspace_state_path(repository.root, state_file), repository.workspace_id)
    settings_store = StateStore(
        user_dir / "settings.json",
        None,
        {"auto_refresh": False, "appearance": AppearanceSettings().model_dump()},
    )
    migrated_from = None
    if state_file is None:
        migrated_from = migrate_legacy_state(
            store, [Path.cwd() / ".expman" / "state.json", user_dir / "state.json"]
        )
    repository.json_sources = JSONMetrics(repository.root, store.read()["json_metrics"])
    repository.scan()
    native = NativeTensorBoard(repository.root, tensorboard_loader)
    analysis_jobs = AnalysisJobs(repository)
    metadata_jobs = AnalysisJobs(
        repository, max_results=2, native=native if tensorboard_loader != "python" else None
    )
    comparison_jobs = AnalysisJobs(repository, max_results=2, native=native)
    relationship_jobs = AnalysisJobs(repository, max_results=2, native=native)
    full_curve_jobs = AnalysisJobs(repository, max_results=2, max_active=32)

    @asynccontextmanager
    async def lifespan(application):
        try:
            yield
        finally:
            native.close()
            analysis_jobs.close()
            metadata_jobs.close()
            comparison_jobs.close()
            relationship_jobs.close()
            full_curve_jobs.close()
            json_metric_jobs.close()

    app = FastAPI(title="Expman", version="0.1.0", lifespan=lifespan)
    app.state.repository = repository
    app.state.store = store
    app.state.settings_store = settings_store
    app.state.analysis_jobs = analysis_jobs
    app.state.metadata_jobs = metadata_jobs
    app.state.comparison_jobs = comparison_jobs
    app.state.relationship_jobs = relationship_jobs
    app.state.tensorboard = native
    app.state.full_curve_jobs = full_curve_jobs
    static = Path(__file__).parent / "static"

    @app.exception_handler(KeyError)
    async def missing_handler(request: Request, error: KeyError):
        return JSONResponse(status_code=404, content={"detail": str(error).strip("'")})

    @app.exception_handler(ValueError)
    async def value_handler(request: Request, error: ValueError):
        return JSONResponse(status_code=400, content={"detail": str(error)})

    @app.exception_handler(OSError)
    async def storage_handler(request: Request, error: OSError):
        return JSONResponse(
            status_code=503,
            content={
                "detail": f"Cannot access app storage: {error}. Check directory permissions "
                "or set --state-file / --user-data-dir to writable locations."
            },
        )

    def descriptions(experiments, load=False):
        annotations = store.read()["experiments"]
        imported = repository.json_sources.collect(list(repository.experiments.values()))["metrics"]
        return [
            {
                **repository.describe(item, annotations.get(item.id, {}), load),
                "metrics": {**item.summaries, **imported.get(item.id, {})},
            }
            for item in experiments
        ]

    def summary_options(selected, tags=None):
        imported = repository.json_sources.collect(list(repository.experiments.values()))["metrics"]
        return {
            "json_summaries": {
                item.id: {
                    tag: value
                    for tag, value in imported.get(item.id, {}).items()
                    if tags is None or tag in tags
                }
                for item in selected
            },
            "summary_prefixes": repository.json_sources.prefixes,
        }

    def json_metric_status(source=None, report=None):
        source = source or repository.json_sources
        if report is None:
            report = source.collect(list(repository.experiments.values()))
        return {
            "paths": source.paths,
            "summary_tags": sorted(
                {tag for values in report["metrics"].values() for tag in values}
            ),
            "matched_experiments": sum(bool(values) for values in report["metrics"].values()),
            "metric_values": sum(len(values) for values in report["metrics"].values()),
            "warnings": report["warnings"],
            "errors": report["errors"],
        }

    @app.get("/api/json-metrics")
    def json_metric_sources():
        return json_metric_status()

    def load_json_metric_sources(paths, progress=None):
        candidate = JSONMetrics(repository.root, paths)
        report = candidate.collect(list(repository.experiments.values()), progress)
        status = json_metric_status(candidate, report)
        if status["errors"]:
            raise ValueError("; ".join(status["errors"]))
        if progress:
            progress(85, "Saving JSON metric paths")
        store.update(lambda state: state.update(json_metrics=candidate.paths))
        repository.json_sources = candidate
        if progress:
            progress(90, "Updating configuration discovery")
        repository.scan()
        if progress:
            progress(95, "Preparing experiment summaries")
        return {
            **json_metric_status(),
            "experiments": descriptions(list(repository.experiments.values())),
        }

    json_metric_jobs = AnalysisJobs(
        repository, max_results=2, max_active=1, json_loader=load_json_metric_sources
    )
    app.state.json_metric_jobs = json_metric_jobs

    @app.put("/api/json-metrics")
    def update_json_metric_sources(selection: JSONMetricsRequest):
        return load_json_metric_sources(selection.paths)

    @app.post("/api/json-metrics/jobs")
    def start_json_metric_loading(selection: JSONMetricsRequest):
        paths = JSONMetrics(repository.root, selection.paths).paths
        source = Experiment(id="json-metrics", path=repository.root, relative_path="", run_dirs=[])
        return json_metric_jobs.start("json-metrics", source, {"paths": paths})

    @app.get("/api/json-metrics/jobs/{identifier}")
    def json_metric_loading_status(identifier: str):
        return json_metric_jobs.status(identifier)

    @app.get("/api/json-metrics/jobs/{identifier}/result")
    def json_metric_loading_result(identifier: str):
        return json_metric_jobs.result(identifier)

    @app.get("/api/workspace")
    def workspace():
        return {
            "name": repository.root.name,
            "logdir": str(repository.root),
            "id": repository.workspace_id,
            "last_scan": repository.last_scan,
            "revision": repository.revision,
            "warnings": repository.warnings,
            "state_file": str(store.path.absolute()),
            "user_data_dir": str(user_dir),
            "settings_file": str(settings_store.path),
            "settings": settings_store.read(),
            "migrated_from": migrated_from,
            "state": store.read(),
        }

    @app.get("/api/tensorboard/status")
    def tensorboard_status():
        return native.status()

    @app.put("/api/view")
    def save_view(update: ViewRequest):
        if len(json.dumps(update.view, allow_nan=False).encode("utf-8")) > 1024 * 1024:
            raise ValueError("Workspace view must not exceed 1 MiB")
        return store.update(lambda state: state.update(view=update.view))["view"]

    @app.get("/api/named-views")
    def named_views():
        return store.read()["named_views"]

    def write_named_view(update, identifier=None):
        name = update.name.strip()
        if not name:
            raise ValueError("Give the view a name")
        snapshot = None
        if update.view is not None:
            if len(json.dumps(update.view, allow_nan=False).encode("utf-8")) > 1024 * 1024:
                raise ValueError("Named view must not exceed 1 MiB")
            snapshot = {key: value for key, value in update.view.items() if key != "namedView"}
            if snapshot.get("selectionMode") == "filters":
                snapshot["selected"] = []
            if "configurationExclusions" in snapshot:
                IgnoreRequest.model_validate(snapshot["configurationExclusions"])
        saved_id = identifier or uuid.uuid4().hex[:16]

        def mutate(state):
            views = state["named_views"]
            previous = next((item for item in views if item["id"] == saved_id), None)
            if identifier and previous is None:
                raise KeyError(f"Unknown named view: {identifier}")
            if any(
                item["id"] != saved_id and item["name"].casefold() == name.casefold()
                for item in views
            ):
                raise HTTPException(409, "A view with that name already exists")
            if previous is None and len(views) >= 100:
                raise ValueError("A workspace can contain up to 100 named views")
            if previous is None and snapshot is None:
                raise ValueError("Settings are required for a new named view")
            definition = {
                "id": saved_id,
                "name": name,
                "view": snapshot if snapshot is not None else previous["view"],
            }
            state["named_views"] = (
                [definition if item["id"] == saved_id else item for item in views]
                if previous
                else [*views, definition]
            )
            if update.view is not None:
                state["view"] = {**update.view, "namedView": saved_id}

        saved = store.update(mutate)
        return next(item for item in saved["named_views"] if item["id"] == saved_id)

    @app.post("/api/named-views", status_code=201)
    def create_named_view(update: NamedViewRequest):
        return write_named_view(update)

    @app.put("/api/named-views/{identifier}")
    def update_named_view(identifier: str, update: NamedViewRequest):
        return write_named_view(update, identifier)

    @app.post("/api/named-views/{identifier}/load")
    def load_named_view(identifier: str):
        definition = next(
            (item for item in store.read()["named_views"] if item["id"] == identifier), None
        )
        if definition is None:
            raise KeyError(f"Unknown named view: {identifier}")
        if definition["view"].get("selectionMode") == "filters":
            repository.scan()

        def mutate(state):
            state["view"] = {**definition["view"], "namedView": identifier}
            exclusions = definition["view"].get("configurationExclusions")
            if exclusions is not None:
                validated = IgnoreRequest.model_validate(exclusions)
                state.update(ignored_configs=validated.patterns, ignored_files=validated.files)

        return store.update(mutate)["view"]

    @app.delete("/api/named-views/{identifier}")
    def delete_named_view(identifier: str):
        def mutate(state):
            if not any(item["id"] == identifier for item in state["named_views"]):
                raise KeyError(f"Unknown named view: {identifier}")
            state["named_views"] = [
                item for item in state["named_views"] if item["id"] != identifier
            ]
            if state["view"].get("namedView") == identifier:
                state["view"]["namedView"] = ""

        return store.update(mutate)["named_views"]

    @app.get("/api/settings")
    def settings():
        return settings_store.read()

    @app.put("/api/settings")
    def save_settings(update: SettingsRequest):
        return settings_store.update(
            lambda settings: settings.update(update.model_dump(exclude_none=True))
        )

    @app.get("/api/filters")
    def named_filters():
        return store.read()["named_filters"]

    def write_filter(update, identifier=None):
        name = update.name.strip()
        if not name:
            raise ValueError("Give the filter set a name")
        definition = {
            "id": identifier or uuid.uuid4().hex[:16],
            "name": name,
            "filters": [predicate.model_dump() for predicate in update.filters],
        }

        def mutate(state):
            saved = state["named_filters"]
            if identifier and not any(item["id"] == identifier for item in saved):
                raise KeyError(f"Unknown named filter: {identifier}")
            if any(
                item["name"].casefold() == name.casefold() and item["id"] != identifier
                for item in saved
            ):
                raise HTTPException(409, "A named filter with that name already exists")
            state["named_filters"] = [item for item in saved if item["id"] != identifier] + [
                definition
            ]

        store.update(mutate)
        return definition

    @app.post("/api/filters", status_code=201)
    def create_filter(update: NamedFilterRequest):
        return write_filter(update)

    @app.put("/api/filters/{identifier}")
    def update_filter(identifier: str, update: NamedFilterRequest):
        return write_filter(update, identifier)

    @app.delete("/api/filters/{identifier}")
    def delete_filter(identifier: str):
        def mutate(state):
            if not any(item["id"] == identifier for item in state["named_filters"]):
                raise KeyError(f"Unknown named filter: {identifier}")
            state["named_filters"] = [
                item for item in state["named_filters"] if item["id"] != identifier
            ]

        return store.update(mutate)["named_filters"]

    @app.post("/api/filters/{identifier}/matches")
    def filter_matches(identifier: str):
        state = store.read()
        saved = next((item for item in state["named_filters"] if item["id"] == identifier), None)
        if saved is None:
            raise KeyError(f"Unknown named filter: {identifier}")
        selected = [
            experiment.id
            for experiment in repository.experiments.values()
            if not state["experiments"].get(experiment.id, {}).get("archived", False)
            and matches(experiment.config, saved["filters"], experiment.relative_path)
        ]
        return {"experiment_ids": selected, "count": len(selected)}

    @app.get("/api/experiments")
    def experiments():
        return {"experiments": descriptions(list(repository.experiments.values()))}

    @app.post("/api/refresh")
    def refresh():
        return {
            "experiments": descriptions(repository.scan()),
            "warnings": repository.warnings,
            "last_scan": repository.last_scan,
            "revision": repository.revision,
        }

    @app.post("/api/metrics")
    def metrics(selection: Selection):
        selected = repository.select(selection.experiment_ids)
        if tensorboard_loader == "python":
            items = descriptions(selected, load=True)
        else:
            metadata = fast_metadata(repository, native, selected, lambda *arguments: None)
            items = [
                {**item, "metrics": metadata[item["id"]], "loaded": True}
                for item in descriptions(selected)
            ]
        return metric_payload(selected, items)

    def metric_payload(selected, items):
        state = store.read()
        imported = summary_options(selected)["json_summaries"]
        items = [
            {**item, "metrics": {**item["metrics"], **imported.get(item["id"], {})}}
            for item in items
        ]
        configs = {
            key
            for item in selected
            for key in active_config(item, state["ignored_configs"], state["ignored_files"])
        }
        return {
            "tags": sorted(
                {
                    tag
                    for item in items
                    for tag, info in item["metrics"].items()
                    if not info.get("summary_only")
                }
            ),
            "summary_tags": sorted(
                {
                    tag
                    for item in items
                    for tag, info in item["metrics"].items()
                    if info.get("summary_only")
                }
            ),
            "config_keys": sorted(configs),
            "experiments": items,
        }

    @app.post("/api/metrics/preview")
    def preview_metric_names(selection: Selection):
        selected = repository.select(selection.experiment_ids)
        result = metric_preview(repository, native, selected)
        imported = summary_options(selected)["json_summaries"]
        return {
            **result,
            "summary_tags": sorted({tag for values in imported.values() for tag in values}),
        }

    @app.post("/api/metrics/jobs", status_code=202)
    def start_metric_discovery(selection: Selection):
        selected = repository.select(selection.experiment_ids)
        if not selected:
            raise ValueError("Select at least one experiment")
        source = Experiment(
            id="selected-experiments",
            path=repository.root,
            relative_path="",
            run_dirs=[directory for item in selected for directory in item.run_dirs],
        )
        return metadata_jobs.start(
            "metrics",
            source,
            {"experiment_ids": [item.id for item in selected], **summary_options(selected)},
        )

    @app.get("/api/metrics/jobs/{identifier}")
    def metric_discovery_status(identifier: str):
        return metadata_jobs.status(identifier)

    @app.get("/api/metrics/jobs/{identifier}/result")
    def metric_discovery_result(identifier: str):
        result = metadata_jobs.result(identifier)
        selected = repository.select(result["experiment_ids"])
        items = [
            {**descriptions([item])[0], "metrics": result["metadata"][item.id], "loaded": True}
            for item in selected
        ]
        return metric_payload(selected, items)

    @app.post("/api/metrics/jobs/{identifier}/cancel")
    def cancel_metric_discovery(identifier: str):
        return metadata_jobs.cancel(identifier)

    @app.get("/api/experiments/{experiment_id}")
    def experiment(experiment_id: str):
        item = repository.get(experiment_id)
        annotation = store.read()["experiments"].get(item.id, {})
        return {**repository.describe(item, annotation), "files": item.config_files}

    @app.patch("/api/experiments/{experiment_id}")
    def annotate(experiment_id: str, annotation: AnnotationRequest):
        item = repository.get(experiment_id)
        changes = annotation.model_dump(exclude_none=True)
        saved = store.update(
            lambda state: state["experiments"].setdefault(experiment_id, {}).update(changes)
        )
        return repository.describe(item, saved["experiments"][experiment_id])

    @app.post("/api/compare")
    def compare_configs(selection: CompareRequest):
        selected = repository.select(selection.experiment_ids)
        state = store.read()
        rows = compare(
            selected,
            state["ignored_configs"],
            selection.differences_only,
            selection.show_ignored,
            state["ignored_files"],
        )
        configurations = [{"id": "config:" + row["key"], "kind": "config", **row} for row in rows]
        scalars = (
            scalar_comparison_rows(
                repository, selected, [row.model_dump() for row in selection.scalar_rows]
            )
            if selection.scalar_rows
            else []
        )
        return {
            "experiments": [
                {"id": item["id"], "name": item["name"]} for item in descriptions(selected)
            ],
            "rows": scalars + configurations,
        }

    @app.post("/api/compare/scalars/jobs", status_code=202)
    def start_scalar_comparison(selection: CompareRequest):
        selected = repository.select(selection.experiment_ids)
        if not selected or not selection.scalar_rows:
            raise ValueError("Select experiments and add at least one scalar row")
        source = Experiment(
            id="scalar-comparison",
            path=repository.root,
            relative_path="",
            run_dirs=[directory for item in selected for directory in item.run_dirs],
        )
        return comparison_jobs.start(
            "comparison",
            source,
            {
                "experiment_ids": [item.id for item in selected],
                "scalar_rows": [row.model_dump() for row in selection.scalar_rows],
                **summary_options(selected, {row.tag for row in selection.scalar_rows}),
                "cache_dir": str(store.path.parent / "cache"),
            },
        )

    @app.get("/api/compare/scalars/jobs/{identifier}")
    def scalar_comparison_status(identifier: str):
        return comparison_jobs.status(identifier)

    @app.get("/api/compare/scalars/jobs/{identifier}/result")
    def scalar_comparison_result(identifier: str):
        return comparison_jobs.result(identifier)

    @app.post("/api/compare/scalars/jobs/{identifier}/cancel")
    def cancel_scalar_comparison(identifier: str):
        return comparison_jobs.cancel(identifier)

    @app.put("/api/ignored-configs")
    def ignore_configs(update: IgnoreRequest):
        patterns = list(
            dict.fromkeys(pattern.strip() for pattern in update.patterns if pattern.strip())
        )
        files = list(dict.fromkeys(pattern.strip() for pattern in update.files if pattern.strip()))
        if any(len(pattern) > 500 for pattern in patterns + files):
            raise ValueError("Ignore patterns must be at most 500 characters")
        return store.update(
            lambda state: state.update(ignored_configs=patterns, ignored_files=files)
        )

    @app.post("/api/groups", status_code=201)
    def add_group(group: GroupRequest):
        repository.select(group.experiment_ids)
        if not group.experiment_ids or not group.name.strip():
            raise ValueError("Give the group a name and select at least one experiment")
        saved = {
            "id": uuid.uuid4().hex[:16],
            "name": group.name.strip(),
            "experiment_ids": list(dict.fromkeys(group.experiment_ids)),
        }
        store.update(lambda state: state["groups"].append(saved))
        return saved

    @app.put("/api/groups/{group_id}")
    def update_group(group_id: str, group: GroupRequest):
        repository.select(group.experiment_ids)
        if not group.experiment_ids or not group.name.strip():
            raise ValueError("Give the group a name and select at least one experiment")

        def mutate(state):
            saved = next((item for item in state["groups"] if item["id"] == group_id), None)
            if saved is None:
                raise KeyError(f"Unknown group: {group_id}")
            saved.update(
                name=group.name.strip(), experiment_ids=list(dict.fromkeys(group.experiment_ids))
            )

        return store.update(mutate)

    @app.delete("/api/groups/{group_id}")
    def delete_group(group_id: str):
        def mutate(state):
            if not any(item["id"] == group_id for item in state["groups"]):
                raise KeyError(f"Unknown group: {group_id}")
            state["groups"] = [item for item in state["groups"] if item["id"] != group_id]

        return store.update(mutate)

    @app.post("/api/curves")
    def curves(selection: CurveRequest):
        selected = repository.select(selection.experiment_ids)
        source = (
            TensorBoardScalars(
                repository,
                native,
                selected,
                selection.tags,
                selection.max_points,
                include_origins=True,
            )
            if selection.source == "tensorboard"
            else repository
        )
        result = curve_payload(
            source, selected, selection.tags, store.read(), selection.model_dump()
        )
        if selection.source == "tensorboard":
            for values in result.values():
                for curve in values:
                    curve["sampled"] = True
        return {
            "curves": result,
            "source": selection.source,
            "client_smoothing": selection.client_smoothing,
        }

    @app.post("/api/curves/all/jobs", status_code=202)
    def start_full_curve(selection: CurveRequest):
        selected = repository.select(selection.experiment_ids)
        if not selected or not selection.tags:
            raise ValueError("Select experiments and at least one metric to load all values")
        if len(selection.tags) > 1 and len(selected) != 1:
            raise ValueError("Select one experiment to load all values for multiple metrics")
        source = Experiment(
            id="all-values",
            path=repository.root,
            relative_path="",
            run_dirs=[directory for item in selected for directory in item.run_dirs],
        )
        state = store.read()
        return full_curve_jobs.start(
            "all-curves",
            source,
            {
                "experiment_ids": [item.id for item in selected],
                "settings": selection.model_dump(),
                "cache_dir": str(store.path.parent / "cache"),
                "state": {
                    key: state[key]
                    for key in ["experiments", "groups", "ignored_configs", "ignored_files"]
                },
            },
        )

    @app.get("/api/curves/all/jobs/{identifier}")
    def full_curve_status(identifier: str):
        return full_curve_jobs.status(identifier)

    @app.get("/api/curves/all/jobs/{identifier}/result")
    def full_curve_result(identifier: str):
        return full_curve_jobs.result(identifier)

    @app.post("/api/curves/all/jobs/{identifier}/cancel")
    def cancel_full_curve(identifier: str):
        return full_curve_jobs.cancel(identifier)

    def relationship_conditions(selection, selected, state):
        if selection.condition_scope == "all":
            return None
        rows = compare(
            selected,
            state["ignored_configs"],
            selection.configuration_differences_only,
            False,
            state["ignored_files"],
        )
        query = selection.configuration_query.lower()
        return [row["key"] for row in rows if query in row["key"].lower()]

    @app.post("/api/analysis")
    def analysis(selection: AnalysisRequest):
        selection.validate_outcome_window()
        state = store.read()
        selected = repository.select(selection.experiment_ids)
        result = analyze(
            repository,
            selected,
            selection.metric,
            state["ignored_configs"],
            selection.reduction,
            selection.direction,
            state["ignored_files"],
            selection.start_step,
            selection.end_step,
            selection.at_step,
            condition_keys=relationship_conditions(selection, selected, state),
            smoothing=selection.smoothing,
            categorical_conditions=selection.categorical_conditions,
            missing_conditions=selection.missing_conditions,
            separate_null_conditions=selection.separate_null_conditions,
        )
        result["condition_scope"] = selection.condition_scope
        for record in result["records"]:
            record["name"] = (
                state["experiments"].get(record["id"], {}).get("name") or record["name"]
            )
        return result

    @app.post("/api/relationships/jobs", status_code=202)
    def start_relationships(selection: AnalysisRequest):
        selection.validate_outcome_window()
        selected = repository.select(selection.experiment_ids)
        if not selected:
            raise ValueError("Select experiments to analyze relationships")
        state = store.read()
        source = Experiment(
            id="relationships",
            path=repository.root,
            relative_path="",
            run_dirs=[directory for item in selected for directory in item.run_dirs],
        )
        return relationship_jobs.start(
            "relationships",
            source,
            {
                "experiment_ids": [item.id for item in selected],
                "settings": selection.model_dump(exclude={"experiment_ids"}),
                "condition_keys": relationship_conditions(selection, selected, state),
                **summary_options(selected, {selection.metric}),
                "configurations": {
                    item.id: active_config(item, state["ignored_configs"], state["ignored_files"])
                    for item in selected
                },
                "names": {
                    item.id: state["experiments"].get(item.id, {}).get("name") or item.path.name
                    for item in selected
                },
                "cache_dir": str(store.path.parent / "cache"),
            },
        )

    @app.get("/api/relationships/jobs/{identifier}")
    def relationship_status(identifier: str):
        return relationship_jobs.status(identifier)

    @app.get("/api/relationships/jobs/{identifier}/result")
    def relationship_result(identifier: str):
        return relationship_jobs.result(identifier)

    @app.post("/api/relationships/jobs/{identifier}/cancel")
    def cancel_relationship(identifier: str):
        return relationship_jobs.cancel(identifier)

    @app.get("/api/export/scalars.csv")
    def export_scalars(ids: str = Query(max_length=40000), tag: str = Query(max_length=4000)):
        selected = repository.select(ids.split(",") if ids else [])
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["experiment", "metric", "step", "value", "wall_time"])
        for item in selected:
            repository.load(item)
            for step, value, wall_time in item.metrics.get(tag, []):
                writer.writerow([item.relative_path, tag, step, value, wall_time])
        return Response(
            output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="expman-scalars.csv"'},
        )

    def validate_time_window(selection):
        if (
            selection.start is not None
            and selection.end is not None
            and selection.start >= selection.end
        ):
            raise ValueError("The start must be before the end of the analysis window")
        if (
            selection.reference
            and selection.tags is not None
            and selection.reference not in selection.tags
        ):
            raise ValueError("Reference metric must be included in the selected metrics")
        if isinstance(selection, PeriodicityRequest) and (
            selection.min_period
            and selection.max_period
            and selection.min_period >= selection.max_period
        ):
            raise ValueError("Minimum period must be smaller than maximum period")

    @app.post("/api/analysis/jobs", status_code=202)
    def start_analysis(selection: AnalysisJobRequest):
        validate_time_window(selection)
        return analysis_jobs.start(
            selection.kind, repository.get(selection.experiment_id), selection.model_dump()
        )

    @app.get("/api/analysis/jobs/{identifier}")
    def analysis_status(identifier: str):
        return analysis_jobs.status(identifier)

    @app.get("/api/analysis/jobs/{identifier}/result")
    def analysis_result(identifier: str):
        return analysis_jobs.result(identifier)

    @app.post("/api/analysis/jobs/{identifier}/cancel")
    def cancel_analysis(identifier: str):
        return analysis_jobs.cancel(identifier)

    @app.post("/api/events")
    def events(selection: EventRequest):
        validate_time_window(selection)
        return event_analysis(
            repository,
            repository.get(selection.experiment_id),
            selection.tags,
            selection.model_dump(),
        )

    @app.post("/api/periodicity")
    def periodicity(selection: PeriodicityRequest):
        validate_time_window(selection)
        return periodicity_analysis(
            repository,
            repository.get(selection.experiment_id),
            selection.tags,
            selection.model_dump(),
        )

    @app.get("/api/export/workspace.json")
    def export_workspace():
        return JSONResponse(
            {"logdir": str(repository.root), **store.read()},
            headers={"Content-Disposition": 'attachment; filename="expman-workspace.json"'},
        )

    @app.get("/assets/plotly.min.js")
    def plotly_asset():
        import plotly

        path = Path(plotly.__file__).parent / "package_data" / "plotly.min.js"
        return FileResponse(
            path,
            media_type="application/javascript",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @app.get("/")
    def index():
        if not (static / "index.html").is_file():
            raise HTTPException(503, "Frontend assets are not available")
        return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/design", include_in_schema=False)
    def design():
        path = Path(__file__).parent / "design.html"
        if not path.exists():
            path = Path(__file__).parents[2] / "docs" / "design.html"
        if not path.exists():
            raise HTTPException(404, "Design document is not installed")
        return FileResponse(path, media_type="text/html")

    app.mount("/tensorboard", native)
    if static.is_dir():
        app.mount("/static", RevalidatedStaticFiles(directory=static), name="static")
    return app
