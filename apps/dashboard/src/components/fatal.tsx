import { Notice, PageTitle } from './ui'

export function FatalConfig({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <PageTitle title="Configuration problem" />
      <Notice tone="bad" title="This dashboard will not start">
        {message}
      </Notice>
    </main>
  )
}
