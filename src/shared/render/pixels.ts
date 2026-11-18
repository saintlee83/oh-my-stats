/**
 * Pictures made of flat rectangles only, and a typeface of small squares to write on them:
 * the logo's own motif. With no curves and no smoothing, a picture needs no font file and
 * no image library, and compresses to a few kilobytes.
 */

/**
 * A 5 by 7 dot-matrix typeface: capitals, digits and a few signs. Each line of type is written
 * the way it's drawn, a `#` for every square, so a letter can be checked by eye.
 */
const TYPE: [characters: string, ...rows: string[]][] = [
  ['ABCDEFGHIJKLM',
    '.###. ####. .###. ####. ##### ##### .###. #...# .###. ..### #...# #.... #...#',
    '#...# #...# #...# #...# #.... #.... #...# #...# ..#.. ...#. #..#. #.... ##.##',
    '#...# #...# #.... #...# #.... #.... #.... #...# ..#.. ...#. #.#.. #.... #.#.#',
    '##### ####. #.... #...# ####. ####. #.### ##### ..#.. ...#. ##... #.... #.#.#',
    '#...# #...# #.... #...# #.... #.... #...# #...# ..#.. ...#. #.#.. #.... #...#',
    '#...# #...# #...# #...# #.... #.... #...# #...# ..#.. #..#. #..#. #.... #...#',
    '#...# ####. .###. ####. ##### #.... .###. #...# .###. .##.. #...# ##### #...#'],
  ['NOPQRSTUVWXYZ',
    '#...# .###. ####. .###. ####. .#### ##### #...# #...# #...# #...# #...# #####',
    '##..# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# #...# #...# ....#',
    '#.#.# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# .#.#. #...# ...#.',
    '#.#.# #...# ####. #...# ####. .###. ..#.. #...# #...# #.#.# ..#.. .#.#. ..#..',
    '#..## #...# #.... #.#.# #.#.. ....# ..#.. #...# #...# #.#.# .#.#. ..#.. .#...',
    '#...# #...# #.... #..#. #..#. ....# ..#.. #...# .#.#. #.#.# #...# ..#.. #....',
    '#...# .###. #.... .##.# #...# ####. ..#.. .###. ..#.. .#.#. #...# ..#.. #####'],
  ['0123456789',
    '.###. ..#.. .###. .###. ...#. ##### ..##. ##### .###. .###.',
    '#...# .##.. #...# #...# ..##. #.... .#... ....# #...# #...#',
    '#..## ..#.. ....# ....# .#.#. ####. #.... ...#. #...# #...#',
    '#.#.# ..#.. ...#. ..##. #..#. ....# ####. ..#.. .###. .####',
    '##..# ..#.. ..#.. ....# ##### ....# #...# .#... #...# ....#',
    '#...# ..#.. .#... #...# ...#. #...# #...# .#... #...# ...#.',
    '.###. .###. ##### .###. ...#. .###. .###. .#... .###. .##..'],
  ['@#-., ',
    '.###. .#.#. ..... ..... ..... .....',
    '#...# .#.#. ..... ..... ..... .....',
    '#.### ##### ..... ..... ..... .....',
    '#.#.# .#.#. .###. ..... ..... .....',
    '#.### ##### ..... ..... .##.. .....',
    '#.... .#.#. ..... ..... ..#.. .....',
    '.#### .#.#. ..... ..#.. .#... .....'],
];

export const GLYPH_COLUMNS = 5;
export const GLYPH_ROWS = 7;

/** Every character that can be written, as its seven rows of five. */
export const GLYPHS: ReadonlyMap<string, readonly string[]> = new Map(
  TYPE.flatMap(([characters, ...rows]) =>
    Array.from(characters, (character, index): [string, string[]] => [character, rows.map((row) => row.slice(index * (GLYPH_COLUMNS + 1), index * (GLYPH_COLUMNS + 1) + GLYPH_COLUMNS))]),
  ),
);

/** How wide a space is, in columns of squares. */
const SPACE_COLUMNS = 2;

interface Shape {
  /** Columns from the first square to the last, so a narrow letter takes less room than a wide one. */
  columns: number;
  /** A column and a row for each square, counted from the letter's first column. */
  squares: number[];
}

function shapeOf(rows: readonly string[]): Shape {
  const inked = Array.from({ length: GLYPH_COLUMNS }, (_, column) => column).filter((column) => rows.some((row) => row[column] === '#'));
  if (!inked.length) return { columns: SPACE_COLUMNS, squares: [] };
  const first = inked[0];
  const squares: number[] = [];
  rows.forEach((row, y) => {
    for (const column of inked) if (row[column] === '#') squares.push(column - first, y);
  });
  return { columns: inked[inked.length - 1] - first + 1, squares };
}

const SHAPES = new Map(Array.from(GLYPHS, ([character, rows]) => [character, shapeOf(rows)]));
const BLANK = SHAPES.get(' ') as Shape;

/** How large text is: the side of one square and the space between two, in pixels. */
export interface DotSize {
  dot: number;
  gap: number;
}

export const textHeight = ({ dot, gap }: DotSize) => GLYPH_ROWS * (dot + gap) - gap;

/** A character without a glyph takes the room of a space. */
export function textWidth(content: string, { dot, gap }: DotSize): number {
  let columns = 0;
  for (const character of content) columns += (SHAPES.get(character) ?? BLANK).columns + 1;
  return Math.max(0, (columns - 1) * (dot + gap) - gap);
}

/** A picture as rectangles in the order they are painted. Each takes five numbers: x, y, width, height and color. */
export type Drawing = number[];

export function rect(drawing: Drawing, x: number, y: number, width: number, height: number, color: number): void {
  drawing.push(x, y, width, height, color);
}

/** Writes one line with its top left corner at x and y, and returns the x where a next character would start. */
export function text(drawing: Drawing, x: number, y: number, content: string, size: DotSize, color: number): number {
  const pitch = size.dot + size.gap;
  let left = x;
  for (const character of content) {
    const { columns, squares } = SHAPES.get(character) ?? BLANK;
    for (let index = 0; index < squares.length; index += 2) {
      drawing.push(left + squares[index] * pitch, y + squares[index + 1] * pitch, size.dot, size.dot, color);
    }
    left += (columns + 1) * pitch;
  }
  return left;
}

/** PNG's "Up" filter: each byte is its difference from the byte above, so a repeated row is all zeros. */
const SAME_AS_ABOVE = 2;

/**
 * Paints a drawing as the rows a PNG holds, on a background of color 0.
 * A row where no rectangle starts or ends is the same as the row above. Such a row is not
 * painted: it is left as zeros and marked as a copy, which is most of the picture. That keeps
 * the painting to a few thousand short fills, and zeros are the quickest thing to compress.
 */
export function paint(drawing: Drawing, width: number, height: number): Uint8Array<ArrayBuffer> {
  const stride = width + 1;
  const rows = new Uint8Array(stride * height);
  const clamp = (value: number, most: number) => Math.max(0, Math.min(most, Math.round(value)));
  const changes = new Uint8Array(height + 1);
  changes[0] = 1;
  for (let index = 0; index < drawing.length; index += 5) {
    changes[clamp(drawing[index + 1], height)] = 1;
    changes[clamp(drawing[index + 1] + drawing[index + 3], height)] = 1;
  }
  for (let index = 0; index < drawing.length; index += 5) {
    const left = clamp(drawing[index], width);
    const right = clamp(drawing[index] + drawing[index + 2], width);
    const bottom = clamp(drawing[index + 1] + drawing[index + 3], height);
    for (let y = clamp(drawing[index + 1], height); y < bottom; y++) {
      if (changes[y]) rows.fill(drawing[index + 4], y * stride + 1 + left, y * stride + 1 + right);
    }
  }
  for (let y = 1; y < height; y++) if (!changes[y]) rows[y * stride] = SAME_AS_ABOVE;
  return rows;
}
