import {
  getBase58Encoder,
  getBase64Encoder,
  type Address,
  type Commitment,
  type Signature,
} from '@solana/kit'
import { bytesToAddress, readU64, toHex } from './bytes'
import {
  programIds as defaultProgramIds,
  SWAP_BASE_INPUT_DISC,
  TRANSFER_CHECKED_DISC,
  type ProgramIds,
} from './constants'
import { parseProgramError, type AgentAuthError } from './errors'
import { describeInstruction, type RegistryLike } from './registry'
import type { ActivityRpc } from './types'

/** What an activity row represents. */
export type ActivityKind =
  | 'create'
  | 'add_permission'
  | 'remove_permission'
  | 'update_permission'
  | 'set_active'
  | 'revoke'
  | 'verify'
  | 'relay_transfer'
  | 'relay_swap'
  | 'relay_init'
  | 'relay_pause'
  | 'relay_close'
  | 'token_transfer'
  | 'unknown'

/** A relay event decoded from a `Program data:` log line (relay-idl `events`). */
export type RelayEvent =
  | {
      readonly type: 'TransferExecuted'
      readonly mandate: Address
      readonly destination: Address
      readonly mint: Address
      readonly amount: bigint
    }
  | {
      readonly type: 'SwapExecuted'
      readonly mandate: Address
      readonly poolState: Address
      readonly amountInRequested: bigint
      readonly inDelta: bigint
      readonly outDelta: bigint
    }
  | {
      readonly type: 'PolicyInitialized'
      readonly mandate: Address
      readonly policy: Address
      readonly flags: number
    }
  | { readonly type: 'PolicyClosed'; readonly mandate: Address; readonly policy: Address }
  | { readonly type: 'PausedChanged'; readonly mandate: Address; readonly paused: boolean }

/** A relay event together with the top-level instruction that emitted it. */
export interface LocatedRelayEvent {
  /** Index of the top-level instruction (0-based). */
  readonly instructionIndex: number
  readonly event: RelayEvent
}

/** One row of the activity feed. */
export interface ActivityItem {
  readonly signature: string
  readonly slot: bigint
  readonly blockTime: bigint | null
  readonly kind: ActivityKind
  /** False when the whole transaction failed (everything in it reverted). */
  readonly ok: boolean
  /** The decoded program error of a failed transaction, when it carries a custom code. */
  readonly error?: AgentAuthError
  /** Raw-unit amount (transfer amount, swap `amount_in`, or the amount reported to `verify`). */
  readonly amount?: bigint
  /** Destination token account (transfers) or output account (swaps). */
  readonly recipient?: Address
  /** Target program of the action (token program, AMM, or the program a permission is about). */
  readonly program?: Address
  /** Registry/built-in name of the instruction (for example `transfer_checked`). */
  readonly discriminatorName?: string
  /** Index of the top-level instruction this row comes from; -1 for a transaction without a decoded instruction. */
  readonly instructionIndex: number
  /** The relay event emitted by that instruction, if any. */
  readonly event?: RelayEvent
  /** Fee payer of the transaction (the first account key); the agent for relay calls. */
  readonly feePayer?: Address
  /** All signers of the transaction. */
  readonly signers?: readonly Address[]
  /**
   * Set on rows decoded from a CPI (inner instruction): the program of the top-level instruction
   * that made the call, for example a seller program or the relay calling `verify`.
   */
  readonly viaProgram?: Address
  /** Set when the transaction could not be fetched or decoded (the row is a placeholder). */
  readonly fetchError?: string
}

/** A top-level instruction in wire form. */
export interface RawInstruction {
  readonly programIdIndex: number
  readonly accounts: readonly number[]
  /** Base58 instruction data, as `getTransaction` returns it. */
  readonly data: string
}

/** The pure input of {@link decodeTransaction}. */
export interface DecodableTransaction {
  readonly signature: string
  readonly slot: bigint
  readonly blockTime: bigint | null
  /** `meta.err`: `null` on success. */
  readonly err: unknown
  readonly logs: readonly string[]
  /** Static account keys followed by loaded writable then loaded readonly addresses. */
  readonly accountKeys: readonly string[]
  readonly instructions: readonly RawInstruction[]
  /** Inner (CPI) instructions grouped by the index of the top-level instruction. */
  readonly innerInstructions?: readonly {
    readonly index: number
    readonly instructions: readonly RawInstruction[]
  }[]
  /** Number of leading account keys that signed (header.numRequiredSignatures). */
  readonly numRequiredSignatures?: number
}

/** Context for {@link decodeTransaction}. */
export interface DecodeContext {
  /** Keep AgentAuth/relay instructions only if they reference this mandate or `policy`. */
  readonly mandate?: Address
  readonly policy?: Address
  readonly registry?: RegistryLike | null
  readonly programIds?: Partial<ProgramIds>
}

const EVENT_SIZES: Readonly<Record<number, number>> = { 1: 105, 2: 89, 3: 66, 4: 65, 5: 34 }

function decodeEventBytes(bytes: Uint8Array): RelayEvent | null {
  const tag = bytes[0]
  if (tag === undefined || EVENT_SIZES[tag] !== bytes.length) return null
  const key = (o: number): Address => bytesToAddress(bytes.subarray(o, o + 32))
  switch (tag) {
    case 1:
      return {
        type: 'TransferExecuted',
        mandate: key(1),
        destination: key(33),
        mint: key(65),
        amount: readU64(bytes, 97),
      }
    case 2:
      return {
        type: 'SwapExecuted',
        mandate: key(1),
        poolState: key(33),
        amountInRequested: readU64(bytes, 65),
        inDelta: readU64(bytes, 73),
        outDelta: readU64(bytes, 81),
      }
    case 3:
      return {
        type: 'PolicyInitialized',
        mandate: key(1),
        policy: key(33),
        flags: bytes[65] as number,
      }
    case 4:
      return { type: 'PolicyClosed', mandate: key(1), policy: key(33) }
    case 5:
      return { type: 'PausedChanged', mandate: key(1), paused: bytes[33] === 1 }
    default:
      return null
  }
}

/**
 * Decode relay events from transaction logs (`Program data: <base64>` lines).
 *
 * A data line counts only when the relay is the program currently executing (the SDK tracks the
 * `invoke`/`success`/`failed` nesting), so a different program cannot forge a relay event.
 * Unknown tags and wrong lengths are ignored. Layouts: relay-idl `events` (tags 1..5).
 */
export function decodeRelayEvents(
  logs: readonly string[],
  relayProgram: Address,
): LocatedRelayEvent[] {
  const out: LocatedRelayEvent[] = []
  const stack: string[] = []
  let top = -1
  for (const line of logs) {
    let m = /^Program (\S+) invoke \[(\d+)\]$/.exec(line)
    if (m) {
      stack.push(m[1] as string)
      if (m[2] === '1') top++
      continue
    }
    m = /^Program (\S+) (?:success|failed: .*)$/.exec(line)
    if (m) {
      stack.pop()
      continue
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === relayProgram) {
      const parts = line.slice('Program data: '.length).trim().split(' ')
      try {
        const chunks = parts.map((p) => new Uint8Array(getBase64Encoder().encode(p)))
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
        let off = 0
        for (const c of chunks) {
          bytes.set(c, off)
          off += c.length
        }
        const event = decodeEventBytes(bytes)
        if (event) out.push({ instructionIndex: top, event })
      } catch {
        continue
      }
    }
  }
  return out
}

function nameOf(
  programId: string,
  disc8: string,
  registry: RegistryLike | null | undefined,
): string | undefined {
  return describeInstruction(programId, disc8, registry).name ?? undefined
}

function toBytes(base58: string): Uint8Array | null {
  try {
    return new Uint8Array(getBase58Encoder().encode(base58))
  } catch {
    return null
  }
}

type Partial2 = Omit<
  ActivityItem,
  'signature' | 'slot' | 'blockTime' | 'ok' | 'error' | 'instructionIndex'
>

function decodeInstruction(
  programId: string,
  data: Uint8Array,
  accountAt: (i: number) => Address | undefined,
  ids: ProgramIds,
  registry: RegistryLike | null | undefined,
): Partial2 | null {
  const tag = data[0]
  if (tag === undefined) return null
  const keyAt = (o: number): Address | undefined =>
    data.length >= o + 32 ? bytesToAddress(data.subarray(o, o + 32)) : undefined
  const u64At = (o: number): bigint | undefined =>
    data.length >= o + 8 ? readU64(data, o) : undefined

  if (programId === ids.agentAuth) {
    switch (tag) {
      case 0:
        return { kind: 'create' }
      case 1: {
        const program = keyAt(1)
        const discLen = data[49]
        const firstDisc =
          discLen !== undefined && discLen > 0 && data.length >= 58
            ? toHex(data.subarray(50, 58))
            : undefined
        return {
          kind: 'add_permission',
          ...(program ? { program } : {}),
          ...(program && firstDisc
            ? { discriminatorName: nameOf(program, firstDisc, registry) }
            : {}),
        }
      }
      case 2:
        return { kind: 'remove_permission', ...(keyAt(1) ? { program: keyAt(1) as Address } : {}) }
      case 3: {
        const program = keyAt(1)
        const disc = data.length >= 41 ? toHex(data.subarray(33, 41)) : undefined
        const amount = u64At(41)
        return {
          kind: 'verify',
          ...(program ? { program } : {}),
          ...(amount !== undefined ? { amount } : {}),
          ...(program && disc ? { discriminatorName: nameOf(program, disc, registry) } : {}),
        }
      }
      case 4:
        return { kind: 'revoke' }
      case 5:
        return { kind: 'set_active' }
      case 6:
        return { kind: 'update_permission', ...(keyAt(1) ? { program: keyAt(1) as Address } : {}) }
      default:
        return { kind: 'unknown' }
    }
  }
  if (programId === ids.relay) {
    switch (tag) {
      case 0:
        return { kind: 'relay_init' }
      case 1:
        return { kind: 'relay_pause' }
      case 2:
        return { kind: 'relay_close' }
      case 3: {
        const amount = u64At(1)
        const recipient = accountAt(6)
        const program = accountAt(8)
        return {
          kind: 'relay_transfer',
          ...(amount !== undefined ? { amount } : {}),
          ...(recipient ? { recipient } : {}),
          ...(program
            ? { program, discriminatorName: nameOf(program, TRANSFER_CHECKED_DISC, registry) }
            : {}),
        }
      }
      case 4: {
        const amount = u64At(1)
        const recipient = accountAt(6)
        const program = accountAt(7)
        return {
          kind: 'relay_swap',
          ...(amount !== undefined ? { amount } : {}),
          ...(recipient ? { recipient } : {}),
          ...(program
            ? { program, discriminatorName: nameOf(program, SWAP_BASE_INPUT_DISC, registry) }
            : {}),
        }
      }
      default:
        return { kind: 'unknown' }
    }
  }
  if (programId === ids.token || programId === ids.token2022) {
    if (tag === 12) {
      const amount = u64At(1)
      const recipient = accountAt(2)
      return {
        kind: 'token_transfer',
        program: programId as Address,
        discriminatorName: 'transfer_checked',
        ...(amount !== undefined ? { amount } : {}),
        ...(recipient ? { recipient } : {}),
      }
    }
    if (tag === 3) {
      const amount = u64At(1)
      const recipient = accountAt(1)
      return {
        kind: 'token_transfer',
        program: programId as Address,
        discriminatorName: 'transfer',
        ...(amount !== undefined ? { amount } : {}),
        ...(recipient ? { recipient } : {}),
      }
    }
  }
  return null
}

/**
 * Decode one transaction into activity rows (pure, offline). One row per recognised top-level
 * AgentAuth / relay / SPL-Token-transfer instruction; a transaction with none of those yields a
 * single `unknown` row so nothing is silently dropped. Failed transactions carry
 * {@link parseProgramError} output (attributed by failing program id) on every row, and
 * `ok: false` because the whole transaction reverted.
 */
export function decodeTransaction(
  tx: DecodableTransaction,
  ctx: DecodeContext = {},
): ActivityItem[] {
  const ids = defaultProgramIds('devnet', ctx.programIds)
  const ok = tx.err === null || tx.err === undefined
  const error = ok
    ? undefined
    : (parseProgramError([...tx.logs], { programIds: ctx.programIds }) ?? undefined)
  const events = decodeRelayEvents(tx.logs, ids.relay)
  const signerCount = tx.numRequiredSignatures ?? 0
  const base = {
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    ok,
    ...(error ? { error } : {}),
    ...(tx.accountKeys[0] ? { feePayer: tx.accountKeys[0] as Address } : {}),
    ...(signerCount > 0 ? { signers: tx.accountKeys.slice(0, signerCount) as Address[] } : {}),
  }
  const items: ActivityItem[] = []

  tx.instructions.forEach((ix, index) => {
    const programId = tx.accountKeys[ix.programIdIndex]
    if (programId === undefined) return
    const data = toBytes(ix.data)
    if (!data) return
    const accountAt = (i: number): Address | undefined => {
      const k = ix.accounts[i]
      const key = k === undefined ? undefined : tx.accountKeys[k]
      return key as Address | undefined
    }
    const decoded = decodeInstruction(programId, data, accountAt, ids, ctx.registry)
    if (!decoded) return
    if (
      ctx.mandate !== undefined &&
      (programId === ids.agentAuth || programId === ids.relay) &&
      !ix.accounts.some((i) => {
        const key = tx.accountKeys[i]
        return key === ctx.mandate || (ctx.policy !== undefined && key === ctx.policy)
      })
    ) {
      return
    }
    const located = events.find((e) => e.instructionIndex === index)
    const event = located?.event
    const withEvent: Partial2 = { ...decoded }
    // Prefer the event's exact numbers when the relay emitted one.
    const merged =
      event?.type === 'TransferExecuted'
        ? { ...withEvent, amount: event.amount, recipient: event.destination }
        : withEvent
    items.push({ ...base, ...merged, instructionIndex: index, ...(event ? { event } : {}) })
  })

  // CPI verify calls (seller programs, the relay itself) live in meta.innerInstructions.
  for (const group of tx.innerInstructions ?? []) {
    const outer = tx.instructions[group.index]
    const outerProgram = outer ? tx.accountKeys[outer.programIdIndex] : undefined
    for (const inner of group.instructions) {
      const programId = tx.accountKeys[inner.programIdIndex]
      if (programId !== ids.agentAuth) continue
      const data = toBytes(inner.data)
      if (!data || data[0] !== 3) continue
      const touches = inner.accounts.some((i) => tx.accountKeys[i] === ctx.mandate)
      if (ctx.mandate !== undefined && !touches) continue
      const accountAt = (i: number): Address | undefined => {
        const k = inner.accounts[i]
        return (k === undefined ? undefined : tx.accountKeys[k]) as Address | undefined
      }
      const decoded = decodeInstruction(programId, data, accountAt, ids, ctx.registry)
      if (!decoded) continue
      items.push({
        ...base,
        ...decoded,
        instructionIndex: group.index,
        ...(outerProgram ? { viaProgram: outerProgram as Address } : {}),
      })
    }
  }

  if (items.length === 0) items.push({ ...base, kind: 'unknown', instructionIndex: -1 })
  return items
}

/** The slice of a `getTransaction` (encoding `json`) response the SDK reads. A Kit response satisfies it. */
export interface RpcTransactionLike {
  readonly slot: bigint | number
  readonly blockTime: bigint | number | null
  readonly meta: {
    readonly err: unknown
    readonly logMessages?: readonly string[] | null
    readonly loadedAddresses?: {
      readonly writable: readonly string[]
      readonly readonly: readonly string[]
    }
    readonly innerInstructions?:
      readonly { readonly index: number; readonly instructions: readonly RawInstruction[] }[] | null
  } | null
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly string[]
      readonly instructions: readonly RawInstruction[]
      readonly header?: { readonly numRequiredSignatures: number }
    }
  }
}

/** Convert an RPC `getTransaction` response (encoding `json`) into a {@link DecodableTransaction}. */
export function toDecodableTransaction(
  signature: string,
  res: RpcTransactionLike,
): DecodableTransaction {
  const loaded = res.meta?.loadedAddresses
  return {
    signature,
    slot: BigInt(res.slot),
    blockTime: res.blockTime === null ? null : BigInt(res.blockTime),
    err: res.meta?.err ?? null,
    logs: res.meta?.logMessages ?? [],
    accountKeys: [
      ...res.transaction.message.accountKeys,
      ...(loaded?.writable ?? []),
      ...(loaded?.readonly ?? []),
    ],
    instructions: res.transaction.message.instructions,
    innerInstructions: res.meta?.innerInstructions ?? [],
    ...(res.transaction.message.header
      ? { numRequiredSignatures: res.transaction.message.header.numRequiredSignatures }
      : {}),
  }
}

/** Options of {@link getActivity}. */
export interface GetActivityOptions {
  readonly mandate: Address
  /** Also scan the relay policy account (captures `init_policy` / `close_policy` history). */
  readonly policy?: Address
  /** Number of signatures to read per address (1..1000). */
  readonly limit: number
  /** Page backwards: only signatures older than this one. */
  readonly before?: string
  /** Live polling: only signatures newer than this one (stop at the last one you already have). */
  readonly until?: string
  /**
   * Cache of decoded rows by signature. Confirmed transactions are immutable, so a live feed that
   * passes the same Map re-fetches nothing it already decoded.
   */
  readonly cache?: Map<string, ActivityItem[]>
  /** Retries per `getTransaction` on a rate-limit/transient error (exponential backoff). Default 3. */
  readonly retries?: number
  readonly registry?: RegistryLike | null
  readonly programIds?: Partial<ProgramIds>
  readonly commitment?: Exclude<Commitment, 'processed'>
  readonly abortSignal?: AbortSignal
  /** Parallel `getTransaction` calls. Default 5. */
  readonly concurrency?: number
}

/** A page of the activity feed. */
export interface ActivityPage {
  readonly items: ActivityItem[]
  /** Pass as `before` to read the next (older) page, or `null` when the history is exhausted. */
  readonly nextBefore: string | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read the on-chain history of a mandate: `getSignaturesForAddress(mandate)` (plus the policy when
 * given), then `getTransaction` for each signature, decoded with {@link decodeTransaction} (top-level
 * instructions AND CPI `verify` calls). Rows are newest first. Failures are tolerated per
 * transaction: a signature whose fetch fails after retries yields an `unknown` row with
 * `fetchError`, never a rejected feed. Transactions the RPC no longer has yield an `unknown` row.
 */
export async function getActivityPage(
  rpc: ActivityRpc,
  opts: GetActivityOptions,
): Promise<ActivityPage> {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit)))
  const addresses = [opts.mandate, ...(opts.policy ? [opts.policy] : [])]
  const lists = await Promise.all(
    addresses.map((a) =>
      rpc
        .getSignaturesForAddress(a, {
          limit,
          ...(opts.before ? { before: opts.before as Signature } : {}),
          ...(opts.until ? { until: opts.until as Signature } : {}),
          ...(opts.commitment ? { commitment: opts.commitment } : {}),
        })
        .send({ abortSignal: opts.abortSignal }),
    ),
  )
  const bySig = new Map<
    string,
    { signature: string; slot: bigint; blockTime: bigint | null; err: unknown }
  >()
  for (const list of lists) {
    for (const s of list) {
      bySig.set(s.signature, {
        signature: s.signature,
        slot: BigInt(s.slot),
        blockTime: s.blockTime === null ? null : BigInt(s.blockTime),
        err: s.err,
      })
    }
  }
  const sorted = [...bySig.values()].sort((a, b) =>
    a.slot === b.slot ? 0 : a.slot > b.slot ? -1 : 1,
  )
  const sigs = sorted.slice(0, limit)
  const more = sorted.length > limit || lists.some((l) => l.length >= limit)
  const nextBefore =
    more && sigs.length > 0 ? (sigs[sigs.length - 1] as { signature: string }).signature : null

  const results: ActivityItem[][] = new Array<ActivityItem[]>(sigs.length)
  let next = 0
  const retries = opts.retries ?? 3
  const workers = Array.from(
    { length: Math.max(1, Math.min(opts.concurrency ?? 5, sigs.length)) },
    async () => {
      while (true) {
        const i = next++
        const info = sigs[i]
        if (info === undefined) return
        const cached = opts.cache?.get(info.signature)
        if (cached) {
          results[i] = cached
          continue
        }
        const placeholder = (fetchError?: string): ActivityItem[] => [
          {
            signature: info.signature,
            slot: info.slot,
            blockTime: info.blockTime,
            kind: 'unknown',
            ok: info.err === null,
            instructionIndex: -1,
            ...(fetchError ? { fetchError } : {}),
          },
        ]
        let rows: ActivityItem[]
        let cacheable = true
        try {
          let res: unknown = null
          for (let attempt = 0; ; attempt++) {
            try {
              res = await rpc
                .getTransaction(info.signature as Signature, {
                  encoding: 'json',
                  maxSupportedTransactionVersion: 0,
                  ...(opts.commitment ? { commitment: opts.commitment } : {}),
                })
                .send({ abortSignal: opts.abortSignal })
              break
            } catch (error) {
              if (opts.abortSignal?.aborted || attempt >= retries) throw error
              await sleep(250 * 2 ** attempt)
            }
          }
          rows =
            res === null
              ? placeholder()
              : decodeTransaction(
                  toDecodableTransaction(info.signature, res as RpcTransactionLike),
                  {
                    mandate: opts.mandate,
                    policy: opts.policy,
                    registry: opts.registry,
                    programIds: opts.programIds,
                  },
                )
          if (res === null) cacheable = false
        } catch (error) {
          if (opts.abortSignal?.aborted) throw error
          rows = placeholder(error instanceof Error ? error.message : String(error))
          cacheable = false
        }
        results[i] = rows
        if (cacheable) opts.cache?.set(info.signature, rows)
      }
    },
  )
  await Promise.all(workers)
  return { items: results.flat(), nextBefore }
}

/** {@link getActivityPage} without the cursor: just the rows. */
export async function getActivity(
  rpc: ActivityRpc,
  opts: GetActivityOptions,
): Promise<ActivityItem[]> {
  return (await getActivityPage(rpc, opts)).items
}
