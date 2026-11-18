// Packfiles, version 2: the 'PACK' header, one zlib-deflated object after another, and a SHA-1
// trailer over everything before it. Encoding writes whole objects only; decoding additionally
// resolves OFS_DELTA and REF_DELTA entries (including thin packs, whose bases the caller
// supplies) so anything real git — or the suite's client — sends can be read back.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { gitObjectSha } from './util.ts';
import type { ObjType } from './gitdb.ts';

/** One fully resolved object from a pack. */
export interface PackObject {
  sha: string;
  type: ObjType;
  data: Buffer;
}

const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

/** One object's pack header: the type/size varint (type in bits 4-6, size little-endian-ish). */
function writeObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Encode whole objects as a pack v2: 'PACK', version 2, the count, each object as a varint
 * header plus its zlib-deflated raw bytes, and the SHA-1 of all preceding bytes as trailer.
 */
export function encodePack(objects: PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writeObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a little-endian base-128 varint (delta source/target sizes). */
function readDeltaVarint(buf: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    if (offset >= buf.length) throw new Error('delta size varint is truncated');
    const byte = buf[offset];
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new Error('delta size varint is too long');
  }
  return { value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readDeltaVarint(delta, offset);
  offset = source.next;
  const target = readDeltaVarint(delta, offset);
  offset = target.next;
  if (source.value !== base.length) {
    throw new Error(`delta expects a ${source.value}-byte base, got ${base.length}`);
  }
  const out = Buffer.alloc(target.value);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > target.value) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

/** One raw pack entry before delta resolution. */
interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  /** The inflated bytes: the object itself, or the delta stream for a delta entry. */
  data: Buffer;
  /** OFS_DELTA only: the pack offset of the base entry. */
  baseOffset?: number;
  /** REF_DELTA only: the object id of the base. */
  baseSha?: string;
}

/** Inflate the zlib stream starting at `offset`; also returns the offset just past its end. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten || result.engine.bytesWritten <= 0) {
    throw new Error(`zlib stream at pack offset ${offset} consumed no bytes`);
  }
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Decode a pack: verify the trailer SHA-1, inflate every entry, and resolve deltas. An
 * OFS_DELTA's base is an earlier (or any) entry of this pack by offset; a REF_DELTA's base is
 * an object of this pack by id, or — for a thin pack — whatever `resolveExternal` returns for
 * its id. The resolved objects come back in pack order, each with its computed id.
 */
export function decodePack(
  buf: Buffer,
  resolveExternal: (sha: string) => { type: ObjType; data: Buffer } | undefined,
): PackObject[] {
  if (buf.length < 12 + 20) throw new Error('pack is shorter than its header and trailer');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expectedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  const actualTrailer = buf.subarray(trailerStart).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum does not match its bytes');

  const entries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= trailerStart) throw new Error('pack ends before its declared object count');
    const entryOffset = offset;
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeCode === OFS_DELTA) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = buf[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[offset];
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (baseOffset < 12) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
    } else if (typeCode === REF_DELTA) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      baseSha = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TO_TYPE[typeCode]) {
      throw new Error(`unknown pack object type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    offset = inflated.next;
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} inflated to ${inflated.data.length} bytes, header says ${size}`);
    }
    entries.push({ offset: entryOffset, typeCode, size, data: Buffer.from(inflated.data), baseOffset, baseSha });
  }
  if (offset !== trailerStart) throw new Error('pack has bytes unaccounted for before its trailer');

  const resolved: (PackObject | undefined)[] = entries.map(() => undefined);
  const byOffset = new Map<number, number>();
  entries.forEach((entry, i) => byOffset.set(entry.offset, i));
  const bySha = new Map<string, PackObject>();

  const resolveEntry = (i: number, depth: number): PackObject => {
    const done = resolved[i];
    if (done) return done;
    if (depth > entries.length + 1) throw new Error('delta chain is cyclic or too deep');
    const entry = entries[i];
    let obj: PackObject;
    const fullType = CODE_TO_TYPE[entry.typeCode];
    if (fullType) {
      obj = { sha: gitObjectSha(fullType, entry.data), type: fullType, data: entry.data };
    } else {
      let base: PackObject | { type: ObjType; data: Buffer } | undefined;
      if (entry.typeCode === OFS_DELTA) {
        const baseIndex = entry.baseOffset === undefined ? undefined : byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        base = resolveEntry(baseIndex, depth + 1);
      } else {
        base = entry.baseSha === undefined ? undefined : bySha.get(entry.baseSha);
        if (!base && entry.baseSha !== undefined) {
          // The base may be a pack entry not yet resolved; resolve any full entry carrying it,
          // then fall back to the caller's objects (a thin pack's base).
          for (let j = 0; j < entries.length; j += 1) {
            const candidate = entries[j];
            const candidateType = CODE_TO_TYPE[candidate.typeCode];
            if (candidateType && gitObjectSha(candidateType, candidate.data) === entry.baseSha) {
              base = resolveEntry(j, depth + 1);
              break;
            }
          }
        }
        if (!base && entry.baseSha !== undefined) base = resolveExternal(entry.baseSha);
        if (!base) throw new Error(`ref-delta base ${entry.baseSha} is neither in the pack nor supplied`);
      }
      const data = applyDelta(base.data, entry.data);
      obj = { sha: gitObjectSha(base.type, data), type: base.type, data };
    }
    resolved[i] = obj;
    bySha.set(obj.sha, obj);
    return obj;
  };

  return entries.map((_, i) => resolveEntry(i, 0));
}
