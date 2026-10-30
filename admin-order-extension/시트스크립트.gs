// 견적 구글 시트에 붙이는 Apps Script (확장 프로그램 > Apps Script 에 통째로 붙여넣고 저장).
// 어드민 상세보기에서 '시트 복사'한 "상품명\t공급가" 줄을 받아
// 선택한 칸의 줄부터 2줄씩 내려가며 A열 = 상품명, D열 첫 줄 = 공급가를 넣는다. B·C열과 둘째 줄은 건드리지 않는다.
// 숨긴 칸 묶음에 들어가게 되면 그 줄을 다시 보이게 한다. B열이 빈 줄을 만나면(표 끝) 멈춘다.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('견적')
    .addItem('어드민 품목 넣기', 'showAdminPaste')
    .addToUi();
}

function showAdminPaste() {
  const html = HtmlService.createHtmlOutput(
    '<div style="font:13px sans-serif">' +
    '<p style="margin:0 0 6px">첫 품명 칸(예: A6)을 고른 상태에서 여기 붙여넣기(⌘V) 후 넣기</p>' +
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

function fillAdminItems(text) {
  const items = String(text).split(/\r?\n/)
    .map(function (line) { return line.split('\t'); })
    .filter(function (c) { return c[0] && c[0].trim(); })
    .map(function (c) { return { name: c[0].trim(), price: Number(String(c[1] || '').replace(/[^\d]/g, '')) || '' }; });
  if (!items.length) return '붙여넣은 내용이 없음';

  const sheet = SpreadsheetApp.getActiveSheet();
  let row = sheet.getActiveCell().getRow();
  let done = 0;
  for (const item of items) {
    if (sheet.getRange(row, 2).getDisplayValue() === '') break;
    if (sheet.isRowHiddenByUser(row) || sheet.isRowHiddenByUser(row + 1)) sheet.showRows(row, 2);
    sheet.getRange(row, 1).setValue(item.name);
    sheet.getRange(row, 4).setValue(item.price);
    done++;
    row += 2;
  }
  if (done < items.length) return done + '개 넣음 — 칸이 모자라 ' + (items.length - done) + '개 못 넣음';
  return done + '개 넣음';
}
