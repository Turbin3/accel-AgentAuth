# Contributing

Thanks for looking. AgentAuth is an unaudited devnet prototype and a small project. Small, well-tested
changes are easiest to review. For security issues use [SECURITY.md](SECURITY.md), not a public issue.

The one rule that matters most: **do not make a claim in code, comments or docs that the code does not
enforce.** Hard enforcement exists only in the relay `transfer` and the pinned `swap`; everything that
depends on an integrator calling `verify` is advisory and must say so. Read
[docs/SECURITY.md](docs/SECURITY.md), sections 1, 3 and 11, before you write documentation.

## Layout

See the README for the overview. In short: `src/` is the core program; `programs/relay` the relay;
`programs/mock-amm`, `programs/evil-token` are test-only; `programs/gated-example` and
`crates/agent-auth-cpi` are the integrator example and library; `idl/` holds the interface descriptions
the SDK reads; `packages/*` are TypeScript packages (`@agentauth-sol/*`); `apps/*` the dashboard and the
demo harness; `docs/` the documentation.

## Setup

You need: rustup (stable, with rustfmt and clippy), the Solana CLI 3.1.8 (this provides
`cargo build-sbf`, platform-tools v1.52, and `solana-test-validator`), Node 24 (20 or newer works for
most packages), and pnpm 10.

**Put rustup's cargo first on `PATH`.** Homebrew's cargo shadows it and breaks `cargo build-sbf`:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
pnpm install --frozen-lockfile
```

## Build, test, lint

```sh
scripts/build-all.sh           # every on-chain program; prints sha256 and size of each .so
source scripts/env.sh          # exports AGENT_AUTH_SO, AGENT_AUTH_RELAY_SO, ... for the Rust tests
cargo test --workspace --no-fail-fast
pnpm -r --if-present test      # TypeScript packages (offline suites)
scripts/test-all.sh            # build + cargo test + pnpm test in one go
scripts/lint-all.sh            # cargo fmt --check, clippy -D warnings, tsc, lint
make test | make lint | make build   # the same entry points as CI (.github/workflows/ci.yml)
```

- The Rust integration tests load the real compiled `.so` into LiteSVM. A missing `.so` is a **hard
  failure**; `AGENT_AUTH_ALLOW_SKIP=1` opts out, and a run with it proves nothing.
- A faster loop for one program: `cargo build-sbf --manifest-path programs/relay/Cargo.toml` then
  `source scripts/env.sh && cargo test -p agent-auth-relay --test tr`.
- The localnet end-to-end check needs a validator: `scripts/localnet.sh start`, then
  `pnpm --filter @agentauth-sol/demo bootstrap` and `pnpm --filter @agentauth-sol/demo smoke --relay`.
  `make e2e` wraps this.
- Tests tagged `#[ignore]` need external inputs (a funded devnet wallet, a dumped Raydium binary). Do
  not enable them in CI.
- Disk is not free: `target/` directories grow into the tens of gigabytes. Use `CARGO_TARGET_DIR` to share
  one if you have several clones.

## Code standards

Rust (on-chain programs):

- `cargo fmt` and `cargo clippy --workspace --all-targets -- -D warnings` must be clean.
- Programs are `no_std` Pinocchio. No `unsafe` except what the entrypoint macros expand to and the
  documented single syscall in the relay. No `unwrap`, `expect`, indexing or `panic!` reachable from
  untrusted input. The relay denies these with lints, and `tests/source_hygiene.rs` checks the core.
- Hard-coded program ids; exact account-count checks; stored PDA bumps (no `find_program_address` on the
  hot path); checked arithmetic; drop every data borrow before every CPI.
- Every error a handler raises on purpose is a coded error. Core codes 1 to 22 and relay codes 100 to 119
  are public contracts: never renumber, append only. `tests/error_matrix.rs` and
  `tests/source_hygiene.rs` fail if a code is undocumented.
- **Locked interfaces:** the core account layout (2136 bytes), the `verify` ABI (tag 3, 49 bytes) and core
  error codes 1 to 18. A change that touches them needs a design discussion first, a new layout version
  and golden-file updates, not a patch.
- A new instruction or check comes with tests that fail without it. Prefer a test that drives the real
  `.so`. For a security check, write the failing attack test first, then the fix. Mutation-test your own
  change by hand: delete the check and confirm that a test fails.
- Update `idl/*.json` when an instruction changes; `tests/idl_conformance.rs` and
  `programs/relay/tests/conformance.rs` compare them with the code.

TypeScript (packages and apps):

- `strict` TypeScript, no `any` in public APIs, no dead code, no TODO placeholders in shipped paths.
- `pnpm -r typecheck`, `pnpm -r lint` and `prettier --check` must pass. Packages build with `tsup`.
- Anything that builds a transaction an owner will sign needs a test that the preview matches the
  instruction data.
- No network calls that spend money in tests. Localnet and LiteSVM only; devnet is read-only.

Documentation:

- Plain, precise language. No marketing words ("revolutionary", "trustless", "unhackable", "first-ever").
- A number needs the command that produced it. Say whether it is LiteSVM, a local validator or a cluster.
- A statement about another project needs a source link and a date. Do not disparage; be precise.
- Label scripted demos as scripted. Keep "unaudited devnet prototype" visible.
- Diagrams: Mermaid source in `docs/assets/diagrams/*.mmd` and the rendered PNG next to it
  (`mmdc -i x.mmd -o x.png -b transparent -s 2`).

Commits and pull requests:

- Conventional-style subjects as in the history (`fix(relay): ...`, `test(core): ...`, `docs: ...`).
- One logical change per commit; tests in the same commit as the behaviour.
- Do not commit keypairs, `.env` files or anything under `keys/` (gitignored) or `founder/`.
- If an AI assistant wrote part of the change, say so in the pull request. You are still responsible for
  every line, including checking it against the claims above.

## How to add a program to the registry

The registry (`packages/registry`) maps `(program id, 8-byte discriminator)` to a name, a risk class and
an amount descriptor, and feeds the SDK, CLI, MCP server and dashboard. A wrong entry can make an owner
allow the wrong instruction, so treat it like security code. The full checklist is in
`packages/registry/README.md`; the file format is `packages/registry/SCHEMA.md`.

1. Find the primary source: the official IDL, the program or interface source at a pinned commit or
   tag, or official documentation. Do not copy discriminators from an explorer or a third-party list.
2. Create `packages/registry/data/programs/<slug>.json` (slug equals the file name; snake_case
   instruction names as in the IDL).
3. Discriminators follow the canonical `disc8` convention: Anchor programs use
   `sha256("global:<name>")[0..8]`; 1-byte-tag programs use the tag byte plus 7 zero bytes;
   u32-LE-tag programs use the 4 tag bytes plus 4 zero bytes. For native programs take the tag order from
   the source enum, not from memory.
4. Amount descriptors: `offset` is in the raw instruction data; check it against the serialization code.
5. Choose `risk` and `defaultDeny` for every instruction. Every authority change, account close and admin
   instruction must be `defaultDeny: true`. Keep the rationale short.
6. Record `sources` with a commit, tag or version, and `verification`. Set `onchainExecutable` only from a
   real read-only `solana program show` against the cluster.
7. Run `pnpm --filter @agentauth-sol/registry verify` (recomputes every discriminator) and `... test`;
   add decode and amount tests for the new program.
8. Add an honest row to the coverage table in the registry README (confidence level and what was
   not checked).
9. If the program should be usable through a preset, add or extend a file in `packages/registry/data/presets/`.

Adding a **hard-enforced action** to the relay is a different, much larger task (it needs a typed
instruction that derives its own `verify` arguments, a pin model, balance-delta checks, an adversarial
test pass and a threat-model update). Open an issue to discuss it before writing code.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of this repository.
