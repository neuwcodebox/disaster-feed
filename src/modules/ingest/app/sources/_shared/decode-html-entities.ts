const NAMED_ENTITIES = new Map<string, string>([
  ['nbsp', ' '],
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

type DecodeHtmlEntitiesOptions = {
  maxPasses?: number;
};

export function decodeHtmlEntities(value: string, options: DecodeHtmlEntitiesOptions = {}): string {
  const maxPasses = Math.max(1, options.maxPasses ?? 1);
  let decoded = value;

  for (let index = 0; index < maxPasses; index += 1) {
    const next = decodeHtmlEntitiesOnce(decoded);
    if (next === decoded) {
      return next;
    }
    decoded = next;
  }

  return decoded;
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (full, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : full;
    })
    .replace(/&#(\d+);/g, (full, num: string) => {
      const codePoint = Number.parseInt(num, 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : full;
    })
    .replace(/&([a-zA-Z]+);/g, (full, name: string) => NAMED_ENTITIES.get(name) ?? full);
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}
