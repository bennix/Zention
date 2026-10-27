function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trimEnd())
    .filter((part) => part.length > 0)
}

function commonPairs(local: string[], remote: string[]): Array<[number, number]> {
  const n = local.length
  const m = remote.length
  const next = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      next[i]![j] = local[i] === remote[j] ? next[i + 1]![j + 1]! + 1 : Math.max(next[i + 1]![j]!, next[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (local[i] === remote[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (next[i + 1]![j]! >= next[i]![j + 1]!) i += 1
    else j += 1
  }
  return pairs
}

export function mergeText(local: string, remote: string): string {
  if (local === remote) return local
  const a = paragraphs(local)
  const b = paragraphs(remote)
  if (a.length === 0) return remote.replace(/^\uFEFF/, '').trim()
  if (b.length === 0) return local.replace(/^\uFEFF/, '').trim()
  if (a.length * b.length > 1_000_000) return `${a.join('\n\n')}\n\n${b.join('\n\n')}`
  const pairs = commonPairs(a, b)
  const out: string[] = []
  let i = 0
  let j = 0
  for (const [ai, bi] of pairs) {
    out.push(...a.slice(i, ai), ...b.slice(j, bi), a[ai]!)
    i = ai + 1
    j = bi + 1
  }
  out.push(...a.slice(i), ...b.slice(j))
  return out.join('\n\n')
}
