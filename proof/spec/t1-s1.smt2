; THEOREM 1 -- scenario S1 (growth stability): history H = [user, assistant,
; assistant], new message m = user. The merge anchor FLIPS: lastUser(H) is
; element 0, lastUser(H+[m]) is the new element.
;   Run A = f(H):     nudge/hint merges into element 0's content tail.
;   Run B = f(H+[m]): merge lands in the NEW element; element 0 stays clean.
; Carrier families (existentially quantified: free per run):
;   MERGE -- nudge/hint text appended to the last-user turn's content
;            (src/wire-body.ts appendTrailingUserText; degenerate-retry;
;             fake-completion)
;   TAIL  -- trailing user element (imgNote conditional / chain-checkpoint
;            stamp / fresh-turn fallback): optional, present or absent per run

(declare-const R_USER Int)
(declare-const R_ASSIST Int)
(assert (distinct R_USER R_ASSIST))
(declare-const r0 Int)
(declare-const r1 Int)
(declare-const r2 Int)
(declare-const rm Int)
(assert (= r0 R_USER))
(assert (= r1 R_ASSIST))
(assert (= r2 R_ASSIST))
(assert (= rm R_USER))

; stable raw message data -- identical in both runs (same session state)
(declare-const c0 BSeq)
(declare-const c1 BSeq)
(declare-const c2 BSeq)
(declare-const t0 BSeq)
(declare-const t1 BSeq)
(declare-const t2 BSeq)
(declare-const cm BSeq)
(declare-const tm BSeq)

; ref numbers: old ones distinct; fresh number for m exceeds every old one
; (grounded in kernel/src/refs.ts: existing bindings untouched, allocateFreeRef
; scans upward from the persisted cursor)
(declare-const rho0 Int)
(declare-const rho1 Int)
(declare-const rho2 Int)
(declare-const rhom Int)
(assert (and (>= rho0 1) (>= rho1 1) (>= rho2 1) (>= rhom 1)))
(assert (distinct rho0 rho1 rho2 rhom))
(assert (and (> rhom rho0) (> rhom rho1) (> rhom rho2)))

; model + config bytes (shared across runs)
(declare-const MB BSeq)
(declare-const CFG BSeq)

; impure points at the interface (owner stance: x at the interface -- free
; functions / free inputs instantiated per run, no pure extraction):
;   wall clock advances between the two runs
(declare-const nowA Int)
(declare-const nowB Int)
;   checkpoint-tag render: free function of the clock (stampOutbound nowMs arg,
;   src/chain-checkpoint.ts)
(declare-fun ckpt (Int) BSeq)

; carrier contents (free per run)
(declare-const CMergeA BSeq)
(declare-const CMergeB BSeq)
(declare-const CTailA BSeq)
(declare-const CTailB BSeq)
(declare-const hasTailA Bool)
(declare-const hasTailB Bool)

; --- elements. Shared subterms are referenced by BOTH bodies: the proof
; hinges on congruence over these identical subterms. ---
(define-fun elem1 () BSeq
  (bconcat (bconcat (bconcat (fpre r1) (esc c1)) (fmid r1))
           (bconcat (esc t1) (fpost r1 (mktag rho1)))))
(define-fun elem2 () BSeq
  (bconcat (bconcat (bconcat (fpre r2) (esc c2)) (fmid r2))
           (bconcat (esc t2) (fpost r2 (mktag rho2)))))

; element 0: clean (run B) vs carrier-merged (run A). By E1,
; esc(c0 ++ C) = esc(c0) ++ esc(C): carrier bytes sit AFTER the stable ones.
(define-fun elem0B () BSeq
  (bconcat (bconcat (bconcat (fpre r0) (esc c0)) (fmid r0))
           (bconcat (esc t0) (fpost r0 (mktag rho0)))))
(define-fun elem0A () BSeq
  (bconcat (bconcat (bconcat (bconcat (fpre r0) (esc c0)) (esc CMergeA))
                    (fmid r0))
           (bconcat (esc t0) (fpost r0 (mktag rho0)))))

; the new element (run B only); the merge lands in its content tail
(define-fun elemM () BSeq
  (bconcat (bconcat (bconcat (bconcat (fpre rm) (esc cm)) (esc CMergeB))
                    (fmid rm))
           (bconcat (esc tm) (fpost rm (mktag rhom)))))

; trailing elements (optional per run)
(define-fun tailA () BSeq
  (bconcat (bconcat (bconcat (fpre R_USER) (esc CTailA)) (fmid R_USER))
           (fpost R_USER (ckpt nowA))))
(define-fun tailB () BSeq
  (bconcat (bconcat (bconcat (fpre R_USER) (esc CTailB)) (fmid R_USER))
           (fpost R_USER (ckpt nowB))))

; --- bodies ---
(define-fun bodyA () BSeq
  (bconcat (bconcat (bconcat (hdr MB CFG) elem0A) SEP)
           (bconcat (bconcat (bconcat elem1 SEP) elem2)
                    (bconcat (ite hasTailA (bconcat SEP tailA) bempty)
                             (ftr CFG)))))
(define-fun bodyB () BSeq
  (bconcat (bconcat (bconcat (hdr MB CFG) elem0B) SEP)
           (bconcat (bconcat (bconcat (bconcat elem1 SEP) elem2) SEP)
                    (bconcat (bconcat elemM (ite hasTailB (bconcat SEP tailB) bempty))
                             (ftr CFG)))))

; guaranteed-stable depth: envelope head + stable content of the merge anchor
(define-fun D () Int
  (+ (blen (hdr MB CFG)) (blen (fpre r0)) (blen (esc c0))))

; explicit common-prefix term whose length is exactly D (used by the theorem /
; mutation files)
(define-fun P () BSeq (bconcat (bconcat (hdr MB CFG) (fpre r0)) (esc c0)))
