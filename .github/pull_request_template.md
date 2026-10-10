## What and why

<!-- One paragraph. Link the issue if there is one. -->

## Honesty check

- [ ] Any new claim in docs or code comments is backed by code, a test, or a command I ran (quote the command).
- [ ] Enforcement is labelled correctly: hard (relay `transfer`, pinned `swap`) or advisory (everything that depends on an integrator calling `verify`).
- [ ] No "audited", "trustless", "mainnet-ready" or similar wording.

## Checks

- [ ] `make lint`
- [ ] `make test`
- [ ] `make e2e` (if an on-chain program, the SDK, the CLI or the demo changed)
- [ ] Locked interfaces untouched: core `verify` ABI, core account layout (2136 B), error codes 1..18. New error codes and instructions are appended.

## Security impact

<!-- None / describe. Security-sensitive changes (programs/, src/, crates/agent-auth-cpi) need a negative test that fails without the fix. -->
