import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getEnvSettings } from './settings.js';

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) {
      // Replace inline base64 data or large byte buffers with their sha256 hash
      if ((key === 'data' || key === 'bytes') && typeof v === 'string' && v.length > 256) {
        sorted[key] = `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`;
      } else {
        sorted[key] = canonicalize(v);
      }
    }
  }
  return sorted;
}

export function computeCacheKey(model: string, payload: unknown): string {
  const canonical = JSON.stringify({ model, payload: canonicalize(payload) });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function hashFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function readCache<T = unknown>(model: string, key: string): T | null {
  const { cacheDir } = getEnvSettings();
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(cacheDir, safeModel, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(model: string, key: string, data: unknown): void {
  const { cacheDir } = getEnvSettings();
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(cacheDir, safeModel);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${key}.json`);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}
