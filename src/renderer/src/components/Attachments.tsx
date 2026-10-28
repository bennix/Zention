import type { MessageKey } from '../../../shared/i18n'
import { useI18n } from '../i18n'

export const MAX_PROMPT_IMAGES = 5

export type PromptImage = { id: string; mime: string; base64: string; previewUrl: string }

export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of data.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0) {
    for (const file of data.files) {
      if (file.type.startsWith('image/')) files.push(file)
    }
  }
  return files
}

export function revokePromptImages(images: PromptImage[]): void {
  for (const image of images) URL.revokeObjectURL(image.previewUrl)
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export async function takePromptImages(
  files: File[],
  existing: number,
  notify: (message: string) => void,
  translate: (key: MessageKey) => string,
): Promise<PromptImage[]> {
  const room = MAX_PROMPT_IMAGES - existing
  if (room <= 0) {
    notify(translate('attachFull'))
    return []
  }
  const accepted: PromptImage[] = []
  let skippedType = false
  let skippedSize = false
  for (const file of files) {
    if (accepted.length >= room) break
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/i.test(file.type)) {
      skippedType = true
      continue
    }
    if (file.size > 8_000_000) {
      skippedSize = true
      continue
    }
    const mime = file.type.toLowerCase() === 'image/jpg' ? 'image/jpeg' : file.type.toLowerCase()
    accepted.push({
      id: crypto.randomUUID(),
      mime,
      base64: await fileToBase64(file),
      previewUrl: URL.createObjectURL(file),
    })
  }
  if (skippedType) notify(translate('toastImageType'))
  else if (skippedSize) notify(translate('toastImageBig'))
  else if (files.length > room) notify(translate('attachFull'))
  return accepted
}

export function AttachmentBar({
  images,
  disabled,
  onChange,
  onToast,
}: {
  images: PromptImage[]
  disabled?: boolean
  onChange: (images: PromptImage[]) => void
  onToast: (message: string) => void
}) {
  const { t } = useI18n()
  const add = async (files: File[]) => {
    const next = await takePromptImages(files, images.length, onToast, t)
    if (next.length) onChange([...images, ...next])
  }
  const remove = (id: string) => {
    const target = images.find((image) => image.id === id)
    if (target) URL.revokeObjectURL(target.previewUrl)
    onChange(images.filter((image) => image.id !== id))
  }
  return (
    <div
      className="attach-box"
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        const files = imageFiles(event.dataTransfer)
        if (!files.length) return
        event.preventDefault()
        event.stopPropagation()
        void add(files)
      }}
    >
      {images.length > 0 ? (
        <div className="attach-thumbs">
          {images.map((image) => (
            <div className="attach-thumb" key={image.id}>
              <img src={image.previewUrl} alt="" />
              <button
                type="button"
                className="attach-remove"
                aria-label={t('removeImage')}
                disabled={disabled}
                onClick={() => remove(image.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="attach-row">
        <label className="file-btn">
          {t('attachImage')}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            disabled={disabled}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void add(files)
            }}
          />
        </label>
        <span>{t('attachHint')}</span>
      </div>
    </div>
  )
}
