; THEOREM 2 (host discipline): with the persisted MONOTONE cursor -- grounded
; in src/session.ts (state.nextIndex carried verbatim into assignRefs;
; cursor := allocated+1; retire/archive never move it) -- no allocation in the
; session reissues an ever-issued number, even though the session high died.
; Negated conclusion below; expectation UNSAT.
;
; Allocation rule (kernel/src/refs.ts allocateFreeRef), unfolded GROUND form
; over the finite live sets (the scan walks up from the floor; a winner above
; candidate k means every earlier candidate -- k included -- was taken):
;   (FLOOR)  n >= floor
;   (FREE)   n not in the current live number set
;   (SMALL)  n > k ==> k in the current live number set
; Live sets, unfolded from the store chain in t2.smt2:
;   M2: idB->2, idC->3            (idA retired; nothing else ever bound)
;   M3: idB->2, idC->3, q1->n3

; step 3: append q1; floor = c1 (persisted cursor = 6)
(declare-const n3 Int)
(assert (>= n3 c1))
(assert (and (not (= n3 2)) (not (= n3 3))))
(assert (=> (> n3 c1) (or (= c1 2) (= c1 3))))
(assert (=> (> n3 (+ c1 1)) (or (= (+ c1 1) 2) (= (+ c1 1) 3))))
(declare-const c2 Int)
(assert (= c2 (+ n3 1)))

; step 4: append q2
(declare-const n4 Int)
(assert (>= n4 c2))
(assert (and (not (= n4 2)) (not (= n4 3)) (not (= n4 n3))))
(assert (=> (> n4 c2) (or (= c2 2) (= c2 3) (= c2 n3))))
(assert (=> (> n4 (+ c2 1)) (or (= (+ c2 1) 2) (= (+ c2 1) 3) (= (+ c2 1) n3))))

; NEGATED conclusion: SOME allocation reissues an ever-issued number
(assert (or (= n3 2) (= n3 3) (= n3 5)
            (= n4 2) (= n4 3) (= n4 5) (= n4 n3)))
