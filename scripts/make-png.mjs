import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function createPng(width, height, r, g, b) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const full = Buffer.concat([typeBuf, data]);
    let c = 0xffffffff;
    for (let i = 0; i < full.length; i++) {
      c ^= full[i];
      for (let k = 0; k < 8; k++) {
        c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
    }
    crcBuf.writeInt32BE(~c, 0);
    return Buffer.concat([len, full, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowLength = 1 + width * 3;
  const rawData = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLength;
    rawData[rowOffset] = 0; // filter type 0 (none)
    for (let x = 0; x < width; x++) {
      rawData[rowOffset + 1 + x * 3] = r;
      rawData[rowOffset + 1 + x * 3 + 1] = g;
      rawData[rowOffset + 1 + x * 3 + 2] = b;
    }
  }

  const idat = deflateSync(rawData);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const png = createPng(200, 100, 50, 100, 150);
writeFileSync('sample-original.png', png);
console.log('sample-original.png created with size', png.length);
