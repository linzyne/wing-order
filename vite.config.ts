import path from 'path';
import os from 'os';
import fsp from 'fs/promises';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// ── Coupang Wing 자동화 (Playwright, dev 서버 전용) ──
async function runWingDownload(
  credentials: { id: string; password: string },
  status: 'INSTRUCT' | 'ACCEPT',
  businessName: string,
  timeLabel: string = '',
): Promise<{ filePath: string; fileName: string }> {
  const { chromium } = await import('playwright');
  const statusLabel = status === 'INSTRUCT' ? '상품준비중' : '결제완료';
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wing-'));

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // 설치된 실제 Chrome 사용 (봇 감지 우회)
    slowMo: 200,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });
  // navigator.webdriver 플래그 제거 (봇 탐지 우회)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    // 1. 로그인
    await page.goto('https://wing.coupang.com');
    await page.waitForLoadState('domcontentloaded');

    const needsLogin = await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (needsLogin) {
      // 아이디/비번 자동 입력 후 로그인 버튼은 사용자가 직접 클릭
      const idField = page.locator('input[type="text"], input[type="email"]').first();
      const pwField = page.locator('input[type="password"]').first();
      await idField.waitFor({ state: 'visible', timeout: 10_000 });
      await idField.click();
      await idField.type(credentials.id, { delay: 60 });
      await pwField.click();
      await pwField.type(credentials.password, { delay: 60 });
      console.log(`[Wing:${businessName}] ★ 로그인 버튼을 눌러주세요 (최대 2분 대기)`);
      await page.waitForURL(
        url => !url.toString().includes('login') && !url.toString().includes('xauth'),
        { timeout: 120_000 }
      );
    }

    // 2. 주문배송관리 이동
    await page.goto('https://wing.coupang.com/tenants/sfl-portal/delivery/management');
    await page.waitForLoadState('domcontentloaded');

    // 3. 배송상태 라디오 클릭 (exact match로 카드의 "상품준비중 12"와 구분)
    await page.getByText(statusLabel, { exact: true }).first().click();
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

    // 배송사 선택 팝업 처리 헬퍼 (사유 입력 → 다운로드 버튼 클릭)
    const handleCarrierPopup = async () => {
      const reasonField = page.locator('textarea[placeholder*="사유"], textarea[placeholder*="기재"]').first();
      await reasonField.waitFor({ state: 'visible', timeout: 10_000 });
      await reasonField.fill('ㅇㅇㅇㅇㅇ');
      // textarea와 같은 팝업 안의 다운로드 버튼만 선택 (페이지에 #submitConfirm 여러 개 존재)
      const popup = page.locator('div').filter({
        has: page.locator('textarea[placeholder*="사유"], textarea[placeholder*="기재"]'),
      }).filter({
        has: page.locator('[id="submitConfirm"]'),
      }).last();
      const dlBtn = popup.locator('[id="submitConfirm"]').filter({ hasText: '다운로드' });
      await dlBtn.waitFor({ timeout: 5_000 });
      await dlBtn.click({ force: true });
    };

    let download: any;

    if (status === 'ACCEPT') {
      // 결제완료: 발주확인 처리 → 배송사 선택 팝업
      const confirmOrderBtn = page.locator('button:has-text("발주확인 처리")').first();
      await confirmOrderBtn.waitFor({ state: 'visible', timeout: 10_000 });
      [download] = await Promise.all([
        page.waitForEvent('download'),
        (async () => { await confirmOrderBtn.click(); await handleCarrierPopup(); })(),
      ]);
    } else {
      // 상품준비중: 엑셀 다운 → 배송사 선택 팝업
      const excelBtn = page.locator('button:has-text("엑셀 다운"), a:has-text("엑셀 다운")').first();
      await excelBtn.waitFor({ timeout: 10_000 });
      [download] = await Promise.all([
        page.waitForEvent('download'),
        (async () => { await excelBtn.click({ force: true }); await handleCarrierPopup(); })(),
      ]);
    }

    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const fileName = `${dateStr}_${businessName}${timeLabel ? '_' + timeLabel : ''}.xlsx`;
    const filePath = path.join(tmpDir, fileName);
    await download.saveAs(filePath);

    return { filePath, fileName };
  } finally {
    await browser.close();
  }
}

async function runWingInvoiceUpload(
  credentials: { id: string; password: string },
  fileBuffer: Buffer,
  fileName: string,
  businessName: string,
): Promise<void> {
  const { chromium } = await import('playwright');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wing-inv-'));
  const tmpFilePath = path.join(tmpDir, fileName);
  await fsp.writeFile(tmpFilePath, fileBuffer);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    slowMo: 200,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    // 1. 로그인
    console.log(`[Wing:${businessName}] Wing 접속 중...`);
    await page.goto('https://wing.coupang.com');
    await page.waitForLoadState('domcontentloaded');

    const needsLogin = await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (needsLogin) {
      const idField = page.locator('input[type="text"], input[type="email"]').first();
      const pwField = page.locator('input[type="password"]').first();
      await idField.waitFor({ state: 'visible', timeout: 10_000 });
      await idField.click();
      await idField.type(credentials.id, { delay: 60 });
      await pwField.click();
      await pwField.type(credentials.password, { delay: 60 });
      console.log(`[Wing:${businessName}] ★ 로그인 버튼을 눌러주세요 (최대 2분 대기)`);
      await page.waitForURL(
        url => !url.toString().includes('login') && !url.toString().includes('xauth'),
        { timeout: 120_000 }
      );
    }

    // 2. 주문배송관리 이동
    console.log(`[Wing:${businessName}] 주문배송관리 페이지 이동 중...`);
    await page.goto('https://wing.coupang.com/tenants/sfl-portal/delivery/management');
    await page.waitForLoadState('domcontentloaded');

    // 3. 상품준비중 탭 클릭
    await page.getByText('상품준비중', { exact: true }).first().click();
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

    // 4. 엑셀 대량배송 버튼 클릭
    console.log(`[Wing:${businessName}] "엑셀 대량배송" 버튼 클릭 중...`);
    const excelUploadBtn = page.locator('button:has-text("엑셀 대량배송"), a:has-text("엑셀 대량배송")').first();
    await excelUploadBtn.waitFor({ timeout: 15_000 });
    await excelUploadBtn.click({ force: true });

    // 5. 팝업에서 파일 선택 (hidden input이므로 attached 상태만 확인 후 직접 주입)
    console.log(`[Wing:${businessName}] 파일 업로드 중...`);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 10_000 });
    await fileInput.setInputFiles(tmpFilePath);

    // 6. 등록하기 버튼 클릭
    console.log(`[Wing:${businessName}] 등록하기 버튼 클릭 중...`);
    const confirmBtn = page.getByRole('button', { name: '등록하기' }).first();
    await confirmBtn.waitFor({ timeout: 8_000 });
    await confirmBtn.click({ force: true });

    await page.waitForTimeout(2_000);
    console.log(`[Wing:${businessName}] 송장 업로드 완료`);
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Vite dev 서버 미들웨어 플러그인
function wingAutomationPlugin(): Plugin {
  return {
    name: 'wing-automation',
    configureServer(server) {
      server.middlewares.use('/api/wing-download', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { id, password, status, businessName, timeLabel } = JSON.parse(body);
            const { filePath, fileName } = await runWingDownload({ id, password }, status, businessName, timeLabel);

            const fileBuffer = await fsp.readFile(filePath);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.end(fileBuffer);

            fsp.unlink(filePath).catch(() => {});
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message ?? '자동화 오류' }));
          }
        });
      });

      server.middlewares.use('/api/wing-invoice-upload', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { id, password, fileBase64, fileName, businessName } = JSON.parse(body);
            const fileBuffer = Buffer.from(fileBase64, 'base64');
            await runWingInvoiceUpload({ id, password }, fileBuffer, fileName, businessName);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message ?? '자동화 오류' }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/coupang-api': {
          target: 'https://api-gateway.coupang.com',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/coupang-api/, ''),
        },
      },
    },
    plugins: [react(), wingAutomationPlugin()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
