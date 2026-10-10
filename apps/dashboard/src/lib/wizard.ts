import {
  MAX_RECIPIENTS,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  parseAddress,
  parseDuration,
  parseUnits,
  type OnboardingInput,
  type PermissionInput,
  type SwapConfig,
} from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'
import type { PresetData, PresetPermissionData } from './registry-data'

/** A token account of the owner, as read from the chain. */
export interface TokenAccountInfo {
  readonly address: Address
  readonly mint: Address
  readonly decimals: number
  readonly amount: bigint
  readonly delegate: Address | null
  readonly delegatedAmount: bigint
}

/** The pinned pool, with the direction already resolved from the source mint. */
export interface SwapPoolInfo {
  readonly kind: 'mock' | 'cpmm'
  readonly label: string
  readonly ammProgram: Address
  readonly ammAuthority: Address
  readonly ammConfig: Address
  readonly poolState: Address
  readonly inputVault: Address
  readonly outputVault: Address
  readonly observationState: Address
  readonly inMint: Address
  readonly outMint: Address
  readonly inTokenProgram: Address
  readonly outTokenProgram: Address
  readonly outDecimals: number
}

export interface RecipientRow {
  readonly address: string
  readonly label: string
}

export interface WizardForm {
  readonly agent: string
  readonly presetName: string
  /** Owner's token account the relay may debit (and the swap input). */
  readonly sourceAccount: string
  readonly perCall: string
  readonly perCallUnlimited: boolean
  readonly totalBudget: string
  readonly totalUnlimited: boolean
  readonly delegation: string
  readonly expiry: string
  readonly fundSol: string
  readonly recipients: readonly RecipientRow[]
  /** Owner's token account that receives swap output. */
  readonly swapOutAccount: string
  readonly floorOut: string
  readonly floorIn: string
  readonly maxDeadlineSlots: string
  /** Accept replacing an SPL delegate the source account already has. */
  readonly replaceDelegate: boolean
}

export const EMPTY_FORM: WizardForm = {
  agent: '',
  presetName: 'payments-usdc',
  sourceAccount: '',
  perCall: '',
  perCallUnlimited: false,
  totalBudget: '',
  totalUnlimited: false,
  delegation: '',
  expiry: '7d',
  fundSol: '0.01',
  recipients: [{ address: '', label: '' }],
  swapOutAccount: '',
  floorOut: '95',
  floorIn: '100',
  maxDeadlineSlots: '150',
  replaceDelegate: false,
}

export interface WizardContext {
  readonly owner: Address
  readonly presets: readonly PresetData[]
  readonly source: TokenAccountInfo | null
  readonly swapPool: SwapPoolInfo | null
  /** Registry cluster key for program ids (always devnet ids: localnet reuses them). */
  readonly mockAmm: Address
  readonly ownerTokenAccounts: readonly TokenAccountInfo[]
  readonly now: number
}

export interface PresetShape {
  readonly transfer: boolean
  readonly swap: boolean
  /** Preset permissions that are neither the relay transfer nor the pinned swap: advisory slots. */
  readonly extras: readonly PresetPermissionData[]
}

/** Which parts of a preset the wizard builds as relay slots and which stay advisory. */
export function presetShape(preset: PresetData): PresetShape {
  let transfer = false
  let swap = false
  const extras: PresetPermissionData[] = []
  for (const perm of preset.permissions) {
    if (perm.slug === 'spl-token' && perm.instructions.some((i) => i.name === 'transfer_checked'))
      transfer = true
    else if (
      perm.slug === 'raydium-cpmm' &&
      perm.instructions.some((i) => i.name === 'swap_base_input')
    )
      swap = true
    else extras.push(perm)
  }
  return { transfer, swap, extras }
}

export type FieldErrors = Readonly<Record<string, string>>

export type BuildResult =
  | {
      readonly ok: true
      readonly input: Omit<OnboardingInput, 'chainState' | 'programIds' | 'registry'>
      readonly labels: Readonly<Record<string, string>>
      readonly cap: bigint
      readonly swapConfig: SwapConfig | null
      readonly warnings: readonly string[]
    }
  | { readonly ok: false; readonly errors: FieldErrors }

function tryParse<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

function amount(
  text: string,
  decimals: number,
  field: string,
  errors: Record<string, string>,
): bigint | null {
  const t = text.trim()
  if (t === '') {
    errors[field] = 'Required.'
    return null
  }
  const r = tryParse(() => parseUnits(t, decimals))
  if ('error' in r) {
    errors[field] = `Enter a plain number with at most ${decimals} decimals.`
    return null
  }
  if (r.value <= 0n) {
    errors[field] = 'Must be greater than zero. Tick "unlimited" if you really mean no limit.'
    return null
  }
  return r.value
}

/**
 * Turn the wizard form into SDK onboarding input. Pure: no network, no clock besides `ctx.now`.
 * Every error is attached to a field so the UI can show it next to the input. The SDK stays the
 * authority: this only prepares input and catches typos early; `client.plan.onboarding` refuses
 * anything unsafe with its own reasons.
 */
export function buildOnboardingInput(form: WizardForm, ctx: WizardContext): BuildResult {
  const errors: Record<string, string> = {}
  const warnings: string[] = []
  const preset = ctx.presets.find((p) => p.name === form.presetName)
  if (!preset) return { ok: false, errors: { presetName: 'Pick a preset.' } }
  const shape = presetShape(preset)

  // Agent
  let agent: Address | null = null
  if (form.agent.trim() === '')
    errors['agent'] = 'Paste the agent public key, or generate a demo agent.'
  else {
    const r = tryParse(() => parseAddress(form.agent.trim()))
    if ('error' in r) errors['agent'] = 'That is not a valid Solana address.'
    else if (r.value === ctx.owner)
      errors['agent'] = 'The agent must be a different key than your wallet.'
    else agent = r.value
  }

  // Source account and decimals
  const source = ctx.source
  if (!source) errors['sourceAccount'] = 'Pick the token account the agent may spend from.'
  const decimals = source?.decimals ?? 6

  // Limits
  const labels: Record<string, string> = {}
  let perCall: bigint | 'unlimited' | null = null
  let total: bigint | 'unlimited' | null = null
  if (form.perCallUnlimited) perCall = 'unlimited'
  else perCall = amount(form.perCall, decimals, 'perCall', errors)
  if (form.totalUnlimited) total = 'unlimited'
  else total = amount(form.totalBudget, decimals, 'totalBudget', errors)
  if (typeof perCall === 'bigint' && typeof total === 'bigint' && perCall > total) {
    errors['perCall'] = 'The per-call cap is above the total budget, so the cap could never bind.'
  }

  // Delegation (hard cap enforced by the Token program)
  const cap = amount(form.delegation, decimals, 'delegation', errors)
  if (cap !== null && typeof total === 'bigint' && cap > total) {
    errors['delegation'] =
      'The delegation is above the total budget. The SDK refuses that: lower it or raise the budget.'
  }
  if (cap !== null && source && cap > source.amount) {
    warnings.push(
      'The delegation is larger than the current balance of the source account; the balance is the real limit until you add funds.',
    )
  }
  if (
    cap !== null &&
    source &&
    source.amount > 0n &&
    cap * 2n >= source.amount &&
    cap <= source.amount
  ) {
    warnings.push(
      'The delegation is at least half of the source balance: a compromised relay path could move that much before you react.',
    )
  }
  if (source && source.delegate !== null && source.delegatedAmount > 0n) {
    if (!form.replaceDelegate) {
      errors['replaceDelegate'] =
        'This account already delegates to someone else. Approving the relay would replace that: confirm below.'
    } else {
      warnings.push(
        'You are replacing the existing SPL delegate of the source account. Whatever relied on it stops working.',
      )
    }
  }

  // Expiry
  const exp = tryParse(() => parseDuration(form.expiry.trim() === '' ? 'x' : form.expiry.trim()))
  let expiry: bigint | null = null
  if ('error' in exp) errors['expiry'] = 'Use a duration like 1h, 24h, 7d or 30d.'
  else if (exp.value <= 0n) errors['expiry'] = 'The mandate must last longer than zero.'
  else if (exp.value > 365n * 86_400n) errors['expiry'] = 'At most one year.'
  else expiry = BigInt(ctx.now) + exp.value

  // Fee funding
  let fund = 0n
  if (form.fundSol.trim() !== '') {
    const r = tryParse(() => parseUnits(form.fundSol.trim(), 9))
    if ('error' in r) errors['fundSol'] = 'Enter SOL as a plain number, for example 0.01.'
    else if (r.value > 1_000_000_000n) errors['fundSol'] = 'At most 1 SOL.'
    else fund = r.value
  }

  // Recipients
  const recipients: Address[] = []
  if (shape.transfer) {
    const rows = form.recipients.filter((r) => r.address.trim() !== '' || r.label.trim() !== '')
    if (rows.length === 0)
      errors['recipients'] = 'Add at least one allowed recipient token account.'
    if (rows.length > MAX_RECIPIENTS) errors['recipients'] = `At most ${MAX_RECIPIENTS} recipients.`
    const seen = new Set<string>()
    rows.forEach((row, i) => {
      const r = tryParse(() => parseAddress(row.address.trim()))
      if ('error' in r) errors[`recipient-${i}`] = 'Not a valid token account address.'
      else if (seen.has(r.value)) errors[`recipient-${i}`] = 'Duplicate.'
      else {
        seen.add(r.value)
        recipients.push(r.value)
        if (row.label.trim() !== '') labels[r.value] = row.label.trim()
      }
    })
  }

  // Swap
  let swapConfig: SwapConfig | null = null
  let swapInput: OnboardingInput['swap'] | undefined
  if (shape.swap) {
    const pool = ctx.swapPool
    if (!pool) errors['pool'] = 'Pick the pool to pin.'
    const out = form.swapOutAccount.trim()
    const outInfo = ctx.ownerTokenAccounts.find((a) => a.address === out)
    if (out === '')
      errors['swapOutAccount'] = 'Pick your own token account that receives the swap output.'
    else if (!outInfo) errors['swapOutAccount'] = 'That is not one of your token accounts.'
    else if (pool && outInfo.mint !== pool.outMint)
      errors['swapOutAccount'] = 'That account holds a different mint than the pool output.'
    if (source && pool && source.mint !== pool.inMint) {
      errors['sourceAccount'] = 'The source account must hold the pool input mint.'
    }
    const fo = amount(form.floorOut, pool?.outDecimals ?? decimals, 'floorOut', errors)
    const fi = amount(form.floorIn, decimals, 'floorIn', errors)
    const slots = Number(form.maxDeadlineSlots)
    if (!Number.isInteger(slots) || slots < 1 || slots > 9000)
      errors['maxDeadlineSlots'] = 'A whole number from 1 to 9000.'
    if (
      pool &&
      source &&
      fo !== null &&
      fi !== null &&
      outInfo &&
      Object.keys(errors).length === 0
    ) {
      swapConfig = {
        ammProgram: pool.ammProgram,
        ammAuthority: pool.ammAuthority,
        ammConfig: pool.ammConfig,
        poolState: pool.poolState,
        inputVault: pool.inputVault,
        outputVault: pool.outputVault,
        observationState: pool.observationState,
        inMint: pool.inMint,
        outMint: pool.outMint,
        inTokenProgram: pool.inTokenProgram,
        outTokenProgram: pool.outTokenProgram,
        inAccount: source.address,
        outAccount: outInfo.address,
        floorOut: fo,
        floorIn: fi,
        maxDeadlineSlots: slots,
      }
      swapInput = swapConfig
    }
  }

  if (
    Object.keys(errors).length > 0 ||
    !agent ||
    !source ||
    expiry === null ||
    cap === null ||
    perCall === null ||
    total === null
  ) {
    return { ok: false, errors: Object.keys(errors).length > 0 ? errors : { agent: 'Incomplete.' } }
  }

  // Permissions: the relay slots first, then the advisory extras with a nominal limit.
  const permissions: PermissionInput[] = []
  if (shape.transfer) {
    permissions.push({
      program: TOKEN_PROGRAM_ID,
      spendLimit: total,
      perTxLimit: perCall,
      discriminators: [TRANSFER_CHECKED_DISC],
    })
  }
  if (shape.swap && swapConfig) {
    permissions.push({
      program: swapConfig.ammProgram,
      spendLimit: total,
      perTxLimit: perCall,
      discriminators: [SWAP_BASE_INPUT_DISC],
    })
  }
  for (const extra of shape.extras) {
    const id = extra.programIds['devnet'] ?? extra.programIds['mainnet-beta']
    if (!id) continue
    permissions.push({
      program: id as Address,
      // These instructions move no tokens, so the amount reported is 0; the limit is nominal.
      spendLimit: 1n,
      perTxLimit: 1n,
      discriminators: extra.instructions.map((i) => i.disc8),
    })
  }
  if (form.totalUnlimited || form.perCallUnlimited) {
    warnings.push(
      'You chose "unlimited" for a limit. On chain, 0 means unlimited: nothing but the SPL delegation then bounds the agent.',
    )
  }

  const input: Omit<OnboardingInput, 'chainState' | 'programIds' | 'registry'> = {
    owner: ctx.owner,
    agent,
    expiry,
    fundAgentLamports: fund,
    token: { mint: source.mint, source: source.address, delegateCap: cap },
    permissions,
    recipients,
    ...(swapInput ? { swap: swapInput } : {}),
    allowUnlimited: form.totalUnlimited || form.perCallUnlimited,
    allowReplaceDelegate: form.replaceDelegate,
  }
  return { ok: true, input, labels, cap, swapConfig, warnings }
}
