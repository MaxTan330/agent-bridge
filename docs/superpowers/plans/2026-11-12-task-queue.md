# Task queue implementation plan

**Goal:** Busy messages enter a bounded FIFO queue and execute automatically; users can inspect and cancel queued tasks.

**Design:** Preserve one active runtime and existing completion/cleanup ordering. Persist queued task metadata and deduplication atomically; keep prompts in memory. Add /queue, /cancel <id>, /cancel all and scoped status. Default global limit: 20 queued tasks. Stop/restart interrupts pending work without replay, recording a retrievable result. Queue inspection/cancellation is restricted to the same account/chat/thread and owner (or configured admin for individual tasks); cancel all affects only the caller's queue.

- [x] Write failing queue tests: FIFO, deduplication, visibility, cancellation, capacity, failures, stop/restart.
- [x] Extend task states/store and implement queue admission, draining and commands.
- [x] Update existing tests and user documentation; preserve release configuration changes.
- [x] Run typecheck, 117 tests, build and bundle smoke check; review queue races and lifecycle boundaries. Review found and fixed result ordering after queued cancellation, with a failing-then-passing recovery regression test. Eleven queue tests pass; live Feishu delivery has not been exercised.
