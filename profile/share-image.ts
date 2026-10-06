/**
 * Deterministic social preview PNG for FREE contest/league share pages.
 * Proper 1200×630 OG card. No monetary/prize language. Pure Node (zlib).
 */
import { deflateSync } from "node:zlib";

export interface ShareImageInput {
  kind: "FREE_CONTEST" | "PRIVATE_LEAGUE";
  matchLabel: string;
  label: string;
  rank: number | null;
  /** Display points (already /1000), or null. */
  score: number | null;
}

/** Standard Open Graph dimensions. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const W = OG_WIDTH;
const H = OG_HEIGHT;

/** 5x7 uppercase glyph bitmaps (MSB left). Space + A-Z + 0-9 + # . - : */
const GLYPHS: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "#": [0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x01, 0x01, 0x01, 0x01, 0x11, 0x11, 0x0e],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, c]);
}

function sanitize(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9 #.\-:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function drawText(
  pixels: Uint8Array,
  text: string,
  x0: number,
  y0: number,
  scale: number,
  color: [number, number, number],
  maxWidth: number,
): void {
  let x = x0;
  const glyphW = 6 * scale;
  for (const ch of sanitize(text)) {
    if (x + glyphW > x0 + maxWidth) break;
    const rows = GLYPHS[ch] ?? GLYPHS[" "]!;
    for (let row = 0; row < 7; row++) {
      const bits = rows[row]!;
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = x + col * scale + dx;
              const py = y0 + row * scale + dy;
              if (px < 0 || py < 0 || px >= W || py >= H) continue;
              const i = (py * W + px) * 3;
              pixels[i] = color[0];
              pixels[i + 1] = color[1];
              pixels[i + 2] = color[2];
            }
          }
        }
      }
    }
    x += glyphW;
  }
}

function fillRect(
  pixels: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
): void {
  for (let py = y; py < y + h && py < H; py++) {
    if (py < 0) continue;
    for (let px = x; px < x + w && px < W; px++) {
      if (px < 0) continue;
      const i = (py * W + px) * 3;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
    }
  }
}

/** Build a 1200×630 deterministic PNG buffer for og:image. */
export function renderSharePreviewPng(input: ShareImageInput): Buffer {
  const pixels = new Uint8Array(W * H * 3);
  // Background
  fillRect(pixels, 0, 0, W, H, [11, 18, 32]);
  // Card
  fillRect(pixels, 48, 48, W - 96, H - 96, [18, 26, 43]);
  // Accent bar
  fillRect(pixels, 48, 48, 14, H - 96, [94, 234, 212]);
  // FREE badge
  fillRect(pixels, 96, 88, 140, 48, [15, 61, 52]);
  drawText(pixels, "FREE", 116, 100, 4, [94, 234, 212], 120);

  drawText(pixels, "KICKR", 96, 168, 6, [232, 238, 252], 1000);
  drawText(pixels, input.matchLabel.slice(0, 48), 96, 260, 4, [232, 238, 252], 1000);
  drawText(pixels, input.label.slice(0, 44), 96, 330, 3, [147, 160, 184], 1000);

  const rankLabel = input.rank != null ? `#${input.rank}` : "—";
  const scoreLabel = input.score != null ? `${input.score.toFixed(1)} PTS` : "— PTS";
  drawText(pixels, `RANK ${rankLabel}`, 96, 420, 5, [94, 234, 212], 520);
  drawText(pixels, scoreLabel, 650, 420, 5, [232, 238, 252], 460);
  drawText(pixels, "NO ENTRY FEE  NO MONETARY PRIZE", 96, 520, 2, [147, 160, 184], 1000);

  // PNG encode RGB
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    raw.set(pixels.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function shareOgImagePath(kind: "contest" | "league", id: string): string {
  return `/share/${kind}/${id}/og.png`;
}

/** Read IHDR width/height from a PNG buffer (for tests). */
export function readPngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png[0] !== 137) {
    throw new Error("not a PNG");
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}
