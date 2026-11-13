# Repository Guidelines

## Project Structure & Module Organization

This workspace currently has no application source, dependency manifest, tests, or assets. The following layout is suggested for future development; create directories only when needed:

- `src/`: application code, grouped by feature or responsibility.
- `tests/`: automated tests mirroring the source layout.
- `docs/`: architecture notes and contributor documentation.
- `assets/`: static resources required by the application.

Keep root-level files focused on project configuration and documentation. Document the actual structure as implementation begins.

## Build, Test, and Development Commands

No build system, package manager, or development commands are configured yet. When introducing tooling, record exact installation, local execution, build, lint, and test commands in `README.md` and update this guide. Commands should run from the repository root and use declared dependencies.

For this document, `wc -w AGENTS.md` checks its length. There is currently no application build or test suite to run.

## Coding Style & Naming Conventions

No language-specific style or formatter is established. Follow the selected language's standard conventions, use consistent indentation within each file, and avoid mixing tabs and spaces. Choose descriptive module, function, and variable names. Introduce formatter and linter configuration alongside the first implementation, and keep unrelated formatting changes out of functional patches.

## Testing Guidelines

No testing framework or coverage threshold is configured. Add automated tests with the first executable functionality. Follow the selected framework's discovery conventions, mirror source organization, and cover expected behavior, boundary conditions, and failure paths. Keep tests deterministic and document required fixtures or services.

## Commit & Pull Request Guidelines

Git history is unavailable in this workspace, so existing commit conventions cannot be verified. Until conventions are established, use concise imperative subjects, such as `Add configuration loader`, and keep commits focused.

Pull requests should explain the problem, summarize the change, link relevant issues, and report validation results or why checks were unavailable. Include screenshots when changing a user interface.

## Security & Configuration

Keep credentials, tokens, and private configuration out of commits. Use placeholder values in examples and document required environment variables when introducing configuration.
