; MUTATION (S2): a regression that rewrites the MIDDLE element's STABLE
; content in BOTH runs -- same length, different bytes, strictly before D.
; Expectation SAT with the corruption visible in the model (c1bad != esc(c1)).
(declare-const c1bad BSeq)
(assert (and (not (= c1bad (esc c1))) (= (blen c1bad) (blen (esc c1)))))
(define-fun elem1bad () BSeq
  (bconcat (bconcat (bconcat (fpre r1) c1bad) (fmid r1))
           (bconcat (esc t1) (fpost r1 (mktag rho1)))))
(define-fun bodyAm () BSeq
  (bconcat (bconcat (bconcat (bconcat (hdr MB CFG) elem0) SEP)
                    (bconcat (bconcat elem1bad SEP) elem2A))
           (bconcat (ite hasTailA (bconcat SEP tailA) bempty)
                    (ftr CFG))))
(define-fun bodyBm () BSeq
  (bconcat (bconcat (bconcat (bconcat (hdr MB CFG) elem0) SEP)
                    (bconcat (bconcat (bconcat (bconcat elem1bad SEP) elem2B) SEP)
                             elemM))
           (bconcat (ite hasTailB (bconcat SEP tailB) bempty)
                    (ftr CFG))))
; the corrupted run fails the guaranteed-prefix property -- expected SAT.
; (Sound single-side form: the uncorrupted side satisfies the property by the
; theorem file, so this conjunct's failure IS the pair property's failure.)
(assert (not (= (bextract bodyAm 0 (blen P)) P)))
