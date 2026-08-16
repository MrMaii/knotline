// SPDX-License-Identifier: Apache-2.0

export const MODE_NS = 'knotline.mode'

export const zh = {
  'locale.id': 'zh',
  'launcher.label': '地图',
  'launcher.open.aria': '打开项目地图',
  'launcher.close.aria': '返回 DeepSeek Harness 聊天',
  'launcher.open.title': '打开项目地图',
  'launcher.close.title': '返回聊天',
  'launcher.open.hint': '在一张地图里规划、执行并审核项目',
  'launcher.close.hint': '地图模式 · 点击返回聊天',
  'layer.aria': '项目地图',
} as const

export type ModeLocaleKey = keyof typeof zh

export const en: Record<ModeLocaleKey, string> = {
  'locale.id': 'en',
  'launcher.label': 'Map',
  'launcher.open.aria': 'Open project map',
  'launcher.close.aria': 'Return to DeepSeek Harness chat',
  'launcher.open.title': 'Open project map',
  'launcher.close.title': 'Return to chat',
  'launcher.open.hint': 'Plan, execute, and review a project on one map',
  'launcher.close.hint': 'Map mode · click to return',
  'layer.aria': 'Project map',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'knotline.mode': ModeLocaleKey
  }
}
