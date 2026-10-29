import { Menu, app, shell } from 'electron'
import { translate } from '../shared/i18n'
import { currentLocale } from './store'

let canInstallUpdate = false
let onCheckUpdate: (() => void) | null = null
let onInstallUpdate: (() => void) | null = null

export function setMenuUpdateHandlers(handlers: {
  check: () => void
  install: () => void
}): void {
  onCheckUpdate = handlers.check
  onInstallUpdate = handlers.install
  rebuildAppMenu()
}

export function setMenuUpdateInstallable(ready: boolean): void {
  if (canInstallUpdate === ready) return
  canInstallUpdate = ready
  rebuildAppMenu()
}

export function rebuildAppMenu(): void {
  const locale = currentLocale()
  const t = (key: 'updateCheck' | 'updateRestart' | 'updateSection') => translate(locale, key)
  const isMac = process.platform === 'darwin'
  const updateItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: t('updateCheck'),
      click: () => onCheckUpdate?.(),
    },
    {
      label: t('updateRestart'),
      enabled: canInstallUpdate,
      click: () => onInstallUpdate?.(),
    },
  ]

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              ...updateItems,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac
      ? []
      : [
          {
            label: t('updateSection'),
            submenu: updateItems,
          },
        ]),
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub',
          click: () => void shell.openExternal('https://github.com/bennix/Zention'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
