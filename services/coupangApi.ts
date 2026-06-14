declare var XLSX: any;

export interface CoupangApiKeys {
  accessKey: string;
  secretKey: string;
  vendorId: string;
}

export type OrderStatus = 'INSTRUCT' | 'ACCEPT';

const API_PREFIX = 'coupang_api_keys_';

export function saveCoupangApiKeys(businessId: string, keys: CoupangApiKeys): void {
  localStorage.setItem(API_PREFIX + businessId, JSON.stringify(keys));
}

export function loadCoupangApiKeys(businessId: string): CoupangApiKeys | null {
  const raw = localStorage.getItem(API_PREFIX + businessId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function deleteCoupangApiKeys(businessId: string): void {
  localStorage.removeItem(API_PREFIX + businessId);
}

function formatDatetime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(-2) + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function formatApiDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function sign(secretKey: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchPage(
  accessKey: string, secretKey: string, vendorId: string,
  status: OrderStatus, startDate: string, endDate: string, pageIndex: number,
): Promise<any[]> {
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  const params: Record<string, string> = {
    endDate, maxPerPage: '100', pageIndex: String(pageIndex), startDate, status,
  };
  const sortedQuery = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const datetime = formatDatetime(new Date());
  const signature = await sign(secretKey, datetime + 'GET' + path + '?' + sortedQuery);

  const res = await fetch(`/coupang-api${path}?${sortedQuery}`, {
    headers: {
      'Authorization': `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
  }
  const json = await res.json();
  if (json.code !== '200') throw new Error(`쿠팡 API 오류 (${json.code}): ${json.message}`);
  return json.data?.orderSheetList ?? [];
}

export async function downloadOrdersAsExcel(
  keys: CoupangApiKeys,
  status: OrderStatus,
  businessName: string,
): Promise<number> {
  const { accessKey, secretKey, vendorId } = keys;

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 0);

  const allOrders: any[] = [];
  let pageIndex = 1;
  while (true) {
    const page = await fetchPage(accessKey, secretKey, vendorId, status, formatApiDate(start), formatApiDate(end), pageIndex);
    allOrders.push(...page);
    if (page.length < 100) break;
    pageIndex++;
  }

  const headers = [
    '묶음배송번호', '주문번호', '택배사', '운송장번호', '분리배송 여부', '분리배송 주문번호',
    '주문일시', '결제완료일시', '상품ID', '상품명', '옵션ID', '옵션명', '수량', '출고지',
    '수취인이름', '전화번호1', '전화번호2', '우편번호', '주소', '배송메세지', '주문자ID', '주문자 이름',
  ];

  const rows: any[][] = [];
  for (const order of allOrders) {
    for (const item of (order.orderItems ?? [])) {
      rows.push([
        order.shipmentBoxId ?? '', order.orderId ?? '', '', '',
        order.splitShipping ? 'Y' : 'N', '',
        order.orderedAt ?? '', order.paidAt ?? '',
        item.productId ?? '', item.productName ?? '',
        item.vendorItemId ?? '', item.vendorItemName ?? '',
        item.shippingCount ?? 0, '',
        order.receiver?.name ?? '',
        order.receiver?.safeNumber ?? order.receiver?.mobile ?? '',
        order.receiver?.mobilePhoneNumber ?? '',
        order.receiver?.postCode ?? '',
        ((order.receiver?.addr1 ?? '') + ' ' + (order.receiver?.addr2 ?? '')).trim(),
        order.receiver?.message ?? '',
        order.orderer?.username ?? '', order.orderer?.name ?? '',
      ]);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), '주문');
  const statusLabel = status === 'INSTRUCT' ? '상품준비중' : '결제완료';
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `주문배송관리-${statusLabel}-${businessName}-${dateStr}.xlsx`);
  return rows.length;
}
