/**
 * Ambient type declaration for `jq-in-the-browser` (v0.7.2), which ships no
 * bundled `.d.ts`. The package's default export is a compile-then-run factory:
 * `jq(expression)` parses the jq expression once (throwing a `SyntaxError` on a
 * malformed expression) and returns a function that evaluates it against an
 * input value.
 *
 * @see https://www.npmjs.com/package/jq-in-the-browser
 */
declare module 'jq-in-the-browser' {
  /**
   * Compile a jq expression. Throws synchronously on a malformed expression.
   * @param expression - A jq filter expression.
   * @returns A function that evaluates the compiled filter against an input.
   */
  export default function jqInTheBrowser(
    expression: string,
  ): (input: unknown) => unknown;
}
