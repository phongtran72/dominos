const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) | 0;
}

function createPNG(size, drawFn) {
  const w = size, h = size;
  const pixels = Buffer.alloc(w * h * 4);

  function setPixel(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
  }

  function fillRect(x, y, rw, rh, r, g, b, a) {
    a = a === undefined ? 255 : a;
    for (let py = Math.round(y); py < Math.round(y + rh); py++)
      for (let px = Math.round(x); px < Math.round(x + rw); px++)
        setPixel(px, py, r, g, b, a);
  }

  function fillCircle(cx, cy, radius, r, g, b, a) {
    a = a === undefined ? 255 : a;
    const r2 = radius * radius;
    for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py++)
      for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px++) {
        const dx = px - cx, dy = py - cy;
        if (dx*dx + dy*dy <= r2) setPixel(px, py, r, g, b, a);
      }
  }

  function fillRoundRect(x, y, rw, rh, rad, r, g, b, a) {
    a = a === undefined ? 255 : a;
    fillRect(x + rad, y, rw - 2*rad, rh, r, g, b, a);
    fillRect(x, y + rad, rw, rh - 2*rad, r, g, b, a);
    fillCircle(x + rad, y + rad, rad, r, g, b, a);
    fillCircle(x + rw - rad - 1, y + rad, rad, r, g, b, a);
    fillCircle(x + rad, y + rh - rad - 1, rad, r, g, b, a);
    fillCircle(x + rw - rad - 1, y + rh - rad - 1, rad, r, g, b, a);
  }

  drawFn({ setPixel, fillRect, fillCircle, fillRoundRect, w, h });

  // Build raw filter data (filter type 0 = None per row)
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    pixels.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }

  const deflated = zlib.deflateSync(raw);
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  function writeChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcData = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4); crc.writeInt32BE(crc32(crcData));
    chunks.push(len, typeB, data, crc);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeChunk('IHDR', ihdr);
  writeChunk('IDAT', deflated);
  writeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat(chunks);
}

function drawIcon(ctx) {
  const s = ctx.w / 512;

  // Green background
  ctx.fillRoundRect(0, 0, ctx.w, ctx.h, Math.round(96*s), 26, 92, 42);

  // Ivory tile body
  ctx.fillRoundRect(Math.round(128*s), Math.round(96*s), Math.round(256*s), Math.round(320*s), Math.round(24*s), 245, 240, 224);

  // Divider
  ctx.fillRect(Math.round(140*s), Math.round(254*s), Math.round(232*s), Math.round(4*s), 187, 187, 187);

  // Pips
  const pr = Math.round(18*s);
  // Top: 3 (diagonal)
  ctx.fillCircle(Math.round(316*s), Math.round(148*s), pr, 34, 34, 34);
  ctx.fillCircle(Math.round(256*s), Math.round(176*s), pr, 34, 34, 34);
  ctx.fillCircle(Math.round(196*s), Math.round(204*s), pr, 34, 34, 34);
  // Bottom: 5
  ctx.fillCircle(Math.round(196*s), Math.round(296*s), pr, 34, 34, 34);
  ctx.fillCircle(Math.round(316*s), Math.round(296*s), pr, 34, 34, 34);
  ctx.fillCircle(Math.round(256*s), Math.round(336*s), pr, 34, 34, 34);
  ctx.fillCircle(Math.round(196*s), Math.round(376*s), pr, 34, 34, 34);
  ctx.fillCircle(Math.round(316*s), Math.round(376*s), pr, 34, 34, 34);
}

[192, 512].forEach(function(size) {
  const png = createPNG(size, drawIcon);
  const path = __dirname + '/icon-' + size + '.png';
  fs.writeFileSync(path, png);
  console.log('Created icon-' + size + '.png (' + png.length + ' bytes)');
});
