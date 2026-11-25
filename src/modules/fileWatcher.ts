import * as vscode from 'vscode';
import * as fs from 'fs';
import * as debounce from 'lodash.debounce';
import logger from '../logger';
import { isValidFile, isConfigFile, fileDepth } from '../helper';
import { upload, removeRemote } from '../fileHandlers';
import { WatcherService, localWriteGuard } from '../core';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';

const watchers: {
  [x: string]: vscode.FileSystemWatcher;
} = {};

// Deduplicate by fsPath (Set<Uri> would keep duplicate Uri objects for the same path).
const uploadQueue = new Map<string, vscode.Uri>();
const deleteQueue = new Map<string, vscode.Uri>();

// less than 550 will not work
const ACTION_INTEVAL = 550;

function doUpload() {
  const files = Array.from(uploadQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  uploadQueue.clear();

  files.forEach(async uri => {
    const fspath = uri.fsPath;

    if (localWriteGuard.isTempPath(fspath)) {
      logger.info(`[watcher/skip] ${fspath} (temp)`);
      return;
    }

    try {
      const st = fs.statSync(fspath);
      if (
        localWriteGuard.isEcho(fspath, {
          size: st.size,
          mtime: st.mtimeMs,
          isDirectory: st.isDirectory(),
        })
      ) {
        logger.info(`[watcher/skip] ${fspath} (echo)`);
        return;
      }
    } catch (error) {
      logger.info(`[watcher/skip] ${fspath} (missing)`);
      return;
    }

    logger.info(`[watcher/updated] ${fspath}`);
    try {
      await upload(uri);
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

function doDelete() {
  const files = Array.from(deleteQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  deleteQueue.clear();
  files.forEach(async uri => {
    const fspath = uri.fsPath;
    if (localWriteGuard.isTempPath(fspath)) {
      return;
    }
    logger.info(`[watcher/removed] ${fspath}`);
    try {
      await removeRemote(uri);
    } catch (error) {
      logger.error(error, `remove ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

const debouncedUpload = debounce(doUpload, ACTION_INTEVAL, { leading: true, trailing: true });
const debouncedDelete = debounce(doDelete, ACTION_INTEVAL, { leading: true, trailing: true });

function uploadHandler(uri: vscode.Uri) {
  if (!isValidFile(uri)) {
    return;
  }

  if (localWriteGuard.isTempPath(uri.fsPath)) {
    return;
  }

  // Config reloads live in fileActivityMonitor; never auto-upload sftp.json.
  if (isConfigFile(uri)) {
    return;
  }

  uploadQueue.set(uri.fsPath, uri);
  debouncedUpload();
}

function addWatcher(id, watcher) {
  watchers[id] = watcher;
}

function getWatcher(id) {
  return watchers[id];
}

function createWatcher(
  watcherBase: string,
  watcherConfig: { files: false | string; autoUpload: boolean; autoDelete: boolean }
) {
  let watcher = getWatcher(watcherBase);
  if (watcher) {
    // clear old watcher
    watcher.dispose();
  }

  if (!watcherConfig) {
    return;
  }

  const shouldAddListenser = watcherConfig.autoUpload || watcherConfig.autoDelete;
  // tslint:disable-next-line triple-equals
  if (watcherConfig.files == false || !shouldAddListenser) {
    return;
  }

  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(watcherBase, watcherConfig.files),
    false,
    false,
    false
  );
  addWatcher(watcherBase, watcher);

  if (watcherConfig.autoUpload) {
    watcher.onDidCreate(uploadHandler);
    watcher.onDidChange(uploadHandler);
  }

  if (watcherConfig.autoDelete) {
    watcher.onDidDelete(uri => {
      if (!isValidFile(uri)) {
        return;
      }

      deleteQueue.set(uri.fsPath, uri);
      debouncedDelete();
    });
  }
}

function removeWatcher(watcherBase: string) {
  const watcher = getWatcher(watcherBase);
  if (watcher) {
    watcher.dispose();
    delete watchers[watcherBase];
  }
}

const watcherService: WatcherService = {
  create: createWatcher,
  dispose: removeWatcher,
};

export default watcherService;
