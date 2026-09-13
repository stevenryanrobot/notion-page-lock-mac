const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("lockPanel", {
  info: () => ipcRenderer.invoke("npl:panel-info"),
  submit: (values) => ipcRenderer.invoke("npl:panel-submit", values),
  close: () => ipcRenderer.send("npl:panel-close"),
});
