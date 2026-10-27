/// <reference types="vite/client" />

import type { ZentionApi } from '../../shared/types'

declare global {
  interface Window {
    zention: ZentionApi
  }
}

export {}
