; THEOREM 1 (S1): growth stability -- negated form; expectation UNSAT.
; P (defined in t1-s1.smt2) is the explicit common-prefix term: envelope head +
; stable content of the merge-anchor element; blen(P) = D. The statement says
; the first blen(P) bytes of BOTH bodies equal P -- the decidable form of
; "common byte prefix of depth at least D": Z3's string solver normalizes
; substr at boundaries aligned with the concat structure, whereas quantifying
; over a symbolic p is beyond its decision procedure (returns unknown).
(assert (not (and (= (bextract bodyA 0 (blen P)) P)
                  (= (bextract bodyB 0 (blen P)) P))))
