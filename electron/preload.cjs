const { contextBridge, ipcRenderer } = require("electron");

function getBackendUrl() {
  const backendUrl = ipcRenderer.sendSync("elitical:get-backend-url");

  console.info("[elitical:preload] backend URL received", backendUrl || "(empty)");
  return backendUrl;
}

contextBridge.exposeInMainWorld("eliticalDesktop", {
  isDesktop: true,
  backendUrl: getBackendUrl(),
  getBackendUrl,
});
