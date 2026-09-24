/**
 * 把多个 ReadableStream 顺序拼接成一个流（R2 分片合并用）。
 * Workers 运行时不支持 ReadableStream.pipeTo 串联写回 R2，故手动拉取。
 */
export class ConcatStream extends ReadableStream<Uint8Array> {
  constructor(streams: ReadableStream<Uint8Array>[]) {
    const readers = streams.map((s) => s.getReader());
    let index = 0;
    super({
      async pull(controller) {
        while (index < readers.length) {
          const { done, value } = await readers[index]!.read();
          if (done) {
            index++;
            continue;
          }
          if (value) controller.enqueue(value);
          return;
        }
        controller.close();
      },
      cancel() {
        for (const r of readers) r.cancel().catch(() => {});
      },
    });
  }
}
