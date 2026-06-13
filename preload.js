const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startCrawl: (dates) => ipcRenderer.invoke('start-crawl', dates),
  pauseCrawl: () => ipcRenderer.invoke('pause-crawl'),
  // 💡 이어하기 시 실시간으로 바뀐 지역 필터명을 넘겨줄 수 있도록 매개변수(filter) 추가
  resumeCrawl: (filter) => ipcRenderer.invoke('resume-crawl', filter),
  saveCSV: (data) => ipcRenderer.invoke('save-csv', data),
  onCrawlProgress: (callback) => ipcRenderer.on('crawl-progress', (event, data) => callback(data))
});