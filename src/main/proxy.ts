import { session } from 'electron'
import type { Agent } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

export interface ProxyRoute {
  agent?: Agent
  label: string
}

function bypass(hostname: string): boolean {
  const raw = process.env.NO_PROXY || process.env.no_proxy || ''
  const host = hostname.toLowerCase()
  return raw.split(',').some((item) => {
    const rule = item.trim().toLowerCase()
    if (!rule) return false
    if (rule === '*') return true
    const name = rule.replace(/^\*\.?/, '').replace(/^\./, '')
    return host === name || host.endsWith(`.${name}`)
  })
}

function systemProxyUrl(raw: string): string | null {
  for (const part of raw.split(';')) {
    const match = /^(PROXY|HTTPS|SOCKS4|SOCKS5|SOCKS)\s+(\[[^\]]+\]|[^:\s]+):(\d+)/i.exec(part.trim())
    if (!match) continue
    const kind = match[1]!.toUpperCase()
    const host = match[2]!
    const port = match[3]!
    if (kind === 'SOCKS4') return `socks4://${host}:${port}`
    if (kind.startsWith('SOCKS')) return `socks5://${host}:${port}`
    if (kind === 'HTTPS') return `https://${host}:${port}`
    return `http://${host}:${port}`
  }
  return null
}

function envProxyUrl(protocol: string): string | null {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy
  const chosen = (protocol === 'https:' ? httpsProxy || httpProxy || allProxy : httpProxy || allProxy || httpsProxy)?.trim()
  if (!chosen) return null
  try {
    const url = new URL(chosen)
    if (!url.hostname || !url.port) return null
    return url.toString()
  } catch {
    return null
  }
}

function agentFor(proxyUrl: string): Agent {
  if (new URL(proxyUrl).protocol.startsWith('socks')) return new SocksProxyAgent(proxyUrl)
  return new HttpsProxyAgent(proxyUrl)
}

export function normalizeProxyUrl(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('errProxy')
  }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol)) {
    throw new Error('errProxyScheme')
  }
  if (!url.hostname || !url.port) throw new Error('errProxyPort')
  return url.toString()
}

async function discoverProxyUrl(targetUrl: string): Promise<string> {
  const target = new URL(targetUrl)
  if (bypass(target.hostname)) return ''
  let proxyUrl: string | null = null
  try {
    proxyUrl = systemProxyUrl(await session.defaultSession.resolveProxy(targetUrl))
  } catch {
    proxyUrl = null
  }
  if (!proxyUrl) proxyUrl = envProxyUrl(target.protocol)
  return proxyUrl ?? ''
}

function routeFromUrl(proxyUrl: string): ProxyRoute {
  if (!proxyUrl) return { label: 'direct' }
  const shown = new URL(proxyUrl)
  const kind = shown.protocol.startsWith('socks') ? 'SOCKS' : 'HTTP'
  return { agent: agentFor(proxyUrl), label: `${kind} ${shown.hostname}:${shown.port}` }
}

export async function detectProxy(
  targetUrl = 'https://zenmux.ai/api/v1',
): Promise<{ url: string; label: string; kind: 'direct' | 'http' | 'socks'; endpoint: string }> {
  const url = await discoverProxyUrl(targetUrl)
  const route = routeFromUrl(url)
  if (!url) return { url: '', label: route.label, kind: 'direct', endpoint: '' }
  const shown = new URL(url)
  return {
    url,
    label: route.label,
    kind: shown.protocol.startsWith('socks') ? 'socks' : 'http',
    endpoint: `${shown.hostname}:${shown.port}`,
  }
}

export async function proxyRouteFor(targetUrl: string, preference?: string): Promise<ProxyRoute> {
  const target = new URL(targetUrl)
  if (bypass(target.hostname)) return { label: 'direct' }
  if (preference !== undefined) return routeFromUrl(normalizeProxyUrl(preference))
  return routeFromUrl(await discoverProxyUrl(target.toString()))
}
