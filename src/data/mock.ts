import type { Team } from '../types';

export const MOCK_TEAMS: Team[] = [
  {
    id: 'vera',
    name: 'VERA',
    teammates: [
      { id: 'v1', name: 'teammate-01', command: 'claude', cwd: '~/AI-Projects/VERA', status: 'running', activeFile: 'core/STRATEGY.md' },
      { id: 'v2', name: 'teammate-02', command: 'claude', cwd: '~/AI-Projects/VERA', status: 'waiting', activeFile: 'core/ops/follow-ups.md' },
      { id: 'v3', name: 'teammate-03', command: 'claude', cwd: '~/AI-Projects/VERA', status: 'running', activeFile: 'ai-risk-readiness/REPORT-SPEC.md' },
    ],
  },
  {
    id: 'helm',
    name: 'HELM',
    teammates: [
      { id: 'h1', name: 'teammate-01', command: 'claude', cwd: '~/AI-Projects/Helm', status: 'running', activeFile: 'src/components/TerminalPanel.tsx' },
      { id: 'h2', name: 'teammate-02', command: 'claude', cwd: '~/AI-Projects/Helm', status: 'running', activeFile: 'src/styles/tokens.css' },
      { id: 'h3', name: 'teammate-03', command: 'claude', cwd: '~/AI-Projects/Helm', status: 'done', activeFile: 'src/hooks/useGridLayout.ts' },
      { id: 'h4', name: 'teammate-04', command: 'claude', cwd: '~/AI-Projects/Helm', status: 'error', activeFile: 'src/App.tsx' },
    ],
  },
  {
    id: 'trading',
    name: 'TRADING',
    teammates: [
      { id: 't1', name: 'teammate-01', command: 'claude', cwd: '~/AI-Projects/Trading', status: 'running', activeFile: 'autotrade_kalshi/loop.py' },
      { id: 't2', name: 'teammate-02', command: 'claude', cwd: '~/AI-Projects/Trading', status: 'running', activeFile: 'autotrade_kalshi/model.py' },
    ],
  },
];

export const FAKE_TERMINAL_LINES: string[][] = [
  [
    '> claude --dangerously-skip-permissions',
    '',
    '✓ Connected · Claude Sonnet 4.6',
    '─────────────────────────────────',
    '',
    'Task: Refactor authentication module',
    '',
    'Reading src/auth/login.tsx...',
    'Analyzing structure, 312 lines',
    '',
    'Writing src/auth/login.tsx',
    '  + JWT refresh interceptor',
    '  + Removed legacy session handler',
    '  + Unified error boundary',
    '  ✓ Saved · 47 lines changed',
    '',
    'Reading src/auth/middleware.ts...',
    'Analyzing dependencies...',
    '',
    'Writing src/auth/middleware.ts',
    '  + Token validation pipeline',
    '  ✓ Saved · 23 lines changed',
    '',
    'Running: npm test -- --watch=false',
    '  ✓ 12/12 tests passed',
    '',
    'Reading src/lib/api.ts...',
  ],
  [
    '> claude --dangerously-skip-permissions',
    '',
    '✓ Connected · Claude Sonnet 4.6',
    '─────────────────────────────────',
    '',
    'Task: Build dashboard components',
    '',
    'Reading src/components/Dashboard/...',
    'Found 8 files to process',
    '',
    'Writing src/components/Dashboard/MetricsCard.tsx',
    '  + Responsive grid layout',
    '  + API hook integration',
    '  + Loading skeleton states',
    '  ✓ Saved · 89 lines',
    '',
    'Writing src/components/Dashboard/Chart.tsx',
    '  + D3 integration',
    '  + Dark theme tokens',
    '  ✓ Saved · 134 lines',
    '',
    'Running: npx tsc --noEmit',
    '  ✓ 0 errors',
    '',
    'Reading src/app/page.tsx...',
  ],
  [
    '> claude --dangerously-skip-permissions',
    '',
    '✓ Connected · Claude Sonnet 4.6',
    '─────────────────────────────────',
    '',
    'Task: Optimize database queries',
    '',
    'Reading lib/db/queries.ts...',
    'Identified N+1 query in getUserCards()',
    '',
    'Writing lib/db/queries.ts',
    '  + Replaced N+1 with JOIN',
    '  + Added index hint',
    '  + Pagination support',
    '  ✓ Saved · 31 lines changed',
    '',
    'Running: npx supabase db diff',
    '  ✓ No schema drift',
    '',
    'Reading lib/db/cards.ts...',
    'Analyzing usage patterns...',
    '',
    'Writing lib/db/cards.ts',
    '  + Batch insert support',
    '  ✓ Saved · 18 lines changed',
  ],
  [
    '> claude --dangerously-skip-permissions',
    '',
    '✓ Connected · Claude Sonnet 4.6',
    '─────────────────────────────────',
    '',
    'Task: Write test coverage for API routes',
    '',
    'Reading src/app/api/...',
    'Found 6 routes without coverage',
    '',
    'Writing src/app/api/chat/route.test.ts',
    '  + POST /api/chat happy path',
    '  + Rate limiting behavior',
    '  + Auth failure cases',
    '  ✓ Saved · 112 lines',
    '',
    'Writing src/app/api/upload/route.test.ts',
    '  + File validation',
    '  + Size limit enforcement',
    '  ✓ Saved · 78 lines',
    '',
    'Running: npm test',
    '  ✓ 31/31 tests passed',
    '  Coverage: 84.2%',
  ],
];

export const FAKE_FILE_CONTENT = `import { useState, useCallback, useEffect } from 'react'
import { signIn, signOut } from '@/lib/auth'
import { validateCredentials } from '@/lib/validation'
import { useRouter } from 'next/navigation'
import type { AuthResult } from '@/types'

interface LoginProps {
  onSuccess?: (result: AuthResult) => void
  redirectTo?: string
}

export function LoginForm({ onSuccess, redirectTo = '/dashboard' }: LoginProps) {
  const router = useRouter()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    setError(null)
  }, [email, password])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const validation = await validateCredentials({ email, password })
      if (!validation.ok) {
        setError(validation.message)
        return
      }

      const result = await signIn({ email, password })
      onSuccess?.(result)
      router.push(redirectTo)

    } catch (err) {
      setError('Authentication failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [email, password, redirectTo, onSuccess, router])

  return (
    <form onSubmit={handleSubmit} className="login-form">
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={loading}>
        {loading ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  )
}
`;
