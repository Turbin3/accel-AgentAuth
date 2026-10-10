import Link from 'next/link'
import { EmptyState } from '@/components/ui'

export default function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link href="/" className="underline">
          Back to the start
        </Link>
      }
    >
      <p>That address does not exist in this dashboard.</p>
    </EmptyState>
  )
}
