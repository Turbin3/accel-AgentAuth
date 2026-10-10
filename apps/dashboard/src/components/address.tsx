'use client'

import { useState } from 'react'
import { explorerUrl } from '@/lib/config'
import { useConfig } from '@/lib/config-context'
import { shortAddress } from '@/lib/format'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? `${label} copied` : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => setCopied(false))
      }}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        {copied ? (
          <path d="M20 6 9 17l-5-5" />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V6a2 2 0 0 1 2-2h9" />
          </>
        )}
      </svg>
    </button>
  )
}

/** Monospaced address, middle ellipsis, full value in the tooltip, copy button, optional explorer link. */
export function AddressText({
  value,
  label,
  link = false,
  full = false,
}: {
  value: string
  /** A person-given name ("Alice") shown before the address. */
  label?: string
  link?: boolean
  full?: boolean
}) {
  const config = useConfig()
  const text = full ? value : shortAddress(value)
  const body = (
    <span className="font-mono text-[0.8125rem]" title={value}>
      {text}
    </span>
  )
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      {label ? <span className="font-medium">{label}</span> : null}
      {link ? (
        <a
          href={explorerUrl(config, 'address', value)}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-line-strong"
        >
          {body}
          <span className="sr-only"> (opens the explorer)</span>
        </a>
      ) : (
        body
      )}
      <CopyButton value={value} label={`Copy address ${shortAddress(value)}`} />
    </span>
  )
}

export function SignatureLink({ signature }: { signature: string }) {
  const config = useConfig()
  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={explorerUrl(config, 'tx', signature)}
        target="_blank"
        rel="noreferrer noopener"
        title={signature}
        className="font-mono text-[0.8125rem] underline decoration-line-strong"
      >
        {shortAddress(signature, 6, 6)}
        <span className="sr-only"> (opens the explorer)</span>
      </a>
      <CopyButton value={signature} label="Copy signature" />
    </span>
  )
}

/** One line near the first explorer link: the custom-cluster explorer reads the local RPC from your browser. */
export function ExplorerNote() {
  const config = useConfig()
  if (config.cluster !== 'localnet') return null
  return (
    <p className="text-xs text-muted" data-testid="explorer-note">
      Explorer links open explorer.solana.com with your local RPC as a custom cluster. They work in
      Chrome and Firefox when {config.rpcUrl} is reachable from your browser; Chrome asks to allow
      local network access, and the explorer shows &quot;Fetch Failed&quot; if you refuse.
    </p>
  )
}
