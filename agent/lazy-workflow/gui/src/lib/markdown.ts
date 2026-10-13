/**
 * The Markdown a coding agent writes for a person — its closing summary, a
 * ticket body — read into the few blocks the window draws: headings,
 * paragraphs, lists and code. Anything else stays the text it was, so nothing
 * the agent wrote is lost; it is only not dressed up.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

export type Block =
  | { readonly kind: "heading"; readonly inline: readonly Inline[] }
  | { readonly kind: "paragraph"; readonly inline: readonly Inline[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: ReadonlyArray<readonly Inline[]> }
  | { readonly kind: "code"; readonly text: string };

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

export function inlineMarkdown(text: string): Inline[] {
  return text.split(INLINE).filter((part) => part.length > 0).map((part): Inline => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return { kind: "strong", text: part.slice(2, -2) };
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return { kind: "code", text: part.slice(1, -1) };
    return { kind: "text", text: part };
  });
}

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;

export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const close = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inline: inlineMarkdown(paragraph.join("\n")) });
    if (list) blocks.push({ kind: "list", ordered: list.ordered, start: list.start, items: list.items.map(inlineMarkdown) });
    paragraph = [];
    list = null;
  };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE.test(line)) {
      close();
      const code: string[] = [];
      for (index += 1; index < lines.length && !FENCE.test(lines[index]!); index += 1) code.push(lines[index]!);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({ kind: "heading", inline: inlineMarkdown(heading[1]!) });
      continue;
    }
    const ordered = ORDERED.exec(line);
    const unordered = ordered ? null : UNORDERED.exec(line);
    if (ordered || unordered) {
      const isOrdered = ordered !== null;
      if (paragraph.length > 0 || (list && list.ordered !== isOrdered)) close();
      list ??= { ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] };
      list.items.push(ordered ? ordered[2]! : unordered![1]!);
      continue;
    }
    // An indented line continues the item above it; anything else ends the list.
    if (list && /^\s/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) close();
    paragraph.push(line);
  }
  close();
  return blocks;
}
