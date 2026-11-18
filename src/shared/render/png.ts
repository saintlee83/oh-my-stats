/**
 * Writes a PNG without an image library, which the server doesn't have. The picture is a list
 * of palette indexes, one byte a pixel, and the platform's own deflate compresses it.
 */

export interface IndexedImage {
  width: number;
  height: number;
  /** Up to 256 colors as 0xRRGGBB. A pixel is its color's place in this list. */
  palette: readonly number[];
  /** Row after row, each `width + 1` bytes: the row's PNG filter type, then one byte a pixel. */
  rows: Uint8Array<ArrayBuffer>;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PALETTE_COLORS = 3;
const EIGHT_BITS = 8;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

/** The checksum each part of a PNG ends with. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One part of the file: its length, its four-letter type, its data, and a checksum of the last two. */
function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Compresses in zlib's format, which is what a PNG holds. */
async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // Reading starts before the write is awaited, so a full buffer can't hold the write back.
  const written = writer.write(data).then(() => writer.close());
  const [compressed] = await Promise.all([new Response(stream.readable).arrayBuffer(), written]);
  return new Uint8Array(compressed);
}

export async function encodePng({ width, height, palette, rows }: IndexedImage): Promise<Uint8Array<ArrayBuffer>> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = EIGHT_BITS;
  header[9] = PALETTE_COLORS;
  const colors = Uint8Array.from(palette.flatMap((color) => [color >> 16, (color >> 8) & 0xff, color & 0xff]));
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('PLTE', colors),
    chunk('IDAT', await deflate(rows)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const file = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  return file;
}
