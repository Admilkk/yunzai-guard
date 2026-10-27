These are maintainer qualification tools, never runtime plugin dependencies.

`linux-qualified-profiles.c` is a pure source component for the two fixed Linux
daemon image SHA-to-profile choices. It includes the production source but calls
only the immutable table lookup: no process discovery, pidfd, signal or Inspector
action. Compile privately with the pinned Zig static x86_64-linux-musl target;
exact musl/glibc SHA values select their different fixed ids, unknown/partial/hash
suffix values refuse. This component is not final native process qualification.

`linux-identity-probe.mjs` retains the existing musl actual-parent qualification.
The separate glibc private qualification records the official archive SHA, actual
Ubuntu loader/library hashes, owned parent SIGUSR1 and exact WebSocket PID with
fresh confirmations. Before a final bundle is accepted, run both actual images
against that same rebuilt helper; VM/systemd/PM2/business coverage remains separate.

`linux-fixture-reclaim.c` replaces the fixture's Python-only emergency reclaimer.
Compile a separate static `x86_64-linux-musl` artifact with the pinned existing Zig
toolchain. Keep source/toolchain/arguments/output hashes beside each qualification.
It has no arguments and accepts exactly one bounded JSONL record on private stdin:

```
{"protocol":1,"nonce":"48 lowercase hex","bootId":"current boot UUID","budgetMs":15000,"records":[{"pid":123,"startTicks":"456","pidNamespace":"dev:ino"}]}
```

Only the trusted fixture may supply records from its historically validated scope
ledger. Parent relationships may legitimately change after orphaning; do not replace
the ledger with a new current-PPID guess. The program verifies current boot/namespace,
exact start ticks, held pidfd liveness, and sends only fixed SIGKILL through that
same pidfd. It never signals a numeric PID or accepts a signal/path/command parameter.
It refuses its own and its caller's PIDs. All records share the initial <=15 second
deadline, with <=5 seconds per same-pidfd exit wait. No deadline is renewed.

An empty `records` array performs only `pidfd_open(getpid())`, fixed signal 0 on
that same self pidfd, `poll(0)` (must remain live), and close. On success it adds
`nativeEligibility:"pidfd-self-open-send0-poll"`. Run this before preparing a real
fixture so missing ABI/permissions are found early. It proves self capability only;
the separate owned-target negative and fixed SIGKILL qualification remains required.

`already-gone-unconfirmed` does not identify the historical process after a failed
new pidfd open, and `sent-exit-unconfirmed` is not confirmed cleanup. A successful
known-ledger recovery cannot repair an incomplete process census; its output always
keeps `scopeObservationComplete:false`. This helper is deliberately excluded from
the production native process identity manifest and closed Inspector protocol.
