import { decodeCpmmPool, encodeCpmmPoolForTest } from '@/lib/cpmm'
import { AGENT, AUTHORITY, MINT, OWNER, RECIPIENT, SOURCE } from './fixtures'
import { TOKEN_PROGRAM_ID } from '@agentauth-sol/sdk'

describe('decodeCpmmPool', () => {
  it('reads the pinned fields at the PoolState offsets', () => {
    const pool = {
      ammConfig: OWNER,
      token0Vault: AGENT,
      token1Vault: SOURCE,
      token0Mint: MINT,
      token1Mint: RECIPIENT,
      token0Program: TOKEN_PROGRAM_ID,
      token1Program: TOKEN_PROGRAM_ID,
      observation: AUTHORITY,
    }
    expect(decodeCpmmPool(encodeCpmmPoolForTest(pool))).toEqual(pool)
  })

  it('rejects an account that is too short to be a pool', () => {
    expect(() => decodeCpmmPool(new Uint8Array(100))).toThrow(/at least 328/)
  })
})
