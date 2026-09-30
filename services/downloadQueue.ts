declare var XLSX: any;

// 사파리는 한 번에 여러 파일 다운로드를 연달아 요청하면 첫 파일 뒤로는 조용히 막아버린다.
// 모든 사업자/분할 파일 다운로드를 하나의 큐로 모아 간격을 두고 차례로 내려받게 한다.
const GAP_MS = 700;
let chain: Promise<void> = Promise.resolve();
let lastAt = 0;

export const queueWorkbookDownload = (wb: any, fileName: string): void => {
    chain = chain.then(async () => {
        const wait = lastAt + GAP_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try {
            XLSX.writeFile(wb, fileName);
        } catch (e) {
            console.error('[다운로드 실패]', fileName, e);
        }
        lastAt = Date.now();
    });
};
