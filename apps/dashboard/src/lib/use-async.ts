'use client'

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'

export interface AsyncState<T> {
  readonly data: T | undefined
  readonly error: unknown
  /** True only for the first load of a given key; background refreshes keep the old data visible. */
  readonly loading: boolean
  readonly refreshing: boolean
  readonly refresh: () => void
}

interface Options {
  /** Poll every N ms while the tab is visible. */
  readonly intervalMs?: number
  /** When false nothing is fetched and `loading` stays false. */
  readonly enabled?: boolean
}

/**
 * Small data hook: runs `fn` when `deps` change, keeps the previous data during background
 * refreshes (no layout shift), optionally polls while the tab is visible.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: Options = {},
): AsyncState<T> {
  const { intervalMs, enabled = true } = options
  const [state, setState] = useState<{
    data: T | undefined
    error: unknown
    loading: boolean
    refreshing: boolean
  }>({
    data: undefined,
    error: undefined,
    loading: enabled,
    refreshing: false,
  })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const depsKey = JSON.stringify(deps.map((d) => (typeof d === 'bigint' ? d.toString() : d)))

  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: undefined, loading: false, refreshing: false })
      return
    }
    const controller = new AbortController()
    let first = true
    let running = false
    const load = async () => {
      if (running) return
      running = true
      setState((s) => ({ ...s, loading: first && s.data === undefined, refreshing: !first }))
      try {
        const data = await fnRef.current(controller.signal)
        if (!controller.signal.aborted)
          setState({ data, error: undefined, loading: false, refreshing: false })
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((s) => ({ data: s.data, error, loading: false, refreshing: false }))
        }
      } finally {
        running = false
        first = false
      }
    }
    void load()
    let timer: ReturnType<typeof setInterval> | undefined
    if (intervalMs) {
      timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') void load()
      }, intervalMs)
    }
    return () => {
      controller.abort()
      if (timer) clearInterval(timer)
    }
    // depsKey stands in for deps; tick re-runs on demand.
  }, [depsKey, tick, enabled, intervalMs])

  return { ...state, refresh }
}
