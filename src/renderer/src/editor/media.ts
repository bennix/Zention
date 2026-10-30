import { Node, mergeAttributes, type MarkdownToken } from '@tiptap/core'
import { displayImageSrc, storedImageSrc } from './image'

export type MediaKind = 'audio' | 'video'

function mediaKindFromSrc(src: string): MediaKind {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src) ? 'video' : 'audio'
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export const MediaBlock = Node.create({
  name: 'mediaBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    src: { default: '' },
    kind: { default: 'audio' as MediaKind },
    title: { default: '' },
  }),
  parseHTML: () => [
    {
      tag: 'audio[src]',
      getAttrs: (el) => {
        const node = el as HTMLAudioElement
        const src = storedImageSrc(node.getAttribute('src') ?? '')
        return { src, kind: 'audio', title: node.getAttribute('title') ?? '' }
      },
    },
    {
      tag: 'video[src]',
      getAttrs: (el) => {
        const node = el as HTMLVideoElement
        const src = storedImageSrc(node.getAttribute('src') ?? '')
        return { src, kind: 'video', title: node.getAttribute('title') ?? '' }
      },
    },
    {
      tag: 'div[data-zention-media]',
      getAttrs: (el) => {
        const node = el as HTMLElement
        const src = storedImageSrc(node.getAttribute('data-src') ?? '')
        const kind = node.getAttribute('data-kind') === 'video' ? 'video' : mediaKindFromSrc(src)
        return { src, kind, title: node.getAttribute('data-title') ?? '' }
      },
    },
  ],
  renderHTML: ({ node }) => {
    const src = String(node.attrs.src ?? '')
    const kind = (node.attrs.kind === 'video' ? 'video' : 'audio') as MediaKind
    const title = String(node.attrs.title ?? '')
    return [
      'div',
      mergeAttributes({
        'data-zention-media': '',
        'data-src': src,
        'data-kind': kind,
        'data-title': title,
        class: `zention-media zention-media-${kind}`,
      }),
    ]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'zention-media'
      dom.dataset.zentionMedia = ''
      let player: HTMLAudioElement | HTMLVideoElement | null = null
      const sync = () => {
        const src = String(node.attrs.src ?? '')
        const kind = (node.attrs.kind === 'video' ? 'video' : mediaKindFromSrc(src)) as MediaKind
        const title = String(node.attrs.title ?? '')
        dom.dataset.src = src
        dom.dataset.kind = kind
        dom.dataset.title = title
        dom.className = `zention-media zention-media-${kind}`
        if (!player || player.tagName.toLowerCase() !== kind) {
          player?.remove()
          player = document.createElement(kind)
          player.controls = true
          player.preload = 'metadata'
          player.className = 'zention-media-player'
          dom.replaceChildren(player)
        }
        const nextSrc = displayImageSrc(src)
        if (player.getAttribute('src') !== nextSrc) player.setAttribute('src', nextSrc)
        if (title) player.setAttribute('title', title)
        else player.removeAttribute('title')
      }
      sync()
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== 'mediaBlock') return false
          node = updated
          sync()
          return true
        },
        stopEvent: (event) => {
          const target = event.target
          return target instanceof globalThis.Node && !!player && (player === target || player.contains(target))
        },
      }
    }
  },
  markdownTokenizer: {
    name: 'mediaBlock',
    level: 'block',
    start: (src) => {
      const audio = src.search(/<audio\b/i)
      const video = src.search(/<video\b/i)
      if (audio < 0) return video
      if (video < 0) return audio
      return Math.min(audio, video)
    },
    tokenize(src) {
      const match = /^<(audio|video)\b([^>]*)>(?:<\/\1>)?/i.exec(src)
      if (!match) return undefined
      const kind = match[1]!.toLowerCase() === 'video' ? 'video' : 'audio'
      const attrs = match[2] ?? ''
      const srcAttr = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      const titleAttr = attrs.match(/\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      const rawSrc = srcAttr?.[1] ?? srcAttr?.[2] ?? srcAttr?.[3] ?? ''
      if (!rawSrc) return undefined
      return {
        type: 'mediaBlock',
        raw: match[0],
        src: storedImageSrc(rawSrc),
        kind,
        title: titleAttr?.[1] ?? titleAttr?.[2] ?? titleAttr?.[3] ?? '',
      } as MarkdownToken & { src: string; kind: MediaKind; title: string }
    },
  },
  parseMarkdown: (token, helpers) => {
    const row = token as MarkdownToken & { src?: string; kind?: MediaKind; title?: string }
    const src = String(row.src ?? '')
    return helpers.createNode('mediaBlock', {
      src,
      kind: row.kind === 'video' ? 'video' : mediaKindFromSrc(src),
      title: String(row.title ?? ''),
    })
  },
  renderMarkdown: (node) => {
    const src = String(node.attrs?.src ?? '')
    if (!src) return ''
    const kind = node.attrs?.kind === 'video' ? 'video' : mediaKindFromSrc(src)
    const title = String(node.attrs?.title ?? '')
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
    return `<${kind} controls src="${escapeAttr(src)}"${titleAttr}></${kind}>\n\n`
  },
  addCommands() {
    return {
      insertMediaBlock:
        (attrs: { src: string; kind?: MediaKind; title?: string }) =>
        ({ commands }) => {
          const src = String(attrs.src ?? '').trim()
          if (!src) return false
          const kind = attrs.kind === 'video' || attrs.kind === 'audio' ? attrs.kind : mediaKindFromSrc(src)
          return commands.insertContent({
            type: 'mediaBlock',
            attrs: { src, kind, title: String(attrs.title ?? '').slice(0, 120) },
          })
        },
    }
  },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mediaBlock: {
      insertMediaBlock: (attrs: { src: string; kind?: MediaKind; title?: string }) => ReturnType
    }
  }
}
