import {
  explainMandate,
  mandatePda,
  parseDisc,
  parseLimit,
  relayAuthorityPda,
  relayPolicyPda,
  toHex,
  POLICY_FLAG_STRICT_TOP_LEVEL,
  type Client,
  type Explanation,
  type Mandate,
  type OnboardingInput,
  type Permission,
  type RelayPolicy,
  type SwapConfig,
} from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'

type WizardInput = Omit<OnboardingInput, 'chainState' | 'programIds' | 'registry'>

export interface WizardPreview {
  readonly explanation: Explanation
  readonly mandate: Mandate
  readonly policy: RelayPolicy
}

/**
 * What the mandate WOULD say once the wizard's two transactions have landed: the same
 * explainMandate the detail page uses, run on a hypothetical mandate and policy built from the
 * form. Nothing here is read from or written to the chain.
 */
export async function explainWizardInput(
  client: Client,
  input: WizardInput,
  swapConfig: SwapConfig | null,
  decimals: number,
  nowSeconds: number,
): Promise<WizardPreview> {
  const owner = input.owner as Address
  const mandateAddress = (await mandatePda(owner, input.agent, client.programIds.agentAuth)).address
  const policyAddress = (await relayPolicyPda(mandateAddress, client.programIds.relay)).address
  const authority = (await relayAuthorityPda(mandateAddress, client.programIds.relay)).address

  const permissions: Permission[] = input.permissions.map((p, index) => {
    const spend = parseLimit(p.spendLimit, 'spendLimit')
    const perTx = parseLimit(p.perTxLimit, 'perTxLimit')
    const discriminators = p.discriminators.map((d) => parseDisc(d))
    return {
      index,
      program: p.program,
      spendLimit: spend,
      perTxLimit: perTx,
      spendUnlimited: spend === 0n,
      perTxUnlimited: perTx === 0n,
      spendTotal: 0n,
      callCount: 0,
      discriminators,
      discriminatorsHex: discriminators.map((d) => toHex(d)),
    }
  })
  const mandate: Mandate = {
    address: mandateAddress,
    owner,
    agent: input.agent,
    expiry: input.expiry,
    active: true,
    version: 1,
    bump: 0,
    permissions,
  }
  const policy: RelayPolicy = {
    address: policyAddress,
    version: 1,
    policyBump: 0,
    authorityBump: 0,
    flags: POLICY_FLAG_STRICT_TOP_LEVEL,
    paused: false,
    strictTopLevel: true,
    mandate: mandateAddress,
    owner,
    agent: input.agent,
    authority,
    mandateExpiry: input.expiry,
    tokenProgram: input.token.tokenProgram ?? client.programIds.token,
    budgetMint: input.token.mint,
    sourceAccount: input.token.source,
    recipients: input.recipients,
    swap: swapConfig,
  }
  const explanation = explainMandate(mandate, {
    policy,
    registry: client.registry,
    budgetDecimals: decimals,
    now: nowSeconds,
    mandateAddress,
    delegation: { delegate: authority, delegatedAmount: input.token.delegateCap },
  })
  return { explanation, mandate, policy }
}
