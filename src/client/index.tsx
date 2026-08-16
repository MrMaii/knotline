// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import {
  defineStore,
  type ClientContext,
  type EngineStoreHandle,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { App } from '../../web/src/App.tsx'
import knotlineMarkDark from '../../web/src/assets/knotline-mark-dark.png'
import knotlineMarkLight from '../../web/src/assets/knotline-mark-light.png'
import '../../web/src/styles.css'
import css from './KnotlineMode.module.css'
import { en, MODE_NS, zh } from './locales.ts'

type ModeState = { open: boolean }
type ModeActions = {
  toggle: (draft: ModeState) => void
  close: (draft: ModeState) => void
}

function createModeStore(): EngineStoreHandle<ModeState, ModeActions> {
  return defineStore({
    init: (): ModeState => ({ open: false }),
    actions: {
      toggle: draft => { draft.open = !draft.open },
      close: draft => { draft.open = false },
    },
  })
}

type ModeStore = ReturnType<typeof createModeStore>
type LauncherProps = PropsRuntime<'sidebar.footer.action'> & PropsStore<ModeStore> & PropsLocale<typeof MODE_NS>
type LayerProps = PropsRuntime<'shell.overlay'> & PropsStore<ModeStore> & PropsLocale<typeof MODE_NS>

function KnotlineLauncher({ wide, useStore, actions, t }: LauncherProps) {
  const open = useStore(state => state.open)
  return (
    <button
      type="button"
      aria-label={t(open ? 'launcher.close.aria' : 'launcher.open.aria')}
      aria-pressed={open}
      title={t(open ? 'launcher.close.title' : 'launcher.open.title')}
      className={`${css.trigger}${wide ? '' : ` ${css.rail}`}${open ? ` ${css.active}` : ''}`}
      onClick={() => { actions.toggle() }}
    >
      <span className={css.triggerIcon} aria-hidden="true">
        <img className={css.triggerLogoLight} src={knotlineMarkLight} alt="" />
        <img className={css.triggerLogoDark} src={knotlineMarkDark} alt="" />
      </span>
      {wide && (
        <>
          <span className={css.triggerCopy}>
            <span className={css.triggerLabel}>{t('launcher.label')}</span>
            <span className={css.triggerHint}>{t(open ? 'launcher.close.hint' : 'launcher.open.hint')}</span>
          </span>
          <span className={css.triggerAction} aria-hidden="true">
            {open ? <IconChevronLeftOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </>
      )}
    </button>
  )
}

function KnotlineLayer({ ctx, useStore, actions, t }: LayerProps & { ctx: ClientContext }) {
  const open = useStore(state => state.open)
  const layerRef = useRef<HTMLElement | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const workspaceState = useSyncExternalStore(
    listener => ctx.workspaces.list.subscribe(listener),
    () => ctx.workspaces.list.getSnapshot(),
  )

  useLayoutEffect(() => {
    if (!open) return
    const overlay = layerRef.current?.closest<HTMLElement>('[data-shell-overlay]')
    const frame = overlay?.parentElement
    const sidebar = frame?.firstElementChild
    if (!(sidebar instanceof HTMLElement)) return
    const update = (): void => { setSidebarWidth(sidebar.getBoundingClientRect().width) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(sidebar)
    return () => { observer.disconnect() }
  }, [open])

  if (!open) return null
  return (
    <section
      ref={layerRef}
      className={css.layer}
      aria-label={t('layer.aria')}
      style={{ '--knotline-sidebar-offset': `${sidebarWidth}px` } as CSSProperties}
    >
      <App
        language={t('locale.id')}
        user={{
          type: 'user',
          id: 'dsh-user',
          name: t('locale.id') === 'zh' ? 'DeepSeek Harness 用户' : 'DeepSeek Harness User',
          avatarUrl: null,
        }}
        workspaces={workspaceState.items.map(workspace => ({
          id: String(workspace.workspaceId),
          title: workspace.title,
          path: workspace.path,
        }))}
        workspacesLoading={!workspaceState.baselinesReady}
        onClose={() => { actions.close() }}
      />
    </section>
  )
}

export const inject = ['slots', 'locale', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(MODE_NS, { zh, en }), 'knotline: dictionaries')
  const modeStore = createModeStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'knotline-mode',
    store: modeStore,
    locale: MODE_NS,
  }, KnotlineLauncher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'knotline-mode',
    store: modeStore,
    locale: MODE_NS,
  }, props => <KnotlineLayer {...props} ctx={ctx} />))
}
