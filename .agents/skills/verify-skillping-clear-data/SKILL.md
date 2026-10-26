---
name: verify-skillping-clear-data
description: Verify SkillPing data-clearing safety after changes to clear confirmation, generation fencing, coordination locks, deletion, or retained settings. Runs bounded TLC checks, actual-code scenarios, and compiling source mutations.
---

Run from the repository root on Windows x64 with Node 24+ and the Runtime development dependencies installed:

~~~powershell
rtk proxy node plugins/skillping-runtime/verification/clear-data/run.mjs
~~~

The first run downloads pinned, checksum-verified TLC and a portable JVM into ignored .scratch/formal-tools. It does not change system Java. Isolated builds, fixture data, reports and counterexamples go into verification/clear-data/.work beneath the Runtime package.

Read the [state diagram, rule mapping and limits](../../../plugins/skillping-runtime/verification/clear-data/README.md) when changing behavior. Read [verification.json](../../../plugins/skillping-runtime/verification/clear-data/verification.json) for the authoritative source hashes, tool pins, mutation recipes and sync commit. The README records the source review behind that synchronization.

Coverage is config.withDataAccess, clearData and atomicJsonWrite; engine.control for request_clear and confirm_clear, syncStorageGeneration, withDataGeneration and track. Storage and domain are compiled and exercised by concrete fixtures, not proved in full. A writer that bypasses the gate changes the model's assumptions.

Completion requires exit 0 and report.status=pass, completed clean TLC exploration, six passing actual-code scenarios before and after, four matching model counterexamples, four compiling source variants failing their designated business invariant, and source_unchanged=true. Read the printed report.json and its events; compilation errors, unrelated assertions, timeouts, or surviving mutants are incomplete checks.

Model counterexamples are abstract traces. Match their actions to the covered code before diagnosing a product defect. Actual-code counterexamples include source locations, patch records and a concrete replay command. A clean-baseline business failure is a finding; retain it. Correct a modeling error only after identifying the transition or assumption that does not describe the code. Product fixes require task authorization.

SOURCE_MAPPING_STALE stops interpretation of the proof. Use codebase-memory-mcp to inspect the changed functions and callers, compare the current code with the recorded sync commit including uncommitted edits, and reconcile the model and concrete scenarios. Update source hashes and move the sync commit forward only after confirming the verification describes the new code. Then run the complete command again, including all deliberate source errors and the final clean baseline.

The formal scope is two processes, two session identities, one active callback per process, two confirmation issuances, generations 0..2 and one bounded worker directory. Assumptions and omitted behaviors are in the linked reference. Passing this check is bounded model checking plus concrete implementation evidence, not a whole-project or refinement proof. Use /maintain-formal-verification-skill after covered changes were made without rechecking this mapping.
