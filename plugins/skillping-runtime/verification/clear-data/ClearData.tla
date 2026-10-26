------------------------------ MODULE ClearData ------------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Processes, MaxClears, Fault

ASSUME /\ Cardinality(Processes) = 2
       /\ MaxClears = 2
       /\ Fault \in {"none", "authorization", "generation", "failure", "settings"}

(* Source commit and computed locations are recorded in verification.json.
   engine.control and config.clearData preserve these async publication boundaries.
   Atomic rename retries stutter before publication; exhaustion takes Fail.
   These four safety rules are not a refinement proof.
   shortcut: one tracked callback and one control flow per runtime process;
   expand this bound when verifying same-process owner interactions. *)

Sessions == {"session1", "session2"}
NoOwner == "none"
DatabaseFiles == {"database", "wal", "shm"}
Groups == DatabaseFiles \cup {"worker-schema", "worker-output", "worker-directory",
                            "key", "progress", "diagnostics", "diagnostics-rotated"}
InitialSettings == [detection_enabled |-> TRUE,
                    recommendation_enabled |-> TRUE,
                    recommendation_pace |-> "balanced",
                    intro_seen |-> TRUE,
                    api_key |-> "retained-api-key"]

IdleCallback == [pc |-> "idle", captured |-> 0]
IdleClear == [pc |-> "idle", expectedGeneration |-> 0,
              expectedPending |-> FALSE, session |-> "session1",
              valid |-> FALSE, authorized |-> TRUE,
              cause |-> "none", reported |-> "none", pausedAtReturn |-> FALSE]

ActiveClearPhases == {"drain", "owner", "firstGate", "pause", "firstRelease",
                     "first-database", "first-wal", "first-shm", "finalGate",
                     "finalValidate", "database", "wal", "shm", "worker-schema",
                     "worker-output", "worker-directory", "key", "progress",
                     "diagnostics", "diagnostics-rotated", "publish",
                     "finalUnlock", "ownerUnlock", "return", "cleanup"}
ErrorCuts == ActiveClearPhases \ {"drain", "return", "cleanup"}

VARIABLES disk, runtime, owner, gate, attempts, completedGeneration,
          unauthorizedDeletion, partialDeletion
vars == <<disk, runtime, owner, gate, attempts, completedGeneration,
          unauthorizedDeletion, partialDeletion>>

Readers == {p \in Processes : runtime[p].callback.pc \in {"check", "work", "release"}}
Clearing(p) == runtime[p].clear.pc \in ActiveClearPhases
FirstSnapshotMatches(p) ==
  /\ disk.generation = runtime[p].clear.expectedGeneration
  /\ disk.pending = runtime[p].clear.expectedPending
FinalSnapshotMatches(p) ==
  /\ disk.generation = runtime[p].clear.expectedGeneration
  /\ disk.pending

Init ==
  /\ disk = [generation |-> 0, pending |-> FALSE, files |-> Groups,
              evidence |-> {0}, settings |-> InitialSettings]
  /\ runtime = [p \in Processes |->
                  [blocked |-> FALSE, callback |-> IdleCallback, clear |-> IdleClear]]
  /\ owner = NoOwner
  /\ gate = NoOwner
  /\ attempts = 0
  /\ completedGeneration = 0
  /\ unauthorizedDeletion = FALSE
  /\ partialDeletion = FALSE

(* engine.control request_clear captures the config snapshot. *)
Request(p, session) ==
  /\ attempts < MaxClears
  /\ runtime[p].clear.pc \in {"idle", "confirmation"}
  /\ runtime' = [runtime EXCEPT ![p].clear =
       [IdleClear EXCEPT !.pc = "confirmation", !.valid = TRUE,
        !.session = session, !.expectedGeneration = disk.generation,
        !.expectedPending = disk.pending]]
  /\ attempts' = attempts + 1
  /\ UNCHANGED <<disk, owner, gate, completedGeneration, unauthorizedDeletion, partialDeletion>>

Expire(p) ==
  /\ runtime[p].clear.pc = "confirmation"
  /\ runtime[p].clear.valid
  /\ runtime' = [runtime EXCEPT ![p].clear.valid = FALSE]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* Wrong-token/local-invalidation rejection is represented by the same exit. *)
RejectToken(p) ==
  /\ runtime[p].clear.pc = "confirmation"
  /\ runtime' = [runtime EXCEPT ![p].clear =
       [IdleClear EXCEPT !.cause = "rejected", !.reported = "needs_context"]]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

Confirm(p, session) ==
  /\ runtime[p].clear.pc = "confirmation"
  /\ IF runtime[p].clear.valid /\
          (session = runtime[p].clear.session \/ Fault = "authorization")
     THEN runtime' = [runtime EXCEPT ![p].blocked = TRUE,
            ![p].clear.pc = "drain", ![p].clear.valid = FALSE,
            ![p].clear.authorized = (session = runtime[p].clear.session),
            ![p].clear.session = "session1"]
     ELSE runtime' = [runtime EXCEPT ![p].clear =
            [IdleClear EXCEPT !.cause = "rejected", !.reported = "needs_context"]]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* engine.control confirm_clear blocks locally before the active-operation drain. *)
Drain(p) ==
  /\ runtime[p].clear.pc = "drain"
  /\ runtime[p].callback.pc = "idle"
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "owner"]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* config.clearData acquires clear-owner.sqlite before clear-lock.sqlite. *)
AcquireOwner(p) ==
  /\ runtime[p].clear.pc = "owner"
  /\ owner = NoOwner
  /\ owner' = p
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "firstGate"]
  /\ UNCHANGED <<disk, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

AcquireFirstGate(p) ==
  /\ runtime[p].clear.pc = "firstGate"
  /\ gate = NoOwner /\ Readers = {}
  /\ gate' = p
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "pause"]
  /\ UNCHANGED <<disk, owner, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

PublishPause(p) ==
  /\ runtime[p].clear.pc = "pause"
  /\ FirstSnapshotMatches(p)
  /\ disk' = [disk EXCEPT !.pending = TRUE]
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "firstRelease"]
  /\ UNCHANGED <<owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

ReleaseFirstGate(p) ==
  /\ runtime[p].clear.pc = "firstRelease"
  /\ gate' = NoOwner
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "first-database"]
  /\ UNCHANGED <<disk, owner, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

AcquireFinalGate(p) ==
  /\ runtime[p].clear.pc = "finalGate"
  /\ gate = NoOwner /\ Readers = {}
  /\ gate' = p
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "finalValidate"]
  /\ UNCHANGED <<disk, owner, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

ValidateFinal(p) ==
  /\ runtime[p].clear.pc = "finalValidate"
  /\ FinalSnapshotMatches(p)
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "database"]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* config.clearData performs one unlink/rmdir per action, including both DB passes,
   two children of one bounded worker, and each diagnostic rotation.
   Reads/stat calls stutter; errors between deletions remain visible. *)
DeleteFile(p, phase, file, nextPhase) ==
  /\ runtime[p].clear.pc = phase
  /\ partialDeletion' = TRUE
  /\ LET remaining == disk.files \ {file}
     IN disk' = [disk EXCEPT !.files = remaining,
                   !.evidence = IF remaining \cap DatabaseFiles = {} THEN {} ELSE @]
  /\ unauthorizedDeletion' = (unauthorizedDeletion \/ ~runtime[p].clear.authorized)
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = nextPhase]
  /\ UNCHANGED <<owner, gate, attempts, completedGeneration>>

(* config.clearData JSON publication can survive later COMMIT/close failure. *)
PublishFinal(p) ==
  /\ runtime[p].clear.pc = "publish"
  /\ partialDeletion' = FALSE
  /\ FinalSnapshotMatches(p)
  /\ disk.generation < MaxClears
  /\ disk' = [disk EXCEPT !.generation = @ + 1, !.pending = FALSE,
                !.settings.api_key = IF Fault = "settings" THEN "" ELSE @]
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "finalUnlock"]
  /\ UNCHANGED <<owner, gate, attempts, completedGeneration, unauthorizedDeletion>>

UnlockFinalGate(p) ==
  /\ runtime[p].clear.pc = "finalUnlock"
  /\ gate' = NoOwner
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "ownerUnlock"]
  /\ UNCHANGED <<disk, owner, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

UnlockOwner(p) ==
  /\ runtime[p].clear.pc = "ownerUnlock"
  /\ owner' = NoOwner
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "return", ![p].clear.cause = "success"]
  /\ UNCHANGED <<disk, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

StaleSnapshot(p) ==
  /\ \/ (runtime[p].clear.pc = "pause" /\ ~FirstSnapshotMatches(p))
     \/ (runtime[p].clear.pc \in {"finalValidate", "publish"} /\ ~FinalSnapshotMatches(p))
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "cleanup", ![p].clear.cause = "stale"]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* Includes lock/open/rename/unlink errors before pause, after partial deletion,
   and after final publication; files and published JSON are never rolled back. *)
Fail(p) ==
  /\ runtime[p].clear.pc \in ErrorCuts
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "cleanup", ![p].clear.cause = "failure"]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

CleanupAfterError(p) ==
  /\ runtime[p].clear.pc = "cleanup"
  /\ gate' = IF gate = p THEN NoOwner ELSE gate
  /\ owner' = IF owner = p THEN NoOwner ELSE owner
  /\ runtime' = [runtime EXCEPT ![p].clear.pc = "return"]
  /\ UNCHANGED <<disk, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* OS process exit drops private state and coordination locks, while committed
   files/JSON survive. Power-loss durability and lock-release ordering are
   assumptions, not operations implemented by TypeScript. *)
Crash(p) ==
  /\ Clearing(p) \/ runtime[p].callback.pc # "idle"
  /\ gate' = IF gate = p THEN NoOwner ELSE gate
  /\ owner' = IF owner = p THEN NoOwner ELSE owner
  /\ runtime' = [runtime EXCEPT ![p] =
       [blocked |-> disk.pending, callback |-> IdleCallback, clear |-> IdleClear]]
  /\ UNCHANGED <<disk, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* engine.control confirm_clear unblocks and returns success on normal completion. *)
Return(p) ==
  /\ runtime[p].clear.pc = "return"
  /\ LET c == runtime[p].clear
         isSuccess == c.cause = "success"
         newBlocked == IF isSuccess THEN FALSE
                       ELSE IF c.cause = "stale" THEN disk.pending ELSE runtime[p].blocked
         report == IF isSuccess \/ (c.cause = "failure" /\ Fault = "failure") THEN "ok"
                   ELSE IF c.cause = "stale" THEN "needs_context" ELSE "unavailable"
     IN /\ runtime' = [runtime EXCEPT ![p].blocked = newBlocked,
                ![p].clear = [IdleClear EXCEPT !.cause = c.cause, !.reported = report,
                              !.pausedAtReturn = newBlocked]]
        /\ completedGeneration' =
             IF isSuccess /\ c.expectedGeneration + 1 > completedGeneration
             THEN c.expectedGeneration + 1 ELSE completedGeneration
  /\ UNCHANGED <<disk, owner, gate, attempts, unauthorizedDeletion, partialDeletion>>

(* A peer may retain this captured generation until after another clear returns. *)
CaptureCallback(p) ==
  /\ runtime[p].callback.pc = "idle"
  /\ ~runtime[p].blocked /\ ~Clearing(p)
  /\ runtime' = [runtime EXCEPT ![p].callback = [pc |-> "waiting", captured |-> disk.generation]]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* config.withDataAccess holds shared ownership through validation and awaited work. *)
AcquireSharedGate(p) ==
  /\ runtime[p].callback.pc = "waiting"
  /\ gate = NoOwner
  /\ runtime' = [runtime EXCEPT ![p].callback.pc = "check"]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

CheckCallback(p) ==
  /\ runtime[p].callback.pc = "check"
  /\ IF ~disk.pending /\
          (runtime[p].callback.captured = disk.generation \/ Fault = "generation")
     THEN runtime' = [runtime EXCEPT ![p].callback.pc = "work"]
     ELSE runtime' = [runtime EXCEPT ![p].callback = IdleCallback,
            ![p].blocked = IF Clearing(p) THEN @ ELSE disk.pending]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

WriteCallback(p) ==
  /\ runtime[p].callback.pc = "work"
  /\ disk' = [disk EXCEPT !.evidence = @ \cup {runtime[p].callback.captured},
                !.files = @ \cup DatabaseFiles \cup {"key"}]
  /\ runtime' = [runtime EXCEPT ![p].callback.pc = "release"]
  /\ UNCHANGED <<owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

ReleaseCallback(p) ==
  /\ runtime[p].callback.pc \in {"waiting", "work", "release"}
  /\ runtime' = [runtime EXCEPT ![p].callback = IdleCallback]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

(* engine.syncStorageGeneration can clear a purely local block on later refresh. *)
SyncPause(p) ==
  /\ ~Clearing(p)
  /\ runtime[p].blocked # disk.pending
  /\ runtime' = [runtime EXCEPT ![p].blocked = disk.pending]
  /\ UNCHANGED <<disk, owner, gate, attempts, completedGeneration, unauthorizedDeletion, partialDeletion>>

Next ==
  \E p \in Processes :
    \/ (\E session \in Sessions : Request(p, session) \/ Confirm(p, session))
    \/ Expire(p) \/ RejectToken(p) \/ Drain(p) \/ AcquireOwner(p)
    \/ AcquireFirstGate(p) \/ PublishPause(p) \/ ReleaseFirstGate(p)
    \/ DeleteFile(p, "first-database", "database", "first-wal")
    \/ DeleteFile(p, "first-wal", "wal", "first-shm")
    \/ DeleteFile(p, "first-shm", "shm", "finalGate")
    \/ AcquireFinalGate(p) \/ ValidateFinal(p)
    \/ DeleteFile(p, "database", "database", "wal")
    \/ DeleteFile(p, "wal", "wal", "shm")
    \/ DeleteFile(p, "shm", "shm", "worker-schema")
    \/ DeleteFile(p, "worker-schema", "worker-schema", "worker-output")
    \/ DeleteFile(p, "worker-output", "worker-output", "worker-directory")
    \/ DeleteFile(p, "worker-directory", "worker-directory", "key")
    \/ DeleteFile(p, "key", "key", "progress")
    \/ DeleteFile(p, "progress", "progress", "diagnostics")
    \/ DeleteFile(p, "diagnostics", "diagnostics", "diagnostics-rotated")
    \/ DeleteFile(p, "diagnostics-rotated", "diagnostics-rotated", "publish")
    \/ PublishFinal(p) \/ UnlockFinalGate(p) \/ UnlockOwner(p)
    \/ StaleSnapshot(p) \/ Fail(p) \/ CleanupAfterError(p) \/ Crash(p) \/ Return(p)
    \/ CaptureCallback(p) \/ AcquireSharedGate(p) \/ CheckCallback(p)
    \/ WriteCallback(p) \/ ReleaseCallback(p) \/ SyncPause(p)

Spec == Init /\ [][Next]_vars

(* The oracles do not inspect Fault; faults change only protocol actions. *)
AUTHORIZATION == ~unauthorizedDeletion
NO_STALE_WRITE == disk.evidence \subseteq completedGeneration..MaxClears
FAILURE_SAFE ==
  /\ (partialDeletion => disk.pending)
  /\ \A p \in Processes :
       LET c == runtime[p].clear
       IN /\ (c.reported = "ok" => c.cause = "success")
          /\ (c.cause = "failure" /\ c.reported # "none" =>
                c.reported = "unavailable" /\ c.pausedAtReturn)
  /\ \A p \in Processes : runtime[p].callback.pc = "work" => ~disk.pending
SETTINGS_RETAINED == disk.settings = InitialSettings

ProcessSymmetry == Permutations(Processes)
=============================================================================
