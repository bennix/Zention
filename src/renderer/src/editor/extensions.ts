import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { CodeBlock } from '@tiptap/extension-code-block'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import { CodeBlockView } from './CodeBlockView'
import { createLocalImage } from './image'
import { BlockEquation, InlineEquation } from './equation'
import { BlockDragHandle } from './blockDragHandle'
import { BlockKeymap } from './blockKeymap'
import { SelectionSlash, SlashCommand, type SlashController, type SlashItem } from './slash'
import { t } from '../i18n'

export function buildExtensions(options: {
  slashController: SlashController
  slashItems: () => SlashItem[]
  external?: boolean
}): AnyExtension[] {
  return [
    StarterKit.configure({
      link: { openOnClick: false },
      codeBlock: false,
      underline: false,
      dropcursor: { color: false, width: 6, class: 'zention-dropcursor' },
    }),
    CodeBlock.extend({
      addNodeView() {
        return ReactNodeViewRenderer(CodeBlockView)
      },
    }),
    Markdown.configure({ indentation: { style: 'space', size: 4 } }),
    TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    createLocalImage(options.external === true),
    InlineEquation,
    BlockEquation,
    Placeholder.configure({
      placeholder: () => t('editorPlaceholder'),
    }),
    SlashCommand.configure({ controller: options.slashController, items: options.slashItems }),
    SelectionSlash,
    BlockKeymap,
    BlockDragHandle,
  ]
}
