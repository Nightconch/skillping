# Runtime verification delivery

Base commit: `41149ac1ec3c6be830a87e153eafb04220b257e4`.

The work is complete when the Windows configuration write fix has a failing pre-change reproduction and passing controlled regression, the current web recommendation and counting contracts have real SQLite checks and compiling mutation counterexamples, all daily checks and the maintained clear-data check pass, required distribution files are rebuilt, and the work is committed locally. No push, release, or merge is part of this run.

## Playbook

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Verifiable units

1. Capture the unchanged test and clear-data baselines. Preserve the existing user document.
2. Reproduce the Windows configuration replacement failure. Fix the shared operation and verify transient and permanent failure behavior plus repeated independent-process updates.
3. Map the current web dispatch state machine. Check claim, finish, timeout, retries, changes to evidence and prototypes, controls, scope, receipts, and suppression against actual SQLite state.
4. Map episode and task counting. Check both thresholds, deduplication, the rolling window, scopes, switches, all paces, and the current pace control command.
5. Require compiling temporary source errors to fail designated business assertions in isolated copies. Keep infrastructure failures separate.
6. Review all covered source changes against the clear-data model and real-code scenarios. Update the mapping only after that review, then run all clear-data mutations again.
7. Integrate the checks into the existing npm entry points. Rebuild distribution, review the final diff, run regression, and create local Git commits.

The three investigation and implementation slices use separate worktrees. The parent integrates and reviews them sequentially. This follows Separate Before Serializing Shared State. Model the Domain determines the state and counting tables before code changes. Prove It Works requires observations from the current Runtime and compiling variants.

The first throughput checkpoint is the unchanged baseline plus the three source-grounded rule summaries. It decides whether more model infrastructure is needed. Reuse the existing toolchain and test conventions. The final check must use the combined source, not the individual worktree results.

`decisions.tsv` records decisions and evidence. Scenario details, replay commands, and model limits live with their checks.

The completed outcome and exact tested snapshot are in [RESULTS.md](RESULTS.md). Final verification passed 142 daily tests and 19 compiling source errors from a fresh isolated checkout after a controlled CRLF conversion. Its canonical Git source diff stayed empty. The ordinary fresh LF checkout also passed the 39 focused checks before conversion.
