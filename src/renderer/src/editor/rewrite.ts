export const KEEP_FORMAT =
  '忠实保留原来的 Markdown 格式和结构：标题级别、列表和序号、表格、引用、代码块、行内代码、链接、加粗、斜体、分段和公式都保持原样。只改需要改的文字。代码内容、网址和公式源码不要改。不要加解释，不要新加与原文无关的标题，不要用代码围栏把全文包起来。'

export function rewritePrompt(instruction: string): string {
  return `${instruction}\n${KEEP_FORMAT}`
}

export const POLISH_STYLES = [
  { id: 'polish:natural', label: '自然', instruction: '润色成自然、顺口的语气，保持原意。' },
  { id: 'polish:formal', label: '正式', instruction: '润色成正式、书面的语气，保持原意。' },
  { id: 'polish:concise', label: '简洁', instruction: '润色得更简洁，去掉重复和空话，信息不减少。' },
  { id: 'polish:vivid', label: '生动', instruction: '润色得更生动、具体，保持原意，不另起话题。' },
  { id: 'polish:academic', label: '学术', instruction: '润色成严谨的学术语气，术语准确，保持原意。' },
  { id: 'polish:casual', label: '口语', instruction: '润色成口语，像当面说话，保持原意。' },
  { id: 'polish:business', label: '商务', instruction: '润色成清楚、礼貌的商务语气，适合邮件和汇报，保持原意。' },
] as const

export const EXPAND_LEVELS = [
  { id: 'longer:slight', label: '略扩', instruction: '略微扩写，长度大约增加到原文的 1.5 倍，只补一句必要细节。' },
  { id: 'longer:medium', label: '适中', instruction: '适中扩写，长度大约增加到原文的 2 倍，补上原因或一个例子。' },
  { id: 'longer:full', label: '充分', instruction: '充分扩写，长度大约增加到原文的 3 倍，补上背景、例子和衔接。' },
  { id: 'longer:deep', label: '展开', instruction: '按原有结构展开，长度大约增加到原文的 4 倍，写完整，不另起无关题目。' },
] as const

export const TRANSLATE_LANGS = [
  { id: 'lang:zh', label: '简体中文', instruction: '翻译成简体中文。只翻译可读文字。' },
  { id: 'lang:zh-Hant', label: '繁体中文', instruction: '翻译成繁体中文。只翻译可读文字。' },
  { id: 'lang:en', label: '英文', instruction: '翻译成英文。只翻译可读文字。' },
  { id: 'lang:ja', label: '日文', instruction: '翻译成日文。只翻译可读文字。' },
  { id: 'lang:ko', label: '韩文', instruction: '翻译成韩文。只翻译可读文字。' },
  { id: 'lang:fr', label: '法文', instruction: '翻译成法文。只翻译可读文字。' },
  { id: 'lang:de', label: '德文', instruction: '翻译成德文。只翻译可读文字。' },
  { id: 'lang:es', label: '西班牙文', instruction: '翻译成西班牙文。只翻译可读文字。' },
  { id: 'lang:pt', label: '葡萄牙文', instruction: '翻译成葡萄牙文。只翻译可读文字。' },
  { id: 'lang:ru', label: '俄文', instruction: '翻译成俄文。只翻译可读文字。' },
  { id: 'lang:ar', label: '阿拉伯文', instruction: '翻译成阿拉伯文。只翻译可读文字。' },
  { id: 'lang:it', label: '意大利文', instruction: '翻译成意大利文。只翻译可读文字。' },
] as const

const REWRITE_ACTIONS = [...POLISH_STYLES, ...EXPAND_LEVELS, ...TRANSLATE_LANGS, { id: 'shorter', label: '缩短', instruction: '把这段文字缩短，保留关键信息。' }]

export function instructionFor(id: string): string | null {
  return REWRITE_ACTIONS.find((item) => item.id === id)?.instruction ?? null
}
