"""Serve real event logs and frontend assets for isolated Chromium sessions."""

import json
import re
import socket
import threading
import time
from pathlib import Path

import pytest
import uvicorn
import yaml
from tensorboard.compat.proto import event_pb2, summary_pb2
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from expman.app import create_app
from expman.demo import generate_demo

STRESS_POINTS = 20_050


def build_ui_app(root, scenario="basic", onset_signals=None):
    logdir = root / "logs"
    generate_demo(logdir, count=4)
    if scenario == "missing-condition":
        for run, value in [("exp000", True), ("exp001", None)]:
            path = logdir / run / "config.yaml"
            config = yaml.safe_load(path.read_text())
            config["motion"] = {"reserve_endpoint_frame": value}
            path.write_text(yaml.safe_dump(config))
    if scenario == "onsets":
        observations = {}
        for tag, points in onset_signals.items():
            for step, value, wall_time in points:
                observations.setdefault(int(step), [wall_time, []])[1].append(
                    summary_pb2.Summary.Value(tag=tag, simple_value=float(value))
                )
        writer = EventFileWriter(str(logdir / "exp000"))
        try:
            for step, (wall_time, values) in sorted(observations.items()):
                values.extend(
                    summary_pb2.Summary.Value(
                        tag=f"onset/other_{index:02}", simple_value=step * (index + 1) * 0.001
                    )
                    for index in range(12)
                )
                writer.add_event(
                    event_pb2.Event(
                        step=step, wall_time=wall_time, summary=summary_pb2.Summary(value=values)
                    )
                )
        finally:
            writer.close()
    if scenario == "refresh":
        for index in range(9):
            (logdir / f"broken-{index}").symlink_to(root / f"missing-{index}")
    if scenario == "combined-indexing":
        for path in (logdir / "exp000").glob("events.out.tfevents.*"):
            path.unlink()
        EventFileWriter(str(logdir / "exp000")).close()
    if scenario in {"annotations", "json-refresh", "config-display"}:
        (logdir / "exp000" / "evaluation_metrics.json").write_text(
            json.dumps({"metrics": {"score": 0.95}})
        )
    if scenario == "config-display":
        for index in range(4):
            path = logdir / f"exp{index:03}" / "config.yaml"
            config = yaml.safe_load(path.read_text())
            if index < 3:
                config["display"] = {"value": [1, "1", None][index]}
            path.write_text(yaml.safe_dump(config))
    if scenario == "config-search":
        for index in range(4):
            path = logdir / f"exp{index:03}" / "config.yaml"
            config = yaml.safe_load(path.read_text())
            config["env"] = {"config": {"terrain": {"generator": {"seed": [1, 2, 3, 42][index]}}}}
            config["constant"] = {"marker": "identical"}
            config["search_padding"] = {f"field_{field:03}": field + index for field in range(160)}
            path.write_text(yaml.safe_dump(config))
    if scenario in {"stress", "sections"}:
        writer = EventFileWriter(str(logdir / "exp000"))
        try:
            count = STRESS_POINTS if scenario == "stress" else 3
            for step in range(count):
                values = (
                    [summary_pb2.Summary.Value(tag="stress/loss", simple_value=step % 100 / 100)]
                    + (
                        [
                            summary_pb2.Summary.Value(
                                tag="stress/reward", simple_value=1000 + step % 97 * 2
                            )
                        ]
                        if step % 2 == 0
                        else []
                    )
                    if scenario == "stress"
                    else [
                        summary_pb2.Summary.Value(
                            tag=f"UI/panel/{index:02}", simple_value=step + index
                        )
                        for index in range(40)
                    ]
                )
                writer.add_event(
                    event_pb2.Event(
                        step=step,
                        wall_time=1_790_000_000 + step * 10,
                        summary=summary_pb2.Summary(value=values),
                    )
                )
        finally:
            writer.close()
    app = create_app(logdir, root / "state.json", root / "user", tensorboard_loader="fast")
    identifiers = [item.id for item in app.state.repository.scan()]
    if scenario == "combined-indexing":
        gate = threading.Event()
        app.state.ui_metadata_gate = gate
        app.state.metadata_jobs.executor.submit(gate.wait, 30)
    if scenario in {"combined-indexing", "plot-refresh"}:
        start_fast = app.state.tensorboard._start_fast

        def start_with_short_reload(board):
            board.flags.reload_interval = 1
            return start_fast(board)

        app.state.tensorboard._start_fast = start_with_short_reload
    view = {
        "selected": identifiers[:1] if scenario == "stress" else identifiers,
        "panels": ["stress/loss"] if scenario == "stress" else ["train/loss", "eval/reward"],
        "tab": "overview",
        "showAllPanels": scenario == "sections",
        "collapsedPanelGroups": ["UI"] if scenario == "sections" else [],
        "options": {
            "x_axis": "step",
            "smoothing": 0.4,
            "band": "std",
            "alignment": "overlap",
            "group": "",
            "groupKeys": [],
        },
    }
    groups = [
        {"id": "control", "name": "Control / variant: α", "experiment_ids": identifiers[:2]},
        {"id": "other", "name": "Other group", "experiment_ids": identifiers[2:]},
    ]
    if scenario == "combined-indexing":
        view["combinedPlot"] = {
            "experiment": identifiers[0],
            "tags": ["train/loss", "eval/reward"],
            "scale": "standard",
            "smoothing": 0.9,
        }
    if scenario == "refresh":
        view["selectionMode"] = "filters"
    if scenario == "onsets":
        view["time"] = {
            "mode": "onsets",
            "experiment": identifiers[0],
            "reference": "",
            "include": ["onset/*"],
            "exclude": [],
            "start": 400,
            "end": 1000,
            "onset_smoothing": 10,
            "onset_duration": 20,
        }
    if scenario in {"json-refresh", "config-display"}:
        view["configScalars"] = [
            {"id": "evaluation-score", "tag": "JSON/evaluation_metrics/score", "mode": "latest"}
        ]
    if scenario == "config-search":
        view.update(
            selectionMode="filters",
            query="env.config.terrain.generator.seed",
            configOrder=[f"config:search_padding.field_{field:03}" for field in range(160)],
        )
    app.state.store.update(lambda state: state.update(view=view, groups=groups))
    if scenario == "config-search":
        app.state.store.update(
            lambda state: state.update(ignored_configs=["env.config.terrain.generator.seed"])
        )
    return app


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    return {
        **browser_context_args,
        "viewport": {"width": 1600, "height": 1100},
        "service_workers": "block",
    }


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args, browser_name):
    if browser_name == "chromium":
        return {
            **browser_type_launch_args,
            "args": [*browser_type_launch_args.get("args", []), "--enable-unsafe-swiftshader"],
        }
    return browser_type_launch_args


@pytest.fixture
def ui_server(tmp_path, request):
    scenario = request.node.get_closest_marker("ui_scenario")
    name = scenario.args[0] if scenario else "basic"
    signals = request.getfixturevalue("onset_signals") if name == "onsets" else None
    app = build_ui_app(tmp_path, name, signals)
    request.node.expman_ui_app = app
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, loop="asyncio", log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 20
        while not server.started:
            if not thread.is_alive() or time.monotonic() >= deadline:
                pytest.fail("The UI test server did not start")
            time.sleep(0.05)
        yield f"http://127.0.0.1:{port}"
    finally:
        if hasattr(app.state, "ui_metadata_gate"):
            app.state.ui_metadata_gate.set()
        server.should_exit = True
        thread.join(timeout=15)
        listener.close()
        if thread.is_alive():
            server.force_exit = True
            pytest.fail("The UI test server did not stop")


def wait_for_overview(page):
    page.wait_for_function(
        """() => {
          const plot = document.getElementById('curve-0');
          return plot && plot._fullData && plot._fullData.length &&
            !document.getElementById('overview-discovery-progress');
        }""",
        timeout=60_000,
    )


@pytest.fixture
def ui_page(page, ui_server, request):
    errors, application_errors, responses = [], [], []
    page.expose_function("__expmanRecordError", lambda message: application_errors.append(message))
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "console", lambda message: errors.append(message.text) if message.type == "error" else None
    )
    page.on(
        "response",
        lambda response: (
            responses.append({"url": response.url, "status": response.status})
            if response.status >= 400
            else None
        ),
    )
    page.add_init_script(
        """document.addEventListener('DOMContentLoaded', () => {
          const toast = document.getElementById('toast');
          if (!toast) return;
          new MutationObserver(() => {
            if (!toast.hidden && toast.classList.contains('error'))
              window.__expmanRecordError(toast.textContent);
          }).observe(toast, {attributes: true, childList: true, subtree: true});
        });"""
    )
    try:
        page.goto(ui_server)
        if hasattr(request.node.expman_ui_app.state, "ui_metadata_gate"):
            page.wait_for_selector("#combined-chart")
        else:
            wait_for_overview(page)
        yield page
    finally:
        if errors or application_errors or responses:
            directory = Path("test-results") / re.sub(r"[^A-Za-z0-9_-]", "_", request.node.name)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "browser-errors.json").write_text(
                json.dumps(
                    {"javascript": errors, "application": application_errors, "http": responses},
                    indent=2,
                )
            )
            if not page.is_closed():
                page.screenshot(path=str(directory / "browser-errors.png"), full_page=True)
        assert not errors, "Browser JavaScript errors: " + repr(errors)
        assert not application_errors, "Application errors: " + repr(application_errors)
        assert not responses, "Failed HTTP responses: " + repr(responses)
