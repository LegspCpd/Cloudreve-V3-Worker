/**
 * 极简 ZIP 归档构建器（仅 STORE，不压缩）。
 *
 * Worker 运行时没有 zlib 的 deflate 可用于流式打包（虽有 CompressionStream，
 * 但其输出带 gzip 头，不能直接放进 zip 本地文件头），因此采用 STORE 方式：
 * 只做 CRC32 与文件头拼接，体积与源文件一致，但 CPU 开销极低、速度极快，
 * 适合 Worker 的 CPU 时间预算。对网盘「打包下载」场景完全够用。
 *
 * 格式严格遵循 PKWARE APPNOTE 6.3.3。
 */
export class ZipBuilder {
  private chunks: Uint8Array[] = [];
  private central: Uint8Array[] = [];
  private offset = 0;

  private crcTable: number[] | null = null;

  private crc32(data: Uint8Array): number {
    if (!this.crcTable) {
      const table = new Array<number>(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
      }
      this.crcTable = table;
    }
    let crc = 0 ^ -1;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ (this.crcTable as number[])[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  private strToBytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  private u16(n: number): Uint8Array {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  }

  private u32(n: number): Uint8Array {
    return new Uint8Array([
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ]);
  }

  /** 添加一个文件 */
  addFile(name: string, data: Uint8Array, _index: number): void {
    const nameBytes = this.strToBytes(name);
    const crc = this.crc32(data);
    const needZip64 = data.length > 0xffffffff || this.offset > 0xffffffff;

    // 本地文件头（不压缩：方法 0）
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(localHeader.buffer);
    dv.setUint32(0, 0x04034b50, true); // 签名
    dv.setUint16(4, 20, true); // 最低解压版本
    dv.setUint16(6, 0, true); // 标志位
    dv.setUint16(8, 0, true); // 方法：STORE
    dv.setUint16(10, 0, true); // 修改时间
    dv.setUint16(12, 0, true); // 修改日期
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length & 0xffffffff, true); // 压缩大小
    dv.setUint32(22, data.length & 0xffffffff, true); // 未压缩大小
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // 额外字段长度
    localHeader.set(nameBytes, 30);

    this.chunks.push(localHeader);
    this.chunks.push(data);

    // 中央目录记录
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // 制作版本
    cv.setUint16(6, 20, true); // 解压版本
    cv.setUint16(8, 0, true); // 标志位
    cv.setUint16(10, 0, true); // 方法
    cv.setUint16(12, 0, true); // 时间
    cv.setUint16(14, 0, true); // 日期
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length & 0xffffffff, true);
    cv.setUint32(24, data.length & 0xffffffff, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // 额外字段
    cv.setUint16(32, 0, true); // 注释
    cv.setUint16(34, 0, true); // 磁盘号
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, this.offset & 0xffffffff, true); // 本地头偏移
    centralHeader.set(nameBytes, 46);
    this.central.push(centralHeader);

    this.offset += localHeader.length + data.length;
    if (needZip64) {
      // 超大文件需要 Zip64 扩展，此处直接抛出以避免生成不可用归档
      throw new Error("文件过大，无法在 Worker 中打包（缺少 Zip64 支持）");
    }
  }

  /** 完成归档，返回完整 zip 字节 */
  finalize(): Uint8Array {
    const centralOffset = this.offset;
    const centralSize = this.central.reduce((acc, c) => acc + c.length, 0);
    const count = this.central.length;

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, count & 0xffff, true);
    ev.setUint16(10, count & 0xffff, true);
    ev.setUint32(12, centralSize & 0xffffffff, true);
    ev.setUint32(16, centralOffset & 0xffffffff, true);
    ev.setUint16(20, 0, true);

    return concatBytes([...this.chunks, ...this.central, end]);
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
