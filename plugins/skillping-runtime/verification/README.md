# Runtime verification

Run the daily checks from `plugins/skillping-runtime`:

~~~powershell
rtk npm test
~~~

The entry point compiles the Runtime, runs the node:test integration checks, then runs the isolated verification commands. `rtk npm run test:verification` reruns only the verification commands. There is no hosted CI configuration in this repository.

All writes, clear operations, credentials, and injected errors use new fixture data. Model responses are injected. No default check calls a paid model or opens the user's SkillPing data.

| Check | Evidence and limits |
| --- | --- |
| [Configuration writes](config-write/README.md) | Controlled Windows sharing denial, transient and permanent rename failures, and compiling retry removal. A separate command repeats the original independent-process updates. |
| [Web recommendations](recommendation/README.md) | Current accepted observation, claim and finish behavior, SQLite receipts and suppression, bounded state exploration, and compiling source errors. |
| [Counting](counting/README.md) | Episode and task thresholds, rolling time boundaries, deduplication, scopes, controls, and compiling source errors. |
| [Clear data](clear-data/README.md) | Pinned TLC model, actual-code cases, and compiling source errors. Windows x64 and Node 24+ are required for its pinned portable toolchain. |

Reports and copied builds stay in each check's ignored `.work` directory. A successful process exit is necessary, but inspect the report to distinguish a business failure from an infrastructure failure. A deliberately broken copy is evidence of check sensitivity, not evidence of that defect in the current product.

Source pins use SHA-256 of UTF-8 text with CRLF converted to LF. Mutation anchors use the same text form. This handles the existing workspace's mixed line endings and copied CRLF sources. The repository's `.gitattributes` keeps new Git checkouts at LF. Each run separately compares raw source bytes before and after. Downloaded tool archives keep their original byte checksums.

[PLAN.md](PLAN.md) records this delivery's scope and gates. [decisions.tsv](decisions.tsv) records its decisions. The pre-existing `docs/technical-documentation.zh-CN.md` is outside this delivery.

[RESULTS.md](RESULTS.md) records the completed 2026-10-26 run, source findings, exact commands, counterexamples, local commits, and remaining limits.

[DEPENDENCY-UPDATE.md](DEPENDENCY-UPDATE.md) records the subsequent security dependency upgrade and the review behind its updated lockfile pins.
