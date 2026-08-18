// SPDX-License-Identifier: Apache-2.0

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'

declare module '*.png' {
  const source: string
  export default source
}
