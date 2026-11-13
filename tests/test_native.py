import copy
import io
import socket
import time
from types import SimpleNamespace

import pytest
from tensorboard.backend.event_processing.data_ingester import LocalDataIngester
from tensorboard.data import server_ingester

from expman.app import create_app
from expman.native import NativeTensorBoard


def wait_for_status(client, condition):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = client.get("/api/tensorboard/status").json()
        if condition(status):
            return status
        time.sleep(0.01)
    raise AssertionError(f"TensorBoard did not reach expected status: {status}")


def test_fast_reader_uses_data_provider_for_real_tensorboard_plugins(
    example_logs, tmp_path, client_factory, monkeypatch
):
    handle = io.BytesIO()
    calls = []

    def start_fast(native, board):
        flags = copy.copy(board.flags)
        calls.append(flags.reload_interval)
        flags.reload_task, flags.reload_interval = "blocking", 0
        local = LocalDataIngester(flags)
        local.start()
        return SimpleNamespace(data_provider=local.data_provider, _stdin_handle=handle)

    monkeypatch.setattr(NativeTensorBoard, "_start_fast", start_fast)
    application = create_app(example_logs, tmp_path / "state.json")
    with client_factory(application) as client:
        assert client.get("/tensorboard/").status_code == 200
        status = wait_for_status(client, lambda item: item["ready"])
        assert status["backend"] == "fast"
        assert status["phase"] == "streaming"
        assert status["initial_index_complete"] is None
        assert status["streams_discovered"] is None
        assert status["streams_with_data"] == 6
        assert status["fallback_reason"] is None
        for plugin in ["scalars", "images", "audio", "text", "histograms"]:
            response = client.get(f"/tensorboard/data/plugin/{plugin}/tags")
            assert response.status_code == 200, response.text
            assert response.json()
        graphs = client.get("/tensorboard/data/plugin/graphs/info").json()
        assert graphs["exp000"]["run_graph"]
        projector = client.get("/tensorboard/data/plugin/projector/info", params={"run": "exp000"})
        assert projector.status_code == 200
        assert projector.json()["embeddings"][0]["tensorName"] == "demo_embedding"
    assert handle.closed
    assert calls == [15]


@pytest.mark.parametrize(
    "error",
    [PermissionError("sockets denied"), server_ingester.DataServerStartupError("reader failed")],
)
def test_auto_reader_falls_back_to_python_with_reason(
    example_logs, tmp_path, client_factory, monkeypatch, error
):
    def unavailable(native, board):
        raise error

    monkeypatch.setattr(NativeTensorBoard, "_start_fast", unavailable)
    with client_factory(
        create_app(example_logs, tmp_path / "auto.json", tensorboard_loader="auto")
    ) as client:
        assert client.get("/tensorboard/").status_code == 200
        status = wait_for_status(client, lambda item: item["ready"])
        assert status["backend"] == "python"
        assert status["requested_loader"] == "auto"
        assert status["initial_index_complete"] is True
        assert str(error) == status["fallback_reason"]
        assert not status["error"]
        assert client.get("/tensorboard/data/plugin/scalars/tags").json()


def test_explicit_python_reader_skips_fast_startup(
    example_logs, tmp_path, client_factory, monkeypatch
):
    def unexpected(native, board):
        raise AssertionError("Explicit Python mode must not start the fast data server")

    monkeypatch.setattr(NativeTensorBoard, "_start_fast", unexpected)
    application = create_app(example_logs, tmp_path / "state.json", tensorboard_loader="python")
    with client_factory(application) as client:
        assert client.get("/tensorboard/").status_code == 200
        status = wait_for_status(client, lambda item: item["ready"])
        assert status["backend"] == "python"
        assert status["fallback_reason"] is None


def test_explicit_fast_reader_reports_startup_failure(
    example_logs, tmp_path, client_factory, monkeypatch
):
    def unavailable(native, board):
        raise server_ingester.DataServerStartupError("native reader unavailable")

    monkeypatch.setattr(NativeTensorBoard, "_start_fast", unavailable)
    application = create_app(example_logs, tmp_path / "state.json", tensorboard_loader="fast")
    with client_factory(application) as client:
        response = client.get("/tensorboard/")
        assert response.status_code == 400
        assert "fast loader is unavailable" in response.json()["detail"]
        status = client.get("/api/tensorboard/status").json()
        assert status["phase"] == "error"
        assert not status["ready"]
        assert status["backend"] is None
        assert "native reader unavailable" in status["error"]


def test_failed_fast_start_closes_child_stdin(tmp_path, monkeypatch):
    handle = io.BytesIO()

    class SocketProbe:
        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            return False

    class FailedProcess:
        stdin = handle
        stderr = io.StringIO("reader exited\n")

        def poll(self):
            return 1

        def wait(self, timeout=None):
            return 1

    monkeypatch.setattr("expman.fast_reader.socket", SimpleNamespace(socket=SocketProbe))
    monkeypatch.setattr(
        server_ingester, "get_server_binary", lambda: SimpleNamespace(path="unused")
    )
    monkeypatch.setattr(
        "expman.fast_reader.subprocess.Popen", lambda *args, **kwargs: FailedProcess()
    )
    flags = SimpleNamespace(
        logdir=str(tmp_path),
        reload_interval=15,
        grpc_creds_type="insecure",
        samples_per_plugin={},
        extra_data_server_flags="",
    )
    with pytest.raises(RuntimeError, match="Fast scalar reader failed"):
        NativeTensorBoard(tmp_path)._start_fast(SimpleNamespace(flags=flags))
    assert handle.closed


def test_actual_fast_reader_when_sockets_and_binary_are_available(
    example_logs, tmp_path, client_factory
):
    try:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
        server_ingester.get_server_binary()
    except (OSError, server_ingester.NoDataServerError) as error:
        pytest.skip(
            f"Native data-server integration requires listening sockets and its binary: {error}"
        )
    application = create_app(example_logs, tmp_path / "state.json", tensorboard_loader="fast")
    with client_factory(application) as client:
        assert client.get("/tensorboard/").status_code == 200
        status = wait_for_status(client, lambda item: item["ready"])
        assert status["backend"] == "fast", status
        deadline = time.monotonic() + 10
        tags = {}
        while time.monotonic() < deadline:
            tags = client.get("/tensorboard/data/plugin/scalars/tags").json()
            if len(tags) == 6:
                break
            time.sleep(0.02)
        assert len(tags) == 6
        response = client.get(
            "/tensorboard/data/plugin/scalars/scalars",
            params={"run": "exp000", "tag": "train/loss"},
        )
        assert response.status_code == 200
        assert len(response.json()) == 400
        for plugin in ["images", "audio", "text", "histograms"]:
            response = client.get(f"/tensorboard/data/plugin/{plugin}/tags")
            assert response.status_code == 200 and response.json()
        graphs = client.get("/tensorboard/data/plugin/graphs/info").json()
        assert graphs["exp000"]["run_graph"]
        projector = client.get("/tensorboard/data/plugin/projector/info", params={"run": "exp000"})
        assert projector.status_code == 200
        identifiers = [
            item["id"] for item in client.get("/api/experiments").json()["experiments"][:1]
        ]
        started = client.post(
            "/api/curves/all/jobs", json={"experiment_ids": identifiers, "tags": ["train/loss"]}
        )
        assert started.status_code == 202, started.text
        identifier = started.json()["id"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = client.get("/api/curves/all/jobs/" + identifier).json()
            if status["status"] in {"complete", "error"}:
                break
            time.sleep(0.02)
        assert status["status"] == "complete", status
        result = client.get("/api/curves/all/jobs/" + identifier + "/result").json()
        assert len(result["curves"]["train/loss"][0]["x"]) == 400
        assert not result["curves"]["train/loss"][0]["sampled"]
