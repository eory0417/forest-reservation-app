const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 조회를 시작하라는 요청 (기존)
  startCrawl: (dates) => ipcRenderer.invoke('start-crawl', dates),
  
  // 💡 일시중지 / 이어하기 / CSV 저장을 위한 백엔드 제어 통로 (추가)
  pauseCrawl: () => ipcRenderer.invoke('pause-crawl'),
  resumeCrawl: () => ipcRenderer.invoke('resume-crawl'),
  saveCSV: (data) => ipcRenderer.invoke('save-csv', data),
  
  // 백엔드가 실시간으로 보내주는 데이터를 수신하는 통로 (기존)
  onCrawlProgress: (callback) => ipcRenderer.on('crawl-progress', (event, data) => callback(data))
});