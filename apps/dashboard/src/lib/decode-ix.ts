import type { BuiltInstruction, ProgramIds } from '@agentauth-sol/sdk'
import { toHex } from '@agentauth-sol/sdk'

const CORE = [
  'create_mandate',
  'add_permission',
  'remove_permission',
  'verify',
  'revoke_mandate',
  'set_active',
  'update_permission',
]
const RELAY = ['init_policy', 'set_paused', 'close_policy', 'transfer', 'swap']
const TOKEN: Record<number, string> = {
  3: 'Transfer',
  4: 'Approve',
  5: 'Revoke',
  12: 'TransferChecked',
}
const SYSTEM: Record<number, string> = { 2: 'Transfer' }

export interface DecodedInstruction {
  readonly program: string
  readonly name: string
  readonly accounts: readonly { address: string; writable: boolean; signer: boolean }[]
  readonly dataHex: string
}

/** Names the instruction a plan will send, from the program id and its tag byte (u32 for System). */
export function decodeInstruction(ix: BuiltInstruction, ids: ProgramIds): DecodedInstruction {
  const tag = ix.data[0] ?? 0
  let program = ix.programAddress as string
  let name = `tag ${tag}`
  if (ix.programAddress === ids.agentAuth) {
    program = 'AgentAuth core'
    name = CORE[tag] ?? name
  } else if (ix.programAddress === ids.relay) {
    program = 'AgentAuth relay'
    name = RELAY[tag] ?? name
  } else if (ix.programAddress === ids.token) {
    program = 'SPL Token'
    name = TOKEN[tag] ?? name
  } else if (ix.programAddress === ids.system) {
    program = 'System'
    name = SYSTEM[tag] ?? name
  }
  return {
    program,
    name,
    accounts: ix.accounts.map((a) => ({
      address: a.address as string,
      // AccountRole: 0 readonly, 1 writable, 2 readonly signer, 3 writable signer
      writable: (a.role & 1) === 1,
      signer: a.role >= 2,
    })),
    dataHex: toHex(ix.data),
  }
}
