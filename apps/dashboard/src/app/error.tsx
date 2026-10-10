'use client'

import { Button, EmptyState } from '@/components/ui'

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <EmptyState
      title="Something went wrong on this page"
      action={<Button onClick={reset}>Try again</Button>}
    >
      <p>{error.message || 'An unexpected error occurred.'}</p>
      <p className="mt-2">
        No transaction was sent by this error screen. Check your wallet before retrying anything.
      </p>
    </EmptyState>
  )
}
