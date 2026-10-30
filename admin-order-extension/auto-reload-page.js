// 확장 자동 새로고침 (화면). 확장 코드가 바뀌었으면 확장이 스스로 다시 불러오고, 이 화면도 새로고침해
// 새 코드로 띄운다. 뒤편 쪽은 auto-reload.js.
chrome.runtime.sendMessage({ type: '__AUTO_RELOAD_CHECK' })
  .then((r) => { if (r && r.reloading) setTimeout(() => location.reload(), 1500); })
  .catch(() => {});
