; THEOREM 1 (S2): growth stability, stationary merge anchor -- negated form;
; expectation UNSAT. Same explicit-prefix statement as S1: the first blen(P)
; bytes of both bodies equal the shared term P (see t1-s2.smt2).
(assert (not (and (= (bextract bodyA 0 (blen P)) P)
                  (= (bextract bodyB 0 (blen P)) P))))
