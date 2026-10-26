# 2026-10-26 Runtime verification results

The four requested work items are complete on `codex/runtime-verification`. The final code snapshot is `214448b4bf84fc4d7c3b02e77a198f14635b6f6a`, based on `41149ac1ec3c6be830a87e153eafb04220b257e4`. Only verification documentation and the decision trail changed after the final run. No remote push, release, or merge was performed.

## Product fix

The original independent-process configuration fixture failed with native `EPERM` in 6 of 25 runs. Each sample started a fresh Node test process, which started two children making six independent storage or history health updates. The failing operation was the single `rename` inside `config.atomicJsonWrite`.

A controlled PowerShell process held the destination without `FileShare.Delete`. The real Windows replacement then returned `EPERM`. The test released that handle only after observing the error. SQLite writer serialization does not prevent this operating-system denial. The exact conflicting handle holder in the original six failures was not captured.

The shared operation now retries only Windows `EPERM`, `EACCES`, and `EBUSY`, with at most six attempts and five 20ms waits. It keeps the existing locks, temporary-file replacement, settings, failure cause, health reporting, and cleanup. It never removes the destination before replacement. Persistent failures still return an error. The integrated original fixture passed 25/25 after the fix. The native retry-removal variant compiles, fails the designated native case, and has the same config fingerprint as the original source.

The recommendation and counting checks found no additional product defect. The old pace test used the retired `set_pace` command without checking success. It now verifies `set_recommendation_pace`, the returned pace, disk persistence through a fresh store, and Key non-disclosure.

## Checked contracts

The current path is accepted `observe_turn`, internal `claimDispatch(recommendation="web")`, then public `finish_recommendation`. Public `claim_dispatch` performs Stop cleanup. Extraction uses v6 and review uses v3. Legacy completion and unverified retry methods do not replace the web contract.

The [recommendation state diagram and source mapping](recommendation/README.md) cover persistent one-claim-per-turn receipts, two real processes released from a ready barrier, repeated and late finishes, the exact ten-minute expiry, five-minute backoff and three-failures-per-hour boundaries, live evidence and prototype changes, scope and switches, and atomic completion with cooldown or baseline silence.

The [counting rules and state diagram](counting/README.md) cover distinct episodes AND distinct tasks, retry and continuation deduplication, `(now−30 days, now]`, expiry equality, future evidence, global and normalized project scopes, and both switches. Eager requires 3/2, balanced 5/3, and cautious 8/4. The finite threshold matrix has 198 combinations. All three paces are also exercised through actual v6 engine calls and SQLite.

The [clear-data mapping review](clear-data/README.md) reconciles the config retry with the existing model. Retry waits retain the locks and publish no JSON, so they stutter before the existing publication actions. Exhaustion follows the existing failure action. No property or state bound was weakened.

## Commands and results

All checks used Node `v24.18.0` on Windows and new isolated fixture data. No paid model requests or real SkillPing credentials were used.

| Command or check | Observed result |
| --- | --- |
| Unchanged `rtk npm test` | 113/113 passed once. The repeated original fixture established the intermittent failure separately. |
| `rtk proxy node plugins/skillping-runtime/verification/config-write/repeat.mjs 25` | Original source 19/25; integrated fix 25/25. |
| `rtk npm run build:marketplace` in Runtime | Passed. Tracked bundle SHA-256 `be395213f83948e8e79bb1ba265d3824fa106f1243db3af186d33bd43d8cf3f5` matches the release receipt. |
| Fresh checkout `rtk npm ci` and `rtk npm run prebuild` | Passed with locked dependencies. |
| Fresh LF checkout, `node --test` for architecture, recommendation, and counting | 39/39 passed. |
| Fresh checkout, seven pinned source files explicitly converted to CRLF, then `rtk npm test` | 142/142 passed, followed by all four verification commands. Canonical Git source diff remained empty. |
| Config native red/green command | Clean before, compiling retry removal with designated EPERM failure, clean after. |
| Clear-data command | Two clean TLC explorations of 20,639 distinct states, six actual-code groups before and after, four model counterexamples and four compiling source errors caught. |
| Recommendation command | Exhausted 4,064 states and 21,664 transitions, eight actual-code groups before and after, six model counterexamples and seven compiling source errors caught. |
| Counting command | Ten checks before and after; seven compiling source errors caught. |
| Project Skill validator | Both project Skills passed. The validator used isolated PyYAML because the bundled Python lacked it. |

The daily entry point is `rtk npm test` from `plugins/skillping-runtime`. `rtk npm run test:verification` reruns the four full verification commands. The final run caught 19 deliberate source errors in total, all after successful compilation. The [config](config-write/README.md), [clear-data](clear-data/README.md), [recommendation](recommendation/README.md), and [counting](counting/README.md) references list exact source mutations, required assertion names, and replay commands.

## Findings in verification infrastructure

The old clear-data source hashes correctly stopped with `SOURCE_MAPPING_STALE` after the product fix. The mapping was reviewed before the new pins and sync commit were recorded. This was verification drift.

The recommendation model initially retained an old-prototype marker when the prototype changed before claim. A real claim freezes the current prototype. The corrected model resets that comparison on claim, and its prototype counterexample now requires claim, change, and finish in that order.

Independent review found that ordinary receipt-validation assertions were mislabeled as infrastructure failures. A compiling source variant accepting count 4 demonstrated that gap. Business assertions now return `WEB_CONTRACT` and clean baseline business failures report `code-finding`; fixture assertions remain `incomplete`. The count-4 variant is part of the default full command. Unknown-scenario classification also has a daily check.

The existing workspace had mixed LF and CRLF source files. Fresh Git checkout uses LF because of `.gitattributes`. Canonical source fingerprints and mutation anchors now accept either form, while each run still compares the original raw source and oracle bytes. Tool archive checksums remain byte-for-byte checks. The final CRLF run was an explicit isolated conversion, not an automatically produced Git checkout.

Independent reviewers inherited the parent model per project configuration. They provided separate-context reviews; no cross-model diversity is claimed. Their accepted findings are recorded in [decisions.tsv](decisions.tsv).

## Reports and local commits

The final reports are retained beneath `.scratch/lanes/fresh-verification/plugins/skillping-runtime/verification/`:

- `config-write/.work/red-green-YOY8If/report.json`.
- `clear-data/.work/run-iODOPS/report.json`.
- `recommendation/.work/run-HXRxfd/report.json`.
- `counting/.work/run-5ficCV/report.json`.

The aggregate assertion check is `.scratch/review/verification/final-summary.json`. The controlled conversion record is `.scratch/lanes/fresh-verification/.scratch/eol-context.json`. The original failure logs remain in `.scratch/lanes/config/plugins/skillping-runtime/verification/config-write/.work/2026-10-26T09-57-46.905Z/`. Reports and copied builds are ignored by Git. Rerunning the commands creates new reports.

| Local commit | Delivery |
| --- | --- |
| `839522e57fc21bc0733eccbbba586f5f67fffb7a` | Shared Windows configuration replacement fix and native regressions. |
| `7411221` | Counting matrix, current protocol checks, and pace test repair. |
| `d153fcf1c18fb061f6cb78be7f9193bf4efb46b8` | Web state model, actual-code cases, and compiling variants. |
| `bab7749` | Updated distribution bundle and receipt. |
| `214448b4bf84fc4d7c3b02e77a198f14635b6f6a` | Daily integration, project Skills, maintained clear-data proof, and review corrections. |

The pre-existing `docs/technical-documentation.zh-CN.md` stayed untracked and unchanged. Its SHA-256 remains `32dafff25e5614b2717ab887972acfd461033be7bf421789b82cbaa04b2d2e46`.

## Limits and remaining risks

The checks are bounded safety models plus concrete implementation evidence. Clear data has two processes, two sessions, at most two confirmation issuances, and generations 0..2. The recommendation model has two workflows, two task/turn identities, and one request per workflow. Concrete cases add selected time boundaries and native SQLite contention. These are not whole-system refinement proofs, arbitrary scheduling guarantees, power-loss guarantees, or tests of online extraction and search quality.

Windows handles held longer than the retry budget can still produce the preserved write error. The original interfering process remains unidentified.

`npm audit --omit=dev --json` reported two existing high-severity advisories, for `body-parser` and `zod`. Dependencies were not upgraded and production exploitability was not assessed in this task. The captured summary is `.scratch/review/verification/dependency-audit.json`.

The user subsequently authorized a dependency upgrade. That follow-up resolved both audit findings and passed the full checks; its versions, mapping review, and reports are in [DEPENDENCY-UPDATE.md](DEPENDENCY-UPDATE.md). The paragraph above records the earlier run's state.
