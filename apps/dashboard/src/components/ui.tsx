'use client'

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { DisplayError } from '@/lib/tx-runner'

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad'

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink border-line',
  ok: 'bg-ok-bg text-ok border-ok/40',
  warn: 'bg-warn-bg text-warn border-warn/40',
  bad: 'bg-bad-bg text-bad border-bad/40',
}

const TONE_MARK: Record<Tone, string> = { neutral: '', ok: '✓ ', warn: '! ', bad: '✕ ' }

/** Status chip. The mark (check, !, cross) keeps meaning when colour is not perceived. */
export function Chip({
  tone = 'neutral',
  children,
  title,
  mark = true,
}: {
  tone?: Tone
  children: ReactNode
  title?: string
  mark?: boolean
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      {mark ? <span aria-hidden="true">{TONE_MARK[tone]}</span> : null}
      {children}
    </span>
  )
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink border-accent hover:opacity-90',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-surface-2',
  danger: 'bg-surface text-bad border-bad/60 hover:bg-bad-bg',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-surface-2',
}

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...props}
    />
  )
}

export function Card({
  children,
  className = '',
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article' | 'li'
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`rounded-xl border border-line bg-surface p-4 sm:p-6 ${className}`} {...rest}>
      {children}
    </Tag>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`aa-skeleton ${className}`} />
}

export function PageTitle({
  title,
  lead,
  actions,
}: {
  title: string
  lead?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {lead ? <p className="mt-2 text-muted">{lead}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      {children ? (
        <div className="mx-auto mt-2 max-w-prose text-sm text-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

/** A decoded error: program and name first, the plain message, then what to do about it. */
export function ErrorBox({
  error,
  title,
}: {
  error: DisplayError | null | undefined
  title?: string
}) {
  if (!error) return null
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad-bg p-4 text-sm text-ink">
      {title ? <p className="mb-1 font-semibold text-bad">{title}</p> : null}
      <p className="font-semibold text-bad" data-testid="error-title">
        {error.title}
        {error.code ? (
          <span className="ml-2 font-mono text-xs font-normal">({error.code})</span>
        ) : null}
      </p>
      <p className="mt-1 break-words">{error.detail}</p>
      {error.hint ? (
        <p className="mt-2 text-muted">
          <span className="font-medium text-ink">What to do: </span>
          {error.hint}
        </p>
      ) : null}
    </div>
  )
}

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone
  title?: string
  children: ReactNode
}) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'note'}
      className={`rounded-lg border p-4 text-sm ${TONE[tone]}`}
    >
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="text-ink">{children}</div>
    </div>
  )
}

/**
 * Modal dialog on the native <dialog> element: the browser traps focus, makes the rest of the page
 * inert, closes on Escape and returns focus to the opener.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-line bg-surface p-0 shadow-xl"
    >
      {open ? (
        <div className="p-4 sm:p-6">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description ? (
            <div id={descId} className="mt-2 text-sm text-muted">
              {description}
            </div>
          ) : null}
          {children ? <div className="mt-4">{children}</div> : null}
          {footer ? <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs font-medium text-bad">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export const inputClass =
  'min-h-10 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted aria-[invalid=true]:border-bad'
