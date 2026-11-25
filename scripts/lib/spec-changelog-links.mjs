/**
 * Spec-history navigation uses CommonMark source spans, never rendered Markdown.
 * Micromark owns syntax and code-context recognition; its destination offsets refer to
 * the original input, including CRLF and Unicode. Consumers edit only those spans so
 * titles, delimiters, code examples and all other recorded bytes remain intact.
 * Reference definitions are intentionally unsupported: their document-wide label scope
 * would change when independent entries are concatenated. Authors use inline links instead.
 */
import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';

/** Return relative file destinations and their exact source spans. @internal */
export function inlineFileLinks(text) {
  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const links = [];
  for (const [kind, token] of events) {
    if (kind !== 'enter') {
      continue;
    }
    if (token.type === 'definition') {
      throw new Error(
        'reference-style definitions are not supported; use inline links or images',
      );
    }
    if (token.type !== 'resourceDestinationString') {
      continue;
    }
    const start = token.start.offset;
    const end = token.end.offset;
    const destination = decodeString(text.slice(start, end));
    // Schemes, root paths and pathless references keep their existing document context.
    if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/iu.test(destination)) {
      continue;
    }
    links.push({ start, end, destination });
  }
  return links;
}
