import type { Address, TransactionPartialSigner } from '@solana/kit'

export type WalletKind = 'phantom' | 'wallet-standard' | 'dev-server' | 'dev-browser'

/** One way of connecting, as listed in the connect dialog. */
export interface WalletOption {
  readonly id: string
  readonly kind: WalletKind
  readonly label: string
  readonly description: string
  /** Shown as a chip, e.g. DEV. */
  readonly badge?: string
  readonly icon?: string
}

export interface ConnectedWallet {
  readonly address: Address
  readonly kind: WalletKind
  readonly label: string
  readonly signer: TransactionPartialSigner
}

export type WalletStatus = 'disconnected' | 'connecting' | 'connected'

export interface WalletContextValue {
  readonly status: WalletStatus
  readonly wallet: ConnectedWallet | null
  readonly error: string | null
  readonly options: readonly WalletOption[]
  /** True while a dev signer (throwaway or server demo key) is the active signer. */
  readonly isDevSigner: boolean
  readonly connect: (optionId: string) => Promise<void>
  readonly disconnect: () => Promise<void>
}
