import { Readable } from 'stream';
import * as fileOperations from './fileBaseOperations';
import { FileSystem, FileType } from './fs';
import { Task } from './scheduler';
import logger from '../logger';
import localWriteGuard, { TEMP_SUFFIX } from './localWriteGuard';

let hasWarnedModifedTimePermission = false;

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
}

export default class TransferTask implements Task {
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _handle: Readable;
  private _cancelled: boolean;

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  get transferType() {
    return this._transferDirection;
  }

  async run() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    switch (this.fileType) {
      case FileType.File:
        await this._transferFile();
        break;
      case FileType.SymbolicLink:
        await fileOperations.transferSymlink(
          src,
          target,
          srcFs,
          targetFs,
          this._TransferOption
        );
        break;
      default:
        logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
    }
  }

  cancel() {
    if (this._handle && !this._cancelled) {
      this._cancelled = true;
      FileSystem.abortReadableStream(this._handle);
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  private async _transferFile() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      await this._transferFileRemoteToLocal();
      return;
    }
    await this._transferFileLocalToRemote();
  }

  /**
   * Always write to a temp path then rename so a failed/interrupted download
   * never truncates the existing local file.
   */
  private async _transferFileRemoteToLocal() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      fallbackMode,
      atime,
      mtime,
      filePerm,
    } = this._TransferOption;
    const tempTarget = target + TEMP_SUFFIX;

    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    if (mode === undefined && perserveTargetMode) {
      try {
        const existing = await targetFs.lstat(target);
        mode = existing.mode;
      } catch {
        mode = fallbackMode;
      }
    }
    if (mode === undefined) {
      mode = fallbackMode;
    }

    localWriteGuard.beginWrite(target);
    let uploadFd;
    let tempOpened = false;

    try {
      // Open remote stream first — if this fails, the local original is untouched.
      this._handle = await srcFs.get(src);
      uploadFd = await targetFs.open(tempTarget, 'w');
      tempOpened = true;

      await targetFs.put(this._handle, tempTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });

      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      await targetFs.close(uploadFd);
      uploadFd = undefined;

      try {
        await targetFs.unlink(target);
      } catch {
        // target may not exist yet
      }
      await targetFs.rename(tempTarget, target);
      tempOpened = false;

      const stat = await targetFs.lstat(target);
      localWriteGuard.recordFile(target, stat.size, stat.mtime);
    } catch (error) {
      if (uploadFd !== undefined) {
        try {
          await targetFs.close(uploadFd);
        } catch {
          // ignore close errors during cleanup
        }
        uploadFd = undefined;
      }
      if (tempOpened) {
        try {
          await targetFs.unlink(tempTarget);
        } catch {
          // ignore unlink errors during cleanup
        }
      }
      throw error;
    } finally {
      localWriteGuard.endWrite(target);
    }
  }

  private async _transferFileLocalToRemote() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      useTempFile,
      openSsh,
      fallbackMode,
      atime,
      mtime,
      filePerm
    } = this._TransferOption;
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd;
    let uploadFd;
    const uploadTarget = target + (useTempFile ? '.new' : '');

    if (mode === undefined && perserveTargetMode) {
      if (useTempFile) {
        [targetFd, uploadFd] = await Promise.all([
          targetFs.open(target, 'r').catch(() => null),
          targetFs.open(uploadTarget, 'w'),
        ]);
      } else {
        targetFd = uploadFd = await targetFs.open(uploadTarget, 'w');
      }

      if (targetFd) {
        [this._handle, mode] = await Promise.all([
          srcFs.get(src),
          targetFs
            .fstat(targetFd)
            .then(stat => stat.mode)
            .catch(() => fallbackMode),
        ]);

        if (useTempFile) {
          targetFs.close(targetFd);
        }
      } else {
        this._handle = await srcFs.get(src);
        mode = fallbackMode;
      }
    } else {
      [this._handle, uploadFd] = await Promise.all([
        srcFs.get(src),
        targetFs.open(uploadTarget, 'w'),
      ]);
    }

    try {
      if (useTempFile) {
        logger.info('uploading temp file: ' + uploadTarget);
      }
      await targetFs.put(this._handle, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });
      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      if (useTempFile) {
        logger.info('moving from: ' + target + '.new' + ' to: ' + target);
        if (openSsh) {
          await targetFs.renameAtomic(uploadTarget, target);
        } else {
          try {
            await targetFs.unlink(target);
          } catch (error) {
            // Just ignore
          }
          await targetFs.rename(uploadTarget, target);
        }
      }
    } finally {
      await targetFs.close(uploadFd);
    }
  }
}
