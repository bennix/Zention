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

async function zenmuxFetch(url: string, init: RequestInit = {}, onChunk?: (chunk: Buffer) => void): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'Zention')
  const target = new URL(url)
  const payload =
    init.body == null ? undefined : Buffer.from(typeof init.body === 'string' ? init.body : String(init.body))
  if (payload && !headers.has('Content-Length')) headers.set('Content-Length', String(payload.length))
  const secrets = await getSecrets()
  const preference = proxyPreference !== undefined ? proxyPreference : secrets.proxy
  const route = await proxyRouteFor(url, preference)
  const transport = target.protocol === 'http:' ? httpRequest : httpsRequest
  const via = route.label

  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      run()
    }
    const fail = (error: unknown) =>
      finish(() => {
        if (timedOut) {
          reject(new Error(msg('netTimeout')))
          return
        }
        const detail = fetchDetail(error)
        const text = detail ? msg('netFail', { detail }) : msg('netFailBare')
        reject(new Error(via && via !== 'direct' ? `${text} (${via})` : text))
      })
    const req = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: init.method || 'GET',
        headers: headerRecord(headers),
        ...(route.agent ? { agent: route.agent } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          onChunk?.(chunk)
        })
        res.on('end', () => {
          const flat: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (value == null) continue
            flat[key] = Array.isArray(value) ? value.join(', ') : value
          }
          finish(() => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: flat })))
        })
        res.on('error', fail)
      },
    )
    req.setTimeout(180_000, () => {
      timedOut = true
      req.destroy()
    })
    req.on('error', fail)
    init.signal?.addEventListener(
      'abort',
      () => {
        req.destroy()
        finish(() => reject(new Error(msg('netCancelled'))))
      },
      { once: true },
    )
    if (payload) req.write(payload)
    req.end()
  })
}

async function readBody(response: Response): Promise<{ json: any; text: string }> {
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

function chatText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
      return ''
    })
    .join('')
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
    return chatText(json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content)
  } catch {
    return ''
  }
}

export async function completeChat(input: ChatInput, onDelta?: (delta: string) => void): Promise<string> {
  const secrets = await getSecrets()
  if (!secrets.apiKey) throw new Error(msg('errNoKey'))
  const images = chatImages(input.images)
  const settings = await viewSettings()
  const model = pickModel(input.model, settings.chatModels, secrets.chatModel, images.length > 0)
  const temperature = Math.min(1, Math.max(0, input.temperature ?? (images.length ? 0.1 : 0.4)))
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
  const take = (line: string) => {
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
        temperature,
        stream: true,
        messages: [
          { role: 'system', content: input.system },
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
  )
  if (carry) take(carry)
  const { json, text } = await readBody(response)
  if (!response.ok) throw httpError(msg('errChatHttp'), response.status, json, text)
  const content = streamed.trim() || (text.includes('\ndata:') || text.startsWith('data:') ? chatFromStream(text) : '') || chatText(json?.choices?.[0]?.message?.content).trim()
  if (!content) throw new Error(msg('errNoContent'))
  return content
}

function chatFromStream(text: string): string {
  let out = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const json = JSON.parse(data)
      out += chatText(json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content)
    } catch {
      continue
    }
  }
  return out.trim()
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
    if (model.startsWith('google/')) throw vertexError
    try {
      image = await generateViaOpenAiImages(secrets.apiKey, secrets.baseUrl, model, prompt, input.aspectRatio)
    } catch (fallbackError) {
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

async function postChatProbe(
  apiKey: string,
  baseUrl: string,
  model: string,
  limitField: 'max_tokens' | 'max_completion_tokens',
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const response = await zenmuxFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      temperature: 0,
      [limitField]: 16,
      messages: [{ role: 'user', content: '只回复 ok' }],
    }),
  })
  const body = await readBody(response)
  return { ok: response.ok, status: response.status, ...body }
}

async function testChat(apiKey: string, baseUrl: string, model: string): Promise<string> {
  let result = await postChatProbe(apiKey, baseUrl, model, 'max_tokens')
  const detail = String(result.json?.error?.message ?? result.json?.message ?? result.text ?? '')
  if (!result.ok && /max_tokens|unsupported parameter/i.test(detail)) {
    result = await postChatProbe(apiKey, baseUrl, model, 'max_completion_tokens')
  }
  if (result.status === 401 || result.status === 403) throw httpError(msg('errBadKey'), result.status, result.json, result.text)
  if (!result.ok) throw httpError(msg('errModelDown', { model }), result.status, result.json, result.text)
  const reply = chatText(result.json?.choices?.[0]?.message?.content).trim().replace(/\s+/g, ' ')
  if (!reply) throw new Error(msg('errModelEmpty', { model }))
  return msg('errModelOk', { model, reply: reply.slice(0, 40) })
}

async function testImage(apiKey: string, baseUrl: string, model: string): Promise<string> {
  const prompt = '一个红色圆点'
  try {
    const image = await generateViaVertex(apiKey, model, prompt, '1:1')
    if (!image.base64 && !image.url) throw new Error(msg('errNoPicture'))
  } catch (vertexError) {
    if (model.startsWith('google/') || /401|403/.test(errorMessage(vertexError))) throw vertexError
    try {
      const image = await generateViaOpenAiImages(apiKey, baseUrl, model, prompt, '1:1')
      if (!image.base64 && !image.url) throw new Error(msg('errNoPicture'))
    } catch (fallbackError) {
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
