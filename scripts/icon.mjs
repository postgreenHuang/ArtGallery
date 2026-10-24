import fs from "node:fs";
import zlib from "node:zlib";
const size = 64,
  raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    let light = false;
    const border =
      x >= 14 &&
      x <= 49 &&
      y >= 11 &&
      y <= 53 &&
      (x < 17 ||
        x > 46 ||
        y > 50 ||
        ((x - 31.5) ** 2 + (y - 29) ** 2 > 15 ** 2 && y < 29));
    const lines =
      (x >= 24 && x <= 39 && (y === 30 || y === 40)) ||
      (x >= 30 && x <= 33 && y >= 23 && y <= 46);
    light = border || lines;
    const c = light ? [236, 234, 216] : [72, 91, 65];
    const i = y * (size * 4 + 1) + 1 + x * 4;
    raw.set([...c, 255], i);
  }
function crc(b) {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    len = Buffer.alloc(4),
    check = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  check.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, check]);
}
const h = Buffer.alloc(13);
h.writeUInt32BE(size);
h.writeUInt32BE(size, 4);
h[8] = 8;
h[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", h),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = size;
header[7] = size;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
fs.mkdirSync("src-tauri/icons", { recursive: true });
fs.writeFileSync("src-tauri/icons/icon.png", png);
fs.writeFileSync("src-tauri/icons/icon.ico", Buffer.concat([header, png]));
