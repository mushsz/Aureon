// Gera os ícones PNG do PWA sem dependências (zlib nativo do Node). Uso: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [15, 14, 11], GOLD = [226, 176, 74];
const distSeg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); };

// Marca: um "A" aberto (ápice) com um ponto — em 24 unidades: (4,19)→(12,4)→(20,19), ponto em (12,15)
function mark(x, y, s, { pad = 0.2, rounded = true } = {}) {
  const S = 4; let cov = 0, inside = 0;
  for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
    const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
    // fundo com cantos arredondados (para "any"); sem cantos para maskable
    const r = rounded ? s * 0.22 : 0;
    const cx = Math.min(Math.max(px, r), s - r), cy = Math.min(Math.max(py, r), s - r);
    if (Math.hypot(px - cx, py - cy) <= r || !rounded) inside++;
    const u = ((px / s) - pad) / (1 - 2 * pad) * 24, v = ((py / s) - pad) / (1 - 2 * pad) * 24;
    const w = 1.45;
    if (distSeg(u, v, 4, 19, 12, 4) < w || distSeg(u, v, 12, 4, 20, 19) < w || Math.hypot(u - 12, v - 15) < 2.2) cov++;
  }
  const a = inside / (S * S), c = cov / (S * S);
  return [Math.round(BG[0] + (GOLD[0] - BG[0]) * c), Math.round(BG[1] + (GOLD[1] - BG[1]) * c), Math.round(BG[2] + (GOLD[2] - BG[2]) * c), Math.round(255 * a)];
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, (x, y, s) => mark(x, y, s)));
writeFileSync('public/icons/icon-512.png', png(512, (x, y, s) => mark(x, y, s)));
writeFileSync('public/icons/icon-maskable-512.png', png(512, (x, y, s) => mark(x, y, s, { pad: 0.28, rounded: false })));
writeFileSync('public/icons/apple-touch-icon.png', png(180, (x, y, s) => mark(x, y, s, { pad: 0.2, rounded: false })));
console.log('ícones gerados em public/icons');
