# Expman

A local experiment workbench for TensorBoard event logs, YAML/JSON configurations, and JSON summary metrics.

See [the design](docs/design.html) for the architecture, user workflows, data semantics, and acceptance criteria. Open the HTML file in a browser; it includes navigation, a diagram, and print styling.

## Quickstart

Python 3.11 or later and [uv](https://docs.astral.sh/uv/) are required. Dependencies and the frontend are packaged together; no Node build or external chart CDN is needed.

```bash
uv sync --locked
uv run expman demo --logdir experiments/demo
uv run expman serve --logdir experiments/demo
```

Open `http://127.0.0.1:8000`. To inspect your own experiments, use `uv run expman serve --logdir /path/to/logs`. The example includes YAML configurations, scalar curves, delayed spikes, a known periodic signal, images, histograms, text, audio, a graph, and embeddings. Generation refuses to overwrite a nonempty directory.

Use `--host 0.0.0.0` to listen on all interfaces and open `http://<host-ip>:8000`. The default host is `127.0.0.1`. The app has no authentication; use a trusted network or authenticated proxy for shared access. `--port` changes the port. Workspace data defaults to `<logdir>/.expman/state.json`; `--state-file` overrides it. User-wide settings default to `~/.expman/settings.json`; `--user-data-dir` or `EXPMAN_HOME` overrides that directory.

TensorBoard and Overview default to `--tensorboard-loader fast` and share its native data server. Startup reports an error if that reader is unavailable. Explicit `auto` and `python` modes remain available for native TensorBoard compatibility; Overview requires the fast reader. Its status banner identifies the reader. Data can appear while the initial scan continues.

## Workflows

Experiment selection is shared across Overview, Configurations, and Relationships. Time-series investigations focus on one experiment independently.

- **Experiments:** find runs using search, configuration conditions, and path filters. Reuse named filters, organize groups, and maintain names, notes, tags, favorites, and archive state. Filtering preserves manual selections and identifies selected runs outside the filters.
- **Overview:** compare scalar curves across experiments or groups. Browse metrics by tag hierarchy, smooth curves, inspect complete observations, and combine different metrics from one experiment with independent scaling.
- **Configurations:** compare typed values against a baseline, exclude irrelevant fields, and highlight differences or scalar extrema. Include scalar summaries at the latest or a fixed step, with optional smoothing. Customize field names and displayed values while retaining the original data for comparisons and exports.
- **Relationships:** explore associations between configuration choices and outcomes using ranked scores, scatter plots, and parallel coordinates. Outcomes can inherit a configured scalar's settings. Missing and null conditions share a category by default, and numeric conditions can be treated as categories.
- **Time series:** detect spikes, sustained changes, periodic behavior, and timing relationships across curves. Rank related curves by correlation or onset to investigate which changes appear first. Analysis covers all curves by default, with optional inclusion/exclusion patterns.
- **Named views:** save settings across workspace pages, with either a fixed experiment set or selection that follows filters and includes new matches. Working changes autosave; saved snapshots change only through an explicit update.
- **TensorBoard:** use the native dashboards for logged media, distributions, model graphs, embeddings, and other supported plugins alongside Expman's comparisons and analyses.

Appearance preferences customize fonts and colors across workspaces. Automatic refresh discovers new data while preserving unchanged views. Long analyses report progress and support cancellation; comparison and analysis results can be exported as CSV or JSON.

## Data semantics

### Logs and configurations

Discovery walks the log directory recursively, deduplicates aliases, avoids cycles, and reports broken links. Event streams are namespaced by their path within the experiment. Legacy and tensor-backed scalars are supported; duplicate steps retain the latest finite observation.

The preferred primary configuration is `config.yaml`, `config.yml`, or `config.json`, in that order, with matching `.hydra/config.*` fallbacks. Additional YAML/JSON files and timestamped `hparams.*` files use qualified paths such as `@extra.json::optimizer.lr`, preserving primary values. Literal dots and backslashes in keys are escaped; Hydra expressions remain literal. Malformed configurations retain source text and warnings.

Comparisons distinguish missing, null, boolean, numeric, and list values. Missing cells are blank; explicit null appears as `null`.

### JSON summary metrics

Additional numeric summaries default to `{experiment}/evaluation_metrics.json`. A bare filename such as `evaluation_metrics.json` is resolved inside each experiment; `{experiment}/evaluation/metrics.json` supports nested files. Shared files at the log root are not loaded through bare filenames.

Supported formats include `{"accuracy": 0.9}`, `{"metrics": {"accuracy": 0.9}}`, and evaluation records with `experiment`, `status`, and `metrics` fields. The containing experiment folder identifies the owner. Nested names use `/` under a source prefix, for example `JSON/evaluation_metrics/Success rate`.

Registered paths persist and changed values are reloaded on refresh. Invalid registrations preserve the previous sources. Imported metrics are final-value summaries for configuration comparisons and relationship outcomes; they have no step history or smoothing and are excluded from configuration conditions and curve panels. Missing or pending values stay blank.

### Exclusions

Configuration exclusions accept exact keys, subtrees, and globs such as `seed` or `paths.*`. Filename patterns such as `hparams.yml` match at any depth; patterns containing `/` match experiment-relative paths. Exclusions apply to comparisons, grouping, and relationship analysis. Registered JSON metric sources are excluded from configuration discovery.

### Sampling, smoothing, and groups

Overview initially uses TensorBoard's retained samples and can load every observation for a plot. Complete observations are temporary and may be invalidated by page reloads, source refreshes, or changes to the plot's inputs.

Overview, Configurations, and Relationships use the same bias-corrected exponential smoothing formula. Overview smooths loaded observations in the browser; smoothed configuration and outcome summaries use complete histories. Results can therefore differ until Overview loads all values. Raw CSV exports retain unsmoothed observations; outcome analysis follows the selected summary mode.

Group means interpolate within recorded ranges. Overlap uses the common range; union allows varying contributor counts without extrapolation. Bands show population standard deviation, min–max, or sample standard error, which requires at least two contributors.

### Analysis scores and timing

Continuous event detection uses local median/MAD scores; binary flags use a smoothed Bernoulli model with a longer context. Periodic adjustment accounts for expected cycle fluctuations. Detection scores are distinct from the displayed curve's z-score.

Sustained-change analysis measures departures from a preceding baseline and reports Pearson correlations of smoothed levels and adjacent changes. Onset delay compares sustained threshold crossings. Correlation lag measures alignment across the interval.

Positive event delay means the target follows the reference. Numeric associations use absolute Spearman correlation; categorical associations use square-root eta squared. These associations and timing relationships do not establish causation.

Periodic fits use recorded timestamps and may subsample long curves. Spectral scores describe explained variation, not significance probabilities. Phase delays are modulo one cycle. Logging cadence and gaps limit timing precision.

### Persistence

Workspace metadata is saved atomically in `<logdir>/.expman/state.json`, including annotations, groups, named filters and views, exclusions, selections, and page settings. User-wide appearance and automatic-refresh preferences live in `~/.expman/settings.json`. Named view snapshots exclude annotations, source registrations, saved group/filter definitions, and Appearance.

Renaming and archiving affect metadata only. Event logs and experiment configurations remain untouched. Custom metadata locations support read-only log roots; metadata destinations must be writable. Background jobs use bounded caches and reuse results until sources change or cached results expire. See [the design](docs/design.html) for implementation details.

## Development

```bash
uv sync --locked
uv run expman --help
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv build
```

The Python package lives in `src/expman/`; bundled assets are in `src/expman/static/`. Tests cover actual TensorBoard event files, config comparisons, persistence, group mathematics, outcomes, event timing, periodicity, and native TensorBoard endpoints. OpenAPI documentation is available at `/docs`, and the HTML design is served at `/design`.

Real Chromium tests live in `tests/ui/` and run against the actual server, bundled Plotly, and native TensorBoard reader with temporary synthetic logs and workspace state. Install the pinned browser tooling and Chromium, then run:

```bash
uv run --locked --with-requirements tests/ui/requirements.txt python -m playwright install chromium
uv run --locked --with-requirements tests/ui/requirements.txt pytest tests/ui --ui --browser chromium --tracing retain-on-failure --screenshot only-on-failure --output test-results
```

On Linux, add `--with-deps` to the installation command if Chromium needs system libraries. The `Browser UI` GitHub Actions workflow installs those libraries and runs the complete backend and browser suite on pushes and pull requests. Failures retain browser traces, screenshots, and JavaScript/application/HTTP error reports in `test-results/`. Tests fail on browser errors or application error toasts, including errors caught by the app itself. To run the complete suite locally, replace `pytest tests/ui --ui` with `pytest --ui` in the command above.

Coverage includes repeated panel expansion and regrouping, independent/global smoothing without curve requests, shared legend isolation and persistent colors, automatic loading after section expansion and scrolling, and navigation through Experiments, Configurations, Relationships, and Time series. Experiment workflows also cover favorite persistence, editing details, archiving and restoration, preserved JSON summaries, pending feedback, and delayed responses that must not undo annotations or interrupt navigation. A 20,050-observation test checks actual Plotly input traces, calculated steps, and SVG vertices after **Load all values**, smoothing, and repeated expansion. Full-value plots disable line simplification so every plotted observation remains a vertex.

Ordinary `pytest` runs skip the browser suite; an explicit `--ui` run requires its dependencies and never silently skips a missing installation. On November 13, 2026, the complete suite passed **188 tests with no skips**, including sixteen real Chromium tests and the native TensorBoard socket integration. This run used individually approved execution outside the ordinary sandbox, which still denies sockets. Browser dependencies and Chromium were downloaded using that approved route. To reuse the installed temporary caches, prefix both commands with `UV_CACHE_DIR=/tmp/expman-uv-cache PLAYWRIGHT_BROWSERS_PATH=/tmp/expman-playwright`. The [verification record](docs/design.html#verification-status) distinguishes the checks performed from remaining manual coverage.

## License

Apache License 2.0; see [LICENSE](LICENSE).
