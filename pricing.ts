import type { PricingConfig, CompanyConfig, ProductPricing } from './types';

const PRICING_STORAGE_KEY = 'pricingConfig';

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  '연두': {
    deadline: '09:00',
    phone: '',
    bankName: '우리은행',
    accountNumber: '1005103634084',
    products: {
      '포기김치 3kg': { supplyPrice: 16300, displayName: '포기김치 3kg' },
      '포기김치 5kg': { supplyPrice: 21300, displayName: '포기김치 5kg' },
      '포기김치 10kg': { supplyPrice: 33000, displayName: '포기김치 10kg' },
      '총각김치 2kg': { supplyPrice: 11800, displayName: '총각김치 2kg' },
      '총각김치 5kg': { supplyPrice: 23800, displayName: '총각김치 5kg' },
      '총각김치 10kg': { supplyPrice: 43400, displayName: '총각김치 10kg' }
    }
  },
  '웰그린': {
    deadline: '09:00',
    phone: '',
    bankName: '농협(웰그린푸드)',
    accountNumber: '3511291313313',
    products: {
      '제주 구좌 당근 중 3kg': { supplyPrice: 5400, displayName: '제주 구좌 당근 중 3kg' },
      '제주 구좌 당근 상 3kg': { supplyPrice: 5700, displayName: '제주 구좌 당근 상 3kg' },
      '제주 구좌 당근 특 3kg': { supplyPrice: 6000, displayName: '제주 구좌 당근 특 3kg' },
      '제주 구좌 당근 중 5kg': { supplyPrice: 7000, displayName: '제주 구좌 당근 중 5kg' },
      '제주 구좌 당근 상 5kg': { supplyPrice: 7700, displayName: '제주 구좌 당근 상 5kg' },
      '제주 구좌 당근 특 5kg': { supplyPrice: 8400, displayName: '제주 구좌 당근 특 5kg' },
      '제주 구좌 당근 중 10kg': { supplyPrice: 10500, displayName: '제주 구좌 당근 중 10kg' },
      '제주 구좌 당근 상 10kg': { supplyPrice: 11500, displayName: '제주 구좌 당근 상 10kg' },
      '제주 구좌 당근 특 10kg': { supplyPrice: 12500, displayName: '제주 구좌 당근 특 10kg' },
      '제주 구좌 당근 왕 3kg': { supplyPrice: 5000, displayName: '제주 구좌 당근 왕 3kg' },
      '제주 구좌 당근 왕 5kg': { supplyPrice: 6300, displayName: '제주 구좌 당근 왕 5kg' },
      '제주 구좌 당근 왕 10kg': { supplyPrice: 9500, displayName: '제주 구좌 당근 왕 10kg' },
      '사과 선물세트 (9과)': { supplyPrice: 25000, displayName: '사과 선물세트 (9과)', margin: 3976 },
      '혼합 과일 선물세트 (6과)': { supplyPrice: 20000, displayName: '혼합 과일 선물세트 (6과)', margin: 6414 },
      '샤인머스캣 선물세트 1.6kg (2수)': { supplyPrice: 15000, displayName: '샤인머스캣 선물세트 1.6kg (2수)', margin: 5142 },
      '★A급 가정용 부사사과 2kg내외 13-15과': { supplyPrice: 8250, displayName: '★A급 가정용 부사사과 2kg내외 13-15과', margin: 2704 },
      '★A급 가정용 부사사과 3kg내외 17-20과': { supplyPrice: 12450, displayName: '★A급 가정용 부사사과 3kg내외 17-20과', margin: 3275 },
      '★A급 가정용 부사사과 5kg내외 27-32과': { supplyPrice: 17650, displayName: '★A급 가정용 부사사과 5kg내외 27-32과', margin: 5053 },
      '★A급 가정용 부사 사과 10kg내외 51-65과': { supplyPrice: 32500, displayName: '★A급 가정용 부사 사과 10kg내외 51-65과', margin: 5398 },
      '부사사과2kg내외 13-15과': { supplyPrice: 7500, displayName: '부사사과2kg내외 13-15과', margin: 2571 },
      '부사사과4kg내외 16-20과': { supplyPrice: 14000, displayName: '부사사과4kg내외 16-20과', margin: 4905 },
      '부사 사과8kg내외 31-40과': { supplyPrice: 24000, displayName: '부사 사과8kg내외 31-40과', margin: 4092 }
    }
  },
  '팜플로우': {
    deadline: '09:00',
    phone: '',
    bankName: '은행명',
    accountNumber: '계좌번호',
    products: {
      '프리미엄과일 선물세트 혼합 5호': { supplyPrice: 56500, displayName: '프리미엄과일 선물세트 혼합 5호', margin: 7458 }
    }
  },
  '고랭지김치': {
    deadline: '10:00',
    phone: '',
    bankName: '기업은행',
    accountNumber: '58906027204014',
    products: {
      '3kg': { supplyPrice: 16300, displayName: '3kg' },
      '5kg': { supplyPrice: 21300, displayName: '5kg' },
      '7kg': { supplyPrice: 25600, displayName: '7kg' },
      '10kg': { supplyPrice: 33000, displayName: '10kg' }
    }
  },
  '답도': {
    deadline: '10:00',
    phone: '01042626343',
    bankName: '농협',
    accountNumber: '301-6600-4079-21',
    products: {
      '한라봉 2,5KG 소과(13-20과 내외) 가정용': { supplyPrice: 18500, displayName: '한라봉 2,5KG 소과(13-20과 내외) 가정용' },
      '한라봉 2.5KG 중과(10-12과 내외) 가정용': { supplyPrice: 20000, displayName: '한라봉 2.5KG 중과(10-12과 내외) 가정용' },
      '한라봉 2.5KG 대과(06-09과 내외) 가정용': { supplyPrice: 21500, displayName: '한라봉 2.5KG 대과(06-09과 내외) 가정용' },
      '한라봉 4.5KG 소과(24-35과 내외) 가정용': { supplyPrice: 29500, displayName: '한라봉 4.5KG 소과(24-35과 내외) 가정용' },
      '한라봉 4.5KG 중과(18-23과 내외) 가정용': { supplyPrice: 32000, displayName: '한라봉 4.5KG 중과(18-23과 내외) 가정용' },
      '한라봉 4.5KG 대과(09-17과 내외) 가정용': { supplyPrice: 34000, displayName: '한라봉 4.5KG 대과(09-17과 내외) 가정용' },
      '한라봉 2,5KG 소과(15-20과 내외) 선물용': { supplyPrice: 22500, displayName: '한라봉 2,5KG 소과(15-20과 내외) 선물용' },
      '한라봉 2.5KG 중과(11-14과 내외) 선물용': { supplyPrice: 23500, displayName: '한라봉 2.5KG 중과(11-14과 내외) 선물용' },
      '한라봉 2.5KG 대과(06-10과 내외) 선물용': { supplyPrice: 24500, displayName: '한라봉 2.5KG 대과(06-10과 내외) 선물용' },
      '한라봉 4.5KG 소과(24-30과 내외) 선물용': { supplyPrice: 35000, displayName: '한라봉 4.5KG 소과(24-30과 내외) 선물용' },
      '한라봉 4.5KG 중과(18-23과 내외) 선물용': { supplyPrice: 37000, displayName: '한라봉 4.5KG 중과(18-23과 내외) 선물용' },
      '한라봉 4.5KG 대과(10-17과 내외) 선물용': { supplyPrice: 38000, displayName: '한라봉 4.5KG 대과(10-17과 내외) 선물용' }
    }
  },
  '제이제이': {
    deadline: '14:00',
    phone: '',
    bankName: '국민은행',
    accountNumber: '89253700006218',
    orderFormHeaders: ['송하인', '송하인주소', '송하인연락처', '품목', '받는분성명', '받는분주소', '받는분연락처', '배송메시지', '주문번호'],
    products: {
      '노지감귤 3kg 로얄과(S/M)': { supplyPrice: 9500, displayName: '노지감귤 3kg 로얄과(S/M)' },
      '노지감귤 5kg 로얄과(S/M)': { supplyPrice: 12500, displayName: '노지감귤 5kg 로얄과(S/M)' },
      '노지감귤 10kg 로얄과(S/M)': { supplyPrice: 19500, displayName: '노지감귤 10kg 로얄과(S/M)' },
      '노지감귤 10kg 중대과(L/L2)': { supplyPrice: 10000, displayName: '노지감귤 10kg 중대과(L/L2)' },
      '제주 순살 갈치 5마리': { supplyPrice: 15500, displayName: '제주 순살 갈치 5마리' },
      '제주 은갈치 5마리 (중)': { supplyPrice: 19000, displayName: '제주 은갈치 5마리 (중)' },
      '제주 은갈치 5마리 (대)': { supplyPrice: 35500, displayName: '제주 은갈치 5마리 (대)' },
      '제주 노지 한라봉(정품) 3kg': { supplyPrice: 13000, displayName: '제주 노지 한라봉(정품) 3kg' },
      '제주 노지 한라봉(정품) 5kg': { supplyPrice: 18500, displayName: '제주 노지 한라봉(정품) 5kg' },
      '제주 노지 한라봉(정품) 10kg': { supplyPrice: 32000, displayName: '제주 노지 한라봉(정품) 10kg' },
      '제주 하우스 한라봉 선물세트 3kg': { supplyPrice: 23500, displayName: '제주 하우스 한라봉 선물세트 3kg' },
      '제주 하우스 한라봉 선물세트 5kg': { supplyPrice: 33500, displayName: '제주 하우스 한라봉 선물세트 5kg' }
    }
  },
  '신선마켓': {
    deadline: '14:00',
    phone: '',
    bankName: '농협',
    accountNumber: '35711240304018',
    products: {
      '제주(서귀포) 감귤 1kg / L~2L': { supplyPrice: 4600, displayName: '제주(서귀포) 감귤 1kg / L~2L' },
      '제주(서귀포) 감귤 1kg / 2S-M': { supplyPrice: 5100, displayName: '제주(서귀포) 감귤 1kg / 2S-M' },
      '제주(서귀포) 감귤 2kg / L~2L': { supplyPrice: 5800, displayName: '제주(서귀포) 감귤 2kg / L~2L' },
      '제주(서귀포) 감귤 2kg / 2S-M': { supplyPrice: 7000, displayName: '제주(서귀포) 감귤 2kg / 2S-M' },
      '제주(서귀포) 감귤 3kg / L~2L': { supplyPrice: 7000, displayName: '제주(서귀포) 감귤 3kg / L~2L' },
      '제주(서귀포) 감귤 3kg / 2S-M': { supplyPrice: 8600, displayName: '제주(서귀포) 감귤 3kg / 2S-M' },
      '제주(서귀포) 감귤 5kg / L~2L': { supplyPrice: 8300, displayName: '제주(서귀포) 감귤 5kg / L~2L' },
      '제주(서귀포) 감귤 5kg / 2S-M': { supplyPrice: 11000, displayName: '제주(서귀포) 감귤 5kg / 2S-M' },
      '제주(서귀포) 감귤 10kg / 2S-M': { supplyPrice: 22000, displayName: '제주(서귀포) 감귤 10kg / 2S-M' },
      '제주(서귀포) 감귤 10kg / L~2L': { supplyPrice: 16600, displayName: '제주(서귀포) 감귤 10kg / L~2L' }
    }
  },
  '귤_초록': {
    phone: '010-4262-6343',
    products: {
      '제주 노지 조생 감귤 특상품 벌크 S~M / 10kg': { supplyPrice: 22700, displayName: '제주 노지 조생 감귤 특상품 벌크 S~M / 10kg' },
      '제주 노지 조생 감귤 특상품 벌크 L~2L / 10kg': { supplyPrice: 10000, displayName: '제주 노지 조생 감귤 특상품 벌크 L~2L / 10kg' }
    }
  },
  '홍게': {
    phone: '',
    products: {
      'B급 6kg (12~15미내외)': { supplyPrice: 15000, displayName: 'B급 6kg (12~15미내외)' },
      'A급 9kg (25미내외)': { supplyPrice: 20000, displayName: 'A급 9kg (25미내외)' }
    }
  },
  '꽃게': {
    phone: '010-1234-5678',
    products: {
      '2kg': { supplyPrice: 21500, displayName: '빙장꽃게 2kg' },
      '3kg': { supplyPrice: 30500, displayName: '빙장꽃게 3kg' }
    }
  },
  '홍게2': {
    phone: '',
    products: {
      '홍게 3kg': { supplyPrice: 10000, displayName: '홍게 3kg' }
    }
  },
  '황금향': {
    phone: '010-9876-5432',
    products: {
      '황금향 2kg (가정용)': { supplyPrice: 10000, displayName: '황금향 2kg (가정용)' },
      '황금향 3kg (가정용)': { supplyPrice: 13000, displayName: '황금향 3kg (가정용)' },
      '황금향 5kg (가정용)': { supplyPrice: 19500, displayName: '황금향 5kg (가정용)' },
      '황금향 2kg (선물세트)': { supplyPrice: 11500, displayName: '황금향 2kg (선물세트)' },
      '황금향 3kg (선물세트)': { supplyPrice: 15000, displayName: '황금향 3kg (선물세트)' },
      '황금향 5kg (선물세트)': { supplyPrice: 21000, displayName: '황금향 5kg (선물세트)' }
    }
  },
  '귤': {
    phone: '010-9876-5432',
    products: {
      '노지감귤 3kg 소과': { supplyPrice: 11100, displayName: '노지감귤 3kg 소과' },
      '노지감귤 3kg 로얄과(S/M)': { supplyPrice: 10500, displayName: '노지감귤 3kg 로얄과(S/M)' },
      '노지감귤 3kg 중대과(L/L2)': { supplyPrice: 8700, displayName: '노지감귤 3kg 중대과(L/L2)' },
      '노지감귤 5kg 소과(2S)': { supplyPrice: 15500, displayName: '노지감귤 5kg 소과(2S)' },
      '노지감귤 5kg 로얄과(S/M)': { supplyPrice: 14500, displayName: '노지감귤 5kg 로얄과(S/M)' },
      '노지감귤 5kg 중대과(L/L2)': { supplyPrice: 11500, displayName: '노지감귤 5kg 중대과(L/L2)' },
      '노지감귤 9kg 소과': { supplyPrice: 25000, displayName: '노지감귤 9kg 소과' },
      '노지감귤 9kg 로얄과(S/M)': { supplyPrice: 22300, displayName: '노지감귤 9kg 로얄과(S/M)' },
      '노지감귤 9kg 중대과(L/L2)': { supplyPrice: 17800, displayName: '노지감귤 9kg 중대과(L/L2)' }
    }
  },
};

export const getPricingConfig = (): PricingConfig => {
    try {
        const savedConfigStr = localStorage.getItem(PRICING_STORAGE_KEY);
        if (savedConfigStr) {
            const savedConfig = JSON.parse(savedConfigStr);
            if (typeof savedConfig === 'object' && savedConfig !== null) {
                return savedConfig;
            }
        }
    } catch (error) {
        console.error("Failed to load pricing config from localStorage:", error);
    }
    // localStorage에 저장된 설정이 없으면 기본값 사용 후 즉시 저장
    const config = JSON.parse(JSON.stringify(DEFAULT_PRICING_CONFIG));
    savePricingConfig(config);
    return config;
};

export const savePricingConfig = (config: PricingConfig): void => {
    try {
        localStorage.setItem(PRICING_STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
        console.error("Failed to save pricing config to localStorage:", error);
    }
};

export const findProductConfig = (
    config: PricingConfig, 
    companyName: string, 
    productName: string
): [string, ProductPricing & { margin: number }] | null => {
  const companyConfig = config[companyName];
  if (!companyConfig || !companyConfig.products) return null;

  const companyProducts = companyConfig.products;

  const processProduct = (productKey: string): [string, ProductPricing & { margin: number }] => {
    const productConfig = companyProducts[productKey];
    
    const supplyPrice = Number(productConfig.supplyPrice) || 0;
    const margin = Number(productConfig.margin) || 0; 
    
    const sanitizedProductConfig = {
      ...productConfig,
      displayName: productConfig.displayName || productKey,
      supplyPrice,
      margin
    };
    
    return [productKey, { ...sanitizedProductConfig, margin }];
  };

  if (!productName) return null;
  const lowerProductName = productName.toLowerCase();

  const sortedProductKeys = Object.keys(companyProducts).sort((a, b) => {
      const keywordA = companyProducts[a]?.displayName || a;
      const keywordB = companyProducts[b]?.displayName || b;
      return keywordB.length - keywordA.length;
  });

  // 최우선: aliases 매칭 (가장 긴 alias 우선)
  let bestAliasMatch: { key: string; aliasLen: number } | null = null;
  for (const productKey of sortedProductKeys) {
    const productConfig = companyProducts[productKey];
    if (!productConfig?.aliases) continue;
    for (const alias of productConfig.aliases) {
      if (alias && lowerProductName.includes(alias.toLowerCase())) {
        if (!bestAliasMatch || alias.length > bestAliasMatch.aliasLen) {
          bestAliasMatch = { key: productKey, aliasLen: alias.length };
        }
      }
    }
  }
  if (bestAliasMatch) return processProduct(bestAliasMatch.key);

  for (const productKey of sortedProductKeys) {
    const productConfig = companyProducts[productKey];
    if (!productConfig) continue;
    const keyword = productConfig.displayName;
    if (keyword && lowerProductName.includes(keyword.toLowerCase())) {
      return processProduct(productKey);
    }
  }

  // 정규화 매칭: 쉼표/마침표/공백 차이를 무시
  const normalize = (s: string) => s.toLowerCase().replace(/[,.\s]/g, '');
  const normalizedProductName = normalize(productName);
  let bestNormMatch: { key: string; len: number } | null = null;
  for (const productKey of sortedProductKeys) {
    const productConfig = companyProducts[productKey];
    if (!productConfig) continue;
    const normDisplay = normalize(productConfig.displayName);
    if (normalizedProductName.includes(normDisplay)) {
      if (!bestNormMatch || normDisplay.length > bestNormMatch.len) {
        bestNormMatch = { key: productKey, len: normDisplay.length };
      }
    }
  }
  if (bestNormMatch) return processProduct(bestNormMatch.key);

  for (const productKey of sortedProductKeys) {
    if (lowerProductName.includes(productKey.toLowerCase())) {
        return processProduct(productKey);
    }
  }

  const productKeys = Object.keys(companyProducts);
  if (productKeys.length === 1) {
      return processProduct(productKeys[0]);
  }

  return null;
};
