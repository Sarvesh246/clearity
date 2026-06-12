'use client'

import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center px-6 bg-base"
        style={{ gap: 24 }}
      >
        <div
          className="neu-card flex flex-col items-center gap-4 text-center"
          style={{ padding: 32, maxWidth: 360, width: '100%', borderRadius: 24 }}
          role="alert"
        >
          <div
            className="neu-inset flex items-center justify-center"
            style={{ width: 56, height: 56, borderRadius: 16 }}
          >
            <AlertTriangle size={24} color="#e84141" strokeWidth={1.75} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p className="font-semibold text-white" style={{ fontSize: 17 }}>
              Something went wrong
            </p>
            <p style={{ fontSize: 13, color: '#8888a0', lineHeight: 1.5 }}>
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
          </div>
          <button
            className="neu-button flex items-center gap-2"
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: '10px 20px', fontSize: 14, fontWeight: 500, color: '#e8e8f0' }}
            aria-label="Retry — dismiss error and try again"
          >
            <RefreshCw size={15} strokeWidth={1.75} />
            Try again
          </button>
        </div>
      </div>
    )
  }
}
