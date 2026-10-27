import type { ReactNode } from 'react'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {children}
    </svg>
  )
}

function Lines({ d }: { d: string[] }) {
  return (
    <Svg>
      {d.map((item) => (
        <path key={item} d={item} {...stroke} />
      ))}
    </Svg>
  )
}

const MARKS: Record<string, string> = {
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  'lang:zh': '文',
  'lang:zh-Hant': '繁',
  'lang:en': 'En',
  'lang:ja': 'あ',
  'lang:ko': '한',
  'lang:fr': 'Fr',
  'lang:de': 'De',
  'lang:es': 'Es',
  'lang:pt': 'Pt',
  'lang:ru': 'Я',
  'lang:ar': 'ع',
  'lang:it': 'It',
}

const LINES: Record<string, string[]> = {
  paragraph: ['M2.5 4h11', 'M2.5 8h11', 'M2.5 12h7'],
  quote: ['M4 3.5c2 1 2 3.2 0 4.2', 'M9 3.5c2 1 2 3.2 0 4.2', 'M3.5 12.5h9'],
  code: ['M6 4.5 3 8l3 3.5', 'M10 4.5 13 8l-3 3.5'],
  math: ['M3 3.5h10', 'M8 3.5 5.5 13', 'M8 3.5 11 13'],
  'inline-math': ['M3 12 6.5 4h1L11 12', 'M4.4 9.2h5.2'],
  mermaid: ['M3 3.5h4.5v3H3z', 'M8.5 9.5H13v3H8.5z', 'M5.2 6.5 11 9.5'],
  table: ['M2.5 3.5h11v9h-11z', 'M2.5 6.5h11', 'M2.5 9.5h11', 'M6.5 3.5v9', 'M10 3.5v9'],
  hr: ['M2.5 8h11'],
  'image-url': ['M6.5 8.5a3 3 0 0 1 0-4.2l.6-.6a3 3 0 0 1 4.2 4.2l-.4.4', 'M9.5 7.5a3 3 0 0 1 0 4.2l-.6.6a3 3 0 0 1-4.2-4.2l.4-.4'],
  'ai-continue': ['M3 8h8', 'M8.5 4.5 12.5 8 8.5 11.5', 'M3 4.5v7'],
  'recognize-formula': ['M2.5 3h6.5v6.5H2.5z', 'M10 8.5h3.5', 'M11.8 6.8v4.8', 'M10 12.2h3.5'],
  'ai-image-above': ['M3 7.5h10v5.5H3z', 'M8 2.2v4', 'M6 4.2 8 2.2 10 4.2'],
  'ai-image-below': ['M3 3h10v5.5H3z', 'M8 9.8v4', 'M6 11.8 8 13.8 10 11.8'],
  above: ['M3 7.5h10v5.5H3z', 'M8 2.2v4', 'M6 4.2 8 2.2 10 4.2'],
  below: ['M3 3h10v5.5H3z', 'M8 9.8v4', 'M6 11.8 8 13.8 10 11.8'],
  polish: ['M9.5 2.5 13.5 6.5 6 14H2v-4z', 'M8 4 12 8'],
  shorter: ['M3 5h10', 'M5 8h6', 'M7 11h2'],
  longer: ['M3 4h4', 'M3 8h7', 'M3 12h10'],
  translate: ['M2.5 4.5h6', 'M5.5 3.5v1', 'M3.5 6.5c.8 2 2.2 3.2 4 4', 'M8.5 8.5h5', 'M9.5 8.5 12.2 13', 'M13.2 8.5 10.5 13'],
  'polish:natural': ['M3 11c2-4 3-6 5-6s3 2 5 6'],
  'polish:formal': ['M3 3.5h10v9H3z', 'M6 3.5v9', 'M3 6.5h10'],
  'polish:concise': ['M3 6.5h10', 'M5 9.5h6'],
  'polish:vivid': ['M8 2.5 9.2 6.2 13 7.4 9.2 8.6 8 12.3 6.8 8.6 3 7.4 6.8 6.2z'],
  'polish:academic': ['M2.5 7 8 4.2 13.5 7 8 9.8z', 'M5 8.2v3.2c1 .8 2 .9 3 .9s2-.1 3-.9V8.2'],
  'polish:casual': ['M3.5 6.5a4.5 4.5 0 0 1 9 0V10a1.5 1.5 0 0 1-1.5 1.5H9l-2 2v-2H5A1.5 1.5 0 0 1 3.5 10z'],
  'polish:business': ['M3 6.5h10v6.5H3z', 'M6 6.5V5a2 2 0 0 1 4 0v1.5'],
  'longer:slight': ['M3 8h10'],
  'longer:medium': ['M3 6h10', 'M3 10h10'],
  'longer:full': ['M3 4.5h10', 'M3 8h10', 'M3 11.5h10'],
  'longer:deep': ['M3 3.5h10', 'M3 6.5h10', 'M3 9.5h10', 'M3 12.5h10'],
}

export function MenuIcon({ id }: { id: string }) {
  const mark = MARKS[id]
  let body: ReactNode = mark ? <span>{mark}</span> : null
  if (!body && id === 'task') {
    body = (
      <Svg>
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" {...stroke} />
        <path d="M4.8 8.1 7 10.2 11.2 5.8" {...stroke} />
      </Svg>
    )
  }
  if (!body && id === 'bullet') {
    body = (
      <Svg>
        <circle cx="3" cy="4.5" r="1" fill="currentColor" />
        <circle cx="3" cy="8" r="1" fill="currentColor" />
        <circle cx="3" cy="11.5" r="1" fill="currentColor" />
        <path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" {...stroke} />
      </Svg>
    )
  }
  if (!body && id === 'ordered') {
    body = (
      <Svg>
        <path d="M2.2 4.8h1.6M3 3.2v1.6M2.2 11.6h2M2.2 10.2c.8 0 1.4-.4 1.4-1s-.6-1-1.4-1" {...stroke} />
        <path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" {...stroke} />
      </Svg>
    )
  }
  if (!body && id === 'image-file') {
    body = (
      <Svg>
        <path d="M2.5 3.5h11v9h-11z" {...stroke} />
        <circle cx="5.5" cy="6.2" r="0.9" fill="currentColor" />
        <path d="M2.5 10.5 5.5 7.8 8 10.2l2-1.8 3.5 3.1" {...stroke} />
      </Svg>
    )
  }
  if (!body && id === 'ai') {
    body = (
      <Svg>
        <path d="M8 1.8 9.1 6 13.2 7.2 9.1 8.4 8 12.6 6.9 8.4 2.8 7.2 6.9 6z" {...stroke} />
      </Svg>
    )
  }
  const lines = LINES[id]
  if (!body && lines) body = <Lines d={lines} />
  if (!body) body = <Lines d={['M4 8h8']} />
  return <span className="menu-icon">{body}</span>
}
