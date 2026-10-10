import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features'
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features'
import { address } from '@solana/kit'
import type { AppConfig } from '../config'
import type { ConnectedWallet, WalletOption } from './types'
import { partialSignerFromWire } from './signer'

type SolanaWallet = Wallet & {
  readonly features: Wallet['features'] & StandardConnectFeature & SolanaSignTransactionFeature
}

function isSolanaWallet(wallet: Wallet): wallet is SolanaWallet {
  return (
    StandardConnect in wallet.features &&
    SolanaSignTransaction in wallet.features &&
    wallet.chains.some((c) => c.startsWith('solana:'))
  )
}

/** Wallet Standard wallets present right now (Phantom, Solflare, Backpack ... register themselves). */
export function listStandardWallets(): SolanaWallet[] {
  return getWallets().get().filter(isSolanaWallet)
}

/** Subscribe to wallets that register later; returns the unsubscribe function. */
export function onStandardWalletsChange(listener: () => void): () => void {
  const api = getWallets()
  const off1 = api.on('register', listener)
  const off2 = api.on('unregister', listener)
  return () => {
    off1()
    off2()
  }
}

export function standardOptions(): WalletOption[] {
  return listStandardWallets().map((w) => ({
    id: `ws:${w.name}`,
    kind: 'wallet-standard',
    label: w.name,
    description: 'Wallet Standard wallet detected in this browser',
    icon: w.icon,
  }))
}

/** Wallet Standard chain id: wallets only know the public clusters, a local validator reuses devnet. */
function chainFor(wallet: SolanaWallet, config: AppConfig): `solana:${string}` {
  const wanted = config.cluster === 'devnet' ? 'solana:devnet' : 'solana:localnet'
  if (wallet.chains.includes(wanted as never)) return wanted as `solana:${string}`
  if (wallet.chains.includes('solana:devnet' as never)) return 'solana:devnet'
  return (wallet.chains.find((c) => c.startsWith('solana:')) ??
    'solana:devnet') as `solana:${string}`
}

export async function connectStandardWallet(
  optionId: string,
  config: AppConfig,
): Promise<ConnectedWallet> {
  const name = optionId.replace(/^ws:/, '')
  const wallet = listStandardWallets().find((w) => w.name === name)
  if (!wallet) throw new Error(`Wallet "${name}" is not available in this browser.`)
  const { accounts } = await wallet.features[StandardConnect].connect()
  const account: WalletAccount | undefined = accounts.find((a) =>
    a.features.includes(SolanaSignTransaction),
  )
  if (!account)
    throw new Error(`${name} did not share an account that can sign Solana transactions.`)
  const owner = address(account.address)
  const chain = chainFor(wallet, config)
  const signer = partialSignerFromWire(owner, async (wire) => {
    const [out] = await wallet.features[SolanaSignTransaction].signTransaction({
      account,
      transaction: wire,
      chain,
    })
    if (!out) throw new Error('The wallet returned nothing.')
    return out.signedTransaction
  })
  return { address: owner, kind: 'wallet-standard', label: wallet.name, signer }
}
