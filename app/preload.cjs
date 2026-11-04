const { contextBridge, ipcRenderer } = require('electron');
const invoke = operation => payload => ipcRenderer.invoke(`harbor:${operation}`, payload);
const subscribe = channel => listener => {
  if (typeof listener !== 'function') throw new TypeError('Expected function');
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};
contextBridge.exposeInMainWorld('harbor', Object.freeze({
  bootstrap: invoke('bootstrap'), list: invoke('list'), saveProfile: invoke('saveProfile'), deleteProfile: invoke('deleteProfile'),
  chooseKey: invoke('chooseKey'), chooseLocalDirectory: invoke('chooseLocalDirectory'), connect: invoke('connect'), disconnect: invoke('disconnect'),
  mutate: invoke('mutate'), enqueue: invoke('enqueue'), cancelQueue: invoke('cancelQueue'), getQueue: invoke('getQueue'),
  onQueue: subscribe('harbor:queue'), onConnection: subscribe('harbor:connection')
}));
