const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');

// 개발 환경, 폴더형(win-unpacked), 단독 실행형(Portable) 모두를 만족하는 .env 경로 연산
let envPath;
if (!app.isPackaged) {
  envPath = path.join(__dirname, '.env');
} else if (process.env.PORTABLE_EXECUTABLE_DIR) {
  envPath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.env');
} else {
  envPath = path.join(path.dirname(app.getPath('exe')), '.env');
}

// 환경변수 로드 수행
require('dotenv').config({ path: envPath });

// ================= 카카오 API 설정 구간 =================
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const kakaoHeaders = { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` };
// =======================================================

let mainWindow;
let isPaused = false;
let globalRegionFilter = '전체'; // 💡 실시간 지역 추적을 위해 모듈 스코프로 변경

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1350, 
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const delay = (min, max) => {
  const time = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, time));
};

ipcMain.handle('pause-crawl', () => { isPaused = true; console.log('⏸️ 일시중지 활성화'); });

// 💡 [기능 추가] 이어하기 수신 시 새로 변경된 지역 이름을 실시간으로 연동
ipcMain.handle('resume-crawl', (event, filter) => { 
  isPaused = false; 
  globalRegionFilter = filter || '전체';
  console.log(`▶️ 조사 재개 (실시간 필터 변경 타겟: ${globalRegionFilter})`); 
});

ipcMain.handle('save-csv', async (event, data) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '현재까지 수집된 데이터 CSV로 내보내기',
    defaultPath: path.join(app.getPath('downloads'), '숲나들e_최저가_경로종합분석.csv'),
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });

  if (filePath) {
    let csvContent = '휴양림명\t객실 정보\t최저 가격\t주소\t휴양림(Km)\t휴양림(시간)\t목적지(Km)\t목적지(시간)\n';
    data.forEach(item => {
      csvContent += `"${item.resortName}"\t"${item.roomName}"\t"${item.price}"\t"${item.address}"\t"${item.distance}"\t"${item.duration}"\t"${item.destDistance}"\t"${item.destDuration}"\n`;
    });
    
    fs.writeFileSync(filePath, '\ufeff' + csvContent, 'utf16le');
    return true;
  }
  return false;
});

async function searchKakaoKeyword(keyword) {
  const url = 'https://dapi.kakao.com/v2/local/search/keyword.json';
  try {
    const response = await axios.get(url, { headers: kakaoHeaders, params: { query: keyword } });
    if (response.status === 200 && response.data.documents?.length > 0) {
      const place = response.data.documents[0];
      return {
        address: place.road_address_name || place.address_name,
        x: place.x,
        y: place.y
      };
    }
  } catch (error) {
    console.error(`💥 카카오 검색 오류 (${keyword}):`, error.message);
  }
  return null;
}

async function getKakaoDirections(originX, originY, destX, destY) {
  const url = 'https://apis-navi.kakaomobility.com/v1/directions';
  try {
    const response = await axios.get(url, {
      headers: kakaoHeaders,
      params: { origin: `${originX},${originY}`, destination: `${destX},${destY}`, priority: 'RECOMMEND' }
    });
    if (response.status === 200 && response.data.routes?.length > 0) {
      const summary = response.data.routes[0].summary;
      const distanceKm = (summary.distance / 1000).toFixed(1);
      const durationS = summary.duration;
      const hours = Math.floor(durationS / 3600);
      const minutes = Math.floor((durationS % 3600) / 60);
      const durationStr = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;
      return { distanceKm, durationStr };
    }
  } catch (error) {
    console.error('💥 카카오 내비 길찾기 오류:', error.message);
  }
  return { distanceKm: '', durationStr: '' };
}

ipcMain.handle('start-crawl', async (event, { startDate, endDate, origin, destination, regionFilter }) => {
  isPaused = false;
  globalRegionFilter = regionFilter || '전체';
  let lastProcessedFilter = globalRegionFilter; // 💡 변경 추적용 로컬 상태 스냅샷
  
  const originPlaceCoords = await searchKakaoKeyword(origin);
  if (!originPlaceCoords) {
    console.error(`❌ 출발지(${origin}) 위치를 카카오 Map에서 식별하지 못했습니다.`);
  }

  let destPlaceCoords = null;
  if (destination && destination.trim() !== "") {
    destPlaceCoords = await searchKakaoKeyword(destination);
    if (!destPlaceCoords) {
      console.error(`❌ 선택 목적지(${destination}) 위치를 카카오 Map에서 식별하지 못했습니다.`);
    }
  }
  
  const formattedStartDate = startDate.replace(/-/g, '');
  const formattedEndDate = endDate.replace(/-/g, '');
  const userDataDir = path.join(app.getPath('userData'), 'browser-data');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome', 
    args: [
      '--start-maximized', 
      '--disable-blink-features=AutomationControlled',
      '--excludeSwitches=enable-automation',
      '--disable-infobars'
    ],
    viewport: null
  });

  let page = await context.newPage(); 
  let finalResults = [];

  context.on('page', async newPage => {
    try { await newPage.waitForLoadState(); page = newPage; } catch (e) {}
  });

  try {
    console.log('숲나들e 자연휴양림 통합 메인 페이지 진입 시도...');
    
    let entrySuccess = false;
    for (let i = 1; i <= 3; i++) {
      try {
        await page.goto('https://www.foresttrip.go.kr/main.do?hmpgId=FRIP', { waitUntil: 'load', timeout: 30000 });
        entrySuccess = true;
        break;
      } catch (gotoError) {
        console.log(`⚠️ 메인 페이지 접속 시도 (${i}/3회) 리셋 감지. 2초 후 자동 재시도합니다...`);
        if (i === 3) throw gotoError;
        await delay(2000, 3000);
      }
    }

    let isLoggedIn = await page.locator('text=로그아웃').first().isVisible();
    if (!isLoggedIn) {
      while (!isLoggedIn) {
        await delay(1000, 1000);
        isLoggedIn = await page.locator('text=로그아웃').first().isVisible();
      }
      await delay(1500, 2500);
    }

    console.log('일반예약 검색 페이지로 다이렉트 이동 중...');
    
    let searchPageSuccess = false;
    for (let i = 1; i <= 3; i++) {
      try {
        await page.goto('https://www.foresttrip.go.kr/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001', { waitUntil: 'load', timeout: 30000 });
        searchPageSuccess = true;
        break;
      } catch (gotoError) {
        console.log(`⚠️ 검색 페이지 이동 시도 (${i}/3회) 리셋 감지. 재점프 중...`);
        if (i === 3) throw gotoError;
        await delay(2000, 3000);
      }
    }

    const isRegionOpen = await page.locator('#srch_region').isVisible();
    if (!isRegionOpen) {
      await page.click('.preview_wrap.locate');
      await page.waitForSelector('#srch_region', { state: 'visible', timeout: 10000 });
    }
    const regionLocators = page.locator('#srch_region ul > li > a');
    const regionCount = await regionLocators.count();
    
    if (await page.locator('#srch_region').isVisible()) {
      await page.click('.preview_wrap.locate');
    }

    for (let r = 0; r < regionCount; r++) {
      const isRegVisible = await page.locator('#srch_region').isVisible();
      if (!isRegVisible) {
        await page.click('.preview_wrap.locate');
        await page.waitForSelector('#srch_region', { state: 'visible', timeout: 5000 });
      }
      
      const siteRegionName = await regionLocators.nth(r).innerText();
      // 💡 globalRegionFilter 전역 변수를 참조하도록 바인딩 변경
      if (globalRegionFilter && globalRegionFilter !== '전체') {
        const keywords = globalRegionFilter.split('/');
        const isMatch = keywords.some(kw => siteRegionName.includes(kw));
        if (!isMatch) continue; 
      }
      
      await regionLocators.nth(r).click();
      await delay(1500, 2500); 

      const isResortOpen = await page.locator('#srch_rcfcl').isVisible();
      if (!isResortOpen) {
        await page.click('.preview_wrap.name');
        await page.waitForSelector('#srch_rcfcl', { state: 'visible', timeout: 5000 });
      }
      const resortLocators = page.locator('#srch_rcfcl ul > li > a');
      const resortCount = await resortLocators.count();
      
      if (await page.locator('#srch_rcfcl').isVisible()) {
        await page.click('.preview_wrap.name');
      }

      for (let m = 1; m < resortCount; m++) {
        while (isPaused) { await delay(500, 500); }

        // 💡 [핵심 추가] 일시중지 해제 직후, 변경 사항을 대조하여 중간 지역 하이재킹 가동
        if (globalRegionFilter !== lastProcessedFilter) {
          console.log(`🔄 [지역 점프 활성화] 필터가 ${lastProcessedFilter} 에서 ${globalRegionFilter} 로 변경되었습니다.`);
          lastProcessedFilter = globalRegionFilter;
          
          // 열려있던 요소 꼬임 방지를 위해 일반예약 검색 메인 뼈대로 재탑승 처리
          await page.goto('https://www.foresttrip.go.kr/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001', { waitUntil: 'load', timeout: 30000 });
          await delay(1000, 1500);
          
          r = -1; // r이 -1로 가면 루프 증감식에 의해 0번(첫 지역)부터 완전 재탐색 구동
          break;
        }

        try {
          const isInnerResortVisible = await page.locator('#srch_rcfcl').isVisible();
          if (!isInnerResortVisible) {
            await page.click('.preview_wrap.name');
            await page.waitForSelector('#srch_rcfcl', { state: 'visible', timeout: 5000 });
          }

          const resortName = await resortLocators.nth(m).innerText();
          console.log(`  └ 🌲 ${resortName} 조회 중...`);

          await resortLocators.nth(m).click();
          await delay(600, 1200);

          await page.evaluate(({ start, end }) => {
            const bgIn = document.getElementById('srchRsrvtBgDt') || document.querySelector('input[name="srchRsrvtBgDt"]');
            const edIn = document.getElementById('srchRsrvtEdDt') || document.querySelector('input[name="srchRsrvtEdDt"]');
            if (bgIn) { bgIn.value = start; bgIn.dispatchEvent(new Event('change', { bubbles: true })); }
            if (edIn) { edIn.value = end; edIn.dispatchEvent(new Event('change', { bubbles: true })); }
          }, { start: formattedStartDate, end: formattedEndDate });
          await delay(400, 800);

          await page.click('.fs_btn button');
          await page.waitForLoadState('networkidle');
          await delay(2500, 3500); 

          await page.evaluate(() => {
            const campInputs = document.querySelectorAll('#cmpgr input[name="camp"]');
            campInputs.forEach(cb => {
              if (cb.checked) {
                cb.checked = false;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          });
          await delay(200, 400);

          try {
            await page.evaluate(() => {
              const selectEl = document.getElementById('srtngOrdr');
              if (selectEl) {
                const targetOption = Array.from(selectEl.options).find(opt => opt.text.includes('낮은') || opt.text.includes('가격'));
                if (targetOption) {
                  selectEl.value = targetOption.value; 
                  selectEl.dispatchEvent(new Event('change', { bubbles: true })); 
                }
              }
            });
            await delay(1500, 2500); 
          } catch (sortError) {}

          const firstRoomCard = page.locator('.list_box.type01, .list_box').first();
          let roomName = ''; let price = ''; let isFound = false;

          if (await firstRoomCard.count() > 0 && await firstRoomCard.isVisible()) {
            const rawText = await firstRoomCard.innerText();
            const textLines = rawText.split('\n').map(line => line.trim()).filter(Boolean);
            if (textLines.length >= 2) {
              roomName = `${textLines[0]} ${textLines[1]}`; 
              price = textLines.find(line => line.includes('원')) || '가격 정보 없음';
              isFound = true;
            }
          }

          if (!isFound || price === '가격 정보 없음') {
            const sidebar = page.locator('.reservation_select, .reserve_wrap, div:has-text("예약선택")').first();
            if (await sidebar.count() > 0 && await sidebar.isVisible()) {
              const sideText = await sidebar.innerText();
              if (sideText.includes('원')) {
                const sideLines = sideText.split('\n').map(line => line.trim()).filter(Boolean);
                price = sideLines.find(line => line.includes('원')) || price;
                const facilityLine = sideLines.find(line => line.includes('시설') || line.includes('[')) || '';
                roomName = facilityLine.replace('시설', '').trim() || roomName;
                if (price.includes('원')) isFound = true;
              }
            }
          }

          if (isFound && roomName) {
            if (roomName.includes('산림휴양')) { continue; }

            let cleanResortName = resortName;
            if (cleanResortName && cleanResortName.includes(')')) {
              cleanResortName = cleanResortName.split(')').slice(1).join(')').trim();
            }

            let cleanRoomName = roomName;
            if (cleanRoomName && cleanRoomName.includes('[')) {
              cleanRoomName = cleanRoomName.substring(cleanRoomName.indexOf('[')).trim();
            }

            let cleanPrice = "0";
            if (price && price.includes('원')) {
              const priceMatches = price.match(/([0-9,]+)\s*원/g);
              if (priceMatches) {
                let totalPriceSum = 0;
                priceMatches.forEach(matchText => {
                  const pureNum = parseInt(matchText.replace(/[^0-9]/g, ''), 10);
                  if (!isNaN(pureNum)) {
                    totalPriceSum += pureNum;
                  }
                });
                cleanPrice = totalPriceSum.toString();
              } else {
                cleanPrice = price.replace(/[^0-9]/g, '') || "0";
              }
            }

            let kakaoAddress = "검색 실패";
            let kakaoDistance = ""; let kakaoDuration = "";
            let destDistance = ""; let destDuration = "";

            const resortPlace = await searchKakaoKeyword(cleanResortName);
            if (resortPlace) {
              kakaoAddress = resortPlace.address;
              if (originPlaceCoords) {
                const navi = await getKakaoDirections(originPlaceCoords.x, originPlaceCoords.y, resortPlace.x, resortPlace.y);
                kakaoDistance = navi.distanceKm;
                kakaoDuration = navi.durationStr;
              }
              if (destPlaceCoords) {
                const naviDest = await getKakaoDirections(resortPlace.x, resortPlace.y, destPlaceCoords.x, destPlaceCoords.y);
                destDistance = naviDest.distanceKm;
                destDuration = naviDest.durationStr;
              }
            }

            const resultItem = {
              resortName: cleanResortName,
              roomName: cleanRoomName,
              price: cleanPrice,
              address: kakaoAddress,
              distance: kakaoDistance,
              duration: kakaoDuration,
              destDistance: destDistance,
              destDuration: destDuration,
              coords: {
                origin: originPlaceCoords ? { name: origin, x: originPlaceCoords.x, y: originPlaceCoords.y } : null,
                resort: resortPlace ? { name: cleanResortName, x: resortPlace.x, y: resortPlace.y } : null,
                dest: destPlaceCoords ? { name: destination, x: destPlaceCoords.x, y: destPlaceCoords.y } : null
              }
            };

            finalResults.push(resultItem);
            console.log(`    💰 [매칭 및 전송 완료] -> ${cleanResortName} | ${cleanPrice}원`);

            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('crawl-progress', resultItem);
            }
          } else {
            console.log(`    ❌ 현재 날짜에 예약 가능한 숙박 시설이 없습니다.`);
          }

        } catch (innerError) {
          console.error(`      ⚠️ 요소 매칭 오류 우회 스킵:`, innerError.message);
        }
      }
    }
  } catch (error) {
    console.error('치명적 에러:', error);
  } finally {
    await context.close();
  }

  return finalResults;
});