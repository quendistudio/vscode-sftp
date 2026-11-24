jest.mock('fs');

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import { sync, TransferDirection } from '../transfer';
import localFs from '../../../core/localFs';
import TransferTask from '../../../core/transferTask';
import localWriteGuard, { TEMP_SUFFIX, _resetForTests } from '../../../core/localWriteGuard';
import FileSystem, { FileType } from '../../../core/fs/fileSystem';
import RemoteFs from '../../../../test/helper/localRemoteFs';

function createRemoteFs() {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours: 0,
  });
}

const file = (c, time = 0) => ({
  $$type: 'file',
  content: c,
  mtime: new Date(new Date().getTime() + time * 1000),
});

const fillFs = obj => {
  const files: { [x: string]: string } = {};
  const dirs: string[] = [];
  const stats: {
    [x: string]: {
      mtime: Date;
    };
  } = {};
  const processDirTree = (obj1, filepath = '/') => {
    const keys = Object.keys(obj1);
    if (keys.length <= 0) {
      dirs.push(filepath);
      return;
    }

    keys.forEach(key => {
      const fullpath = path.join(filepath, key);
      if (obj1[key].$$type === 'file') {
        files[fullpath] = obj1[key].content;
        stats[fullpath] = obj1[key];
      } else {
        processDirTree(obj1[key], fullpath);
      }
    });
  };
  processDirTree(obj);
  vol.fromJSON(files, '/');
  dirs.forEach(dir => fs.mkdirSync(dir));
  Object.keys(stats).forEach(filepath => {
    fs.utimesSync(filepath, stats[filepath].mtime, stats[filepath].mtime);
  });
};

/** FileSystem wrapper that records which instance performed get/open/put. */
class TrackingFs extends FileSystem {
  readonly ops: Array<{ method: string; filePath: string }> = [];
  private inner: FileSystem;
  private _label: string;

  constructor(label: string, inner: FileSystem) {
    super(inner.pathResolver);
    this.inner = inner;
    this._label = label;
  }

  get label() {
    return this._label;
  }

  private track(method: string, filePath: string) {
    this.ops.push({ method, filePath });
  }

  readFile(p, option?) {
    return this.inner.readFile(p, option);
  }
  open(p: string, flags: string, mode?: number) {
    this.track('open', p);
    return this.inner.open(p, flags, mode);
  }
  close(fd) {
    return this.inner.close(fd);
  }
  fstat(fd) {
    return this.inner.fstat(fd);
  }
  futimes(fd, atime, mtime) {
    return this.inner.futimes(fd, atime, mtime);
  }
  get(p: string, option?) {
    this.track('get', p);
    return this.inner.get(p, option);
  }
  put(input, p, option?) {
    this.track('put', p);
    return this.inner.put(input, p, option);
  }
  mkdir(dir: string) {
    return this.inner.mkdir(dir);
  }
  ensureDir(dir: string) {
    return this.inner.ensureDir(dir);
  }
  chmod(p: string, mode: number) {
    return this.inner.chmod(p, mode);
  }
  list(dir: string) {
    return this.inner.list(dir);
  }
  lstat(p: string) {
    return this.inner.lstat(p);
  }
  readlink(p: string) {
    return this.inner.readlink(p);
  }
  symlink(targetPath: string, p: string) {
    return this.inner.symlink(targetPath, p);
  }
  unlink(p: string) {
    return this.inner.unlink(p);
  }
  rmdir(p: string, recursive: boolean) {
    return this.inner.rmdir(p, recursive);
  }
  rename(srcPath: string, destPath: string) {
    this.track('rename', destPath);
    return this.inner.rename(srcPath, destPath);
  }
  renameAtomic(srcPath: string, destPath: string) {
    return this.inner.renameAtomic(srcPath, destPath);
  }
}

describe('safe transfer (R2L + SyncBoth)', () => {
  afterEach(() => {
    vol.reset();
    _resetForTests();
  });

  test('SyncBoth remote-newer task reads with remoteFs and writes with localFs', async () => {
    fillFs({
      local: {
        b: file('local-b', 1),
      },
      remote: {
        b: file('remote-b', 2),
      },
    });

    const localTracked = new TrackingFs('local', localFs);
    const remoteTracked = new TrackingFs('remote', createRemoteFs());
    const tasks: TransferTask[] = [];

    await sync(
      {
        srcFsPath: path.sep + 'local',
        srcFs: localTracked,
        targetFsPath: path.sep + 'remote',
        targetFs: remoteTracked,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: {
          bothDiretions: true,
          perserveTargetMode: false,
        },
      },
      t => tasks.push(t)
    );

    const r2l = tasks.filter(t => t.transferType === TransferDirection.REMOTE_TO_LOCAL);
    expect(r2l.length).toBe(1);
    expect(r2l[0].localFsPath.replace(/\//g, path.sep)).toBe(path.join(path.sep, 'local', 'b'));

    await Promise.all(tasks.map(t => t.run()));

    const remoteGet = remoteTracked.ops.find(
      op =>
        op.method === 'get' &&
        op.filePath.replace(/\//g, path.sep).endsWith(path.join('remote', 'b'))
    );
    const localOpenTemp = localTracked.ops.find(
      op =>
        op.method === 'open' &&
        op.filePath.replace(/\//g, path.sep).endsWith(path.join('local', 'b') + TEMP_SUFFIX)
    );

    expect(remoteGet).toBeTruthy();
    expect(localOpenTemp).toBeTruthy();
    expect(fs.readFileSync(path.join(path.sep, 'local', 'b'), 'utf8')).toBe('remote-b');
  });

  test('R2L failure leaves original intact and removes temp', async () => {
    fillFs({
      local: {
        keep: file('ORIGINAL', 1),
      },
      remote: {
        keep: file('NEW', 2),
      },
    });

    const localPath = path.join(path.sep, 'local', 'keep');
    const remotePath = path.join(path.sep, 'remote', 'keep');
    const tempPath = localPath + TEMP_SUFFIX;

    const brokenRemote = new TrackingFs('remote-broken', createRemoteFs());
    brokenRemote.get = async () => {
      throw new Error('simulated remote read failure');
    };

    const task = new TransferTask(
      { fsPath: remotePath, fileSystem: brokenRemote },
      { fsPath: localPath, fileSystem: localFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: {
          atime: Date.now(),
          mtime: Date.now(),
          perserveTargetMode: false,
          fallbackMode: 0o644,
        },
      }
    );

    await expect(task.run()).rejects.toThrow('simulated remote read failure');
    expect(fs.readFileSync(localPath, 'utf8')).toBe('ORIGINAL');
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(localWriteGuard.isWriting(localPath)).toBe(false);
  });

  test('R2L put failure leaves original intact and removes temp', async () => {
    fillFs({
      local: {
        keep: file('ORIGINAL', 1),
      },
      remote: {
        keep: file('NEW-CONTENT', 2),
      },
    });

    const localPath = path.join(path.sep, 'local', 'keep');
    const remotePath = path.join(path.sep, 'remote', 'keep');
    const tempPath = localPath + TEMP_SUFFIX;

    const brokenLocal = new TrackingFs('local-broken', localFs);
    brokenLocal.put = async () => {
      throw new Error('put failed');
    };

    const task = new TransferTask(
      { fsPath: remotePath, fileSystem: createRemoteFs() },
      { fsPath: localPath, fileSystem: brokenLocal },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: {
          atime: Date.now(),
          mtime: Date.now(),
          perserveTargetMode: false,
          fallbackMode: 0o644,
        },
      }
    );

    await expect(task.run()).rejects.toThrow('put failed');
    expect(fs.readFileSync(localPath, 'utf8')).toBe('ORIGINAL');
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
