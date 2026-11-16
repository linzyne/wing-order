// 롯데 ALPS 자동 로그인 정보. chrome.storage.local에만 두고(윙발주·Firestore로 보내지 않음) lotte.js가 로그인 화면에서 읽어 쓴다.
const $ = (id) => document.getElementById(id);
const KEY = 'lotteCredentials';
const show = (text, ok = true) => {
  $('msg').textContent = text;
  $('msg').style.color = ok ? '#059669' : '#dc2626';
};

chrome.storage.local.get(KEY, (r) => {
  const c = r && r[KEY];
  if (c) {
    $('id').value = c.id || '';
    $('pw').value = c.pw || '';
    show('저장된 정보가 있어요.');
  }
});

$('save').addEventListener('click', () => {
  const id = $('id').value.trim();
  const pw = $('pw').value;
  if (!id || !pw) return show('아이디와 비밀번호를 모두 넣어주세요.', false);
  chrome.storage.local.set({ [KEY]: { id, pw } }, () => show('저장했어요. 이제 롯데 로그인 화면이 뜨면 자동으로 로그인해요.'));
});

$('clear').addEventListener('click', () => {
  chrome.storage.local.remove(KEY, () => {
    $('id').value = '';
    $('pw').value = '';
    show('지웠어요.');
  });
});

// 예약은 올라갔는데 롯데 창이 닫혀 운송장 출력이 끝나지 않은 건을 다시 연다(background.js RESUME_LOTTE).
const UPLOADED = ['uploading', 'uploaded', 'waybillMenu', 'waybillPage', 'preview', 'waybillDone', 'verify', 'manual', 'error'];
// 아이콘을 누를 때도 확장 새 코드를 확인한다(바뀌었으면 확장이 다시 불러오며 이 창이 닫힌다 — 다시 누르면 새 코드).
chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }).catch(() => {});
chrome.storage.local.get('lottePending', (r) => {
  const p = r && r.lottePending;
  if (!p || !p.batchId) return ($('lotteInfo').textContent = '이어서 할 롯데 예약이 없어요.');
  if (p.step === 'waybills') return ($('lotteInfo').textContent = `${p.batchId}는 운송장번호까지 다 받았어요.`);
  if (!UPLOADED.includes(p.step) || !p.uploadedAt) return ($('lotteInfo').textContent = `${p.batchId}는 롯데에 예약이 올라가기 전에 멈췄어요. 윙발주에서 다시 예약해 주세요.`);
  $('lotteInfo').textContent = `${p.businessName || ''} ${p.batchId} · 박스 ${(p.ordNos || []).length}개 · 마지막 상태: ${p.status || p.step}`;
  $('resume').disabled = false;
});
$('resume').addEventListener('click', () => {
  $('resume').disabled = true;
  chrome.runtime.sendMessage({ type: 'RESUME_LOTTE' }, (res) => {
    const m = $('resumeMsg');
    m.textContent = res && res.ok ? '롯데 창을 열었어요. 로그인 뒤 운송장 출력부터 이어서 해요.' : (res && res.error) || '못 열었어요.';
    m.style.color = res && res.ok ? '#059669' : '#dc2626';
  });
});
