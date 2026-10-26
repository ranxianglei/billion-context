; MUTATION (S1): a regression that rewrites element 0's STABLE content in run
; B -- same length, different bytes (a stable-region corruption at the spec
; level; WHICH byte changed is existentially hidden at this abstraction, the
; concrete byte surface is pinned by the #2144 suite). Expectation SAT: the
; corrupted run fails the guaranteed-prefix property -- the proof is falsifiable.
(declare-const c0bad BSeq)
(assert (and (not (= c0bad (esc c0))) (= (blen c0bad) (blen (esc c0)))))
(define-fun elem0Bm () BSeq
  (bconcat (bconcat (bconcat (fpre r0) c0bad) (fmid r0))
           (bconcat (esc t0) (fpost r0 (mktag rho0)))))
(define-fun bodyBm () BSeq
  (bconcat (bconcat (bconcat (hdr MB CFG) elem0Bm) SEP)
           (bconcat (bconcat (bconcat (bconcat elem1 SEP) elem2) SEP)
                    (bconcat (bconcat elemM (ite hasTailB (bconcat SEP tailB) bempty))
                             (ftr CFG)))))
; single-side form: the uncorrupted side satisfies the property by the theorem
; file, so this conjunct's failure IS the pair property's failure.
(assert (not (= (bextract bodyBm 0 (blen P)) P)))
