// 견적 구글 시트에 붙이는 Apps Script (확장 프로그램 > Apps Script 에 통째로 붙여넣고 저장).
// 어드민 상세보기에서 '시트 복사'한 "상품명\t공급가" 줄을 받아
// 선택한 칸부터 2줄씩 내려가며 그 칸 = 상품명, 세 칸 오른쪽(A에서 고르면 D) 첫 줄 = 공급가를 넣는다. 사이 두 칸과 둘째 줄은 건드리지 않는다.
// 숨긴 칸 묶음에 들어가게 되면 그 줄을 다시 보이게 한다. 둘째 품목부터는 바로 오른쪽 칸(A에서 고르면 B)이 빈 줄을 만나면(표 끝) 멈춘다.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('견적')
    .addItem('어드민 품목 넣기', 'showAdminPaste')
    .addToUi();
}

function showAdminPaste() {
  const html = HtmlService.createHtmlOutput(
    '<div style="font:13px sans-serif">' +
    '<p style="margin:0 0 6px">넣을 첫 품명 칸을 고른 상태에서 여기 붙여넣기(⌘V) 후 넣기</p>' +
    '<textarea id="t" style="width:100%;height:180px;box-sizing:border-box"></textarea>' +
    '<button id="b" style="margin-top:8px;padding:6px 16px">넣기</button> <span id="m"></span>' +
    '<script>' +
    'document.getElementById("t").focus();' +
    'document.getElementById("b").onclick=function(){' +
    '  var m=document.getElementById("m");m.textContent="넣는 중…";' +
    '  google.script.run.withSuccessHandler(function(r){m.textContent=r;if(r.indexOf("못")<0)google.script.host.close();})' +
    '    .withFailureHandler(function(e){m.textContent="실패: "+e.message;})' +
    '    .fillAdminItems(document.getElementById("t").value);' +
    '};' +
    '</script></div>'
  ).setWidth(420).setHeight(290);
  SpreadsheetApp.getUi().showModalDialog(html, '어드민 품목 넣기');
}

// 상품명: 한글·영문·숫자 말고는 빼고(1.5kg 같은 숫자 사이 점은 둠) 띄어쓰기는 한 칸으로.
function cleanName(s) {
  return String(s)
    .replace(/(\d)\.(\d)/g, '$1\u0000$2')
    .replace(/[^0-9A-Za-z가-힣\u0000]+/g, ' ')
    .replace(/\u0000/g, '.')
    .replace(/ +/g, ' ')
    .trim();
}

function fillAdminItems(text) {
  const items = String(text).split(/\r?\n/)
    .map(function (line) { return line.split('\t'); })
    .filter(function (c) { return c[0] && c[0].trim(); })
    .map(function (c) { return { name: cleanName(c[0]), price: Number(String(c[1] || '').replace(/[^\d]/g, '')) || '' }; });
  if (!items.length) return '붙여넣은 내용이 없음';

  const sheet = SpreadsheetApp.getActiveSheet();
  const cell = sheet.getActiveCell();
  let row = cell.getRow();
  const col = cell.getColumn();
  let done = 0;
  for (const item of items) {
    if (done && sheet.getRange(row, col + 1).getDisplayValue() === '') break;
    if (sheet.isRowHiddenByUser(row) || sheet.isRowHiddenByUser(row + 1)) sheet.showRows(row, 2);
    sheet.getRange(row, col).setValue(item.name);
    sheet.getRange(row, col + 3).setValue(item.price);
    done++;
    row += 2;
  }
  if (done < items.length) return done + '개 넣음 — 칸이 모자라 ' + (items.length - done) + '개 못 넣음';
  return done + '개 넣음';
}
