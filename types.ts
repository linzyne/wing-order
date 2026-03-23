
export type BusinessId = '안군농원' | '조에';

export const BUSINESS_INFO: Record<BusinessId, {
  displayName: string;
  senderName: string;
  phone: string;
  address: string;
}> = {
  '안군농원': {
    displayName: '안군농원',
    senderName: '안군농원',
    phone: '01042626343',
    address: '제주도',
  },
  '조에': {
    displayName: '조에농원',
    senderName: '조에농원',
    phone: '010944963434',
    address: '',
  },
};

export interface ProductPricing {
  supplyPrice: number;
  displayName: string; // 업체 품목명 (매칭용)
  orderFormName?: string; // 발주서생성용 품목명 (비어있으면 displayName 사용)
  siteProductName?: string; // 사이트용 (매칭용) - 구 aliases 대체
  sellingPrice?: number; // 판매가
  margin?: number; // 마진
  aliases?: string[]; // 하위 호환성 위해 유지 (삭제 예정이지만 에러 방지)
}

export interface CompanyConfig {
  phone?: string;
  bankName?: string;
  accountNumber?: string;
  orderFormHeaders?: string[]; // 발주서 헤더
  orderFormFilename?: string; // 발주서 양식 파일명
  invoiceHeaders?: string[]; // 송장 헤더
  invoiceFilename?: string; // 송장 양식 파일명
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
}

export interface UnmatchedOrder {
  companyName: string;
  recipientName: string;
  productName: string;
  phone: string;
  orderNumber: string;
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
  isAuto?: boolean;    // 택배대행/롯데택배 자동 생성 여부
}

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
