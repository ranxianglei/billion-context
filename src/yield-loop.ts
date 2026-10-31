// #4528: cooperative event-loop yield for long synchronous turns. Node is
// single-threaded: a turn over a large resent history runs many O(messages)
// passes back-to-back, and while any one of them holds the main thread no other
// request on the same listener (including the built-in web UI) can be accepted
// or answered. Deferring to setImmediate hands control to the poll phase so the
// queued I/O callbacks run before the next pass. setImmediate (NOT
// queueMicrotask/nextTick) is required — microtasks run before the poll phase
// and would starve I/O exactly as the bug does.
export function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}
