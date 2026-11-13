"""Expose the real TensorBoard UI and all installed TensorBoard plugins."""

import copy
import logging
import threading
import time

from starlette.middleware.wsgi import WSGIMiddleware

from expman.fast_reader import FullScalarReader


class NativeTensorBoard:
    def __init__(self, logdir, loader="fast"):
        if loader not in {"auto", "fast", "python"}:
            raise ValueError("TensorBoard loader must be auto, fast, or python")
        self.logdir = logdir
        self.loader = loader
        self.lock = threading.Lock()
        self.application = None
        self.ingester = None
        self.stop_event = threading.Event()
        self.worker = None
        self.phase = "idle"
        self.error = None
        self.ready = threading.Event()
        self.state_lock = threading.Lock()
        self.started = None
        self.last_reload = None
        self.backend = None
        self.fallback_reason = None
        self.available_streams = 0

    @staticmethod
    def _release_fast(ingester):
        if isinstance(ingester, FullScalarReader):
            ingester.close()
            return
        handle = getattr(ingester, "_stdin_handle", None)
        if handle is not None:
            handle.close()

    def _start_fast(self, board):
        flags = board.flags
        return FullScalarReader(
            logdir=flags.logdir,
            reload_interval=flags.reload_interval,
            samples_per_plugin=flags.samples_per_plugin,
            wait_complete=False,
        ).__enter__()

    def _monitor_fast(self):
        from tensorboard import context

        while not self.stop_event.is_set():
            try:
                runs = self.ingester.data_provider.list_runs(
                    context.RequestContext(), experiment_id=""
                )
            except Exception as error:
                if self.stop_event.is_set():
                    return
                with self.state_lock:
                    self.phase = "error"
                    self.error = str(error)
            else:
                with self.state_lock:
                    self.available_streams = len(runs)
                    self.phase = "streaming" if runs else "indexing"
                    self.error = None
                    self.last_reload = time.time()
                if runs:
                    self.ready.set()
            if self.stop_event.wait(2):
                break

    def _create(self):
        from tensorboard import program
        from tensorboard.backend import application
        from tensorboard.backend.event_processing import data_ingester as local_ingester
        from tensorboard.data import server_ingester

        board = program.TensorBoard()
        board.configure(
            argv=[
                "tensorboard",
                "--logdir",
                str(self.logdir),
                "--path_prefix",
                "/tensorboard",
                "--load_fast",
                "auto" if self.loader != "python" else "false",
                "--reload_interval",
                "15",
                "--reload_task",
                "thread",
            ]
        )
        if self.loader != "python":
            try:
                self.ingester = self._start_fast(board)
            except (
                OSError,
                server_ingester.NoDataServerError,
                server_ingester.DataServerStartupError,
                RuntimeError,
            ) as error:
                if self.loader == "fast":
                    raise ValueError(f"TensorBoard fast loader is unavailable: {error}") from error
                self.fallback_reason = str(error)
                logging.getLogger(__name__).info("Using TensorBoard Python loader: %s", error)
            else:
                self.backend = "fast"
        if self.ingester is None:
            ingestion_flags = copy.copy(board.flags)
            ingestion_flags.reload_interval = 0
            ingestion_flags.reload_task = "blocking"
            self.ingester = local_ingester.LocalDataIngester(ingestion_flags)
            self.backend = "python"
        board_app = application.TensorBoardWSGIApp(
            board.flags,
            board.plugin_loaders,
            self.ingester.data_provider,
            board.assets_zip_provider,
            self.ingester.deprecated_multiplexer if self.backend == "python" else None,
        )

        def reload():
            while not self.stop_event.is_set():
                with self.state_lock:
                    self.phase = "reloading" if self.ready.is_set() else "indexing"
                    self.error = None
                try:
                    self.ingester.start()
                except Exception as error:
                    logging.getLogger(__name__).exception("TensorBoard indexing failed")
                    with self.state_lock:
                        self.phase = "error"
                        self.error = str(error)
                else:
                    with self.state_lock:
                        self.phase = "ready"
                        self.last_reload = time.time()
                    self.ready.set()
                if self.stop_event.wait(15):
                    break

        self.worker = threading.Thread(
            target=reload if self.backend == "python" else self._monitor_fast,
            name="Expman-TensorBoard",
            daemon=True,
        )
        self.worker.start()

        def prefixed(environment, start_response):
            environment["PATH_INFO"] = "/tensorboard" + environment["PATH_INFO"]
            environment["SCRIPT_NAME"] = ""
            return board_app(environment, start_response)

        return WSGIMiddleware(prefixed)

    def close(self):
        self.stop_event.set()
        if self.backend == "fast":
            self._release_fast(self.ingester)
        if self.worker is not None:
            self.worker.join(timeout=2)

    def status(self):
        with self.state_lock:
            result = {
                "phase": self.phase,
                "ready": self.ready.is_set(),
                "error": self.error,
                "last_reload": self.last_reload,
                "elapsed": time.time() - self.started if self.started else 0,
                "backend": self.backend,
                "requested_loader": self.loader,
                "fallback_reason": self.fallback_reason,
                "initial_index_complete": self.ready.is_set()
                if self.backend == "python"
                else (
                    self.ingester.complete.is_set()
                    if isinstance(self.ingester, FullScalarReader)
                    else None
                ),
            }
        result["streams_with_data"] = 0
        result["streams_discovered"] = 0
        if self.ingester is not None and self.backend == "python":
            runs = self.ingester.deprecated_multiplexer.Runs()
            result["streams_discovered"] = len(runs)
            result["streams_with_data"] = sum(bool(tags.get("tensors")) for tags in runs.values())
        elif self.backend == "fast":
            result["streams_with_data"] = self.available_streams
            result["streams_discovered"] = None
        return result

    def initialize(self):
        with self.lock:
            if self.application is None:
                self.started = time.time()
                self.phase = "starting"
                try:
                    self.application = self._create()
                except Exception as error:
                    if self.backend == "fast":
                        self._release_fast(self.ingester)
                        self.ingester = None
                    with self.state_lock:
                        self.phase = "error"
                        self.error = str(error)
                    raise

    async def __call__(self, scope, receive, send):
        if self.application is None:
            import anyio

            await anyio.to_thread.run_sync(self.initialize)
        await self.application(scope, receive, send)
