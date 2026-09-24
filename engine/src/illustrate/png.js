/**
 * A minimal PNG writer, so the raster image path can be exercised without a
 * network call, an API key or a cent of spend.
 *
 * This exists for one reason: everything downstream of an image - the EPUB
 * manifest, the media type, the figure layout, the byte size of the book, the
 * KDP cover advice - behaves differently for a raster image than for the SVG
 * charts the engine used to make. Being able to produce a real PNG offline
 * means all of that is testable before you pay an image model anything.
 *
 * It is not a graphics library. It writes 8-bit RGB, no interlacing, no
 * palette, which is all a placeholder needs.
 */
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, table built once. The PNG spec's polynomial, nothing clever. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {function} pixel  (x, y) => [r, g, b], each 0-255
 * @returns {Buffer} a complete PNG file
 */
export function encodePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline, then RGB triples.
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = row + 1 + x * 3;
      raw[at] = r & 255;
      raw[at + 1] = g & 255;
      raw[at + 2] = b & 255;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** True if these bytes start with the PNG signature. Used to validate what a provider returned. */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

export function isJpeg(buffer) {
  return (
    Buffer.isBuffer(buffer) && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  );
}

/** Width and height read back out of a PNG's IHDR, for verifying a provider's output. */
export function pngSize(buffer) {
  if (!isPng(buffer)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
