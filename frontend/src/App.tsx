import { useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, generateSaga, getMockSaga } from './api/saga'
import { buildSagaView } from './api/viewModel'
import LandingTerminal, { CrtOverlay } from './components/LandingTerminal.jsx'
import SagaApp from './components/SagaApp.jsx'
import { useLanguage } from './i18n/LanguageContext.jsx'
import type { SagaPayload } from './types/saga'

const DEFAULT_LIMIT = 15

/**
 * Language-independent error descriptor. Resolving the message at render time
 * (instead of in the catch block) means the alert follows a later FR/EN toggle.
 */
type AppError =
  | { kind: 'offline' }
  | { kind: 'unexpected' }
  | { kind: 'http'; status: number }
  | { kind: 'server'; message: string }

function toAppError(err: unknown): AppError {
  if (err instanceof ApiError) {
    if (err.status === 0) return { kind: 'offline' }
    // `api/saga.ts` falls back to an "HTTP nnn" token when the body is not
    // JSON (Vite proxy 502, plain-text 500). Those are infrastructure
    // failures: show the offline copy rather than a bare status code.
    const token = /^HTTP (\d{3})$/.exec(err.message)
    if (token) {
      const status = Number(token[1])
      return status >= 502 ? { kind: 'offline' } : { kind: 'http', status }
    }
    return { kind: 'server', message: err.message }
  }
  return { kind: 'unexpected' }
}

export default function App() {
  const { lang, t } = useLanguage()
  const [saga, setSaga] = useState<SagaPayload | null>(null)
  const [repoPath, setRepoPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  // Demo sagas are language-specific: refetch `/saga/mock?lang=…` when the HUD
  // toggles. A saga generated from a repo stays in the language it was
  // generated in (regenerating is an explicit, expensive action).
  const [source, setSource] = useState<'demo' | 'repo' | null>(null)
  const demoLang = useRef<string | null>(null)

  const view = useMemo(
    () => (saga ? buildSagaView(saga, { repoPath: repoPath || undefined }) : null),
    [saga, repoPath],
  )

  useEffect(() => {
    if (source !== 'demo' || demoLang.current === lang) return undefined
    demoLang.current = lang
    let alive = true
    setBusy(true)
    setError(null)
    getMockSaga(lang === 'fr' ? 'fr' : 'en')
      .then((payload) => {
        if (alive) setSaga(payload)
      })
      .catch((err) => {
        if (alive) setError(toAppError(err))
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [lang, source])

  const errorText = (value: AppError | null): string | null => {
    if (!value) return null
    switch (value.kind) {
      case 'offline':
        return t('app.offline')
      case 'unexpected':
        return t('app.unexpected')
      case 'http':
        return t('app.httpError', { status: value.status })
      default:
        return value.message
    }
  }

  async function start(repo: string) {
    setBusy(true)
    setError(null)
    try {
      const payload = await generateSaga({
        repo_url: `https://github.com/${repo}`,
        limit: DEFAULT_LIMIT,
        language: lang === 'fr' ? 'fr' : 'en',
      })
      setRepoPath(repo)
      setSaga(payload)
      demoLang.current = null
      setSource('repo')
    } catch (err) {
      setError(toAppError(err))
    } finally {
      setBusy(false)
    }
  }

  async function loadDemo() {
    setBusy(true)
    setError(null)
    try {
      const payload = await getMockSaga(lang === 'fr' ? 'fr' : 'en')
      setRepoPath('')
      setSaga(payload)
      demoLang.current = lang
      setSource('demo')
    } catch (err) {
      setError(toAppError(err))
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setSaga(null)
    setRepoPath('')
    setError(null)
    demoLang.current = null
    setSource(null)
  }

  if (view) {
    return <SagaApp initialSaga={view} onReset={reset} />
  }

  return (
    <>
      <LandingTerminal
        onStart={start}
        onDemo={loadDemo}
        busy={busy}
        serverError={errorText(error)}
      />
      <CrtOverlay />
    </>
  )
}
