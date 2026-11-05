; MUTATION (T2): claim-state coupling made executable (#3198 proof hardening).
; If live-message ref PRESENTATION were gated on RECONCILE CLAIM state instead
; of the persistent content-keyed map (assignRefs: an existing byRaw entry
; always wins), a byte-identical live message could present under DIFFERENT
; refs across two consecutive turns -- breaking T1's shared-subterm congruence
; for its tag bytes even though the mid-history bytes never changed.
; Expectation SAT -- the model must exhibit equal content with unequal refs:
; turn A takes the map-lookup path (the stored, ever-issued number 5) while
; turn B takes the fresh-allocation path (a number >= cursor 6).
;
; The shipped rule has no such coupling: kernel/src/refs.ts assignRefs reads
; only the persistent map + persisted cursor, and kernel/src/wire/message-id.ts
; derives raw ids from message CONTENT (same bytes => same raw id => same map
; key => same stored ref). [grounding:g1] pins the allocator half,
; [grounding:g4] the id-derivation half. This twin proves the theorem WOULD
; break if the coupling were ever introduced (falsifiability discipline per
; ../README.md "Mutation discipline").

(declare-sort CMsg 0)
(declare-const H0 CMsg)
(declare-const H1 CMsg)
(assert (= H0 H1))            ; antecedent: mid-history bytes identical

(declare-const storedNum Int) ; persistent byRaw[rawId(H0)] binding (ISSUED0 member)
(assert (= storedNum 5))
(declare-const curNum Int)    ; monotone persisted cursor, above every issued number
(assert (= curNum 6))

(declare-const claimA Bool)   ; reconcile claim state at each turn
(declare-const claimB Bool)
(declare-const rA Int)        ; presented ref at each turn
(declare-const rB Int)
; COUPLED assignment rule (the injected defect): unclaimed -> map lookup,
; claimed -> fresh allocation from the cursor.
(assert (=> (not claimA) (= rA storedNum)))
(assert (=> claimA (>= rA curNum)))
(assert (=> (not claimB) (= rB storedNum)))
(assert (=> claimB (>= rB curNum)))

; THE DEFECT: same bytes, different presented refs across turns
(assert (and (= rA storedNum)        ; turn A took the map-lookup path
             (>= rB curNum)          ; turn B took the fresh-allocation path
             (not (= rA rB))))       ; => tag bytes differ mid-history
