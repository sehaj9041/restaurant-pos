const { contextBridge, ipcRenderer } = require('electron');
// The POS page uses window.vfDesktop (when present) instead of calling the old printer agent on 127.0.0.1:4567
contextBridge.exposeInMainWorld('vfDesktop', {
  printHtml: (html) => ipcRenderer.invoke('print-html', html),
  printBill: (html, copies) => ipcRenderer.invoke('print-bill', html, copies),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  testPrint: () => ipcRenderer.invoke('test-print'),
  printImage: (job) => ipcRenderer.invoke('print-image', job),
  kickDrawer: () => ipcRenderer.invoke('kick-drawer')
});
