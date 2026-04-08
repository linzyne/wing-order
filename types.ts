
export type HardcodedBusinessId = '안군농원' | '조에';
export type BusinessId = HardcodedBusinessId | (string & {});

export interface BusinessInfo {
  displayName: string;
  shortName: string;
  senderName: string;
  phone: string;
  address: string;
  themeColor?: string;
  buttonColor?: string;
}

export const BUSINESS_INFO: Record<HardcodedBusinessId, BusinessInfo> = {
  '안군농원': {
    displayName: '안군농원',
    shortName: '안군',
    senderName: '안군농원',
    phone: '01042626343',
    address: '제주도',
  },
  '조에': {
    displayName: '조에농원',
    shortName: '조에',
    senderName: '조에농원',
    phone: '010944963434',
    address: '',
  },
};

// ===== 동적 사업자 런타임 레지스트리 =====
// useBusinessList hook이 Firestore에서 로드한 동적 사업자를 여기에 등록
const _dynamicBusinessRegistry: Record<string, BusinessInfo> = {};

export function registerDynamicBusiness(id: string, info: BusinessInfo): void {
  _dynamicBusinessRegistry[id] = info;
}

export function unregisterDynamicBusiness(id: string): void {
  delete _dynamicBusinessRegistry[id];
}

/** 하드코딩 + 동적 사업자 통합 조회. 못 찾으면 undefined */
export function getBusinessInfo(id: string): BusinessInfo | undefined {
  return (BUSINESS_INFO as Record<string, BusinessInfo>)[id] || _dynamicBusinessRegistry[id];
}

export interface ProductPricing {
  supplyPrice: number;
  displayName: string; // 업체 품목명 (매칭용)
  orderFormName?: string; // 발주서생성용 품목명 (비어있으면 displayName 사용)
  siteProductName?: string; // 사이트용 (매칭용) - 구 aliases 대체
  sellingPrice?: number; // 판매가
  margin?: number; // 마진
  aliases?: string[]; // 하위 호환성 위해 유지 (삭제 예정이지만 에러 방지)
}

export const ORDER_FORM_FIELD_TYPES = [
  { key: 'recipientName',    label: '받는사람이름' },
  { key: 'recipientPhone',   label: '받는사람전화번호' },
  { key: 'recipientZipcode', label: '우편번호' },
  { key: 'recipientAddress', label: '받는사람주소' },
  { key: 'deliveryMessage',  label: '배송메시지' },
  { key: 'productName',      label: '상품명' },
  { key: 'qty',              label: '수량' },
  { key: 'orderNumber',      label: '주문번호' },
  { key: 'senderName',       label: '보내는사람이름' },
  { key: 'senderPhone',      label: '보내는사람전화번호' },
  { key: 'senderAddress',    label: '보내는사람주소' },
  { key: 'empty',            label: '비워둠' },
] as const;

export type OrderFormFieldKey = typeof ORDER_FORM_FIELD_TYPES[number]['key'];

export const VENDOR_INVOICE_FIELD_TYPES = [
  { key: 'orderNumber',    label: '주문번호' },
  { key: 'trackingNumber', label: '송장번호' },
  { key: 'empty',          label: '비워둠' },
] as const;

export type VendorInvoiceFieldKey = typeof VENDOR_INVOICE_FIELD_TYPES[number]['key'];

export interface CompanyConfig {
  phone?: string;
  courierName?: string;  // 택배사명 (예: 우체국, CJ 대한통운, 롯데택배)
  bankName?: string;
  accountNumber?: string;
  orderFormHeaders?: string[]; // 발주서 헤더
  orderFormFieldMap?: string[]; // 발주서 필드 매핑 (orderFormHeaders와 1:1 대응)
  orderFormFilename?: string; // 발주서 양식 파일명
  invoiceHeaders?: string[]; // 송장 헤더
  invoiceFilename?: string; // 송장 양식 파일명
  vendorInvoiceHeaders?: string[]; // 업체 송장파일 헤더 (입력 양식)
  vendorInvoiceFieldMap?: string[]; // 업체 송장파일 필드 매핑 (주문번호/송장번호 위치)
  deadline?: string; // 마감 시간 (예: "09:00")
  keywords?: string[]; // 매칭 키워드 (엑셀 그룹컬럼 매칭용)
  products: {
    [productKey: string]: ProductPricing;
  };
}

export type PricingConfig = Record<string, CompanyConfig>;

export type AnalysisResult = {
  [productKey: string]: {
    count: number;
    totalPrice: number;
  };
};

export interface ExcludedOrder {
  companyName: string;
  recipientName: string;
  productName: string;
  phone: string;
  orderNumber: string;
  qty?: number;
}

export interface UnmatchedOrder {
  companyName: string;
  recipientName: string;
  productName: string;
  phone: string;
  orderNumber: string;
  qty?: number;
}

export interface ManualOrder {
  id: string;
  companyName: string;
  recipientName: string;
  phone: string;
  address: string;
  productName: string;
  qty: number;
}

export type ProcessingStatus = 'idle' | 'processing' | 'success' | 'error';

export interface SalesRecord {
  date: string; // YYYY-MM-DD
  company: string;
  product: string;
  count: number;
  supplyPrice: number;
  totalPrice: number;
  margin?: number;
}

export interface DepositRecord {
  bankName: string;
  accountNumber: string;
  amount: number;
  label?: string;
}

export interface MarginRecord {
  registeredName: string; // 등록상품명
  productName: string;    // 품목명
  count: number;          // 수량
  sellingPrice: number;   // 판매가
  supplyPrice: number;    // 공급가
  marginPerUnit: number;  // 마진(개당)
  totalMargin: number;    // 총마진
}

export interface ExpenseRecord {
  id: string;
  category: string;    // 임대료, 통신비, 소모품비, 물류비, 마케팅, 식비, 기타, 이자
  amount: number;      // 지출 금액
  description: string; // 지출 내역
  isAuto?: boolean;    // 자동 생성 여부
}

export interface CourierTemplate {
  id: string;
  name: string;           // 택배사 이름 (e.g. '롯데택배', 'CJ대한통운')
  label?: string;         // 사용자 지정 명칭 (e.g. '과일용', '채소용') — 택배 양식 구분용
  headers: string[];      // 업로드된 양식의 헤더 row
  mapping: {
    orderNumber: number;      // 주문번호 열 index
    recipientName: number;    // 받는사람 열 index
    recipientPhone: number;   // 전화번호 열 index
    recipientAddress: number; // 주소 열 index
    trackingNumber: number;   // 운송장번호 열 index
  };
  fixedValues: Record<number, string>; // 열 index → 고정값 (보내는사람, 상품명 등)
  unitPrice: number;      // 건당 단가 (물류비 계산용)
}

// ===== 멀티 플랫폼 설정 =====

export interface PlatformColumnMapping {
  orderNumber: number;        // 주문번호
  groupName?: number;         // 그룹명/업체구분 (없을 수 있음)
  productName: number;        // 상품명
  optionName?: number;        // 옵션명
  quantity: number;           // 수량
  recipientName: number;      // 수취인명
  recipientPhone: number;     // 수취인 전화번호
  postalCode?: number;        // 우편번호
  address: number;            // 수취인 주소
  deliveryMessage?: number;   // 배송메세지
  orderDate?: number;         // 주문일시
}

export interface PlatformInvoiceMapping {
  orderNumber: number;        // 주문번호 열
  trackingNumber: number;     // 운송장번호 열
  courierName?: number;       // 택배사 열
}

export interface PlatformConfig {
  name: string;                          // 플랫폼 이름
  orderColumns: PlatformColumnMapping;   // 주문 파일 입력 매핑
  invoiceColumns?: PlatformInvoiceMapping; // 송장 업로드 출력 매핑
  detectHeaders: string[];               // 자동 감지용 고유 헤더 키워드
  sampleHeaders?: string[];              // 샘플 파일에서 추출한 헤더 (참고용)
  headerRowIndex: number;                // 헤더 행 번호 (기본 0)
  dataStartRow: number;                  // 데이터 시작 행 (기본 1)
}

export type PlatformConfigs = Record<string, PlatformConfig>;

export interface DailySales {
  date: string;
  records: SalesRecord[];
  totalAmount: number;
  savedAt: string; // ISO timestamp
  orderRows?: any[][];
  orderHeaders?: string[];
  invoiceRows?: any[][];
  invoiceHeaders?: string[];
  depositRecords?: DepositRecord[];
  depositTotal?: number;
  marginRecords?: MarginRecord[];
  marginTotal?: number;
  expenseRecords?: ExpenseRecord[];
}

// ===== Todo List =====
export const DAYS_OF_WEEK = ['월', '화', '수', '목', '금', '토', '일'] as const;
export type DayOfWeek = typeof DAYS_OF_WEEK[number];

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  day?: DayOfWeek;
}
