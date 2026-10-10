'use client'

import { useCallback, useRef, useState } from 'react'
import { relayPolicyPda, type ActivityItem, type Client } from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'
import { useAsync } from './use-async'

const PAGE = 50

export function rowKey(item: ActivityItem): string {
  return `${item.signature}:${item.instructionIndex}:${item.kind}`
}

/**
 * Live activity feed of a mandate (and its relay policy): newest first, allowed AND blocked.
 * Confirmed transactions never change, so decoded rows are cached and each poll only fetches new ones.
 */
export function useActivity(client: Client, mandate: Address, intervalMs = 5000) {
  const cache = useRef(new Map<string, ActivityItem[]>())
  const [older, setOlder] = useState<ActivityItem[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const state = useAsync(
    async (signal) => {
      const policy = (await relayPolicyPda(mandate, client.programIds.relay)).address
      const page = await client.activityPage({
        mandate,
        policy,
        limit: PAGE,
        cache: cache.current,
        abortSignal: signal,
      })
      return { items: page.items, nextBefore: page.nextBefore, policy }
    },
    [mandate],
    { intervalMs },
  )

  const loadOlder = useCallback(async () => {
    if (!state.data) return
    const last = [...state.data.items, ...older].at(-1)
    if (!last) return
    setLoadingOlder(true)
    try {
      const page = await client.activityPage({
        mandate,
        policy: state.data.policy,
        limit: PAGE,
        before: last.signature,
        cache: cache.current,
      })
      setOlder((o) => [...o, ...page.items])
      if (page.nextBefore === null || page.items.length === 0) setExhausted(true)
    } finally {
      setLoadingOlder(false)
    }
  }, [client, mandate, state.data, older])

  const rows = state.data ? dedupe([...state.data.items, ...older]) : []
  const canLoadOlder = !exhausted && state.data !== undefined && state.data.nextBefore !== null
  return { state, rows, loadOlder, loadingOlder, canLoadOlder }
}

function dedupe(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>()
  const out: ActivityItem[] = []
  for (const item of items) {
    const k = rowKey(item)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(item)
    }
  }
  return out
}
