/** Ambient type declaration for the optional `@deepseek-kit/tokenizer` peer.
 * The package supplies an offline DeepSeek V4 tokenizer. It is loaded lazily
 * by `createDeepSeekTokenizerBackend`; when not installed, the factory
 * returns `undefined` and the generic heuristic fallback remains active. */
declare module '@deepseek-kit/tokenizer' {
  export function countTokens(text: string): Promise<number>
}
