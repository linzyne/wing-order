// 업체 어드민(adminplus) 화면 왼쪽 아래 작은 패널.
// 윙발주에서 이 업체·사업자 앞으로 보낸 발주서가 오면:
// 주문입력 → 대량 주문입력(엑셀) → 공통 엑셀파일 → 파일 넣기 → '다음: 엑셀 내용 확인' 까지 누르고 멈춘다.
// 내용 확인·제품 매칭·주문 등록은 사람이 한다.
(() => {
  if (window.__adminOrderPanel) return;
  window.__adminOrderPanel = true;

  const POLL_MS = 4000;
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const host = location.host;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  // ── 진단 로그 (패널의 '로그'를 누르면 다운로드 폴더에 어드민발주로그_*.json) ──
  const log = [];
  const L = (text) => {
    const d = new Date();
    log.push(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${text}`);
  };
  const saveLog = () => chrome.runtime.sendMessage({ type: 'SAVE_LOG', log: log.slice(), page: location.href });

  // ── 패널 ──
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;width:104px;background:#fff;color:#3f3f46;border:1px solid #e4e4e7;border-radius:10px;padding:6px;font:11px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:4px';
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:4px">
      <span style="font-size:10px;font-weight:800;color:#2563eb;letter-spacing:-.2px">윙발주</span>
      <span data-k="log" title="진단 로그 받기" style="font-size:9px;color:#a1a1aa;cursor:pointer">로그</span>
    </div>
    <span data-k="label" title="눌러서 업체명·사업자명 바꾸기 (윙발주에 적힌 이름과 같아야 함)" style="font-size:10px;font-weight:700;color:#52525b;background:#f4f4f5;border-radius:5px;padding:2px 5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    <input data-k="company" placeholder="업체명" style="display:none;width:100%;box-sizing:border-box;background:#fafafa;color:#18181b;border:1px solid #e4e4e7;border-radius:5px;padding:3px 5px;font-size:10px;outline:none">
    <input data-k="business" placeholder="사업자명" style="display:none;width:100%;box-sizing:border-box;background:#fafafa;color:#18181b;border:1px solid #e4e4e7;border-radius:5px;padding:3px 5px;font-size:10px;outline:none">
    <button data-k="retry" title="마지막으로 받은 발주서를 다시 올리기" style="display:none;background:#fff;color:#2563eb;border:1px solid #93c5fd;border-radius:6px;padding:4px 0;font-size:10px;font-weight:800;cursor:pointer">다시 올리기</button>
    <button data-k="pickcopy" title="고른 옵션을 '상품명 [탭] 공급가' 줄로 복사 — 시트에서 견적 > 어드민 품목 넣기에 붙여넣기" style="display:none;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:4px 0;font-size:10px;font-weight:800;cursor:pointer"></button>
    <span data-k="pickclear" style="display:none;font-size:9px;color:#a1a1aa;cursor:pointer;text-align:center">고른 것 비우기</span>
    <div data-k="msg" style="font-size:9px;color:#71717a;white-space:pre-wrap;word-break:break-all">기다리는 중</div>`;
  document.documentElement.appendChild(box);
  const $ = (k) => box.querySelector(`[data-k="${k}"]`);
  const show = (text, color) => {
    $('msg').textContent = text;
    $('msg').style.color = color || '#71717a';
  };

  // 업체명·사업자명은 어드민 주소마다 저장. 업체명은 탭 제목 '마니팜 - 셀라 : ADMINPLUS' 에서 짐작하고,
  // 사업자명(윙발주의 안군농원·조에농원 등)은 어드민 로그인 이름과 달라서 처음 한 번 직접 적는다.
  const storeKey = `names:${host}`;
  let names = { company: '', business: '' };
  const guessNames = () => {
    const m = document.title.match(/^\s*(.+?)\s*-/);
    return { company: m ? m[1] : '', business: '' };
  };
  const showNames = () => {
    const ok = names.company && names.business;
    $('label').style.display = ok ? 'block' : 'none';
    $('label').textContent = ok ? `${names.company} · ${names.business}` : '';
    $('company').style.display = ok ? 'none' : 'block';
    $('business').style.display = ok ? 'none' : 'block';
    $('company').value = names.company;
    $('business').value = names.business;
  };
  const saveNames = () => {
    const company = $('company').value.trim();
    const business = $('business').value.trim();
    if (!company || !business) return;
    names = { company, business };
    chrome.storage.local.set({ [storeKey]: names });
    showNames();
  };
  ['company', 'business'].forEach((k) => {
    $(k).addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNames(); });
    $(k).addEventListener('change', saveNames);
  });
  $('label').addEventListener('click', () => {
    $('label').style.display = 'none';
    $('company').style.display = 'block';
    $('business').style.display = 'block';
    $('company').focus();
  });
  $('log').addEventListener('click', saveLog);

  // ── 화면 찾기 도우미 ──
  const visible = (el) => !!(el && el.getClientRects().length);
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const waitFor = async (fn, ms, step = 250) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  const findButton = (label) => [...document.querySelectorAll('button')].find((b) => visible(b) && !box.contains(b) && text(b) === label) || null;

  const toFile = (b64, name) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: XLSX_MIME });
  };

  // ── 올리기 ──
  let busy = false;
  let lastItem = null;
  async function upload(item) {
    busy = true;
    lastItem = item;
    $('retry').style.display = 'none';
    L(`받음: ${item.fileName} (${item.rowCount}행)`);
    show(`${item.label} ${item.rowCount}행 받음\n올리는 중…`, '#2563eb');
    try {
      // 대량 주문입력(엑셀) 화면으로
      if (!location.hash.startsWith('#/excel')) {
        L(`화면 이동: ${location.hash} → #/excel`);
        location.hash = '#/excel';
      }
      const input = await waitFor(() => document.querySelector('input[type="file"][accept*="xls"]'), 15000);
      if (!input) throw new Error('엑셀 올리는 칸을 못 찾음');

      // 업로드 방식: 공통 엑셀파일
      const common = [...document.querySelectorAll('input[name="exeluploadtype"]')]
        .find((r) => text(r.closest('label') || r.parentElement).includes('공통 엑셀파일'));
      if (!common) throw new Error("'공통 엑셀파일' 선택칸을 못 찾음");
      if (!common.checked) {
        common.click();
        await sleep(300);
        L('공통 엑셀파일 선택');
      }

      // 개인정보 제3자 제공 동의는 직접 체크해야 한다
      const agree = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((c) => text(c.closest('label') || c.parentElement).includes('동의'));
      if (agree && !agree.checked) throw new Error("'개인정보 제3자 제공 동의'를 체크한 뒤 '다시 올리기'를 눌러 주세요");

      // 파일 넣기
      const dt = new DataTransfer();
      dt.items.add(toFile(item.fileBase64, item.fileName));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      L('파일 넣음');
      const shown = await waitFor(() => document.body.innerText.includes(item.fileName), 5000);
      L(shown ? '화면에 파일 이름 보임' : '화면에 파일 이름 안 보임(계속 진행)');

      // 다음: 엑셀 내용 확인
      const next = await waitFor(() => {
        const b = findButton('다음: 엑셀 내용 확인');
        return b && !b.disabled ? b : null;
      }, 5000);
      if (!next) throw new Error("'다음: 엑셀 내용 확인' 버튼이 안 눌림");
      next.click();
      L('다음: 엑셀 내용 확인 누름');
      const moved = await waitFor(() => !findButton('다음: 엑셀 내용 확인'), 10000);
      if (!moved) throw new Error('내용 확인 화면으로 안 넘어감 — 화면의 안내를 확인해 주세요');
      L('내용 확인 화면');
      show(`${item.label} ${item.rowCount}행 올림\n내용 확인 후 직접 등록하세요`, '#16a34a');
    } catch (e) {
      L(`실패: ${e.message}`);
      show(`실패: ${e.message}`, '#dc2626');
      $('retry').style.display = 'block';
    } finally {
      busy = false;
    }
  }
  $('retry').addEventListener('click', () => { if (lastItem && !busy) upload(lastItem); });

  // ── 상품 상세보기 '구성상품'에서 옵션 골라 구글 시트용으로 복사 ──
  // 표의 각 줄 제품명 앞에 체크칸을 붙인다. 공급가는 '공급가' 머리글 아래 같은 가로 위치의 ₩값.
  // 복사하면 고른 순서대로 "상품명\t공급가" 줄 → 시트의 견적 메뉴(시트스크립트.gs)가 A열·D열에 2줄씩 넣는다.
  const picked = new Map(); // 상품명 → 공급가
  const isOurs = (el) => el.hasAttribute('data-pick');
  const isLeaf = (el) => ![...el.children].some((c) => !isOurs(c));
  const leaves = (root) => [...root.querySelectorAll('*')].filter((el) => !isOurs(el) && isLeaf(el) && text(el) && !box.contains(el));
  const overlapX = (a, b) => a.left < b.right && a.right > b.left;

  function showPicks() {
    const n = picked.size;
    $('pickcopy').style.display = n ? 'block' : 'none';
    $('pickclear').style.display = n ? 'block' : 'none';
    $('pickcopy').textContent = `시트 복사 ${n}개`;
  }

  function scanOptions() {
    const all = leaves(document.body).filter(visible);
    const nameHead = all.find((el) => text(el) === '제품명');
    if (!nameHead) return;
    const nh = nameHead.getBoundingClientRect();
    const supplyHead = all.find((el) => text(el) === '공급가' && Math.abs(el.getBoundingClientRect().top - nh.top) < 10);
    if (!supplyHead) return;
    const sh = supplyHead.getBoundingClientRect();
    // 제품명 칸 = 제품명 머리글부터 오른쪽 다음 머리글(재고) 앞까지
    const nextHeadLeft = Math.min(sh.left, ...all
      .map((el) => el.getBoundingClientRect())
      .filter((r) => Math.abs(r.top - nh.top) < 10 && r.left > nh.right)
      .map((r) => r.left));
    const nameCol = { left: nh.left - 10, right: nextHeadLeft - 4 };
    const prices = all.filter((el) => {
      if (!/^₩\s*[\d,]+$/.test(text(el))) return false;
      const r = el.getBoundingClientRect();
      return r.top > sh.bottom && overlapX(r, sh);
    });
    const countIn = (el) => prices.filter((p) => el.contains(p)).length;
    for (const price of prices) {
      // 줄 = 이 공급가 하나만 품은 가장 큰 조상
      let row = price;
      while (row.parentElement && row.parentElement !== document.body && !row.parentElement.contains(supplyHead) && countIn(row.parentElement) === 1) row = row.parentElement;
      const nameLeaves = leaves(row).filter((el) => overlapX(el.getBoundingClientRect(), nameCol));
      const name = nameLeaves.map(text).join(' ').trim();
      if (!name || name.startsWith('₩')) continue;
      let cb = row.querySelector('input[data-pick]');
      if (!cb) {
        cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('data-pick', '');
        cb.style.cssText = 'width:15px;height:15px;margin:0 8px 0 0;vertical-align:middle;cursor:pointer;accent-color:#2563eb';
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) picked.set(cb.dataset.name, cb.dataset.price);
          else picked.delete(cb.dataset.name);
          row.style.background = cb.checked ? '#eff6ff' : '';
          showPicks();
        });
        nameLeaves[0].prepend(cb);
      }
      cb.dataset.name = name;
      cb.dataset.price = text(price).replace(/[^\d]/g, '');
      cb.checked = picked.has(name);
      row.style.background = cb.checked ? '#eff6ff' : '';
    }
  }
  let scanTimer = 0;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanOptions, 300);
  }).observe(document.body, { childList: true, subtree: true });

  async function copyText(s) {
    try {
      await navigator.clipboard.writeText(s);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }
  $('pickcopy').addEventListener('click', async () => {
    const lines = [...picked].map(([name, price]) => `${name}\t${price}`);
    await copyText(lines.join('\n'));
    L(`시트 복사 ${lines.length}개`);
    show(`${lines.length}개 복사함\n시트: 견적 > 어드민 품목 넣기`, '#16a34a');
  });
  $('pickclear').addEventListener('click', () => {
    picked.clear();
    scanOptions();
    showPicks();
  });

  // ── 윙발주에서 온 발주서 기다리기 ──
  async function poll() {
    if (busy || !names.company || !names.business) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'TAKE', company: names.company, business: names.business });
    } catch (e) {
      return; // 확장을 다시 불러온 직후 등
    }
    if (res?.error) { L(`목록 실패: ${res.error}`); return; }
    if (res?.item) await upload(res.item);
  }

  chrome.storage.local.get(storeKey, (got) => {
    names = got[storeKey] || guessNames();
    if (names.company && names.business && !got[storeKey]) chrome.storage.local.set({ [storeKey]: names });
    showNames();
    L(`시작: ${host} ${names.company} · ${names.business}`);
    poll();
    setInterval(poll, POLL_MS);
  });
})();
