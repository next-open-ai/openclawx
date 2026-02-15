const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),
    getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
    /** 打开目录选择对话框，返回选中目录的绝对路径，取消返回 null */
    showOpenDirectoryDialog: () => ipcRenderer.invoke('show-open-directory-dialog'),
    platform: process.platform,
});
