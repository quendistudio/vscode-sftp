/**
 * Tracks local writes from Remote→Local transfers so the file watcher
 * can ignore filesystem echoes without freezing unrelated uploads.
 *
 * ponytail: in-memory Maps only; 10min purge bounds memory, not safety.
 */

export const TEMP_SUFFIX = '.sftp-part';
const PURGE_MS = 10 * 60 * 1000;

interface FileSignature {
  size: number;
  mtimeMs: number;
  recordedAt: number;
}

interface DirRecord {
  recordedAt: number;
}

const inFlight = new Map<string, number>();
const files = new Map<string, FileSignature>();
const dirs = new Map<string, DirRecord>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [path, sig] of files) {
    if (now - sig.recordedAt > PURGE_MS) {
      files.delete(path);
    }
  }
  for (const [path, rec] of dirs) {
    if (now - rec.recordedAt > PURGE_MS) {
      dirs.delete(path);
    }
  }
}

export function isTempPath(filePath: string): boolean {
  return filePath.endsWith(TEMP_SUFFIX);
}

export function beginWrite(filePath: string): void {
  purgeExpired();
  inFlight.set(filePath, (inFlight.get(filePath) || 0) + 1);
}

export function endWrite(filePath: string): void {
  const next = (inFlight.get(filePath) || 0) - 1;
  if (next <= 0) {
    inFlight.delete(filePath);
  } else {
    inFlight.set(filePath, next);
  }
}

export function isWriting(filePath: string): boolean {
  return (inFlight.get(filePath) || 0) > 0;
}

export function recordFile(filePath: string, size: number, mtimeMs: number): void {
  files.set(filePath, { size, mtimeMs, recordedAt: Date.now() });
}

export function recordDir(dirPath: string): void {
  dirs.set(dirPath, { recordedAt: Date.now() });
}

export interface EchoStat {
  size: number;
  mtime: number;
  isDirectory?: boolean;
}

/**
 * Returns true when a watcher/save event is an echo of our own R2L write.
 * Matching signatures stay recorded so repeated events for the same write are ignored.
 * A mismatched signature clears the record so a real user edit uploads.
 */
export function isEcho(filePath: string, stat: EchoStat): boolean {
  purgeExpired();

  if (isWriting(filePath)) {
    return true;
  }

  if (stat.isDirectory) {
    return dirs.has(filePath);
  }

  if (dirs.has(filePath)) {
    return true;
  }

  const sig = files.get(filePath);
  if (!sig) {
    return false;
  }

  const sameSize = sig.size === stat.size;
  const sameMtime = Math.floor(sig.mtimeMs / 1000) === Math.floor(stat.mtime / 1000);
  if (sameSize && sameMtime) {
    return true;
  }

  files.delete(filePath);
  return false;
}

/** Test-only reset. */
export function _resetForTests(): void {
  inFlight.clear();
  files.clear();
  dirs.clear();
}

const localWriteGuard = {
  TEMP_SUFFIX,
  isTempPath,
  beginWrite,
  endWrite,
  isWriting,
  recordFile,
  recordDir,
  isEcho,
  _resetForTests,
};

export default localWriteGuard;
