'use client'

import { useCallback, useRef, useState } from 'react'
import {
  AgentAuthError,
  SdkError,
  parseProgramError,
  type Client,
  type Plan,
} from '@agentauth-sol/sdk'
import type { TransactionSigner } from '@solana/kit'

export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface StepProgress {
  readonly label: string
  readonly description: string
  readonly status: StepStatus
  readonly signature?: string
  readonly error?: DisplayError
}

/** An error ready for people: a decoded program error when there is one, plain text otherwise. */
export interface DisplayError {
  readonly title: string
  readonly detail: string
  readonly hint?: string
  readonly code?: string
}

export function toDisplayError(error: unknown): DisplayError {
  if (error instanceof AgentAuthError) {
    return {
      title: `${error.program}: ${error.name}`,
      detail: error.message,
      hint: error.hint,
      code: `${error.program}:${error.code}`,
    }
  }
  const decoded = parseProgramError(error)
  if (decoded) return toDisplayError(decoded)
  if (error instanceof SdkError) {
    return { title: error.code, detail: error.message }
  }
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? error.name : 'Error'
    return { title: name, detail: error.message || String(error) }
  }
  return { title: 'Error', detail: String(error) }
}

export interface TxRunner {
  readonly steps: readonly StepProgress[]
  readonly running: boolean
  readonly done: boolean
  readonly failed: boolean
  readonly run: (plan: Plan) => Promise<boolean>
  readonly reset: () => void
}

/**
 * Run the steps of an unsigned plan in order with the connected signer. Stops at the first failure
 * and reports a decoded error for it; a step that depends on an earlier one is only submitted
 * after the earlier one is confirmed (`sendAndConfirm` returns at `confirmed`).
 */
export function useTxRunner(client: Client, signer: TransactionSigner | null): TxRunner {
  const [steps, setSteps] = useState<StepProgress[]>([])
  const [running, setRunning] = useState(false)
  const busy = useRef(false)

  const reset = useCallback(() => {
    if (!busy.current) setSteps([])
  }, [])

  const run = useCallback(
    async (plan: Plan): Promise<boolean> => {
      if (busy.current) return false
      if (!signer) {
        setSteps([
          {
            label: 'Connect a wallet',
            description: 'A wallet must sign these transactions.',
            status: 'failed',
            error: { title: 'No wallet connected', detail: 'Connect a wallet and try again.' },
          },
        ])
        return false
      }
      busy.current = true
      setRunning(true)
      let progress: StepProgress[] = plan.steps.map((s) => ({
        label: s.label,
        description: s.description,
        status: 'pending',
      }))
      setSteps(progress)
      const update = (i: number, patch: Partial<StepProgress>) => {
        progress = progress.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
        setSteps(progress)
      }
      try {
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i]
          if (!step) continue
          update(i, { status: 'running' })
          try {
            const res = await client.sendAndConfirm(step, { signers: [signer] })
            if (!res.ok) {
              update(i, {
                status: 'failed',
                signature: res.signature,
                error: toDisplayError(res.error ?? res.err),
              })
              return false
            }
            update(i, { status: 'done', signature: res.signature })
          } catch (error) {
            update(i, { status: 'failed', error: toDisplayError(error) })
            return false
          }
        }
        return true
      } finally {
        busy.current = false
        setRunning(false)
      }
    },
    [client, signer],
  )

  return {
    steps,
    running,
    done: steps.length > 0 && steps.every((s) => s.status === 'done'),
    failed: steps.some((s) => s.status === 'failed'),
    run,
    reset,
  }
}
