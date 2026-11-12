const { contextBridge, ipcRenderer } = require('electron');
// The POS page uses window.vfDesktop (when present) instead of calling the old printer agent on 127.0.0.1:4567
contextBridge.exposeInMainWorld('vfDesktop', {
  printHtml: (html) => ipcRenderer.invoke('print-html', html),
  printImage: (job) => ipcRenderer.invoke('print-image', job),
  kickDrawer: () => ipcRenderer.invoke('kick-drawer')
});
