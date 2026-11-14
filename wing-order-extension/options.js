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
