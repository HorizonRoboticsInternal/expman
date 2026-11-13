import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np
import pytest
from tensorboard.compat.proto import event_pb2, summary_pb2, tensor_pb2
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from expman.analytics import aggregate, analyze, curve_payload, outcome, series
from expman.configs import active_config, compare, excluded_file, flatten, load_configs
from expman.experiments import Experiment, ExperimentRepository
from expman.store import StateStore


@pytest.mark.parametrize("axis", ["step", "relative", "wall"])
@pytest.mark.parametrize("smoothing", [0, 0.9])
def test_curve_tooltip_values_match_timestamps_and_group_contributors(tmp_path, axis, smoothing):
    experiments = [Experiment(str(index), tmp_path / str(index), str(index)) for index in range(2)]
    observations = {
        "0": {"loss": [[0, 1, 1000], [2, 3, 1020], [4, 5, 1080]]},
        "1": {"loss": [[0, 3, 2000], [1, 4, 2005], [4, 9, 2080]]},
    }
    source = SimpleNamespace(
        load=lambda item: observations[item.id],
        run_origin=lambda item: {"0": 990, "1": 1980}[item.id],
    )
    state = {"ignored_configs": [], "ignored_files": [], "experiments": {}, "groups": []}
    settings = {"x_axis": axis, "smoothing": smoothing, "alignment": "union"}
    curves = curve_payload(source, experiments, ["loss"], state, settings)["loss"]
    assert curves[0]["elapsed"] == [10, 30, 90]
    assert curves[1]["elapsed"] == [20, 25, 100]
    assert curves[0]["original_y"] == [1, 3, 5]
    assert curves[1]["original_y"] == [3, 4, 9]
    np.testing.assert_allclose(
        curves[0]["y"], [1, 3.9 / 1.9, 8.51 / 2.71] if smoothing else [1, 3, 5]
    )
    assert all(item["elapsed_kind"] == "individual" for item in curves)
    group = curve_payload(
        source, experiments, ["loss"], state, {**settings, "combine_selected": True}
    )["loss"][0]
    assert len(group["elapsed"]) == len(group["x"]) == len(group["y"]) == len(group["original_y"])
    assert group["elapsed_kind"] == "mean"
    if not smoothing:
        np.testing.assert_allclose(group["original_y"], group["y"])
    if axis == "step":
        assert group["x"] == [0, 1, 2, 4]
        assert group["elapsed"] == [15, 22.5, 40, 95]
        assert group["count"] == [2, 2, 2, 2]
        np.testing.assert_allclose(group["original_y"], [2, 3, 13 / 3, 7])
    elif axis == "relative":
        np.testing.assert_allclose(group["elapsed"], group["x"])
        np.testing.assert_allclose(group["original_y"], [1, 2.5, 3.25, 11 / 3, 20 / 3, 9])
    else:
        assert group["elapsed"] == [10, 30, 90, 20, 25, 100]
        assert group["count"] == [1] * 6
        assert group["original_y"] == [1, 3, 5, 3, 4, 9]
        empty = curve_payload(
            source,
            experiments,
            ["loss"],
            state,
            {**settings, "combine_selected": True, "alignment": "overlap"},
        )["loss"][0]
        assert empty["original_y"] == empty["x"] == []


def test_elapsed_uses_latest_duplicate_step_and_follows_downsampling(tmp_path):
    experiment = Experiment("run", tmp_path, "run")
    points = [[0, 1, 1000], [0, 2, 1003]] + [
        [index, index**2, 1000 + index * 10] for index in range(1, 20)
    ]
    source = SimpleNamespace(load=lambda item: {"loss": points}, run_origin=lambda item: 1000)
    curve = curve_payload(
        source,
        [experiment],
        ["loss"],
        {"ignored_configs": [], "experiments": {}, "groups": []},
        {"x_axis": "step", "smoothing": 0.8, "max_points": 4},
    )["loss"][0]
    assert len(curve["x"]) <= 4
    assert curve["elapsed"][0] == 3
    assert curve["elapsed"][1:] == [position * 10 for position in curve["x"][1:]]
    assert curve["original_y"] == [2] + [position**2 for position in curve["x"][1:]]


def test_config_file_provenance_typed_diff_and_escaping(tmp_path):
    (tmp_path / "config.yaml").write_text(
        'value: null\nflag: false\nnested:\n  key: 1\n"nested.key": 2\nplaceholder: ${env:VALUE}\n'
    )
    (tmp_path / "extra.yaml").write_text("value: 5\n")
    flat, files, warnings = load_configs(tmp_path)
    assert flat["value"] is None
    assert flat["nested.key"] == 1
    assert flat[r"nested\.key"] == 2
    assert flat["@extra.yaml::value"] == 5
    assert flat["placeholder"] == "${env:VALUE}"
    assert not warnings
    assert files[0]["primary"]
    experiments = [
        SimpleNamespace(config=flat, config_files=files),
        SimpleNamespace(config={"value": False}, config_files=[]),
    ]
    rows = compare(experiments, [])
    assert next(row for row in rows if row["key"] == "value")["different"]
    assert not compare(experiments, ["*"], show_ignored=False)
    assert all(row["ignored"] for row in compare(experiments, ["*"], show_ignored=True))
    assert not any(
        row["key"].startswith("@extra.yaml")
        for row in compare(experiments, [], file_patterns=["extra.yaml"])
    )
    assert flatten({"a": {}}) == {"a": {}}


def test_unsafe_yaml_is_reported_and_source_retained(tmp_path):
    (tmp_path / "config.yaml").write_text("danger: !!python/object/apply:os.system ['exit 1']")
    config, files, warnings = load_configs(tmp_path)
    assert not config
    assert warnings and "!!python" in files[0]["content"]


@pytest.mark.parametrize("pattern", ["hparams.yml", "hparams.*", "*.yml", "*/hparams.yml"])
def test_nested_yaml_filename_exclusions(tmp_path, pattern):
    experiments = []
    for index in range(2):
        directory = tmp_path / f"run{index}"
        timestamp = directory / str(1793333112 + index)
        timestamp.mkdir(parents=True)
        (directory / "config.yaml").write_text(f"learning_rate: {index + 1}\n")
        (timestamp / "hparams.yml").write_text(f"seed: {index}\n")
        config, files, warnings = load_configs(directory)
        assert not warnings
        experiments.append(SimpleNamespace(config=config, config_files=files))
    assert any("hparams.yml::" in row["key"] for row in compare(experiments, []))
    rows = compare(experiments, [], file_patterns=[pattern])
    assert [row["key"] for row in rows] == ["learning_rate"]
    for experiment in experiments:
        assert set(active_config(experiment, [], [pattern])) == {"learning_rate"}
    shown = compare(experiments, [], show_ignored=True, file_patterns=[pattern])
    assert all(row["ignored"] for row in shown if "hparams.yml::" in row["key"])


def test_yaml_path_exclusions_remain_path_specific():
    files = [{"name": "config.yaml"}]
    first = "@first/hparams.yml::seed"
    second = "@second/hparams.yml::seed"
    assert excluded_file(first, files, ["first/hparams.yml"])
    assert not excluded_file(second, files, ["first/hparams.yml"])
    assert not excluded_file("@first/other-hparams.yml::seed", files, ["hparams.yml"])
    assert excluded_file("learning_rate", files, ["config.yaml"])


def test_group_alignment_band_and_no_extrapolation():
    first = (np.array([0, 2, 4]), np.array([0, 2, 4]))
    second = (np.array([1, 3]), np.array([4, 8]))
    combined = aggregate([first, second])
    assert combined["x"] == [1, 2, 3]
    assert combined["y"] == [2.5, 4, 5.5]
    assert combined["count"] == [2, 2, 2]
    union = aggregate([first, second], alignment="union")
    assert union["y"][0] == 0 and union["y"][-1] == 4
    assert union["count"] == [1, 2, 2, 2, 1]
    sem = aggregate([first, second], band="sem")
    assert sem["upper"][0] - sem["y"][0] == pytest.approx(1.5)
    assert aggregate([first], band="sem")["lower"] == [None, None, None]
    assert aggregate([first, (np.array([8, 9]), np.array([1, 2]))])["x"] == []


def test_smoothing_fixed_outcomes_and_spike_preserving_sampling():
    points = [[0, 2, 100], [2, 6, 102], [4, 4, 104]]
    np.testing.assert_allclose(series(points, smoothing=0.5)[1], [2, 14 / 3, 30 / 7])
    assert outcome(points, "at_step", at_step=1) == 4
    assert outcome(points, "at_step", at_step=9) is None
    assert outcome(points, "mean", start_step=2) == 5
    assert outcome(points, "best", "min") == 2
    assert outcome(points, "last_smoothed", smoothing=0.5) == pytest.approx(30 / 7)
    assert outcome(points, "smoothed_at_step", at_step=1, smoothing=0.5) == pytest.approx(10 / 3)
    assert outcome(points, "smoothed_at_step", at_step=9, smoothing=0.5) is None
    assert outcome(points, "last_smoothed", start_step=2, smoothing=0.5) == pytest.approx(30 / 7)
    values = np.zeros(10000)
    values[5555] = 100
    sampled = aggregate([(np.arange(10000), values)], max_points=40)
    assert max(sampled["y"]) == 100
    assert len(sampled["x"]) <= 40 and sampled["sampled"]


def test_numeric_and_categorical_associations():
    experiments = [
        SimpleNamespace(
            id=str(index),
            path=SimpleNamespace(name=str(index)),
            config={"condition": index, "category": index > 2},
            config_files=[],
        )
        for index in range(6)
    ]
    repository = SimpleNamespace(load=lambda item: {"score": [[0, int(item.id) * -2, 0]]})
    result = analyze(repository, experiments, "score", [])
    numeric = next(item for item in result["associations"] if item["key"] == "condition")
    assert numeric["spearman"] == pytest.approx(-1)
    assert any(item["kind"] == "categorical" for item in result["associations"])
    assert not analyze(repository, experiments, "score", ["*"])["associations"]


def test_numeric_ranks_preserve_ties_and_original_order():
    from expman.analytics import ranks

    np.testing.assert_array_equal(ranks([4, 1, 1, 3, 4]), [3.5, 0.5, 0.5, 2, 3.5])
    np.testing.assert_array_equal(ranks([0, 0, 0]), [1, 1, 1])
    np.testing.assert_array_equal(ranks([-1, -3, -2]), [2, 0, 1])
    assert ranks([]).size == 0
    values = np.arange(10000)[::-1]
    np.testing.assert_array_equal(ranks(values), values)


def test_state_roundtrip_atomic_failure_and_concurrency(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    store = StateStore(path, "first")
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(
            executor.map(
                lambda index: store.update(
                    lambda state: state["ignored_configs"].append(str(index))
                ),
                range(16),
            )
        )
    assert len(StateStore(path, "first").read()["ignored_configs"]) == 16
    other = StateStore(path, "second")
    assert not other.read()["ignored_configs"]
    other.update(lambda state: state["ignored_configs"].append("seed"))
    assert len(StateStore(path, "first").read()["ignored_configs"]) == 16
    assert StateStore(path, "second").read()["ignored_configs"] == ["seed"]
    previous = path.read_text()
    monkeypatch.setattr(
        "expman.store.os.replace", lambda *arguments: (_ for _ in ()).throw(OSError("failed write"))
    )
    with pytest.raises(OSError):
        other.update(lambda state: state.update(ignored_configs=[]))
    assert path.read_text() == previous
    assert other.read()["ignored_configs"] == ["seed"]
    assert json.loads(previous)["version"] == 1


def test_workspace_ids_aliases_and_bounded_cache(example_logs, tmp_path):
    alias = tmp_path / "linked"
    alias.symlink_to(example_logs, target_is_directory=True)
    original = ExperimentRepository(example_logs)
    linked = ExperimentRepository(alias)
    assert original.workspace_id == linked.workspace_id
    experiments = original.scan()
    assert len(experiments) == 6
    original.max_cached_points = 1
    original.load(experiments[0])
    original.load(experiments[1])
    assert len(original.cache) == 1
    assert not experiments[0].metrics
    assert experiments[0].summaries


def test_tensor_scalars_growth_and_stream_namespaces(tmp_path):
    experiment = tmp_path / "run"
    experiment.mkdir()
    (experiment / "config.yaml").write_text("seed: 1")
    writer = EventFileWriter(str(experiment / "validation"))

    def write(step, value):
        writer.add_event(
            event_pb2.Event(
                step=step,
                wall_time=100 + step,
                summary=summary_pb2.Summary(
                    value=[
                        summary_pb2.Summary.Value(
                            tag="score",
                            tensor=tensor_pb2.TensorProto(dtype=1, float_val=[value]),
                            metadata=summary_pb2.SummaryMetadata(
                                plugin_data=summary_pb2.SummaryMetadata.PluginData(
                                    plugin_name="scalars"
                                )
                            ),
                        )
                    ]
                ),
            )
        )
        writer.flush()

    write(0, 2)
    repository = ExperimentRepository(tmp_path)
    discovered = repository.scan()
    assert len(discovered) == 1
    assert discovered[0].relative_path == "run"
    first = repository.load(discovered[0])["validation/score"]
    assert first[:, 1].tolist() == [2]
    write(1, 4)
    assert repository.load(discovered[0])["validation/score"][:, 1].tolist() == [2, 4]
    writer.close()
    (tmp_path / "aaa-alias").symlink_to(experiment, target_is_directory=True)
    (experiment / "cycle").symlink_to(tmp_path, target_is_directory=True)
    assert len(repository.scan()) == 1
