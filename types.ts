
export interface ProductPricing {
  supplyPrice: number;
  displayName: string; // 공급사용 (발주서용)
  siteProductName?: string; // 사이트용 (매칭용) - 구 aliases 대체
  sellingPrice?: number; // 판매가
  margin?: number; // 마진
  aliases?: string[]; // 하위 호환성 위해 유지 (삭제 예정이지만 에러 방지)
}

export interface CompanyConfig {
  phone?: string;
  bankName?: string;
  accountNumber?: string;
  orderFormHeaders?: string[];
  orderFormFilename?: string;
  deadline?: string; // 마감 시간 (예: "09:00")
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
}
