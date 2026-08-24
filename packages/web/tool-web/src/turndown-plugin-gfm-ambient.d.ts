/** Ambient type declaration for `@joplin/turndown-plugin-gfm`, which ships
 * no bundled types. The plugin augments a TurndownService instance in place
 * with GitHub Flavored Markdown extensions (tables, strikethrough, task
 * lists) and returns nothing. */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  /** GFM plugin entry; mutates `service` in place. */
  export function gfm(service: TurndownService): void
}
