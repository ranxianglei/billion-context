; esc axioms E0-E3 (see preamble header for meanings). Kept separate from the
; theorem runs: they are quantified over String and are NOT needed for any
; obligation (proofs are congruence arguments; carrier merges are spelled out
; esc(c) ++ esc(C) BY CONSTRUCTION in the element definitions). This file
; exists so their mutual consistency stays machine-checked [esc-axioms-
; consistency] and so the grounding map in ../README.md has a concrete target.
(assert (= (esc bempty) bempty))
(assert (forall ((a BSeq) (b BSeq)) (= (esc (bconcat a b)) (bconcat (esc a) (esc b)))))
(assert (forall ((a BSeq) (b BSeq)) (=> (= (esc a) (esc b)) (= a b))))
(assert (forall ((s BSeq)) (and (<= (blen s) (blen (esc s))) (<= (blen (esc s)) (* 6 (blen s))))))
