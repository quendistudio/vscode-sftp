import localWriteGuard, {
  beginWrite,
  endWrite,
  isWriting,
  recordFile,
  recordDir,
  isEcho,
  isTempPath,
  _resetForTests,
} from '../localWriteGuard';

describe('localWriteGuard', () => {
  afterEach(() => {
    _resetForTests();
  });

  test('isTempPath detects .sftp-part suffix', () => {
    expect(isTempPath('/tmp/a.txt.sftp-part')).toBe(true);
    expect(isTempPath('/tmp/a.txt')).toBe(false);
  });

  test('inFlight refcount', () => {
    beginWrite('/a');
    beginWrite('/a');
    expect(isWriting('/a')).toBe(true);
    endWrite('/a');
    expect(isWriting('/a')).toBe(true);
    endWrite('/a');
    expect(isWriting('/a')).toBe(false);
  });

  test('matching signature is echo and stays recorded', () => {
    recordFile('/f', 10, 1_700_000_000_000);
    expect(isEcho('/f', { size: 10, mtime: 1_700_000_000_500 })).toBe(true);
    expect(isEcho('/f', { size: 10, mtime: 1_700_000_000_500 })).toBe(true);
  });

  test('mismatched signature clears record and is not echo', () => {
    recordFile('/f', 10, 1_700_000_000_000);
    expect(isEcho('/f', { size: 11, mtime: 1_700_000_000_000 })).toBe(false);
    expect(isEcho('/f', { size: 10, mtime: 1_700_000_000_000 })).toBe(false);
  });

  test('recorded directory is echo', () => {
    recordDir('/dir');
    expect(isEcho('/dir', { size: 0, mtime: 0, isDirectory: true })).toBe(true);
  });

  test('writing path is echo even without signature', () => {
    beginWrite('/w');
    expect(isEcho('/w', { size: 1, mtime: 1 })).toBe(true);
    endWrite('/w');
    expect(isEcho('/w', { size: 1, mtime: 1 })).toBe(false);
  });

  test('default export exposes API', () => {
    expect(localWriteGuard.isTempPath).toBe(isTempPath);
  });
});
