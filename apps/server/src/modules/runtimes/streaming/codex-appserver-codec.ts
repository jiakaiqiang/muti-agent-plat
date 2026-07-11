/**
 * Codex app-server 的 stdio transport 使用 JSONL：每条消息是一行 UTF-8 JSON。
 * 生成的 app-server v2 协议类型不要求 `jsonrpc` 字段，但为兼容测试夹具和
 * 旧客户端仍允许携带该字段。
 *
 * 本模块只做编码/解码,不管进程。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.4。
 */

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeJsonRpc(msg: JsonRpcMessage): Buffer {
  return Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8');
}

export class JsonRpcDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex === -1) return messages;
      const line = this.buffer.subarray(0, newlineIndex).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // 坏行丢弃,继续处理下一行。
      }
    }
  }
}
