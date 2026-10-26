# Runtime security dependency update

This follow-up addresses the two advisories recorded in [RESULTS.md](RESULTS.md). The dependency change is commit `4fb13ebe267086784c9df79e16f78dfcbc18c339`, based on `a50a6edb7fd935c5951842363aac9cdbdc76f99b`.

| Package | Before | After | Reason |
| --- | --- | --- | --- |
| zod | 4.5.4 | 4.6.7 | Fix [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). |
| body-parser | 2.3.0 | 2.4.0 | Fix [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828). |
| qs | 6.16.0 | 6.16.1 | Required by body-parser's new `^6.16.1` range. |

Zod remains pinned to an exact version. Body-parser remains transitive through the existing MCP SDK and Express dependencies. No override or direct body-parser dependency was added. Other locked package versions, development tools, Runtime TypeScript source, and API contracts are unchanged. The bundled Zod notice version is updated; the installed MIT license text is unchanged.

## Dependency and model review

The old dependency audit reported two high-severity findings. The writer's isolated checks passed prebuild, 90 selected existing tests, bundled MCP stdio smoke, and both full and production-only audit with zero findings. The parent independently replayed the Zod boundary check and verified every locked package version delta.

The [Zod security patch](https://github.com/colinhacks/zod/commit/a0ebf97) moves upper-bound collection checks ahead of element parsing. A bounded array and an object containing it were each checked with 256 invalid elements. Version 4.5.4 rejected after visiting every element and reporting 257 issues; 4.6.7 rejected before any element visit and reported one size issue. Both returned invalid. This is an operation-count and validation-result check, not a timing benchmark or a full resource-exhaustion test.

The current MCP entry still uses `StdioServerTransport`. The body-parser HTTP request path is not enabled by that entry. The update changes no configuration write locks, generation fences, clear authorization, SQLite transactions, eligibility rules, or counters. The recommendation and clear-data models abstract input validation before their protocol actions; they do not model every rejected element or error-message object. The early rejection therefore does not require new model transitions or weaker properties. Valid and invalid protocol behavior remains subject to the full concrete checks and all compiling source errors.

Package-lock changes correctly caused the old clear-data check to stop at `SOURCE_MAPPING_STALE` in `clear-data/.work/run-VvgQIn/report.json`. Before the dependency integration, the existing clear-data baseline passed in `clear-data/.work/run-J3UUqb/report.json`. The three manifests now record the reviewed dependency commit and the new lockfile hash. All other source pins, properties, mutation recipes, and state bounds remain unchanged.

## Verification

Run from `plugins/skillping-runtime`:

~~~powershell
rtk npm ci --ignore-scripts
rtk npm run build:marketplace
rtk npm test
rtk proxy node scripts/smoke-runtime.mjs
rtk proxy npm audit --omit=dev --json
rtk proxy npm audit --json
~~~

All commands above completed successfully on Node `v24.18.0` on Windows. The full daily command passed 142 tests and caught all 19 successfully compiled source errors. Both audit scopes returned exit 0 with no reported vulnerabilities. The actual bundled MCP smoke passed. The rebuilt distribution bundle hash is `7717124cc62ace35424eb88622aaa896dcd9a1270232c547b7a73d99f68f9177`, matching its release receipt. Product source and the pre-existing user document remained unchanged.

The final reports beneath `plugins/skillping-runtime/verification/` are:

- `config-write/.work/red-green-2lwXvA/report.json`.
- `clear-data/.work/run-4rTF1A/report.json`.
- `recommendation/.work/run-c76wA5/report.json`.
- `counting/.work/run-IbN52j/report.json`.

Every report records a passing result and unchanged source. All three compiling-mutation runners detected every designated assertion. The clear-data model again explored 20,639 distinct states in both clean runs; the recommendation model again exhausted 4,064 states. The aggregate checked summary is `.scratch/dependency-update/final-summary.json`. Independent review confirmed the audit, exact package delta, license, rebuilt bundle, source pins, and boundary replay. Reviewers inherited the parent model per project configuration.

Reports, the preserved old Zod package, and the replayable boundary check stay in ignored `.scratch` or `.work` directories. The concrete replay is `rtk proxy node .scratch/lanes/security-deps/.scratch/security-dependency-update/zod-bounds-check.mjs` from the repository root.

The model limits remain those in the linked [clear-data](clear-data/README.md), [recommendation](recommendation/README.md), and [counting](counting/README.md) references. No paid model call or real SkillPing data is used. Audit results describe the registry's known advisories at the time of the command; they do not prove the absence of all vulnerabilities.
