import { net } from 'electron'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import { translate, type MessageKey } from '../shared/i18n'
import { ZENMUX_VERTEX_BASE, type ChatInput } from '../shared/types'
import { proxyRouteFor } from './proxy'
import { currentLocale, getSecrets, saveAsset, viewSettings } from './store'

interface GeneratedImage {
  base64?: string
  url?: string
  mime: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function msg(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale(), key, vars)
}

function fetchDetail(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      const code = 'code' in current ? String((current as { code?: unknown }).code ?? '') : ''
      parts.push([code, current.message].filter(Boolean).join(' '))
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return [...new Set(parts.map((part) => part.trim()).filter((part) => part && part !== 'fetch failed'))].join('：')
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

let proxyPreference: string | undefined

class TransientNetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientNetError'
  }
}

class RetryableDisconnect extends Error {
  constructor(
    readonly detail: string,
    readonly via: string,
  ) {
    super(detail)
    this.name = 'RetryableDisconnect'
  }
}

function socketDropped(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  const message = error instanceof Error ? error.message : String(error)
  return (
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED'].includes(code) ||
    /socket hang up|ECONNRESET|aborted|ERR_CONNECTION_|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_SOCKET|ERR_TIMED_OUT/i.test(`${code} ${message}`)
  )
}

function netFailure(detail: string, via: string): TransientNetError {
  const text = detail ? msg('netFail', { detail }) : msg('netFailBare')
  return new TransientNetError(via && via !== 'direct' ? `${text} (${via})` : text)
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(msg('netCancelled')))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    const cancel = () => {
      clearTimeout(timer)
      reject(new Error(msg('netCancelled')))
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function flatHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    flat[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return flat
}

function statusFor(chunks: Buffer[], fallback: number): number {
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.includes('data: [DONE]')) return fallback || 200
  try {
    const json = JSON.parse(text) as { error?: { code?: number } }
    if (json.error) return typeof json.error.code === 'number' && json.error.code >= 400 ? json.error.code : 400
  } catch {
    return fallback || 200
  }
  return fallback || 200
}

function exchangeComplete(chunks: Buffer[]): boolean {
  if (!chunks.length) return false
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.includes('data: [DONE]')) return true
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  try {
    const json = JSON.parse(trimmed) as { choices?: unknown; data?: unknown; error?: unknown }
    return json.choices != null || json.data != null || json.error != null
  } catch {
    return false
  }
}

export async function zenmuxFetch(
  url: string,
  init: RequestInit = {},
  onChunk?: (chunk: Buffer) => void,
  onDiscard?: () => void,
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'Zention')
  const payload =
    init.body == null ? undefined : Buffer.from(typeof init.body === 'string' ? init.body : String(init.body))

  let skipChromium = false
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const secrets = await getSecrets()
    const preference = proxyPreference !== undefined ? proxyPreference : secrets.proxy
    const explicit = typeof preference === 'string' ? preference.trim() : ''
    const route = explicit ? await proxyRouteFor(url, explicit) : { label: 'direct', agent: undefined }
    const viaChromium = !skipChromium && (!explicit || attempt > 0)
    try {
      return await (viaChromium
        ? chromiumExchange(url, init.method || 'GET', headers, payload, init.signal ?? undefined, onChunk)
        : nodeExchange(url, init.method || 'GET', headers, payload, route.agent, init.signal ?? undefined, onChunk))
    } catch (error) {
      if (error instanceof RetryableDisconnect && /ERR_INVALID_ARGUMENT/i.test(error.detail)) skipChromium = true
      if (!(error instanceof RetryableDisconnect) || attempt === 3) {
        if (error instanceof RetryableDisconnect) throw netFailure(error.detail, error.via)
        throw error
      }
      onDiscard?.()
      await waitForRetry(1000 * 2 ** attempt, init.signal ?? undefined)
    } finally {
      route.agent?.destroy()
    }
  }
  throw netFailure('', 'direct')
}

function nodeExchange(
  url: string,
  method: string,
  headers: Headers,
  payload: Buffer | undefined,
  agent: import('node:http').Agent | undefined,
  signal: AbortSignal | undefined,
  onChunk?: (chunk: Buffer) => void,
): Promise<Response> {
  const target = new URL(url)
  const sent = new Headers(headers)
  if (!sent.has('Connection')) sent.set('Connection', 'close')
  if (payload && !sent.has('Content-Length')) sent.set('Content-Length', String(payload.length))
  const transport = target.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let cancelled = false
    const chunks: Buffer[] = []
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      run()
    }
    const succeed = (status: number, responseHeaders: Record<string, string | string[] | undefined>) =>
      finish(() => resolve(new Response(Buffer.concat(chunks), { status, headers: flatHeaders(responseHeaders) })))
    const fail = (error: unknown) =>
      finish(() => {
        if (cancelled) {
          reject(new Error(msg('netCancelled')))
          return
        }
        if (timedOut) {
          reject(new Error(msg('netTimeout')))
          return
        }
        if (exchangeComplete(chunks)) {
          resolve(new Response(Buffer.concat(chunks), { status: statusFor(chunks, 200) }))
          return
        }
        const detail = fetchDetail(error)
        if (socketDropped(error)) {
          reject(new RetryableDisconnect(detail, 'direct'))
          return
        }
        reject(netFailure(detail, 'direct'))
      })
    const req = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers: headerRecord(sent),
        agent: agent ?? false,
      },
      (res) => {
        const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          onChunk?.(chunk)
        })
        res.on('aborted', () => {
          if (exchangeComplete(chunks)) succeed(res.statusCode ?? 200, res.headers)
          else fail(aborted)
        })
        res.on('end', () => {
          if (res.aborted && !exchangeComplete(chunks)) {
            fail(aborted)
            return
          }
          succeed(res.statusCode ?? 0, res.headers)
        })
        res.on('error', fail)
      },
    )
    req.on('socket', (socket) => {
      socket.setKeepAlive(true, 10_000)
      socket.setNoDelay(true)
    })
    req.setTimeout(180_000, () => {
      timedOut = true
      req.destroy()
    })
    req.on('error', fail)
    signal?.addEventListener(
      'abort',
      () => {
        cancelled = true
        req.destroy()
        finish(() => reject(new Error(msg('netCancelled'))))
      },
      { once: true },
    )
    if (payload) req.write(payload)
    req.end()
  })
}

function chromiumExchange(
  url: string,
  method: string,
  headers: Headers,
  payload: Buffer | undefined,
  signal: AbortSignal | undefined,
  onChunk?: (chunk: Buffer) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let cancelled = false
    const chunks: Buffer[] = []
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    const succeed = (status: number, responseHeaders: Record<string, string | string[] | undefined>) =>
      finish(() => resolve(new Response(Buffer.concat(chunks), { status, headers: flatHeaders(responseHeaders) })))
    const fail = (error: unknown) =>
      finish(() => {
        if (cancelled) {
          reject(new Error(msg('netCancelled')))
          return
        }
        if (timedOut) {
          reject(new Error(msg('netTimeout')))
          return
        }
        if (exchangeComplete(chunks)) {
          resolve(new Response(Buffer.concat(chunks), { status: statusFor(chunks, 200) }))
          return
        }
        const detail = fetchDetail(error)
        if (socketDropped(error) || /ERR_/i.test(detail)) {
          reject(new RetryableDisconnect(detail, 'direct'))
          return
        }
        reject(netFailure(detail, 'direct'))
      })
    const request = net.request({ method, url })
    headers.forEach((value, key) => {
      if (!/^(connection|keep-alive|transfer-encoding|host|content-length)$/i.test(key)) request.setHeader(key, value)
    })
    const timer = setTimeout(() => {
      timedOut = true
      request.abort()
    }, 180_000)
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        chunks.push(buf)
        onChunk?.(buf)
      })
      response.on('end', () => succeed(response.statusCode, response.headers))
      response.on('aborted', () => {
        if (exchangeComplete(chunks)) succeed(response.statusCode || 200, response.headers)
        else fail(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
      })
      response.on('error', fail)
    })
    request.on('error', fail)
    signal?.addEventListener(
      'abort',
      () => {
        cancelled = true
        request.abort()
        finish(() => reject(new Error(msg('netCancelled'))))
      },
      { once: true },
    )
    if (payload) request.write(payload)
    request.end()
  })
}

export async function readBody(response: Response): Promise<{ json: any; text: string }> {
  const text = await response.text()
  try {
    return { json: JSON.parse(text), text }
  } catch {
    return { json: null, text }
  }
}

function httpError(label: string, status: number, data: any, text: string): Error {
  const detail = data?.error?.message ?? data?.message ?? text.slice(0, 400)
  return new Error(`${label}（${status}）${detail ? `：${detail}` : ''}`)
}

function modelPath(model: string): { provider: string; name: string } {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(msg('errModelPath'))
  }
  return { provider: model.slice(0, slash), name: model.slice(slash + 1) }
}

function openAiImageSize(aspectRatio?: string): string {
  if (aspectRatio === '16:9') return '1536x1024'
  if (aspectRatio === '4:3') return '1024x768'
  if (aspectRatio === '9:16') return '1024x1536'
  if (aspectRatio === '3:2') return '1536x1024'
  return '1024x1024'
}

function imageFromVertexStream(text: string): GeneratedImage | null {
  let base64 = ''
  let mime = 'image/png'
  const take = (data: any) => {
    const image = generatedPart(data)
    if (!image?.base64) return
    base64 += image.base64
    mime = image.mime || mime
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      take(JSON.parse(data))
    } catch {
      continue
    }
  }
  if (base64) return { base64, mime }
  try {
    const parsed = JSON.parse(text)
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) take(item)
  } catch {
    return null
  }
  return base64 ? { base64, mime } : null
}

function generatedPart(data: any): GeneratedImage | null {
  for (const candidate of data?.candidates ?? []) {
    for (const part of candidate?.content?.parts ?? []) {
      const inline = part?.inlineData ?? part?.inline_data
      if (inline?.data) {
        return { base64: inline.data, mime: inline.mimeType ?? inline.mime_type ?? 'image/png' }
      }
    }
  }
  return null
}

function predictedImage(data: any): GeneratedImage | null {
  const prediction = data?.predictions?.[0]
  if (prediction?.bytesBase64Encoded) {
    return { base64: prediction.bytesBase64Encoded, mime: prediction.mimeType ?? 'image/png' }
  }
  if (prediction?.gcsUri) return { url: prediction.gcsUri, mime: prediction.mimeType ?? 'image/png' }
  const image = data?.data?.[0] ?? data?.generatedImages?.[0]?.image
  if (image?.b64_json || image?.bytesBase64Encoded) {
    return { base64: image.b64_json ?? image.bytesBase64Encoded, mime: 'image/png' }
  }
  if (image?.url || image?.gcsUri) return { url: image.url ?? image.gcsUri, mime: 'image/png' }
  return null
}

/**
 * Image calls follow GenOffice's ZenMux Vertex HTTP client and RedDream's split:
 * `google/*` uses generateContent; every other model uses predict / generateImages.
 * If Vertex rejects the model, fall back to the OpenAI-compatible images API.
 */
async function generateViaVertex(apiKey: string, model: string, prompt: string, aspectRatio?: string): Promise<GeneratedImage> {
  const { provider, name } = modelPath(model)
  const url = `${ZENMUX_VERTEX_BASE}/publishers/${encodeURIComponent(provider)}/models/${encodeURIComponent(name)}`
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

  if (provider === 'google') {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: aspectRatio ?? '1:1', imageSize: '2K' },
      },
    })
    const response = await zenmuxFetch(`${url}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(180_000),
      body,
    })
    const { json, text } = await readBody(response)
    if (!response.ok) throw httpError(msg('errImageHttp'), response.status, json, text)
    const image = imageFromVertexStream(text) ?? generatedPart(json)
    if (!image) throw new Error(msg('errNoImage'))
    return image
  }

  const parameters: Record<string, unknown> = {
    sampleCount: 1,
    aspectRatio: aspectRatio ?? '1:1',
    outputOptions: { mimeType: 'image/png' },
  }
  if (provider === 'openai') {
    parameters.imageSize = openAiImageSize(aspectRatio)
    parameters.quality = 'high'
  }
  const response = await zenmuxFetch(`${url}:predict`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ instances: [{ prompt }], parameters }),
  })
  const { json, text } = await readBody(response)
  if (!response.ok) throw httpError(msg('errImageHttp'), response.status, json, text)
  const image = predictedImage(json)
  if (!image) throw new Error(msg('errNoImage'))
  return image
}

async function generateViaOpenAiImages(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  aspectRatio?: string,
): Promise<GeneratedImage> {
  const response = await zenmuxFetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: openAiImageSize(aspectRatio),
    }),
  })
  const { json, text } = await readBody(response)
  if (!response.ok) throw httpError(msg('errImageHttp'), response.status, json, text)
  const image = predictedImage(json)
  if (!image) throw new Error(msg('errNoImage'))
  return image
}

async function materialize(image: GeneratedImage): Promise<{ bytes: Buffer; mime: string }> {
  if (image.base64) return { bytes: Buffer.from(image.base64, 'base64'), mime: image.mime }
  if (!image.url) throw new Error(msg('errNoImage'))
  const response = await zenmuxFetch(image.url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(msg('errDownload', { status: response.status }))
  const mime = response.headers.get('content-type')?.split(';')[0] || image.mime
  return { bytes: Buffer.from(await response.arrayBuffer()), mime }
}

function extFor(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  return 'png'
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return ''
  const row = part as { thought?: unknown; text?: unknown; content?: unknown; output_text?: unknown }
  if (row.thought === true) return ''
  if (typeof row.text === 'string') return row.text
  if (row.text && typeof row.text === 'object' && typeof (row.text as { value?: unknown }).value === 'string') {
    return (row.text as { value: string }).value
  }
  if (typeof row.content === 'string') return row.content
  if (typeof row.output_text === 'string') return row.output_text
  return ''
}

function chatText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => partText(part)).join('')
  return partText(content)
}

function reasoningText(node: any): string {
  if (!node || typeof node !== 'object') return ''
  const bits: string[] = []
  if (typeof node.reasoning === 'string') bits.push(node.reasoning)
  if (typeof node.reasoning_content === 'string') bits.push(node.reasoning_content)
  if (Array.isArray(node.reasoning_details)) {
    for (const item of node.reasoning_details) {
      if (typeof item?.text === 'string') bits.push(item.text)
      else if (typeof item?.summary === 'string') bits.push(item.summary)
    }
  }
  return bits.join('')
}

function choiceContent(choice: any): string {
  if (!choice) return ''
  return (
    chatText(choice.delta?.content ?? choice.message?.content) ||
    (typeof choice.delta?.output_text === 'string' ? choice.delta.output_text : '') ||
    (typeof choice.message?.output_text === 'string' ? choice.message.output_text : '') ||
    (typeof choice.text === 'string' ? choice.text : '')
  )
}

function visibleText(json: any): string {
  const choice = json?.choices?.[0]
  const direct =
    choiceContent(choice) ||
    (typeof json?.output_text === 'string' ? json.output_text : '')
  if (direct.trim()) return direct.trim()
  const output = Array.isArray(json?.output) ? json.output : []
  for (const item of output) {
    if (item?.type === 'reasoning') continue
    const text = chatText(item?.content) || (typeof item?.text === 'string' ? item.text : '')
    if (text.trim()) return text.trim()
  }
  const candidates = Array.isArray(json?.candidates) ? json.candidates : []
  for (const candidate of candidates) {
    const text = chatText(candidate?.content?.parts)
    if (text.trim()) return text.trim()
  }
  return ''
}

function thoughtText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || (part as { thought?: unknown }).thought !== true) return ''
      return typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''
    })
    .join('')
}

function replyText(json: any): string {
  const visible = visibleText(json)
  if (visible) return visible
  const choice = json?.choices?.[0]
  const message = choice?.message ?? choice?.delta
  const candidates = Array.isArray(json?.candidates) ? json.candidates : []
  return (
    reasoningText(message) ||
    thoughtText(message?.content) ||
    candidates.map((candidate: any) => thoughtText(candidate?.content?.parts)).join('')
  ).trim()
}

function chatImages(images: ChatInput['images']): Array<{ mime: string; base64: string }> {
  return (images ?? []).slice(0, 5).map((image) => {
    const mime = image.mime.split(';')[0]?.trim().toLowerCase() ?? ''
    const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime
    if (!/^image\/(png|jpeg|gif|webp)$/.test(normalized)) throw new Error(msg('errImageType'))
    const base64 = image.base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '')
    if (!base64) throw new Error(msg('errEmptyImage'))
    if (base64.length > 12_000_000) throw new Error(msg('errImageBig'))
    return { mime: normalized, base64 }
  })
}

function pickModel(requested: string | undefined, models: string[], current: string, hasImage: boolean): string {
  const chosen = (requested?.trim() || current).trim()
  if (!hasImage) return chosen
  const vision = /claude|gpt-4|gpt-5|gemini|vision|\bvl\b|glm-.*v/i
  if (vision.test(chosen)) return chosen
  return models.find((model) => vision.test(model)) || chosen
}

function deltaFromSseLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  try {
    const json = JSON.parse(data)
    return choiceContent(json?.choices?.[0])
  } catch {
    return ''
  }
}

function reasoningFromSseLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  try {
    const choice = JSON.parse(data)?.choices?.[0]
    return reasoningText(choice?.delta) || reasoningText(choice?.message)
  } catch {
    return ''
  }
}

export async function completeChat(input: ChatInput, onDelta?: (delta: string) => void, onReset?: () => void): Promise<string> {
  const secrets = await getSecrets()
  if (!secrets.apiKey) throw new Error(msg('errNoKey'))
  const images = chatImages(input.images)
  const settings = await viewSettings()
  const model = pickModel(input.model, settings.chatModels, secrets.chatModel, images.length > 0)
  const system = input.system
  const userContent = images.length
    ? [
        { type: 'text', text: input.user },
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.base64}` },
        })),
      ]
    : input.user
  let carry = ''
  let streamed = ''
  let reasoning = ''
  const take = (line: string) => {
    reasoning += reasoningFromSseLine(line)
    const delta = deltaFromSseLine(line)
    if (!delta) return
    streamed += delta
    onDelta?.(delta)
  }
  const response = await zenmuxFetch(
    `${secrets.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${secrets.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    },
    (chunk) => {
      carry += chunk.toString('utf8')
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) take(line)
    },
    () => {
      carry = ''
      streamed = ''
      reasoning = ''
      onReset?.()
    },
  )
  if (carry) take(carry)
  const { json, text } = await readBody(response)
  if (!response.ok) throw httpError(msg('errChatHttp'), response.status, json, text)
  const fromStream = streamParts(text)
  const content = streamed.trim() || fromStream.content || visibleText(json) || reasoning.trim() || fromStream.reasoning || replyText(json)
  if (!content) throw new Error(msg('errNoContent'))
  return content
}

export async function generateAndStoreImage(input: {
  prompt: string
  model?: string
  aspectRatio?: string
}): Promise<string> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error(msg('errPrompt'))
  const secrets = await getSecrets()
  if (!secrets.apiKey) throw new Error(msg('errNoKey'))
  const model = input.model?.trim() || secrets.imageModel
  let image: GeneratedImage
  try {
    image = await generateViaVertex(secrets.apiKey, model, prompt, input.aspectRatio)
  } catch (vertexError) {
    if (model.startsWith('google/') || vertexError instanceof TransientNetError) throw vertexError
    try {
      image = await generateViaOpenAiImages(secrets.apiKey, secrets.baseUrl, model, prompt, input.aspectRatio)
    } catch (fallbackError) {
      if (fallbackError instanceof TransientNetError) throw fallbackError
      throw new Error(msg('errFallback', { first: errorMessage(vertexError), second: errorMessage(fallbackError) }))
    }
  }
  const file = await materialize(image)
  return saveAsset(file.bytes, extFor(file.mime))
}

async function credentials(input: { apiKey?: string; baseUrl?: string }): Promise<{ apiKey: string; baseUrl: string }> {
  const secrets = await getSecrets()
  const apiKey = input.apiKey?.trim() || secrets.apiKey
  if (!apiKey) throw new Error(msg('errNoKey'))
  const baseUrl = (input.baseUrl?.trim() || secrets.baseUrl).replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(msg('errBaseUrl'))
  return { apiKey, baseUrl }
}

async function testKey(apiKey: string, baseUrl: string): Promise<string> {
  const response = await zenmuxFetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  })
  const { json, text } = await readBody(response)
  if (response.status === 401 || response.status === 403) throw httpError(msg('errBadKey'), response.status, json, text)
  if (response.ok) {
    const count = Array.isArray(json?.data) ? json.data.length : 0
    return count > 0 ? msg('errKeyCount', { count }) : msg('errKeyOk')
  }
  throw httpError(msg('errKeyTest'), response.status, json, text)
}

function streamParts(text: string): { content: string; reasoning: string } {
  let content = ''
  let reasoning = ''
  for (const line of text.split('\n')) {
    content += deltaFromSseLine(line)
    reasoning += reasoningFromSseLine(line)
  }
  return { content: content.trim(), reasoning: reasoning.trim() }
}

async function postChatProbe(
  apiKey: string,
  baseUrl: string,
  model: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const response = await zenmuxFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: '只回复 ok' }], ...extra }),
  })
  const body = await readBody(response)
  return { ok: response.ok, status: response.status, ...body }
}

function probeDetail(result: { json: any; text: string }): string {
  return String(result.json?.error?.message ?? result.json?.message ?? result.text ?? '')
}

function probeReply(result: { json: any; text: string }): string {
  const streamed = streamParts(result.text)
  return (streamed.content || visibleText(result.json) || streamed.reasoning || replyText(result.json)).trim().replace(/\s+/g, ' ')
}

async function testChat(apiKey: string, baseUrl: string, model: string): Promise<string> {
  let result = await postChatProbe(apiKey, baseUrl, model)
  if (!result.ok && /max_tokens|max_completion_tokens|unsupported parameter/i.test(probeDetail(result))) {
    result = await postChatProbe(apiKey, baseUrl, model, { max_completion_tokens: 4096 })
  }
  let reply = result.ok ? probeReply(result) : ''
  if (result.ok && !reply) {
    result = await postChatProbe(apiKey, baseUrl, model, { max_completion_tokens: 4096, reasoning: { effort: 'minimal', max_tokens: 256 } })
    if (result.ok) reply = probeReply(result)
  }
  if (result.status === 401 || result.status === 403) throw httpError(msg('errBadKey'), result.status, result.json, result.text)
  if (!result.ok) throw httpError(msg('errModelDown', { model }), result.status, result.json, result.text)
  if (!reply) throw new Error(msg('errModelEmpty', { model }))
  return msg('errModelOk', { model, reply: reply.slice(0, 40) })
}

async function testImage(apiKey: string, baseUrl: string, model: string): Promise<string> {
  const prompt = '一个红色圆点'
  try {
    const image = await generateViaVertex(apiKey, model, prompt, '1:1')
    if (!image.base64 && !image.url) throw new Error(msg('errNoPicture'))
  } catch (vertexError) {
    if (model.startsWith('google/') || vertexError instanceof TransientNetError || /401|403/.test(errorMessage(vertexError))) throw vertexError
    try {
      const image = await generateViaOpenAiImages(apiKey, baseUrl, model, prompt, '1:1')
      if (!image.base64 && !image.url) throw new Error(msg('errNoPicture'))
    } catch (fallbackError) {
      if (fallbackError instanceof TransientNetError) throw fallbackError
      throw new Error(msg('errFallback', { first: errorMessage(vertexError), second: errorMessage(fallbackError) }))
    }
  }
  return msg('errImageOk', { model })
}

export async function testConnection(input: {
  kind: 'key' | 'chat' | 'image'
  apiKey?: string
  baseUrl?: string
  model?: string
  proxy?: string
}): Promise<string> {
  const previous = proxyPreference
  if (input.proxy !== undefined) proxyPreference = input.proxy
  try {
    const { apiKey, baseUrl } = await credentials(input)
    if (input.kind === 'key') return testKey(apiKey, baseUrl)
    const model = input.model?.trim()
    if (!model) throw new Error(msg('errNoModel'))
    if (input.kind === 'chat') return testChat(apiKey, baseUrl, model)
    return testImage(apiKey, baseUrl, model)
  } finally {
    proxyPreference = previous
  }
}
