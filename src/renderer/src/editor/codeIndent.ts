import type { Editor } from '@tiptap/core'

const pending = new Set<number>()
const listeners = new Set<() => void>()

export function requestCodeIndent(pos: number): void {
  pending.add(pos)
  listeners.forEach((listener) => listener())
}

export function takeCodeIndent(pos: number): boolean {
  if (!pending.has(pos)) return false
  pending.delete(pos)
  return true
}

export function subscribeCodeIndent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function codeBlockPos(editor: Editor): number | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'codeBlock') return $from.before(depth)
  }
  return null
}
