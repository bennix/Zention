import { Image } from '@tiptap/extension-image'
import type { Editor } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

let externalImages = false

/** When a dropped Markdown file is open, relative images resolve beside that file. */
export function setExternalImages(on: boolean): void {
  externalImages = on
}

function encodeLocalPath(src: string): string {
  const bytes = new TextEncoder().encode(src)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeLocalPath(token: string): string {
  const padded = token.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Local files stay workspace-relative. Network and data URLs pass through. */
export function displayImageSrc(src: string, external = externalImages): string {
  if (!src) return src
  if (/^(https?:|data:|blob:|zention-asset:)/i.test(src)) return src
  if (external) return `zention-asset://ext/${encodeLocalPath(src)}`
  const rel = src.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^(\.\.\/)+/, '')
  const encoded = rel.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `zention-asset://local/${encoded}`
}

export function storedImageSrc(src: string): string {
  const extPrefix = 'zention-asset://ext/'
  if (src.startsWith(extPrefix)) {
    try {
      return decodeLocalPath(src.slice(extPrefix.length).replace(/^\/+/, ''))
    } catch {
      return src
    }
  }
  const prefix = 'zention-asset://local/'
  if (!src.startsWith(prefix)) return src
  return decodeURIComponent(src.slice(prefix.length))
}

function fileFrom(data: DataTransfer | null): File | null {
  for (const file of data?.files ?? []) {
    if (EXT_BY_MIME[file.type]) return file
  }
  return null
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

async function persistAndInsert(editor: Editor, file: File, pos: number, external: boolean): Promise<void> {
  const ext = EXT_BY_MIME[file.type]
  if (!ext) return
  const payload = { base64: await fileToBase64(file), ext }
  const saved = external ? await window.zention.saveExternalImage(payload) : await window.zention.saveImage(payload)
  if (!saved.ok) {
    window.dispatchEvent(new CustomEvent('zention:toast', { detail: saved.error }))
    return
  }
  const alt = file.name.replace(/\.[a-z0-9]+$/i, '')
  editor.chain().focus().insertContentAt(pos, { type: 'image', attrs: { src: saved.path, alt } }).run()
}

export function createLocalImage(external: boolean) {
  return Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) => storedImageSrc(element.getAttribute('src') ?? ''),
        renderHTML: (attrs) => ({ src: displayImageSrc(String(attrs.src ?? ''), external) }),
      },
    }
  },
  renderMarkdown: (node) => {
    const src = String(node.attrs?.src ?? '')
    const alt = String(node.attrs?.alt ?? '')
    const title = String(node.attrs?.title ?? '')
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('localImageUpload'),
        props: {
          handlePaste(_view, event) {
            const file = fileFrom(event.clipboardData)
            if (!file) return false
            const selection = editor.state.selection
            if (selection instanceof NodeSelection) {
              const name = selection.node.type.name
              if (name === 'inlineEquation' || name === 'blockEquation') {
                window.dispatchEvent(
                  new CustomEvent('zention:equation-image', {
                    detail: {
                      pos: selection.from,
                      kind: name === 'inlineEquation' ? 'inline' : 'block',
                      latex: String(selection.node.attrs.latex ?? ''),
                      file,
                    },
                  }),
                )
                return true
              }
            }
            void persistAndInsert(editor, file, editor.state.selection.from, external)
            return true
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false
            const file = fileFrom(event.dataTransfer)
            if (!file) return false
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
            void persistAndInsert(editor, file, pos, external)
            return true
          },
        },
      }),
    ]
  },
}).configure({ allowBase64: true })
}
