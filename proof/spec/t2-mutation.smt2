; MUTATION (T2): the #421 residual made executable. After the archive prunes
; the live map (idA's number 5 gone, nothing above it allocated), the cursor is
; RECOMPUTED as highestUsedIndex(pruned)+1 instead of being carried verbatim.
; Expectation SAT -- the model must exhibit the reissued number (n4 = 5).
; Same ground-form allocation rule as t2-host.smt2.

; highestUsedIndex(M2) per kernel/src/refs.ts: max over live bindings.
; Ground unfolding: M2 binds exactly idB->2 and idC->3 (idA retired), so 3.
(declare-const hui Int)
(assert (= hui 3))
(declare-const creset Int)
(assert (= creset (+ hui 1)))

; step 3: append q1; floor = max(creset, MIN_INDEX=1)
(declare-const n3 Int)
(assert (>= n3 creset))
(assert (and (not (= n3 2)) (not (= n3 3))))
(assert (=> (> n3 creset) (or (= creset 2) (= creset 3))))
(assert (=> (> n3 (+ creset 1)) (or (= (+ creset 1) 2) (= (+ creset 1) 3))))
(declare-const c3 Int)
(assert (= c3 (+ n3 1)))

; step 4: append q2
(declare-const n4 Int)
(assert (>= n4 c3))
(assert (and (not (= n4 2)) (not (= n4 3)) (not (= n4 n3))))
(assert (=> (> n4 c3) (or (= c3 2) (= c3 3) (= c3 n3))))
(assert (=> (> n4 (+ c3 1)) (or (= (+ c3 1) 2) (= (+ c3 1) 3) (= (+ c3 1) n3))))

; SOME allocation reissues an ever-issued number -- expected SAT (n4 = 5)
(assert (or (= n3 2) (= n3 3) (= n3 5)
            (= n4 2) (= n4 3) (= n4 5) (= n4 n3)))
