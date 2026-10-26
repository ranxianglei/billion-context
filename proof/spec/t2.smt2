; THEOREM 2 -- ref allocation session model.
; Grounded in kernel/src/refs.ts (assignRefs / allocateFreeRef /
; highestUsedIndex) and src/session.ts applyCompactionArchive (#421).
;
; Session shape (SAME operation sequence in all variants):
;   M0:  idA->5, idB->2, idC->3, persisted cursor c0=6
;        (numbers 2,3,5 were allocated earlier in the session; the cursor sits
;         above every one of them -- the invariant the host maintains)
;   step 1: RETIRE idA -- the session HIGH dies (fold/death removes its binding)
;   step 2: ARCHIVE (#421) -- prune the live map to surviving raw ids
;            (numeric no-op on this instance; the pruning's effect on the
;             cursor is exactly what the variants disagree about)
;   step 3: APPEND q1 -> allocates n3
;   step 4: APPEND q2 -> allocates n4
;
; Variants:
;   t2-host.smt2    persisted MONOTONE cursor (state.nextIndex carried verbatim,
;                   cursor := n+1 after each allocation, retire/archive never
;                   move it) => negation of "some allocation reissues an
;                   ever-issued number" expected UNSAT.
;   t2-mutation.smt2 cursor RECOMPUTED from the pruned map after the archive
;                    (highestUsedIndex+1 -- the #421 residual) => reuse
;                    expected SAT; the model exhibits n4 = 5 (idA's dead number).

(declare-sort RawId 0)
(declare-const UNDEF Int)
(declare-const BLOCKED Int)
(assert (= UNDEF -1))
(assert (= BLOCKED -2))

(declare-const idA RawId)
(declare-const idB RawId)
(declare-const idC RawId)
(assert (distinct idA idB idC))
(declare-const c0 Int)
(assert (= c0 6))
; step 1: retire idA -- the persisted cursor does not move
(declare-const c1 Int)
(assert (= c1 c0))

(declare-const q1 RawId)
(declare-const q2 RawId)
(assert (and (not (= q1 idA)) (not (= q1 idB)) (not (= q1 idC))
             (not (= q2 idA)) (not (= q2 idB)) (not (= q2 idC))
             (not (= q2 q1))))

; NOTE: the live maps themselves (M0 -> M1 -> M2 via retire/archive) are NOT
; formally asserted here -- the variant files state their consequences in GROUND
; form over the finite live sets (only integers, no array quantifiers): the
; ground facts below are mechanical unfoldings of exactly this store chain.

; yardstick: numbers ever issued before this session -- ISSUED0 = {2, 3, 5}
