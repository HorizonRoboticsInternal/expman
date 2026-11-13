import asyncio
import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from expman.app import create_app
from expman.demo import generate_demo


def pytest_addoption(parser):
    parser.addoption("--ui", action="store_true", help="Run the real-browser UI suite")


def pytest_configure(config):
    if config.getoption("--ui") and importlib.util.find_spec("pytest_playwright") is None:
        raise pytest.UsageError(
            "Browser tests require the pinned UI dependencies. Run: "
            "uv run --with-requirements tests/ui/requirements.txt pytest tests/ui --ui"
        )


def pytest_collection_modifyitems(config, items):
    if not config.getoption("--ui"):
        disabled = pytest.mark.skip(reason="Real-browser tests require an explicit --ui run")
        for item in items:
            if item.get_closest_marker("ui"):
                item.add_marker(disabled)


def test_event_loop():
    """Poll callbacks where sandbox policy blocks socketpair wakeup notifications."""
    loop = asyncio.new_event_loop()

    def poll_callbacks():
        loop.call_later(0.01, poll_callbacks)

    loop.call_soon(poll_callbacks)
    return loop


@pytest.fixture(scope="session")
def example_logs(tmp_path_factory):
    root = tmp_path_factory.mktemp("fixtures") / "logs"
    generate_demo(root, count=6)
    return root


@pytest.fixture
def client_factory():
    return lambda application: TestClient(
        application, backend_options={"loop_factory": test_event_loop}
    )


@pytest.fixture(autouse=True)
def isolate_user_data(tmp_path, monkeypatch):
    monkeypatch.setenv("EXPMAN_HOME", str(tmp_path / "user-data"))


@pytest.fixture
def client(example_logs: Path, tmp_path, client_factory):
    with client_factory(
        create_app(example_logs, tmp_path / "state.json", tensorboard_loader="python")
    ) as application:
        yield application
