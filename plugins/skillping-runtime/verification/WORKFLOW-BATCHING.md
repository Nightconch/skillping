# 2026-10-27 Workflow batching verification

The realtime v6 path freezes every qualified candidate and uses bounded batches. Sqwish keeps the highest and second-highest probabilities locally. Main-model fallback uses progressive `same`, `different`, or `uncertain` decisions with one tentative winner. Required final evidence review happens before a single contribution is committed. Historical multi-linked records are retained.

The implementation extends review v3 state and evidence receipts rather than adding a tool or provider. Model the Domain shaped the explicit scan/final state. Type System Discipline kept numerical outcomes separate from main-model verdicts and validates the single selected identity at the storage boundary. Behavior and budgets are described in [workflow-matching.md](../../../docs/workflow-matching.md).

| Check | Actual result |
| --- | --- |
| `rtk npm test` | 160 tests passed, then all five complete verification commands passed. |
| Release inventory upgrade | One added focused test passed after the full run. It restores the matching guide to a recognized old release and preserves unknown files. |
| Configuration writing | Clean checks before and after; the deliberate no-retry variant compiled and failed as required. |
| Clear data | Both TLC baselines explored 20,639 distinct states. Six concrete groups passed before and after; four model and four compiling source errors were caught. The late-response case waits on batch two of seven candidates. |
| Recommendation lifecycle | 4,064 model states and 21,664 transitions. Eight concrete groups passed before and after; six model faults and seven compiling source variants were caught. The two-process race retains two eligible historical Workflows. |
| Counting | Eleven concrete groups passed before and after; eight compiling source variants triggered their designated `COUNT_*` assertions. |
| Matching | 1,745 states and 3,018 transitions; eighteen designated model counterexamples. Five SQLite groups passed before and after; all four source variants compiled and triggered their designated assertions. |
| `rtk npm run build:marketplace` | Updated bundle, Prompt, documentation and release receipt in `distribution`. Eight root files, seven Hook files and eleven Runtime files. |
| `rtk npm run smoke` | Real stdio MCP bundle smoke passed with release 0.1.2 and current contracts. |
| Packaged batching smoke | Started `distribution/skillping-runtime/dist/mcp/server.bundle.js`. Main-model packets were `[1,2,3,4,5]`, `[1,6,7]`, then final `[7]`. No provisional edges, one final contribution for Workflow 7, repeated final reply ignored. |

All five full reports have `status=pass` and `source_unchanged=true`. They remain in the ignored verification output directories:

- `config-write/.work/red-green-7cWF0x/report.json`.
- `clear-data/.work/run-QitJYV/report.json`.
- `recommendation/.work/run-4gOxRw/report.json`.
- `counting/.work/run-mCLatJ/report.json`.
- `matching/.work/run-1YAJfs/report.json`.

The additional packaged smoke is replayable from the repository root with `rtk proxy node .scratch/released-matching-smoke.mjs`. It uses temporary SQLite data and the shipped MCP bundle, with no external provider. The maintained engine tests cover both paths, later candidates, numerical order/group permutations, total budgets, pagination, replay, failures, cancellation, configuration and snapshot changes, and clear/generation changes.

Source mapping was reconciled after the expected `SOURCE_MAPPING_STALE` result. Mapping READMEs explain the relationship to the unchanged clear/claim models and the new matching model. The pins describe the reviewed uncommitted implementation on base `343a9e4b9695f222e8b76427b2d8b28760402f75`; that base commit alone does not contain this work. See [decisions.tsv](matching/decisions.tsv).

Independent separate-context review found and fixed early contributions for old confirmed prototype versions and for forming candidates when recommendations were off. Both regressions assert zero new contribution before final review. Refresh metadata and a double payload charge on stale refresh were also corrected. One added narration comment was removed; no suppressions or broader refactoring were introduced.

No live Sqwish requests, credentials, online semantic-quality evaluation, token measurement or cost evaluation were used. Injected responses establish protocol behavior, not semantic invariance under real model wording, order or grouping. The bounded models are not refinement or whole-system proofs. Existing untracked research and technical-documentation files were preserved; the latter still has SHA-256 `32dafff25e5614b2717ab887972acfd461033be7bf421789b82cbaa04b2d2e46`.
