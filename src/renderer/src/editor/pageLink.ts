import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionProps } from '@tiptap/suggestion'
import type { PageMeta } from '../../../shared/types'
import { pageHref } from '../../../shared/pages'
import { t } from '../i18n'
import type { SlashController, SlashItem, SlashMenuState } from './slash'

function linkTitle(title: string): string {
  return title.replace(/[\[\]]/g, '').trim() || t('untitled')
}

function toState(props: SuggestionProps<SlashItem>): SlashMenuState {
  return {
    items: props.items,
    clientRect: props.clientRect?.() ?? null,
    command: (item) => props.command(item),
  }
}

export const PageLink = Extension.create<{ controller: SlashController | null; pages: () => PageMeta[] }>({
  name: 'pageLink',
  addOptions() {
    return { controller: null, pages: () => [] }
  },
  addProseMirrorPlugins() {
    const getController = () => this.options.controller
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '[[',
        pluginKey: new PluginKey('pageLink'),
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        command: ({ editor, range, props }) => props.run(editor, range),
        items: ({ query }) => {
          const q = query.trim().toLowerCase()
          return this.options
            .pages()
            .filter((page) => !q || page.title.toLowerCase().includes(q) || (page.tags ?? []).some((tag) => tag.toLowerCase().includes(q)))
            .slice(0, 8)
            .map((page) => {
              const pages = this.options.pages()
              const parent = page.parentId ? pages.find((item) => item.id === page.parentId) : undefined
              const title = page.title.trim() || t('untitled')
              const place = parent ? `${parent.title.trim() || t('untitled')} / ${title}` : title
              return {
                id: page.id,
                label: page.folder ? `${place} · ${t('folder')}` : place,
                keywords: [...(page.tags ?? []), page.group ?? ''].filter(Boolean),
                run: (editor, range) => {
                  editor
                    .chain()
                    .focus()
                    .deleteRange(range)
                    .insertContent(`[${linkTitle(page.title)}](${pageHref(page.id)})`, { contentType: 'markdown' })
                    .run()
                },
              }
            })
        },
        render: () => ({
          onStart: (props) => getController()?.onOpen(toState(props)),
          onUpdate: (props) => getController()?.onUpdate(toState(props)),
          onKeyDown: (props) => getController()?.onKeyDown(props.event) ?? false,
          onExit: () => getController()?.onClose(),
        }),
      }),
    ]
  },
})
