import * as vscode from 'vscode';
import logger from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { onDidOpenTextDocument, onDidSaveTextDocument, showConfirmMessage } from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';
import { localWriteGuard } from '../core';

let workspaceWatcher: vscode.Disposable;
let configFileWatchers: vscode.Disposable[] = [];
let configReloadTimer: ReturnType<typeof setTimeout> | undefined;

async function handleConfigSave(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;

  // dispose old service
  findAllFileService(service => service.workspace === workspacePath).forEach(disposeFileService);

  // create new service
  try {
    const configs = await readConfigsFromFile(uri.fsPath);
    configs.forEach(config => createFileService(config, workspacePath));
  } catch (error) {
    reportError(error);
  } finally {
    app.remoteExplorer.refresh();
  }
}

function disposeConfigFileWatchers() {
  configFileWatchers.forEach(d => d.dispose());
  configFileWatchers = [];
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = undefined;
  }
}

// Collapse create+change / save+watcher doubles into one reload.
function scheduleConfigReload(uri: vscode.Uri, reload: (uri: vscode.Uri) => void) {
  if (!isConfigFile(uri)) {
    return;
  }
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
  }
  configReloadTimer = setTimeout(() => {
    configReloadTimer = undefined;
    reload(uri);
  }, 200);
}

async function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.uploadOnSave) {
    const fspath = await realpathSync.native(uri.fsPath);
    if (localWriteGuard.isWriting(fspath) || localWriteGuard.isTempPath(fspath)) {
      logger.info(`[file-save/skip] ${fspath} (r2l in-flight)`);
      return;
    }
    uri = vscode.Uri.file(fspath);
    logger.info(`[file-save] ${fspath}`);
    try {
      await uploadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

async function downloadOnOpen(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.downloadOnOpen) {
    if (config.downloadOnOpen === 'confirm') {
      const isConfirm = await showConfirmMessage('Do you want SFTP to download this file?');
      if (!isConfirm) return;
    }

    const fspath = uri.fsPath;
    logger.info(`[file-open] ${fspath}`);
    try {
      await downloadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

function watchWorkspace({
  onDidSaveFile,
  onDidSaveSftpConfig,
}: {
  onDidSaveFile: (uri: vscode.Uri) => void;
  onDidSaveSftpConfig: (uri: vscode.Uri) => void;
}) {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  disposeConfigFileWatchers();

  workspaceWatcher = onDidSaveTextDocument((doc: vscode.TextDocument) => {
    const uri = doc.uri;
    if (!isValidFile(uri) || !isInWorkspace(uri.fsPath)) {
      return;
    }

    // remove staled cache
    if (app.fsCache.has(uri.fsPath)) {
      app.fsCache.del(uri.fsPath);
    }

    if (isConfigFile(uri)) {
      scheduleConfigReload(uri, onDidSaveSftpConfig);
      return;
    }

    onDidSaveFile(uri);
  });

  // RelativePattern (not a bare glob string): reliable on Windows for external edits.
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.vscode/sftp.json'),
      false,
      false,
      true
    );
    const onConfigFile = (uri: vscode.Uri) =>
      scheduleConfigReload(uri, onDidSaveSftpConfig);
    watcher.onDidCreate(onConfigFile);
    watcher.onDidChange(onConfigFile);
    configFileWatchers.push(watcher);
  }
}

function init() {
  onDidOpenTextDocument((doc: vscode.TextDocument) => {
    if (!isValidFile(doc.uri) || !isInWorkspace(doc.uri.fsPath)) {
      return;
    }

    downloadOnOpen(doc.uri);
  });

  watchWorkspace({
    onDidSaveFile: handleFileSave,
    onDidSaveSftpConfig: handleConfigSave,
  });
}

function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  disposeConfigFileWatchers();
}

export default {
  init,
  destory,
};
