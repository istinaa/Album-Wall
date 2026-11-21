const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('albumWallDesktop', {
  saveFile: ({ bytes, filename }) => ipcRenderer.invoke('save-file', { bytes, filename }),
  reportReady: status => ipcRenderer.send('renderer:ready', status),
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    loadSync: () => ipcRenderer.sendSync('library:load-sync'),
    save: data => ipcRenderer.invoke('library:save', data),
    // A synchronous bridge is used for small library writes so a window
    // closing immediately after a click cannot leave the last edit in the
    // renderer queue.
    saveSync: data => ipcRenderer.sendSync('library:save-sync', data),
    createBackup: () => ipcRenderer.invoke('library:create-backup'),
    chooseSyncFolder: () => ipcRenderer.invoke('library:choose-sync-folder')
  }
});
