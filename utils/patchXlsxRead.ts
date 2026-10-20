declare var XLSX: any;

// 일부 택배사 양식(롯데 B-type 등)은 xml 태그를 `<si >`처럼 공백 붙여 저장해서
// SheetJS가 공유문자열을 못 읽고 글자 칸이 전부 빈칸이 된다 → 태그 공백을 지우고 다시 읽는다.
const hasBrokenSharedStrings = (wb: any): boolean =>
  Array.isArray(wb?.Strings) && wb.Strings.length > 0 &&
  wb.Strings.some((s: any) => s && s.t === undefined && s.r === undefined);

const repairZip = (data: any, opts: any): Uint8Array | null => {
  const cfb = XLSX.CFB.read(data, { type: opts?.type || 'array' });
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let changed = false;
  cfb.FileIndex.forEach((f: any, i: number) => {
    if (!f?.content || !/\.xml$/i.test(cfb.FullPaths[i])) return;
    const s = dec.decode(f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content));
    const n = s.replace(/<([A-Za-z:]+) >/g, '<$1>');
    if (n !== s) { f.content = enc.encode(n); changed = true; }
  });
  if (!changed) return null;
  return new Uint8Array(XLSX.CFB.write(cfb, { fileType: 'zip', type: 'array' }));
};

export const patchXlsxRead = () => {
  if (typeof XLSX === 'undefined' || !XLSX?.read || XLSX.__readPatched) return;
  const origRead = XLSX.read;
  XLSX.read = (data: any, opts?: any) => {
    const wb = origRead(data, opts);
    if (!hasBrokenSharedStrings(wb)) return wb;
    try {
      const fixed = repairZip(data, opts);
      if (fixed) return origRead(fixed, { ...opts, type: 'array' });
    } catch (e) {
      console.warn('[XLSX] 태그 공백 보정 실패:', e);
    }
    return wb;
  };
  XLSX.__readPatched = true;
};
