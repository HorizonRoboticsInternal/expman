"""Temporary native reader retaining all scalar values for explicit full reads."""

import os
import socket
import subprocess
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from types import SimpleNamespace

from tensorboard.data import grpc_provider, server_ingester
from tensorboard.util.grpc_util import ChannelCredsType


class FullScalarReader:
    def __init__(
        self,
        repository=None,
        experiments=None,
        cache_dir=None,
        progress=None,
        *,
        logdir=None,
        reload_interval=0,
        samples_per_plugin=None,
        wait_complete=True,
    ):
        self.repository = repository
        self.experiments = experiments
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.logdir = logdir
        self.reload_interval = reload_interval
        self.samples_per_plugin = (
            {"scalars": 0} if samples_per_plugin is None else samples_per_plugin
        )
        self.wait_complete = wait_complete
        self.progress = progress
        self.process = None
        self.temporary = None
        self.worker = None
        self.complete = threading.Event()
        self.messages = deque(maxlen=20)
        self.ingester = None
        self.backend = "fast"

    def report(self, percent, stage):
        if self.progress:
            self.progress(percent, stage)

    def __enter__(self):
        try:
            with socket.socket():
                pass
            if self.cache_dir:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.temporary = tempfile.TemporaryDirectory(prefix="full-scalars-", dir=self.cache_dir)
            root = Path(self.temporary.name)
            logs = Path(self.logdir) if self.logdir else root / "logs"
            if not self.logdir:
                logs.mkdir()
                for experiment in self.experiments:
                    for directory in experiment.run_dirs:
                        destination = logs / directory.relative_to(self.repository.root)
                        destination.mkdir(parents=True, exist_ok=True)
                        for event_file in directory.glob("events.out.tfevents.*"):
                            (destination / event_file.name).symlink_to(event_file.resolve())
            self.report(0, "Starting fast reader with all scalar observations")
            environment = dict(os.environ)
            environment["RUST_LOG"] = "info"
            self.process = subprocess.Popen(
                [
                    str(server_ingester.get_server_binary().path),
                    "--logdir=" + str(logs),
                    "--reload="
                    + (str(int(self.reload_interval)) if self.reload_interval else "once"),
                    "--samples-per-plugin="
                    + ",".join(
                        f"{key}={'all' if value == 0 else value}"
                        for key, value in self.samples_per_plugin.items()
                    ),
                    "--verbose",
                    "--port=0",
                    "--port-file=" + str(root / "port"),
                    "--error-file=" + str(root / "error"),
                    "--die-after-stdin",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                env=environment,
            )

            def observe():
                for line in self.process.stderr:
                    self.messages.append(line.strip())
                    if "Finished load cycle" in line:
                        self.complete.set()

            self.worker = threading.Thread(target=observe, daemon=True, name="Expman-full-reader")
            self.worker.start()
            deadline = time.monotonic() + 15
            while not (root / "port").exists() or not (root / "port").read_text().endswith("\n"):
                self._check()
                if time.monotonic() >= deadline:
                    raise RuntimeError("Fast reader did not report its startup port")
                self.report(0, "Starting fast reader")
                time.sleep(0.05)
            address = "localhost:" + (root / "port").read_text().strip()
            stub = server_ingester._make_stub(address, ChannelCredsType.LOCAL)
            self.ingester = SimpleNamespace(
                data_provider=grpc_provider.GrpcDataProvider(address, stub)
            )
            if self.wait_complete:
                self.wait_for_complete()
            return self
        except BaseException:
            self.close()
            raise

    def _check(self):
        if self.process.poll() is not None:
            raise RuntimeError("Fast scalar reader failed: " + "\n".join(self.messages))

    def initialize(self):
        return None

    @property
    def data_provider(self):
        return self.ingester.data_provider

    def wait_for_complete(self, progress=None):
        while not self.complete.wait(0.2):
            self._check()
            if progress:
                progress(0, "Fast reader is indexing event files")
            self.report(0, "Fast reader is loading every scalar observation")
        self._check()
        self.report(60, "All observations indexed; preparing requested values")

    def close(self):
        if self.process is not None:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            if self.worker:
                self.worker.join(timeout=1)
            if self.process.stderr:
                self.process.stderr.close()
            self.process = None
        if self.temporary:
            self.temporary.cleanup()
            self.temporary = None

    def __exit__(self, *arguments):
        self.close()
