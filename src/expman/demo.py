"""Deterministic event files for development, screenshots, and acceptance tests."""

import base64
import io
import math
import wave
from pathlib import Path

import numpy as np
import yaml
from tensorboard.compat.proto import event_pb2, graph_pb2, summary_pb2, tensor_pb2, tensor_shape_pb2
from tensorboard.summary.writer.event_file_writer import EventFileWriter


def generate_demo(root: Path, count=9):
    root = Path(root)
    if root.exists() and any(root.iterdir()):
        raise ValueError(f"Refusing to overwrite nonempty demo directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        family, seed = index // 3, index % 3
        directory = root / f"exp{index:03d}"
        directory.mkdir()
        config = {
            "model": {
                "architecture": ["transformer", "moe", "recurrent"][family % 3],
                "hidden_size": 256 * (family + 1),
            },
            "optimizer": {
                "learning_rate": [0.0001, 0.0003, 0.001][family % 3],
                "weight_decay": 0.01,
            },
            "batch_size": 64 * (family + 1),
            "seed": seed,
            "timestamp": f"2026-11-{index + 1:02d}",
            "steps": 400,
        }
        (directory / "config.yaml").write_text(yaml.safe_dump(config))
        (directory / "embeddings.tsv").write_text("0\t0\n1\t0\n0\t1\n")
        (directory / "metadata.tsv").write_text("origin\nfirst\nsecond\n")
        (directory / "projector_config.pbtxt").write_text(
            'embeddings { tensor_name: "demo_embedding" '
            'tensor_path: "embeddings.tsv" metadata_path: "metadata.tsv" }\n'
        )
        writer = EventFileWriter(str(directory))
        graph = graph_pb2.GraphDef()
        input_node = graph.node.add(name="input", op="Placeholder")
        input_node.attr["dtype"].type = 1
        output_node = graph.node.add(name="output", op="Identity", input=["input"])
        output_node.attr["T"].type = 1
        writer.add_event(
            event_pb2.Event(
                wall_time=1_790_000_000 + index * 10000, graph_def=graph.SerializeToString()
            )
        )
        generator = np.random.default_rng(seed + family * 31)
        for step in range(400):
            pulse = sum(3 * math.exp(-(((step - center) / 1.5) ** 2)) for center in (90, 190, 290))
            loss_pulse = sum(
                1.4 * math.exp(-(((step - center - 4) / 1.5) ** 2)) for center in (90, 190, 290)
            )
            loss = (
                2.8 * math.exp(-step / (100 + family * 25))
                + 0.12
                + loss_pulse
                + generator.normal(0, 0.015)
            )
            reward = (1 - math.exp(-step / 100)) * (60 + family * 12) + generator.normal(0, 0.5)
            grad = (
                0.7 + 0.08 * math.sin(2 * math.pi * step / 40) + pulse + generator.normal(0, 0.008)
            )
            metrics = {
                "train/loss": loss,
                "eval/reward": reward,
                "train/grad_norm": grad,
                "train/learning_rate": config["optimizer"]["learning_rate"],
                "system/gpu_utilization": 70 + 9 * math.sin(2 * math.pi * (step - 5) / 40),
            }
            values = [
                summary_pb2.Summary.Value(tag=tag, simple_value=value)
                for tag, value in metrics.items()
            ]
            writer.add_event(
                event_pb2.Event(
                    step=step,
                    wall_time=1_790_000_000 + index * 10000 + step * 2,
                    summary=summary_pb2.Summary(value=values),
                )
            )
        histogram = summary_pb2.HistogramProto(
            min=-1,
            max=1,
            num=28,
            sum=2,
            sum_squares=9,
            bucket_limit=[-0.5, 0, 0.5, 1],
            bucket=[3, 10, 10, 5],
        )
        image = summary_pb2.Summary.Image(
            height=1,
            width=1,
            colorspace=4,
            encoded_image_string=base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNwy3jxHwAFJAKWfZqVUQAAAABJRU5ErkJggg=="
            ),
        )
        audio_bytes = io.BytesIO()
        with wave.open(audio_bytes, "wb") as audio_file:
            audio_file.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            samples = (np.sin(2 * np.pi * 440 * np.arange(800) / 8000) * 12000).astype("<i2")
            audio_file.writeframes(samples.tobytes())
        audio = summary_pb2.Summary.Audio(
            sample_rate=8000,
            num_channels=1,
            length_frames=800,
            encoded_audio_string=audio_bytes.getvalue(),
            content_type="audio/wav",
        )
        text = tensor_pb2.TensorProto(
            dtype=7,
            string_val=[b"Reproducible Expman example run"],
            tensor_shape=tensor_shape_pb2.TensorShapeProto(
                dim=[tensor_shape_pb2.TensorShapeProto.Dim(size=1)]
            ),
        )
        writer.add_event(
            event_pb2.Event(
                step=399,
                wall_time=1_790_000_798 + index * 10000,
                summary=summary_pb2.Summary(
                    value=[
                        summary_pb2.Summary.Value(tag="weights", histo=histogram),
                        summary_pb2.Summary.Value(tag="samples", image=image),
                        summary_pb2.Summary.Value(tag="tone", audio=audio),
                        summary_pb2.Summary.Value(
                            tag="notes/text_summary",
                            tensor=text,
                            metadata=summary_pb2.SummaryMetadata(
                                plugin_data=summary_pb2.SummaryMetadata.PluginData(
                                    plugin_name="text"
                                )
                            ),
                        ),
                    ]
                ),
            )
        )
        writer.close()
