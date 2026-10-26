---
name: verify-skillping-recommendations
description: Verify SkillPing web recommendation completion and episode counting after changes to claims, receipts, suppression, thresholds, evidence, scope, or controls.
---

Run from `plugins/skillping-runtime` with Node 24+ and its development dependencies installed:

~~~powershell
rtk npm test
~~~

This is the daily entry point. It includes the current web lifecycle and counting checks, their isolated compiling source mutations, and the separate clear-data verification. All fixture state is temporary. The checks use injected model responses and no paid online calls.

For a focused run, use `rtk npm run prebuild` followed by:

~~~powershell
rtk proxy node --test scripts/check-recommendation-lifecycle.mjs scripts/check-counting-rules.mjs
rtk proxy node verification/recommendation/run.mjs
rtk proxy node verification/counting/run.mjs
~~~

Read the [recommendation state and source mapping](../../../plugins/skillping-runtime/verification/recommendation/README.md) before changing claim or finish behavior. Read the [counting rules and boundaries](../../../plugins/skillping-runtime/verification/counting/README.md) before changing pace, scope, episode association, or deduplication.

Use the current extraction v6 and review v3 contracts. The public `claim_dispatch` tool currently performs Stop cleanup. The normal accepted `observe_turn` path claims `recommendation:web` internally, then the host calls `finish_recommendation`. Legacy `completeDispatch` and `retryUnverifiedDispatch` do not define the current completion contract.

A completed verification needs clean real-code checks before and after source variants, successful compilation of each variant, the designated business assertion for every injected error, and unchanged product source. A compile error, timeout, unrelated assertion, or surviving variant leaves the check incomplete. Read the generated reports and replay commands before claiming success.

When source hashes or mutation anchors change, inspect the affected symbols and callers through codebase-memory-mcp and reconcile the model, rules, and actual-code cases before updating the mapping. Keep a real failure as a finding. Update an assertion only when evidence establishes that its contract was wrong or intentionally changed.

The recommendation explorer is a finite safety model. The counting matrix checks selected boundary cases against real SQLite. Neither is a refinement proof or a guarantee for arbitrary clocks, workflows, processes, or model answers. Their READMEs state the exact bounds and omissions.
