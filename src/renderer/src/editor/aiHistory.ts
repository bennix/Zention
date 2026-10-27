import { closeHistory } from '@tiptap/pm/history'
import type { Transaction } from '@tiptap/pm/state'

let nextComposition = 1

export function beginAiHistory(): number {
  nextComposition += 1
  return nextComposition
}

export function tagAiHistory(tr: Transaction, composition: number, closeGroup: boolean): void {
  tr.setMeta('addToHistory', true)
  tr.setMeta('composition', composition)
  if (closeGroup) closeHistory(tr)
}
