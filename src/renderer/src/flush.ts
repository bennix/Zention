let flushImpl: (() => Promise<void>) | null = null

export function registerFlush(fn: () => Promise<void>): () => void {
  flushImpl = fn
  return () => {
    if (flushImpl === fn) flushImpl = null
  }
}

export function flushNotes(): Promise<void> {
  return flushImpl?.() ?? Promise.resolve()
}
