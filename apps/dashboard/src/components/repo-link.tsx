'use client'

import { useConfig } from '@/lib/config-context'

export function RepoLink() {
  const config = useConfig()
  if (!config.repoUrl) return null
  return (
    <li>
      <a
        href={config.repoUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium underline"
      >
        Source code
      </a>
      <span className="text-muted"> - open source, MIT.</span>
    </li>
  )
}
