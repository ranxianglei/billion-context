; THEOREM 1 -- scenario S2 (growth stability): history H = [user, assistant,
; user], new message m = assistant. The merge anchor is STATIONARY at element
; 2 in both runs (m does not become the last user turn): both runs merge their
; carrier into element 2's content tail, so the two bodies differ only in the
; carrier bytes themselves and in everything after the new element.

(declare-const R_USER Int)
(declare-const R_ASSIST Int)
(assert (distinct R_USER R_ASSIST))
(declare-const r0 Int)
(declare-const r1 Int)
(declare-const r2 Int)
(declare-const rm Int)
(assert (= r0 R_USER))
(assert (= r1 R_ASSIST))
(assert (= r2 R_USER))
(assert (= rm R_ASSIST))

(declare-const c0 BSeq)
(declare-const c1 BSeq)
(declare-const c2 BSeq)
(declare-const t0 BSeq)
(declare-const t1 BSeq)
(declare-const t2 BSeq)
(declare-const cm BSeq)
(declare-const tm BSeq)

(declare-const rho0 Int)
(declare-const rho1 Int)
(declare-const rho2 Int)
(declare-const rhom Int)
(assert (and (>= rho0 1) (>= rho1 1) (>= rho2 1) (>= rhom 1)))
(assert (distinct rho0 rho1 rho2 rhom))
(assert (and (> rhom rho0) (> rhom rho1) (> rhom rho2)))

(declare-const MB BSeq)
(declare-const CFG BSeq)

(declare-const nowA Int)
(declare-const nowB Int)
(declare-fun ckpt (Int) BSeq)

(declare-const CMergeA BSeq)
(declare-const CMergeB BSeq)
(declare-const CTailA BSeq)
(declare-const CTailB BSeq)
(declare-const hasTailA Bool)
(declare-const hasTailB Bool)

; shared elements (identical subterms in both bodies)
(define-fun elem0 () BSeq
  (bconcat (bconcat (bconcat (fpre r0) (esc c0)) (fmid r0))
           (bconcat (esc t0) (fpost r0 (mktag rho0)))))
(define-fun elem1 () BSeq
  (bconcat (bconcat (bconcat (fpre r1) (esc c1)) (fmid r1))
           (bconcat (esc t1) (fpost r1 (mktag rho1)))))

; merge-anchor element 2: stable content + per-run carrier tail
(define-fun elem2A () BSeq
  (bconcat (bconcat (bconcat (bconcat (fpre r2) (esc c2)) (esc CMergeA))
                    (fmid r2))
           (bconcat (esc t2) (fpost r2 (mktag rho2)))))
(define-fun elem2B () BSeq
  (bconcat (bconcat (bconcat (bconcat (fpre r2) (esc c2)) (esc CMergeB))
                    (fmid r2))
           (bconcat (esc t2) (fpost r2 (mktag rho2)))))

; the new element (run B only); no merge lands here (m is not a user turn)
(define-fun elemM () BSeq
  (bconcat (bconcat (bconcat (fpre rm) (esc cm)) (fmid rm))
           (bconcat (esc tm) (fpost rm (mktag rhom)))))

(define-fun tailA () BSeq
  (bconcat (bconcat (bconcat (fpre R_USER) (esc CTailA)) (fmid R_USER))
           (fpost R_USER (ckpt nowA))))
(define-fun tailB () BSeq
  (bconcat (bconcat (bconcat (fpre R_USER) (esc CTailB)) (fmid R_USER))
           (fpost R_USER (ckpt nowB))))

(define-fun bodyA () BSeq
  (bconcat (bconcat (bconcat (bconcat (hdr MB CFG) elem0) SEP)
                    (bconcat (bconcat elem1 SEP) elem2A))
           (bconcat (ite hasTailA (bconcat SEP tailA) bempty)
                    (ftr CFG))))
(define-fun bodyB () BSeq
  (bconcat (bconcat (bconcat (bconcat (hdr MB CFG) elem0) SEP)
                    (bconcat (bconcat (bconcat (bconcat elem1 SEP) elem2B) SEP)
                             elemM))
           (bconcat (ite hasTailB (bconcat SEP tailB) bempty)
                    (ftr CFG))))

; guaranteed-stable depth: envelope head + elements 0,1 + stable content of
; the (stationary) merge anchor
(define-fun D () Int
  (+ (blen (hdr MB CFG)) (blen elem0) (blen SEP) (blen elem1) (blen SEP)
     (blen (fpre r2)) (blen (esc c2))))

; explicit common-prefix term whose length is exactly D (used by the theorem /
; mutation files)
(define-fun P () BSeq
  (bconcat (bconcat (bconcat (bconcat (bconcat (bconcat (hdr MB CFG) elem0) SEP) elem1) SEP)
            (fpre r2))
           (esc c2)))
