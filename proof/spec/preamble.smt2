; billion-context cache-stability theorems (#2149) -- shared preamble.
; Byte-level model of the outbound-body assembly contract. Conservative SMT2
; (uninterpreted functions + sequences + arrays + linear integer arithmetic);
; targets Z3 4.8+. Trust boundary and grounding map: see ../README.md.

(set-option :produce-models true)
(set-option :timeout 60000)

(define-sort BSeq () String)

(define-fun bempty () BSeq "")
(define-fun bconcat ((a BSeq) (b BSeq)) BSeq (str.++ a b))
(define-fun blen ((s BSeq)) Int (str.len s))
(define-fun bunit ((x Int)) BSeq (str.from_code x))
(define-fun bextract ((s BSeq) (i Int) (j Int)) BSeq (str.substr s i j))

; JSON array-element separator between serialized messages (fixed per wire).
(declare-const SEP BSeq)
(assert (= SEP (bunit 44)))

; esc: the char-wise string encoder inside the JSON document (V8 string
; escaping as used by JSON.stringify on each content/tools field).
;   E0  empty maps to empty
;   E1  homomorphism: esc(a ++ b) = esc(a) ++ esc(b)   (per-char processing)
;   E2  injectivity (escaping is deterministic and reversible)
;   E3  length bounds: |s| <= |esc(s)| <= 6|s|         (\uXXXX worst case)
; GROUNDING [g3] in tests/cache-theorem.test.ts pins E1/E2 against the real
; serializer on randomized inputs.
(declare-fun esc (BSeq) BSeq)
; NOTE: the esc AXIOMS (E0-E3) live in esc-axioms.smt2, deliberately
; OUTSIDE the theorem runs: the proofs are congruence arguments over shared
; subterms and need no quantified axioms, and keeping them out keeps every
; obligation quantifier-free and fast. See ../README.md.

; Per-message element frame: elem = fpre(r) ++ contentBytes ++ fmid(r)
;                             ++ toolsBytes ++ fpost(r, tagBytes).
; Content bytes sit immediately after fpre: this placement is what makes the
; guaranteed-stable depth D land right after the stable content of the
; merge-anchor element. Pure deterministic framing -- no axioms needed.
(declare-fun fpre (Int) BSeq)
(declare-fun fmid (Int) BSeq)
(declare-fun fpost (Int BSeq) BSeq)

; Envelope head/tail outside the message array (model field, stream flag,
; tool surface, ...): pure functions of (modelBytes, cfgBytes). Same inputs
; in both runs => same bytes by congruence. GROUNDING: #2144 billing suite
; pins these empirically (byte-LCP unexplainedDivergences=0 across wires).
(declare-fun hdr (BSeq BSeq) BSeq)
(declare-fun ftr (BSeq) BSeq)

; ACP tag bytes: deterministic function of the ref number.
; GROUNDING [g2] pins determinism/injectivity to indexToRef (kernel/src/refs.ts).
(declare-fun mktag (Int) BSeq)
; NOTE: no injectivity axiom here. The theorems never need it (tags appear as
; shared subterms on both sides of every equality), and a quantified axiom over
; a String-typed function poisons SAT-mode model building in this solver build
; (every mutation check went unknown with it present, instant without).
; Determinism/injectivity of the real tag renderer is grounded separately
; ([grounding:g2] in tests/cache-theorem.test.ts vs indexToRef).