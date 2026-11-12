/** Bounded, in-memory decoding of user attachments. No paths or file writes. */
import type { Readable } from 'node:stream';
import type { Inbound, PromptAttachment } from './types.ts';
export class AttachmentError extends Error {}
export async function decodeAttachment(stream: Readable, attachment: NonNullable<Inbound['attachment']>, signal: AbortSignal): Promise<PromptAttachment> {
  const limit = attachment.type === 'image' ? 5 * 1024 * 1024 : 256 * 1024;
  const abort = () => stream.destroy(new Error('Attachment download aborted'));
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = []; let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new AttachmentError(attachment.type === 'image' ? '图片超过 5 MiB，请压缩后重试。' : '文本文件超过 256 KiB，请拆分后重试。');
      chunks.push(bytes);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    if (attachment.type === 'image') {
      const mimeType = imageMime(bytes);
      if (!mimeType) throw new AttachmentError('图片格式不支持，请发送 PNG、JPEG、GIF 或 WebP。');
      return { type: 'image', data: bytes.toString('base64'), mimeType };
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new AttachmentError('文件不是有效的 UTF-8 文本，请转换编码后重试。'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new AttachmentError('文件包含二进制内容，仅支持 UTF-8 文本文件。');
    return { type: 'text', text: `Attached file: ${attachment.name ?? 'unnamed'}\n\n${text}` };
  } finally { signal.removeEventListener('abort', abort); stream.destroy(); }
}
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
}
