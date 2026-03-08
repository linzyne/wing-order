import { useState, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import type { PricingConfig } from '../types';

export interface QuickRecipient {
  name: string;
  phone: string;
  address: string;
}

export interface ParsedManualOrder {
  companyName: string;
  recipientName: string;
  phone: string;
  address: string;
  productName: string;
  qty: number;
}

const buildPrompt = (
  userInput: string,
  pricingConfig: PricingConfig,
  quickRecipients: QuickRecipient[]
): string => {
  const companyProductList = Object.entries(pricingConfig)
    .map(([company, config]) => {
      const products = Object.values(config.products)
        .map(p => p.displayName)
        .join(', ');
      return `- ${company}: ${products}`;
    })
    .join('\n');

  const recipientList = quickRecipients
    .map(r => `- ${r.name} (전화: ${r.phone}, 주소: ${r.address})`)
    .join('\n');

  return `너는 한국어 주문 파싱 어시스턴트야. 사용자의 자연어 입력을 분석해서 수동 발주 목록을 JSON으로 반환해.

## 등록된 수령자 (이름만 언급되면 전화번호/주소 자동 채움)
${recipientList}

## 업체별 품목 목록
${companyProductList}

## 규칙
1. 품목명을 기준으로 해당 업체를 매칭해. 예: "포기김치"는 "연두" 업체의 품목.
2. 등록된 수령자 이름이 나오면 해당 전화번호/주소를 사용.
3. 미등록 수령자는 입력에서 이름, 전화번호, 주소를 추출. 없으면 빈 문자열.
4. 수량이 명시되지 않으면 기본값 1.
5. "2키로", "3kg" 등은 수량이 아니라 품목명의 규격이야. 수량은 "N개", "N박스" 등으로 표현됨.
6. 하나의 입력에 여러 발주가 포함될 수 있음. 각각 별도 항목으로 파싱.
7. productName은 위 품목 목록에서 정확히 일치하는 이름으로 매칭해.

## 응답 형식 (순수 JSON 배열만, 마크다운/설명 없이)
[{"companyName":"업체명","recipientName":"수령자","phone":"전화번호","address":"주소","productName":"품목명","qty":1}]

사용자 입력: "${userInput}"`;
};

const parseAIResponse = (responseText: string): ParsedManualOrder[] => {
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(item => ({
      companyName: String(item.companyName || ''),
      recipientName: String(item.recipientName || ''),
      phone: String(item.phone || ''),
      address: String(item.address || ''),
      productName: String(item.productName || ''),
      qty: parseInt(item.qty) || 1,
    }));
  } catch {
    return [];
  }
};

export const useAIManualOrder = (
  pricingConfig: PricingConfig,
  quickRecipients: QuickRecipient[]
) => {
  const [parsedOrders, setParsedOrders] = useState<ParsedManualOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseNaturalLanguage = useCallback(async (text: string) => {
    const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!geminiKey) {
      setError('Gemini API 키가 설정되지 않았습니다.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setParsedOrders([]);

    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const prompt = buildPrompt(text, pricingConfig, quickRecipients);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: { temperature: 0 }
      });
      clearTimeout(timeout);

      const responseText = response.text?.trim();
      if (!responseText) {
        setError('AI 응답이 비어있습니다.');
        return;
      }

      const orders = parseAIResponse(responseText);
      if (orders.length === 0) {
        setError('입력에서 발주 정보를 인식할 수 없습니다. 좀 더 명확하게 작성해주세요.');
        return;
      }

      setParsedOrders(orders);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setError('AI 응답 시간이 초과되었습니다. 다시 시도해주세요.');
      } else {
        setError('AI 분석에 실패했습니다. 수동 입력 모드를 이용해주세요.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [pricingConfig, quickRecipients]);

  const updateParsedOrder = useCallback((index: number, updates: Partial<ParsedManualOrder>) => {
    setParsedOrders(prev => prev.map((o, i) => i === index ? { ...o, ...updates } : o));
  }, []);

  const removeParsedOrder = useCallback((index: number) => {
    setParsedOrders(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearParsedOrders = useCallback(() => {
    setParsedOrders([]);
    setError(null);
  }, []);

  return { parsedOrders, isLoading, error, parseNaturalLanguage, clearParsedOrders, updateParsedOrder, removeParsedOrder };
};
