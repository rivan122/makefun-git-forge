// Shared low-level helpers: hashing, the git pkt-line framing, base64, and the HTTP body/JSON
// plumbing every surface (git smart HTTP, REST, GraphQL, MCP) builds on. Standard library only,
// and deterministic: nothing here reads the wall clock or a random source.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The content type every JSON answer carries. */
const JSON_TYPE = 'application/json; charset=utf-8';

/** The largest request body readBody will collect (64 MiB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Lowercase hex SHA-1 of `data`. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of an object: SHA-1 of "<type> <byte length>\0" followed by the raw bytes. */
export function gitObjectSha(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/**
 * Frame one pkt-line: a 4-hex-digit lowercase length prefix (counting the prefix itself)
 * followed by the payload. Payloads that cannot fit the 16-bit length are refused.
 */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error(`pkt-line payload of ${body.length} bytes is too large`);
  const framed = Buffer.allocUnsafe(length);
  framed.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(framed, 4);
  return framed;
}

/** The flush packet: ends a section of a pkt-line stream. */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** The delimiter packet: separates a v2 request's sections. */
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');
/** The response-end packet: ends a v2 response. */
export const PKT_RESPONSE_END: Buffer = Buffer.from('0002', 'ascii');

/** One parsed pkt-line item: a payload, or one of the three zero-payload control packets. */
export type PktItem = Buffer | 'flush' | 'delim' | 'response-end';

/**
 * Parse pkt-lines out of `buf` starting at `start`. Returns the items found and the offset just
 * past the last one consumed. Parsing stops at the buffer's end; a truncated final packet (a
 * short length prefix, or a length that runs past the buffer) is returned as-is — the whole
 * remainder, prefix included — as the last item, so a caller reassembling a stream can hold it
 * until the rest arrives.
 */
export function readPktLines(buf: Buffer, start = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      items.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    const prefix = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) {
      items.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    const length = parseInt(prefix, 16);
    if (length === 0) {
      items.push('flush');
      offset += 4;
    } else if (length === 1) {
      items.push('delim');
      offset += 4;
    } else if (length === 2) {
      items.push('response-end');
      offset += 4;
    } else if (length < 4 || offset + length > buf.length) {
      items.push(buf.subarray(offset));
      offset = buf.length;
      break;
    } else {
      items.push(buf.subarray(offset + 4, offset + length));
      offset += length;
    }
  }
  return { items, next: offset };
}

/** Standard base64 of `data`. */
export function b64(data: Buffer): string {
  return data.toString('base64');
}

/**
 * Decode standard base64, tolerating whitespace and newlines anywhere (and missing padding).
 * Anything outside the base64 alphabet, or an impossible length, throws.
 */
export function unb64(text: string): Buffer {
  const cleaned = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
    throw new Error('invalid base64');
  }
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
  return Buffer.from(padded, 'base64');
}

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id, the only id form git writes. */
export function isHex40(s: string): boolean {
  return HEX40.test(s);
}

/** Collect a whole request body, refusing anything over 64 MiB. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Answer one request with a JSON body: JSON.stringify plus a trailing newline, an explicit
 * content-length, and the request id in the X-GitHub-Request-Id header GitHub sends on every
 * reply. `headers` go beside those; the three standard headers always win.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body) ?? 'null'}\n`;
  res.writeHead(status, {
    ...headers,
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

let requestCounter = 0;

/** The next deterministic request id: 'req-1', 'req-2', ... in arrival order. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}
