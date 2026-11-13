"""The uv-run and installed expman command."""

import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description="Explore TensorBoard experiments and YAML configurations"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="Start the local experiment workbench")
    serve.add_argument(
        "--logdir", type=Path, required=True, help="Root containing experiment directories"
    )
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--state-file", type=Path, help="Override <logdir>/.expman/state.json")
    serve.add_argument("--user-data-dir", type=Path, help="Override ~/.expman (or EXPMAN_HOME)")
    serve.add_argument(
        "--tensorboard-loader",
        choices=["auto", "fast", "python"],
        default="fast",
        help="Native TensorBoard reader (auto prefers the fast data server)",
    )
    demo = subparsers.add_parser(
        "demo", help="Generate reproducible example TensorBoard logs and YAML configs"
    )
    demo.add_argument("--logdir", type=Path, default=Path("experiments/demo"))
    arguments = parser.parse_args()
    if arguments.command == "demo":
        from expman.demo import generate_demo

        generate_demo(arguments.logdir)
        print(f"Demo logs: {arguments.logdir.absolute()}")
        print(f"Start with: uv run expman serve --logdir {arguments.logdir}")
        return
    import uvicorn

    from expman.app import create_app

    try:
        app = create_app(
            arguments.logdir,
            arguments.state_file,
            arguments.user_data_dir,
            arguments.tensorboard_loader,
        )
    except (ValueError, OSError) as error:
        parser.exit(2, f"expman: {error}\n")
    print(
        f"\n  Expman · http://{arguments.host}:{arguments.port}\n"
        f"  Logs: {arguments.logdir.absolute()}\n"
        f"  Workspace data: {app.state.store.path}\n"
        f"  User settings: {app.state.settings_store.path}\n"
    )
    uvicorn.run(app, host=arguments.host, port=arguments.port)


if __name__ == "__main__":
    main()
