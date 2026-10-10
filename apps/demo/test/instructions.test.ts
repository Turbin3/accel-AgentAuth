import { describe, expect, it } from 'vitest'
import { address, getAddressDecoder } from '@solana/kit'
import {
  GATED_ACTION_DISC,
  GATED_EXAMPLE_PROGRAM_ID,
  MOCK_AMM_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  toHex,
} from '@agentauth-sol/sdk'
import { generateKeyPairSigner } from '@solana/kit'
import {
  createAccountIx,
  gatedActionIx,
  gatedConfigPda,
  gatedInitIx,
  initializeAccount3Ix,
  initializeMint2Ix,
  mintToCheckedIx,
  mockAmmAuthority,
  mockAmmInitPoolIx,
} from '../src/lib/instructions'

const A = address('11111111111111111111111111111112')
const B = address('SysvarRent111111111111111111111111111111111')

describe('instruction encoders (byte exact)', () => {
  it('System CreateAccount: u32 tag 0, lamports, space, owner', async () => {
    const payer = await generateKeyPairSigner()
    const fresh = await generateKeyPairSigner()
    const ix = createAccountIx({
      payer,
      newAccount: fresh,
      lamports: 1_461_600n,
      space: 82n,
      owner: TOKEN_PROGRAM_ID,
    })
    expect(ix.programAddress).toBe(SYSTEM_PROGRAM_ID)
    expect(ix.data?.length).toBe(52)
    const dv = new DataView(ix.data!.buffer, ix.data!.byteOffset)
    expect(dv.getUint32(0, true)).toBe(0)
    expect(dv.getBigUint64(4, true)).toBe(1_461_600n)
    expect(dv.getBigUint64(12, true)).toBe(82n)
    expect(getAddressDecoder().decode(ix.data!.slice(20, 52))).toBe(TOKEN_PROGRAM_ID)
    expect(ix.accounts?.map((a) => a.address)).toEqual([payer.address, fresh.address])
  })

  it('SPL InitializeMint2: [20, decimals, authority, 0] with no freeze authority', () => {
    const ix = initializeMint2Ix({ mint: A, decimals: 6, mintAuthority: B })
    expect(ix.programAddress).toBe(TOKEN_PROGRAM_ID)
    expect(ix.data?.length).toBe(35)
    expect([...ix.data!.slice(0, 2)]).toEqual([20, 6])
    expect(getAddressDecoder().decode(ix.data!.slice(2, 34))).toBe(B)
    expect(ix.data![34]).toBe(0)
    expect(ix.accounts).toHaveLength(1)
  })

  it('SPL InitializeAccount3: [18, owner]', () => {
    const ix = initializeAccount3Ix({ account: A, mint: B, owner: A })
    expect(ix.data?.length).toBe(33)
    expect(ix.data![0]).toBe(18)
    expect(ix.accounts?.map((a) => a.address)).toEqual([A, B])
  })

  it('SPL MintToChecked: [14, amount u64 LE, decimals], authority signs', async () => {
    const authority = await generateKeyPairSigner()
    const ix = mintToCheckedIx({
      mint: A,
      destination: B,
      authority,
      amount: 10_000_000_000n,
      decimals: 6,
    })
    expect(toHex(ix.data!)).toBe('0e' + '00e40b5402000000' + '06')
    expect(ix.accounts?.[2]?.address).toBe(authority.address)
  })

  it('mock-amm init_pool: disc FF 69 6E 69 74 00 00 00, mode, aux_key', () => {
    const ix = mockAmmInitPoolIx({ pool: A, vault0: B, vault1: A })
    expect(ix.programAddress).toBe(MOCK_AMM_PROGRAM_ID)
    expect(toHex(ix.data!.slice(0, 9))).toBe('ff696e697400000000')
    expect(ix.data?.length).toBe(41)
    expect([...ix.data!.slice(9)]).toEqual(new Array(32).fill(0))
    const withAux = mockAmmInitPoolIx({ pool: A, vault0: B, vault1: A, mode: 3, auxKey: A })
    expect(withAux.data![8]).toBe(3)
    expect(getAddressDecoder().decode(withAux.data!.slice(9))).toBe(A)
  })

  it('the mock AMM pool authority PDA has the bump the program asserts (255)', async () => {
    const { bump, address: pda } = await mockAmmAuthority()
    expect(bump).toBe(255)
    expect(pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })

  it('gated-example init and gated_action', async () => {
    const signer = await generateKeyPairSigner()
    const config = await gatedConfigPda()
    const init = await gatedInitIx({ authority: signer })
    expect(init.programAddress).toBe(GATED_EXAMPLE_PROGRAM_ID)
    expect([...init.data!]).toEqual([0])
    expect(init.accounts?.map((a) => a.address)).toEqual([
      signer.address,
      config.address,
      SYSTEM_PROGRAM_ID,
    ])

    const act = await gatedActionIx({ agent: signer, mandate: A, owner: B, amount: 4n })
    expect(toHex(act.data!)).toBe('01' + '0400000000000000')
    expect(act.accounts).toHaveLength(5)
    expect(act.accounts?.[4]?.address).toBe(config.address)
    expect(GATED_ACTION_DISC).toBe('0100000000000000')
  })
})
