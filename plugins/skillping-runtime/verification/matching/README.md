# Bounded Workflow scan verification

Run `rtk proxy node plugins/skillping-runtime/verification/matching/run.mjs` from the repository root with Node 24+ and the runtime development dependencies installed. Reports, isolated builds, mutation patches and complete counterexample traces are retained under `.work/run-*/`. Use `--model-only` to run only the abstract model; that result does not imply that source verification passed.

The independent state model has three candidates, two entries per active batch, three probability classes with matching threshold 2, four payload units, one frozen generation/configuration, at most one external invalidation, one replayed intermediate response and up to two attempted final writes. Main-model batches contain the tentative winner plus new candidates. Numeric batches contain only new candidates and retain the highest and second-highest candidate. A failed numeric batch resets traversal and all numerical state before the main-model path starts.

The model checks complete traversal without repeated candidate contributions, numerical top-two bookkeeping, no partial-score reuse by fallback, at most one attribution, one final write, required final evidence, and rejection after generation, configuration revision, candidate set, prototype, evidence, switch, cancellation, expiry or total-payload changes. All 18 deliberate faults must produce their designated invariant and a concrete abstract trace. The clean model must exhaust the queue.

The concrete scenarios freeze seven candidates, reject multi-ID numerical results, keep intermediate main-model associations empty, select candidate seven, reject replayed batch/final replies, and reject final selection after a nonwinner prototype changes. They use temporary SQLite data and no model provider. The full runner checks these scenarios before and after four isolated source variants. Every variant must compile and then fail its designated business assertion; an unrelated failure, compilation error or surviving variant is incomplete verification. Source and oracle bytes must remain unchanged throughout the run.

| Rule | Actual-code scenario | Compiling source error |
| --- | --- | --- |
| `SCAN_COVERAGE` | `catalog-coverage` | Reinstate a five-candidate preparation slice. |
| `SINGLE_ATTRIBUTION` | `single-attribution` | Remove the more-than-one-ID result rejection. |
| `SCAN_COMPLETE` | `early-association` | Write an association while advancing an intermediate batch. |
| `FROZEN_COMMIT` | `whole-snapshot` | Skip full frozen-catalog checks for progressive scans. |

`verification.json` records the reviewed source hashes, unique symbol anchors and exact mutations. Its sync commit is the base for the reviewed uncommitted implementation, as its sync note states. A source mismatch is `SOURCE_MAPPING_STALE`; reconcile the actual behavior, model and scenarios before updating the pins. Each scenario artifact contains a direct replay command.

This model supplements the real SQLite and injected-response tests. It does not prove implementation refinement, model answer quality, semantic order or grouping invariance, real request timing, token consumption or cost. The probability classes exercise threshold and tie mechanics rather than calibrated real probabilities. Main-model replies are nondeterministic choices from the active batch, `different` or `uncertain`; no probability or semantic oracle is invented.

The model abstracts both numerical scanning and main-model selection. These five concrete scenarios exercise storage-side main review and numerical-result validation, not actual HTTP batch scoring. Engine-level injected-response tests separately cover numerical cross-batch scoring, timeout, cancellation and configuration/generation changes. A passing model alone is not an implementation verification pass.
