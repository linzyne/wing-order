
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { PricingConfig, CompanyConfig, ProductPricing, PlatformConfigs, PlatformConfig, PlatformColumnMapping, PlatformInvoiceMapping } from '../types';
import { ORDER_FORM_FIELD_TYPES, VENDOR_INVOICE_FIELD_TYPES } from '../types';
import { inferFieldFromHeader, inferVendorInvoiceField } from '../hooks/useConsolidatedOrderConverter';
import {
    TrashIcon, PlusCircleIcon, DocumentArrowUpIcon, BuildingStorefrontIcon,
    PhoneIcon, ArrowsPointingOutIcon, ArrowsPointingInIcon,
    ChevronDownIcon, ChevronUpIcon, ClipboardDocumentCheckIcon
} from './icons';

declare var XLSX: any;

// undefined 값 제거 (Firestore는 undefined를 지원하지 않음)
const stripUndefined = <T extends Record<string, any>>(obj: T): T => {
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined)
    ) as T;
};

// 표 붙여넣기 파싱 유틸리티
// 노란 셀: 총합계 → supplyPrice, 판매가 → sellingPrice
// 빈 품명 행(소계 등)은 자동 스킵
const parsePastedTable = (text: string): { products: ProductPricing[]; error?: string } => {
    const lines = text.trim().split(/\r?\n/);
    if (!lines.length) return { products: [], error: '내용이 없습니다' };

    const rows = lines.map(line => line.split('\t').map(c => c.trim()));

    const parseNum = (s: string) => Number((s || '').replace(/[,\s]/g, '')) || 0;
    const hasPercent = (s: string) => (s || '').includes('%');

    let nameIdx = 0, supplyIdx = -1, sellingIdx = -1, marginIdx = -1;
    let dataStartRow = 0;

    const firstRow = rows[0];
    const normalized = firstRow.map(c => c.replace(/[\s\n\r]/g, ''));
    const looksLikeHeader = normalized.some(c => /품명|총합계|판매가|공급가|원가율/.test(c));

    if (looksLikeHeader) {
        normalized.forEach((cell, idx) => {
            if (/^(품명|상품명|품목명|품목)$/.test(cell) && nameIdx === 0) nameIdx = idx;
            if (/총합계/.test(cell) && supplyIdx === -1) supplyIdx = idx;
            if (/판매가/.test(cell) && sellingIdx === -1) sellingIdx = idx;
            if (/개당판매이익|개당이익|판매이익/.test(cell) && marginIdx === -1) marginIdx = idx;
        });
        if (supplyIdx === -1) normalized.forEach((cell, idx) => { if (/공급가/.test(cell) && supplyIdx === -1) supplyIdx = idx; });
        if (supplyIdx === -1) supplyIdx = 3;
        if (sellingIdx === -1) sellingIdx = 4;
        dataStartRow = 1;
    } else {
        nameIdx = 0;
        // 첫 번째 % 컬럼 기준으로 총합계(바로 2칸 앞) / 판매가(바로 1칸 앞) 감지
        const percentColIdx = firstRow.findIndex((c, i) => i > 0 && hasPercent(c));
        if (percentColIdx >= 3) {
            supplyIdx = percentColIdx - 2; // 총합계
            sellingIdx = percentColIdx - 1; // 판매가
            // 마진: % 컬럼 이후 마지막 양수 비-% 컬럼
            for (let i = firstRow.length - 1; i > percentColIdx; i--) {
                const v = parseNum(firstRow[i] || '');
                if (v > 0 && !hasPercent(firstRow[i] || '')) { marginIdx = i; break; }
            }
        } else {
            supplyIdx = 1; sellingIdx = 2;
        }
    }

    // 헤더 다중줄 셀 등으로 marginIdx 미감지 시 첫 데이터 행 기준 보완
    if (marginIdx === -1 && dataStartRow < rows.length) {
        const dataRow = rows[dataStartRow];
        const afterSell = sellingIdx >= 0 ? sellingIdx : 0;
        for (let i = dataRow.length - 1; i > afterSell; i--) {
            const v = parseNum(dataRow[i] || '');
            if (v > 0 && !hasPercent(dataRow[i] || '')) { marginIdx = i; break; }
        }
    }

    const products: ProductPricing[] = [];

    for (let i = dataStartRow; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        const name = row[nameIdx] || '';
        if (!name) continue; // 빈 품명 행 스킵 (소계 행 등)

        const supplyPrice = parseNum(row[supplyIdx] || '');
        const sellingPrice = parseNum(row[sellingIdx] || '');
        if (!supplyPrice && !sellingPrice) continue;

        let margin: number | undefined;
        if (marginIdx >= 0) {
            const raw = row[marginIdx] || '';
            if (raw && !hasPercent(raw)) { const m = parseNum(raw); if (m) margin = Math.floor(m / 100) * 100; }
        }

        const product: ProductPricing = { displayName: name, supplyPrice };
        if (sellingPrice) product.sellingPrice = sellingPrice;
        if (margin !== undefined) product.margin = margin;
        products.push(product);
    }

    if (!products.length) return { products: [], error: '추출된 품목이 없습니다. 스프레드시트에서 직접 복사한 표를 붙여넣어 주세요.' };
    return { products };
};

// Updated DialogType to include 'message' in 'productEditor' variant
type DialogType =
    | { type: 'alert'; message: string; onConfirm: () => void }
    | { type: 'confirm'; message: string; onConfirm: () => void; onCancel: () => void }
    | { type: 'prompt'; message: string; placeholder?: string; onConfirm: (value: string) => void; onCancel: () => void }
    | { type: 'productEditor'; message: string; companyName: string; productKey: string; product: ProductPricing; onConfirm: (originalProductKey: string, newProduct: ProductPricing) => void; onCancel: () => void }
    | null;

const EditableField: React.FC<{
    value: string;
    onSave: (value: string) => void;
    placeholder?: string;
    className?: string;
}> = ({ value, onSave, placeholder, className }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [currentValue, setCurrentValue] = useState(value);

    useEffect(() => {
        setCurrentValue(value);
    }, [value]);

    const handleBlur = () => {
        setIsEditing(false);
        if (currentValue !== value) {
            onSave(currentValue);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleBlur();
        } else if (e.key === 'Escape') {
            setCurrentValue(value);
            setIsEditing(false);
        }
    };

    if (isEditing) {
        return (
            <input
                autoFocus
                type="text"
                value={currentValue}
                onChange={(e) => setCurrentValue(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className={className}
            />
        );
    }

    return (
        <div onClick={() => setIsEditing(true)} className={`${className} cursor-pointer min-h-[1em]`}>
            {value || <span className="text-zinc-700 italic">{placeholder || '입력...'}</span>}
        </div>
    );
};

const Dialog: React.FC<{ dialog: DialogType; setDialog: (d: DialogType) => void }> = ({ dialog, setDialog }) => {
    const [promptValue, setPromptValue] = useState('');

    useEffect(() => {
        if (dialog?.type === 'prompt') {
            setPromptValue('');
        }
    }, [dialog]);

    if (!dialog) return null;

    const handleConfirm = () => {
        if (dialog.type === 'prompt') {
            dialog.onConfirm(promptValue);
        } else if (dialog.type === 'productEditor') {
            dialog.onConfirm(dialog.productKey, dialog.product);
        } else {
            dialog.onConfirm();
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]">
                <div className="px-6 pt-5 pb-1">
                {/* Fix: TypeScript error where message was missing on productEditor type variant */}
                <p className="text-base font-black text-white text-center">{dialog.message}</p>
                </div>

                {dialog.type === 'prompt' && (
                    <input
                        autoFocus
                        type="text"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white mx-6 mb-4 focus:ring-2 focus:ring-rose-500/20 outline-none text-base"
                        placeholder={dialog.placeholder}
                        value={promptValue}
                        onChange={(e) => setPromptValue(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
                    />
                )}

                {dialog.type === 'productEditor' && (
                    <div className="space-y-3 px-6 py-3 overflow-y-auto flex-1 text-left">
                        <div>
                            <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">품목 명칭</label>
                            <input
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm"
                                value={dialog.product.displayName}
                                onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, displayName: e.target.value } })}
                            />
                        </div>
                        <div>
                            <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">발주서생성용 품목명</label>
                            <input
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm"
                                placeholder={dialog.product.displayName || '비워두면 품목 명칭 사용'}
                                value={dialog.product.orderFormName || ''}
                                onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, orderFormName: e.target.value || undefined } })}
                            />
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                            <div>
                                <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">공급가</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm text-right"
                                    value={dialog.product.supplyPrice}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, supplyPrice: Number(e.target.value) || 0 } })}
                                    onPaste={(e) => {
                                        const text = e.clipboardData.getData('text');
                                        const parts = text.trim().split(/\t+/);
                                        if (parts.length >= 3) {
                                            const nums = parts.map(s => Number(s.replace(/,/g, ''))).filter(n => !isNaN(n));
                                            if (nums.length >= 3) {
                                                e.preventDefault();
                                                setDialog({ ...dialog, product: { ...dialog.product, supplyPrice: nums[0], sellingPrice: nums[1], margin: nums[2] } });
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">판매가</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm text-right"
                                    value={dialog.product.sellingPrice || 0}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, sellingPrice: Number(e.target.value) || 0 } })}
                                    onPaste={(e) => {
                                        const text = e.clipboardData.getData('text');
                                        const parts = text.trim().split(/\t+/);
                                        if (parts.length >= 3) {
                                            const nums = parts.map(s => Number(s.replace(/,/g, ''))).filter(n => !isNaN(n));
                                            if (nums.length >= 3) {
                                                e.preventDefault();
                                                setDialog({ ...dialog, product: { ...dialog.product, supplyPrice: nums[0], sellingPrice: nums[1], margin: nums[2] } });
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">마진</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm text-right"
                                    value={dialog.product.margin || 0}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, margin: Number(e.target.value) || 0 } })}
                                    onPaste={(e) => {
                                        const text = e.clipboardData.getData('text');
                                        const parts = text.trim().split(/\t+/);
                                        if (parts.length >= 3) {
                                            const nums = parts.map(s => Number(s.replace(/,/g, ''))).filter(n => !isNaN(n));
                                            if (nums.length >= 3) {
                                                e.preventDefault();
                                                setDialog({ ...dialog, product: { ...dialog.product, supplyPrice: nums[0], sellingPrice: nums[1], margin: nums[2] } });
                                            }
                                        }
                                    }}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">배송비</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm text-right"
                                    placeholder="0"
                                    value={dialog.product.shippingCost || ''}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, shippingCost: Number(e.target.value.replace(/,/g, '')) || 0 } })}
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">수량 변환</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm text-right"
                                    placeholder="미설정시 1"
                                    value={dialog.product.orderSplitCount || ''}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, orderSplitCount: Number(e.target.value) || 0, splitMode: 'quantity' } })}
                                />
                            </div>
                            <p className="col-span-2 text-[11px] text-zinc-500 -mt-1">
                                업체에 1kg밖에 없을 때 사용 · 내 품목 2kg → 1kg x 수량2로 변환
                            </p>
                        </div>
                        <div>
                            <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">품목 키워드 <span className="text-zinc-600 normal-case">(K열 그룹아이디 매칭)</span></label>
                            <input
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm"
                                placeholder="예: 열무김치"
                                value={dialog.product.siteProductName || ''}
                                onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, siteProductName: e.target.value || undefined } })}
                            />
                            <p className="text-[10px] text-zinc-600 mt-1">K열에 이 키워드가 포함되면 최우선 매칭</p>
                        </div>
                        <div>
                            <label className="text-[11px] font-black text-zinc-500 uppercase mb-1 block">매칭 키워드 (별칭)</label>
                            <textarea
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm resize-none"
                                rows={2}
                                placeholder="쉼표로 구분하여 입력 (예: 부사사과 2kg, 부사 사과 2kg내외)"
                                value={(dialog.product.aliases || []).join(', ')}
                                onChange={(e) => {
                                    const aliases = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                                    setDialog({ ...dialog, product: { ...dialog.product, aliases: aliases.length > 0 ? aliases : [] } });
                                }}
                            />
                        </div>
                    </div>
                )}

                <div className="flex gap-3 px-6 pb-5 pt-3 shrink-0">
                    {(dialog.type === 'confirm' || dialog.type === 'prompt' || dialog.type === 'productEditor') && (
                        <button
                            onClick={() => dialog.onCancel()}
                            className="flex-1 px-4 py-3 bg-zinc-800 text-zinc-400 font-black rounded-xl hover:bg-zinc-700 transition-all text-sm"
                        >
                            취소
                        </button>
                    )}
                    <button
                        onClick={handleConfirm}
                        className="flex-1 px-4 py-3 bg-rose-500 text-white font-black rounded-xl hover:bg-rose-600 shadow-lg shadow-rose-900/20 transition-all text-sm"
                    >
                        확인
                    </button>
                </div>
            </div>
        </div >
    );
};

// ===== 플랫폼 매핑 필드 정의 =====
const REQUIRED_MAPPING_FIELDS: { key: keyof PlatformColumnMapping; label: string }[] = [
    { key: 'orderNumber', label: '주문번호' },
    { key: 'productName', label: '상품명' },
    { key: 'quantity', label: '수량' },
    { key: 'recipientName', label: '수취인명' },
    { key: 'recipientPhone', label: '수취인 전화번호' },
    { key: 'address', label: '수취인 주소' },
];
const OPTIONAL_MAPPING_FIELDS: { key: keyof PlatformColumnMapping; label: string }[] = [
    { key: 'groupName', label: '업체구분 (그룹명)' },
    { key: 'optionName', label: '옵션명' },
    { key: 'postalCode', label: '우편번호' },
    { key: 'deliveryMessage', label: '배송메세지' },
    { key: 'orderDate', label: '주문일시' },
];
const INVOICE_MAPPING_FIELDS: { key: keyof PlatformInvoiceMapping; label: string; required: boolean }[] = [
    { key: 'orderNumber', label: '주문번호 열', required: true },
    { key: 'trackingNumber', label: '운송장번호 열', required: true },
    { key: 'courierName', label: '택배사 열', required: false },
];

const colIndexToLabel = (idx: number): string => {
    let label = '';
    let n = idx;
    while (n >= 0) {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    }
    return label;
};

// ===== 플랫폼 설정 다이얼로그 =====
const PlatformConfigDialog: React.FC<{
    initial: PlatformConfig | null;
    onSave: (config: PlatformConfig) => void;
    onCancel: () => void;
}> = ({ initial, onSave, onCancel }) => {
    const [name, setName] = useState(initial?.name || '');
    const [sampleHeaders, setSampleHeaders] = useState<string[]>(initial?.sampleHeaders || []);
    const [headerRowIndex, setHeaderRowIndex] = useState(initial?.headerRowIndex ?? 0);
    const [dataStartRow, setDataStartRow] = useState(initial?.dataStartRow ?? 1);
    const [orderColumns, setOrderColumns] = useState<Partial<PlatformColumnMapping>>(initial?.orderColumns || {});
    const [invoiceColumns, setInvoiceColumns] = useState<Partial<PlatformInvoiceMapping>>(initial?.invoiceColumns || {});
    const [detectHeaders, setDetectHeaders] = useState<string>(initial?.detectHeaders?.join(', ') || '');
    const [showInvoice, setShowInvoice] = useState(!!initial?.invoiceColumns);
    const [parsedRows, setParsedRows] = useState<any[][] | null>(null);

    // headerRowIndex 변경 시 해당 행에서 헤더 재추출
    useEffect(() => {
        if (parsedRows && parsedRows.length > headerRowIndex) {
            const headers = parsedRows[headerRowIndex].map((h: any) => String(h || ''));
            setSampleHeaders(headers);
        }
    }, [headerRowIndex, parsedRows]);

    const handleSampleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const data = new Uint8Array(evt.target?.result as ArrayBuffer);
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
                setParsedRows(json);
                if (json.length > headerRowIndex) {
                    const headers = json[headerRowIndex].map((h: any) => String(h || ''));
                    setSampleHeaders(headers);
                    // 자동감지 헤더: 첫 3개 비어있지 않은 헤더
                    if (!detectHeaders) {
                        const autoDetect = headers.filter(Boolean).slice(0, 3).join(', ');
                        setDetectHeaders(autoDetect);
                    }
                }
            } catch (err) {
                console.error('샘플 파일 파싱 실패:', err);
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    const handleSave = () => {
        if (!name.trim()) return;
        const requiredKeys: (keyof PlatformColumnMapping)[] = ['orderNumber', 'productName', 'quantity', 'recipientName', 'recipientPhone', 'address'];
        const missing = requiredKeys.filter(k => orderColumns[k] === undefined);
        if (missing.length > 0) return;

        const config: PlatformConfig = {
            name: name.trim(),
            orderColumns: orderColumns as PlatformColumnMapping,
            invoiceColumns: showInvoice && invoiceColumns.orderNumber !== undefined && invoiceColumns.trackingNumber !== undefined
                ? invoiceColumns as PlatformInvoiceMapping
                : undefined,
            detectHeaders: detectHeaders.split(',').map(s => s.trim()).filter(Boolean),
            sampleHeaders,
            headerRowIndex,
            dataStartRow,
        };
        onSave(config);
    };

    const headerOptions = sampleHeaders.map((h, i) => ({ index: i, label: `${colIndexToLabel(i)}열: ${h}` }));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
                <p className="text-xl font-black text-white mb-6 text-center">
                    {initial ? '플랫폼 설정 편집' : '새 플랫폼 추가'}
                </p>

                {/* 플랫폼 이름 */}
                <div className="mb-5">
                    <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">플랫폼 이름</label>
                    <input
                        autoFocus
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3 text-white focus:ring-2 focus:ring-rose-500/20 outline-none"
                        placeholder="예: 지마켓"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </div>

                {/* 샘플 파일 업로드 */}
                <div className="mb-5">
                    <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">샘플 파일 업로드</label>
                    <label className="flex items-center gap-3 bg-zinc-950 border border-dashed border-zinc-700 rounded-xl px-5 py-4 cursor-pointer hover:border-rose-500/50 transition-all">
                        <DocumentArrowUpIcon className="w-5 h-5 text-zinc-600" />
                        <span className="text-sm text-zinc-500">
                            {sampleHeaders.length > 0 ? `헤더 ${sampleHeaders.length}개 감지됨` : '엑셀 파일을 선택하세요'}
                        </span>
                        <input type="file" className="hidden" accept=".xlsx,.xls" onChange={handleSampleUpload} />
                    </label>
                </div>

                {/* 헤더 행 설정 */}
                <div className="grid grid-cols-2 gap-4 mb-5">
                    <div>
                        <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">헤더 행 번호 (0부터)</label>
                        <input type="number" min={0} className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white outline-none text-sm"
                            value={headerRowIndex}
                            onChange={(e) => setHeaderRowIndex(Number(e.target.value))}
                        />
                    </div>
                    <div>
                        <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">데이터 시작 행</label>
                        <input type="number" min={0} className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white outline-none text-sm"
                            value={dataStartRow}
                            onChange={(e) => setDataStartRow(Number(e.target.value))}
                        />
                    </div>
                </div>

                {/* 컬럼 매핑 - 필수 */}
                {sampleHeaders.length > 0 && (
                    <>
                        <div className="mb-5">
                            <label className="text-[12px] font-black text-rose-500 uppercase mb-3 block">필수 컬럼 매핑</label>
                            <div className="space-y-2">
                                {REQUIRED_MAPPING_FIELDS.map(field => (
                                    <div key={field.key} className="flex items-center gap-3">
                                        <span className="text-sm font-bold text-zinc-400 w-36 shrink-0">{field.label}</span>
                                        <select
                                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white outline-none"
                                            value={orderColumns[field.key] ?? ''}
                                            onChange={(e) => setOrderColumns(prev => ({
                                                ...prev,
                                                [field.key]: e.target.value === '' ? undefined : Number(e.target.value)
                                            }))}
                                        >
                                            <option value="">-- 선택 --</option>
                                            {headerOptions.map(opt => (
                                                <option key={opt.index} value={opt.index}>{opt.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 컬럼 매핑 - 선택 */}
                        <div className="mb-5">
                            <label className="text-[12px] font-black text-zinc-500 uppercase mb-3 block">선택 컬럼 매핑</label>
                            <div className="space-y-2">
                                {OPTIONAL_MAPPING_FIELDS.map(field => (
                                    <div key={field.key} className="flex items-center gap-3">
                                        <span className="text-sm font-bold text-zinc-500 w-36 shrink-0">{field.label}</span>
                                        <select
                                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white outline-none"
                                            value={orderColumns[field.key] ?? ''}
                                            onChange={(e) => setOrderColumns(prev => ({
                                                ...prev,
                                                [field.key]: e.target.value === '' ? undefined : Number(e.target.value)
                                            }))}
                                        >
                                            <option value="">-- 없음 --</option>
                                            {headerOptions.map(opt => (
                                                <option key={opt.index} value={opt.index}>{opt.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 송장 업로드 매핑 */}
                        <div className="mb-5">
                            <label className="flex items-center gap-3 cursor-pointer mb-3">
                                <input type="checkbox" checked={showInvoice} onChange={(e) => setShowInvoice(e.target.checked)}
                                    className="w-4 h-4 rounded border-zinc-700 bg-zinc-950 text-rose-500 focus:ring-rose-500/20" />
                                <span className="text-[12px] font-black text-zinc-500 uppercase">송장 업로드 양식 설정</span>
                            </label>
                            {showInvoice && (
                                <div className="space-y-2 pl-7">
                                    <p className="text-[11px] text-zinc-600">주문서와 동일한 양식에서 송장 관련 열을 선택하세요</p>
                                    {INVOICE_MAPPING_FIELDS.map(field => (
                                        <div key={field.key} className="flex items-center gap-3">
                                            <span className={`text-sm font-bold w-36 shrink-0 ${field.required ? 'text-zinc-400' : 'text-zinc-500'}`}>{field.label}</span>
                                            <select
                                                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white outline-none"
                                                value={invoiceColumns[field.key] ?? ''}
                                                onChange={(e) => setInvoiceColumns(prev => ({
                                                    ...prev,
                                                    [field.key]: e.target.value === '' ? undefined : Number(e.target.value)
                                                }))}
                                            >
                                                <option value="">{field.required ? '-- 선택 --' : '-- 없음 --'}</option>
                                                {headerOptions.map(opt => (
                                                    <option key={opt.index} value={opt.index}>{opt.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* 자동감지 헤더 */}
                        <div className="mb-6">
                            <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">자동감지 헤더 키워드</label>
                            <input
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3 text-white outline-none text-sm"
                                placeholder="쉼표로 구분 (예: 발주번호, 지마켓주문번호)"
                                value={detectHeaders}
                                onChange={(e) => setDetectHeaders(e.target.value)}
                            />
                            <p className="text-[10px] text-zinc-600 mt-1">파일 업로드 시 이 키워드가 헤더에 있으면 자동으로 이 플랫폼으로 감지됩니다</p>
                        </div>
                    </>
                )}

                {/* 버튼 */}
                <div className="flex gap-4">
                    <button onClick={onCancel}
                        className="flex-1 px-6 py-4 bg-zinc-800 text-zinc-400 font-black rounded-xl hover:bg-zinc-700 transition-all">
                        취소
                    </button>
                    <button onClick={handleSave}
                        disabled={!name.trim() || sampleHeaders.length === 0}
                        className="flex-1 px-6 py-4 bg-rose-500 text-white font-black rounded-xl hover:bg-rose-600 shadow-lg shadow-rose-900/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                        저장
                    </button>
                </div>
            </div>
        </div>
    );
};

interface PricingEditorProps {
    config: PricingConfig;
    onConfigChange: (newConfig: PricingConfig) => void;
    businessId?: string;
    platformConfigs?: PlatformConfigs;
    onPlatformConfigsChange?: (configs: PlatformConfigs) => void;
}

const PricingEditor: React.FC<PricingEditorProps> = ({ config, onConfigChange, platformConfigs = {}, onPlatformConfigsChange }) => {
    const [dialog, setDialog] = useState<DialogType>(null);
    const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>(() => {
        return Object.keys(config).reduce((acc, key) => ({ ...acc, [key]: true }), {});
    });
    const [platformDialog, setPlatformDialog] = useState<{ editing: string | null } | null>(null);
    const [isPlatformExpanded, setIsPlatformExpanded] = useState(true);

    // 항상 최신 config를 참조하기 위한 ref (렌더 시점에 동기적으로 갱신)
    const configRef = useRef(config);
    configRef.current = config;

    const handleUpdate = useCallback((newConfig: PricingConfig) => onConfigChange(newConfig), [onConfigChange]);

    const handleAddCompany = () => {
        setDialog({
            type: 'prompt',
            message: '새로운 그룹 이름을 지어주세요 🌸',
            placeholder: '예: 고랭지김치',
            onConfirm: (companyName) => {
                if (!companyName) return;
                const cur = configRef.current;
                if (cur[companyName]) {
                    setDialog({ type: 'alert', message: '이미 있는 이름이에요! ✨', onConfirm: () => setDialog(null) });
                    return;
                }
                const newConfig = JSON.parse(JSON.stringify(cur));
                newConfig[companyName] = { phone: '', bankName: '', accountNumber: '', products: { '기본 품목': { displayName: '기본 품목', supplyPrice: 0 } } };
                onConfigChange(newConfig);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    const handleDeleteCompany = (companyName: string) => {
        setDialog({
            type: 'confirm',
            message: `정말로 '${companyName}' 그룹을 삭제할까요? 🥺`,
            onConfirm: () => {
                const newConfig = JSON.parse(JSON.stringify(configRef.current));
                delete newConfig[companyName];
                onConfigChange(newConfig);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    const handleUpdateCompanyName = (oldName: string, newName: string) => {
        if (oldName === newName) return;
        const cur = configRef.current;
        if (cur[newName]) {
            setDialog({ type: 'alert', message: '이미 있는 이름이에요! 🥺', onConfirm: () => setDialog(null) });
            return;
        }
        const newConfig = JSON.parse(JSON.stringify(cur));
        newConfig[newName] = newConfig[oldName];
        delete newConfig[oldName];
        handleUpdate(newConfig);
    };

    const handleUpdatePhone = (companyName: string, phone: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].phone = phone;
        handleUpdate(newConfig);
    };

    const handleUpdateBank = (companyName: string, bank: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].bankName = bank;
        handleUpdate(newConfig);
    };

    const handleUpdateAccount = (companyName: string, account: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].accountNumber = account;
        handleUpdate(newConfig);
    };

    const handleUpdateCourier = (companyName: string, courier: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].courierName = courier;
        handleUpdate(newConfig);
    };

    const handleUpdateAutoConsolidate = (companyName: string, enabled: boolean) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].autoConsolidate = enabled || undefined;
        handleUpdate(newConfig);
    };

    const handleUpdateDeadline = (companyName: string, deadline: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].deadline = deadline || undefined;
        handleUpdate(newConfig);
    };

    const handleUpdateKeywords = (companyName: string, keywords: string[]) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].keywords = keywords.length > 0 ? keywords : undefined;
        handleUpdate(newConfig);
    };

    const handleUpdateOrderFormHeaders = (companyName: string, headers: string[], fieldMap?: string[]) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].orderFormHeaders = headers.length > 0 ? headers : undefined;
        if (headers.length === 0) {
            newConfig[companyName].orderFormFieldMap = undefined;
        } else if (fieldMap) {
            newConfig[companyName].orderFormFieldMap = fieldMap;
        }
        handleUpdate(newConfig);
    };

    const handleUpdateOrderFormFieldMap = (companyName: string, fieldMap: string[]) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].orderFormFieldMap = fieldMap.length > 0 ? fieldMap : undefined;
        handleUpdate(newConfig);
    };

    const handleUpdateOrderFormFixedValue = (companyName: string, idx: number, value: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        const current: Record<string, string> = { ...(newConfig[companyName].orderFormFixedValues || {}) };
        if (value === '') {
            delete current[String(idx)];
        } else {
            current[String(idx)] = value;
        }
        newConfig[companyName].orderFormFixedValues = Object.keys(current).length > 0 ? current : undefined;
        handleUpdate(newConfig);
    };

    const handleUpdateVendorInvoiceHeaders = (companyName: string, headers: string[], fieldMap?: string[]) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].vendorInvoiceHeaders = headers.length > 0 ? headers : undefined;
        if (headers.length === 0) {
            newConfig[companyName].vendorInvoiceFieldMap = undefined;
        } else if (fieldMap) {
            newConfig[companyName].vendorInvoiceFieldMap = fieldMap;
        }
        handleUpdate(newConfig);
    };

    const handleUpdateVendorInvoiceFieldMap = (companyName: string, fieldMap: string[]) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].vendorInvoiceFieldMap = fieldMap.length > 0 ? fieldMap : undefined;
        handleUpdate(newConfig);
    };

    const handleUpdateVendorInvoiceMatchKey = (companyName: string, matchKey: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newConfig[companyName].vendorInvoiceMatchKey = matchKey === 'orderNumber' ? undefined : matchKey;
        handleUpdate(newConfig);
    };

    const handleBulkAddProducts = (companyName: string, newProducts: ProductPricing[]) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        newProducts.forEach(product => {
            let productKey = product.displayName;
            if (newConfig[companyName].products[productKey]) {
                let idx = 2;
                while (newConfig[companyName].products[`${product.displayName}_${idx}`]) idx++;
                productKey = `${product.displayName}_${idx}`;
            }
            newConfig[companyName].products[productKey] = stripUndefined(product);
        });
        onConfigChange(newConfig);
    };

    const handleAddProduct = (companyName: string) => {
        setDialog({
            type: 'prompt',
            message: `'${companyName}'에 추가할 품목 이름을 지어주세요! ✨`,
            placeholder: '예: 배추김치 5kg',
            onConfirm: (displayName) => {
                if (!displayName) return;
                const newConfig = JSON.parse(JSON.stringify(configRef.current));
                let productKey = displayName;
                // 같은 이름이 있으면 키에 번호를 붙여서 중복 허용
                if (newConfig[companyName].products[productKey]) {
                    let idx = 2;
                    while (newConfig[companyName].products[`${displayName}_${idx}`]) idx++;
                    productKey = `${displayName}_${idx}`;
                }
                newConfig[companyName].products[productKey] = { displayName, supplyPrice: 0 };
                onConfigChange(newConfig);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    const handleDeleteProduct = (companyName: string, productKey: string) => {
        setDialog({
            type: 'confirm',
            message: `'${productKey}' 품목을 삭제할까요? 🧺`,
            onConfirm: () => {
                const newConfig = JSON.parse(JSON.stringify(configRef.current));
                delete newConfig[companyName].products[productKey];
                onConfigChange(newConfig);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    const handleBulkUpdateKeyword = (companyName: string, productKeys: string[], keyword: string) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        productKeys.forEach(key => {
            if (!newConfig[companyName].products[key]) return;
            if (keyword) newConfig[companyName].products[key].siteProductName = keyword;
            else delete newConfig[companyName].products[key].siteProductName;
        });
        handleUpdate(newConfig);
    };

    const handleUpdateProduct = (companyName: string, productKey: string, newProduct: ProductPricing) => {
        const newConfig = JSON.parse(JSON.stringify(configRef.current));
        const cleanProduct = stripUndefined(newProduct);
        console.log('[품목 저장] splitMode:', cleanProduct.splitMode, '| orderSplitCount:', cleanProduct.orderSplitCount);
        const newProductKey = cleanProduct.displayName;
        if (productKey === newProductKey || productKey.startsWith(newProductKey + '_')) {
            // 키가 같거나 기존 번호 붙은 키면 그대로 유지
            newConfig[companyName].products[productKey] = cleanProduct;
        } else {
            delete newConfig[companyName].products[productKey];
            let finalKey = newProductKey;
            if (newConfig[companyName].products[finalKey]) {
                let idx = 2;
                while (newConfig[companyName].products[`${newProductKey}_${idx}`]) idx++;
                finalKey = `${newProductKey}_${idx}`;
            }
            newConfig[companyName].products[finalKey] = cleanProduct;
        }
        handleUpdate(newConfig);
        setDialog(null);
    };

    const toggleCompany = (companyName: string) => setExpandedCompanies(prev => ({ ...prev, [companyName]: !prev[companyName] }));
    const expandAll = () => setExpandedCompanies(Object.keys(config).reduce((acc, key) => ({ ...acc, [key]: true }), {}));
    const collapseAll = () => setExpandedCompanies(Object.keys(config).reduce((acc, key) => ({ ...acc, [key]: false }), {}));

    const handleSavePlatform = (platformConfig: PlatformConfig) => {
        const newConfigs = { ...platformConfigs, [platformConfig.name]: platformConfig };
        // 편집 시 이름이 바뀌었으면 이전 키 삭제
        if (platformDialog?.editing && platformDialog.editing !== platformConfig.name) {
            delete newConfigs[platformDialog.editing];
        }
        onPlatformConfigsChange?.(newConfigs);
        setPlatformDialog(null);
    };

    const handleDeletePlatform = (platformName: string) => {
        setDialog({
            type: 'confirm',
            message: `'${platformName}' 플랫폼 설정을 삭제할까요?`,
            onConfirm: () => {
                const newConfigs = { ...platformConfigs };
                delete newConfigs[platformName];
                onPlatformConfigsChange?.(newConfigs);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    return (
        <div className="space-y-8 pb-16">
            {/* ===== 플랫폼 관리 섹션 ===== */}
            <div className="bg-zinc-900 rounded-[2.5rem] shadow-2xl border border-zinc-800 overflow-hidden">
                <div
                    className="flex justify-between items-center p-6 cursor-pointer hover:bg-zinc-800/40 transition-all"
                    onClick={() => setIsPlatformExpanded(!isPlatformExpanded)}
                >
                    <h3 className="font-black text-xl text-indigo-400 flex items-center gap-4">
                        <span className="bg-zinc-950 p-3 rounded-full shadow-inner border border-zinc-800 text-base">🌐</span>
                        플랫폼 관리
                        <span className="text-sm text-zinc-600 font-bold">{Object.keys(platformConfigs).length}개</span>
                    </h3>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={(e) => { e.stopPropagation(); setPlatformDialog({ editing: null }); }}
                            className="flex items-center gap-2 bg-indigo-500 text-white font-black py-2 px-5 rounded-xl hover:bg-indigo-600 transition-all shadow-lg text-sm"
                        >
                            <PlusCircleIcon className="w-4 h-4" />
                            <span>플랫폼 추가</span>
                        </button>
                        {isPlatformExpanded ? <ChevronUpIcon className="w-6 h-6 text-zinc-600" /> : <ChevronDownIcon className="w-6 h-6 text-zinc-600" />}
                    </div>
                </div>
                {isPlatformExpanded && Object.keys(platformConfigs).length > 0 && (
                    <div className="px-8 pb-8 space-y-3 animate-fade-in">
                        {(Object.entries(platformConfigs) as [string, PlatformConfig][]).map(([key, pc]) => (
                            <div key={key} className="flex items-center justify-between bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800">
                                <div className="flex items-center gap-4">
                                    <span className="text-base font-black text-white">{pc.name}</span>
                                    <span className="text-[10px] text-zinc-600 font-bold">
                                        헤더: {pc.sampleHeaders?.slice(0, 4).join(', ')}{(pc.sampleHeaders?.length || 0) > 4 ? '...' : ''}
                                    </span>
                                    {pc.invoiceColumns && (
                                        <span className="text-[10px] text-indigo-400 font-bold bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">송장 설정됨</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={() => setPlatformDialog({ editing: key })}
                                        className="text-indigo-400 hover:text-indigo-300 font-black text-[11px] underline underline-offset-2"
                                    >
                                        편집
                                    </button>
                                    <button
                                        onClick={() => handleDeletePlatform(key)}
                                        className="text-zinc-700 hover:text-red-500 transition-colors"
                                    >
                                        <TrashIcon className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {isPlatformExpanded && Object.keys(platformConfigs).length === 0 && (
                    <div className="px-8 pb-8 animate-fade-in">
                        <div className="text-center py-8 bg-zinc-950 border border-dashed border-zinc-800 rounded-2xl">
                            <p className="text-sm font-bold text-zinc-600">등록된 플랫폼이 없습니다</p>
                            <p className="text-[11px] text-zinc-700 mt-1">쿠팡 외 플랫폼(지마켓, 스마트스토어, 톡딜 등)을 추가해보세요</p>
                        </div>
                    </div>
                )}
            </div>

            <div className="bg-zinc-900/50 p-5 rounded-full flex flex-wrap items-center justify-between gap-6 border border-zinc-800 shadow-2xl backdrop-blur-sm">
                <div className="flex gap-3">
                    <button onClick={expandAll} className="p-4 bg-zinc-800 hover:bg-zinc-700 rounded-full text-rose-400 transition-all shadow-lg border border-zinc-700"><ArrowsPointingOutIcon className="w-5 h-5" /></button>
                    <button onClick={collapseAll} className="p-4 bg-zinc-800 hover:bg-zinc-700 rounded-full text-rose-400 transition-all shadow-lg border border-zinc-700"><ArrowsPointingInIcon className="w-5 h-5" /></button>
                </div>
                <button onClick={handleAddCompany} className="flex items-center gap-3 bg-rose-500 text-white font-black py-3.5 px-10 rounded-xl hover:bg-rose-600 transition-all shadow-xl shadow-rose-900/30 text-sm">
                    <PlusCircleIcon className="w-6 h-6" /><span>새 그룹</span>
                </button>
            </div>

            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-4 px-2 text-sm font-black text-zinc-500">
                    <span>그룹 <span className="text-rose-500">{Object.keys(config).length}</span>개</span>
                    <span className="text-zinc-800">|</span>
                    <span>품목 <span className="text-rose-500">{Object.values(config).reduce((sum: number, c: CompanyConfig) => sum + Object.keys(c.products).length, 0)}</span>건</span>
                </div>
                {Object.keys(config).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-2">
                        {Object.keys(config).sort((a, b) => a.localeCompare(b, 'ko')).map(name => (
                            <button
                                key={name}
                                onClick={() => {
                                    const el = document.getElementById(`company-card-${name}`);
                                    if (el) {
                                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                        if (!expandedCompanies[name]) setExpandedCompanies(prev => ({ ...prev, [name]: true }));
                                    }
                                }}
                                className="px-3 py-1 text-[11px] font-black rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-rose-400 hover:border-rose-500/30 transition-all"
                            >
                                {name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {Object.keys(config).length === 0 ? (
                <div className="text-center py-24 bg-zinc-900/20 border-2 border-dashed border-zinc-800 rounded-[3rem]">
                    <div className="bg-zinc-800 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-8 shadow-inner border border-zinc-700">
                        <BuildingStorefrontIcon className="w-12 h-12 text-zinc-700" />
                    </div>
                    <p className="text-2xl font-black text-zinc-600">등록된 그룹 업체가 없습니다 🥺</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-8">
                    {Object.entries(config).sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([companyName, companyConfig]) => (
                        <CompanyCard
                            key={companyName}
                            companyName={companyName}
                            companyConfig={companyConfig}
                            isExpanded={expandedCompanies[companyName] ?? true}
                            onToggle={() => toggleCompany(companyName)}
                            onDeleteCompany={() => handleDeleteCompany(companyName)}
                            onUpdateCompanyName={(newName) => handleUpdateCompanyName(companyName, newName)}
                            onUpdatePhone={(phone) => handleUpdatePhone(companyName, phone)}
                            onUpdateBank={(bank) => handleUpdateBank(companyName, bank)}
                            onUpdateAccount={(account) => handleUpdateAccount(companyName, account)}
                            onUpdateCourier={(courier) => handleUpdateCourier(companyName, courier)}
                            onUpdateDeadline={(deadline) => handleUpdateDeadline(companyName, deadline)}
                            onUpdateAutoConsolidate={(enabled) => handleUpdateAutoConsolidate(companyName, enabled)}
                            onUpdateKeywords={(keywords) => handleUpdateKeywords(companyName, keywords)}
                            onUpdateOrderFormHeaders={(headers, fieldMap) => handleUpdateOrderFormHeaders(companyName, headers, fieldMap)}
                            onUpdateOrderFormFieldMap={(fieldMap) => handleUpdateOrderFormFieldMap(companyName, fieldMap)}
                            onUpdateOrderFormFixedValue={(idx, value) => handleUpdateOrderFormFixedValue(companyName, idx, value)}
                            onUpdateVendorInvoiceHeaders={(headers, fieldMap) => handleUpdateVendorInvoiceHeaders(companyName, headers, fieldMap)}
                            onUpdateVendorInvoiceFieldMap={(fieldMap) => handleUpdateVendorInvoiceFieldMap(companyName, fieldMap)}
                            onUpdateVendorInvoiceMatchKey={(matchKey) => handleUpdateVendorInvoiceMatchKey(companyName, matchKey)}
                            onAddProduct={() => handleAddProduct(companyName)}
                            onBulkAddProducts={(products) => handleBulkAddProducts(companyName, products)}
                            onDeleteProduct={(productKey) => handleDeleteProduct(companyName, productKey)}
                            onOpenProductEditor={(productKey, product) => setDialog({
                                type: 'productEditor',
                                message: '품목 정보 수정 ✍️',
                                companyName,
                                productKey,
                                product: { ...product },
                                onConfirm: (originalProductKey, newProduct) => {
                                    handleUpdateProduct(companyName, originalProductKey, newProduct);
                                },
                                onCancel: () => setDialog(null)
                            })}
                            onBulkUpdateKeyword={(productKeys, keyword) => handleBulkUpdateKeyword(companyName, productKeys, keyword)}
                            onUpdateProduct={(productKey, product) => handleUpdateProduct(companyName, productKey, product)}
                        />
                    ))}
                </div>
            )}

            {dialog && <Dialog dialog={dialog} setDialog={setDialog} />}
            {platformDialog && (
                <PlatformConfigDialog
                    initial={platformDialog.editing ? platformConfigs[platformDialog.editing] : null}
                    onSave={handleSavePlatform}
                    onCancel={() => setPlatformDialog(null)}
                />
            )}

            {/* 맨 위로 가기 버튼 */}
            <button
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                className="fixed bottom-8 right-8 p-4 bg-rose-500 hover:bg-rose-600 text-white rounded-full shadow-2xl transition-all hover:scale-110 z-50 border-2 border-rose-400/30"
                aria-label="맨 위로"
            >
                <ChevronUpIcon className="w-6 h-6" />
            </button>
        </div>
    );
};

const CompanyCard: React.FC<{
    companyName: string;
    companyConfig: CompanyConfig;
    isExpanded: boolean;
    onToggle: () => void;
    onDeleteCompany: () => void;
    onUpdateCompanyName: (newName: string) => void;
    onUpdatePhone: (phone: string) => void;
    onUpdateBank: (bank: string) => void;
    onUpdateAccount: (account: string) => void;
    onUpdateCourier: (courier: string) => void;
    onUpdateDeadline: (deadline: string) => void;
    onUpdateAutoConsolidate: (enabled: boolean) => void;
    onUpdateKeywords: (keywords: string[]) => void;
    onUpdateOrderFormHeaders: (headers: string[], fieldMap?: string[]) => void;
    onUpdateOrderFormFieldMap: (fieldMap: string[]) => void;
    onUpdateOrderFormFixedValue: (idx: number, value: string) => void;
    onUpdateVendorInvoiceHeaders: (headers: string[], fieldMap?: string[]) => void;
    onUpdateVendorInvoiceFieldMap: (fieldMap: string[]) => void;
    onUpdateVendorInvoiceMatchKey: (matchKey: string) => void;
    onAddProduct: () => void;
    onBulkAddProducts: (products: ProductPricing[]) => void;
    onDeleteProduct: (productKey: string) => void;
    onOpenProductEditor: (productKey: string, product: ProductPricing) => void;
    onBulkUpdateKeyword: (productKeys: string[], keyword: string) => void;
    onUpdateProduct: (productKey: string, product: ProductPricing) => void;
}> = React.memo(({ companyName, companyConfig, isExpanded, onToggle, ...props }) => {
    return (
        <div id={`company-card-${companyName}`} className="bg-zinc-900 rounded-[2.5rem] shadow-2xl border border-zinc-800 overflow-hidden group scroll-mt-4">
            <div className="flex items-center p-8 cursor-pointer hover:bg-zinc-800/40 transition-all" onClick={onToggle}>
                <div className="flex-grow flex items-center gap-6">
                    <div className="bg-zinc-950 p-4 rounded-2xl shadow-inner border border-zinc-800 group-hover:scale-110 transition-transform">
                        <BuildingStorefrontIcon className="w-8 h-8 text-rose-500" />
                    </div>
                    <div className="flex flex-col">
                        <EditableField
                            value={companyName}
                            onSave={props.onUpdateCompanyName}
                            className="text-2xl font-black text-white bg-transparent border-none focus:ring-2 focus:ring-rose-500/20 rounded-lg px-2"
                        />
                        <span className="text-zinc-500 font-black text-[10px] px-2 tracking-tight uppercase">Settings</span>
                    </div>
                </div>
                <div className="flex items-center gap-5">
                    <button onClick={(e) => { e.stopPropagation(); props.onDeleteCompany(); }} className="p-3 text-zinc-700 hover:text-red-500 hover:bg-zinc-800 rounded-full transition-all"><TrashIcon className="w-6 h-6" /></button>
                    <div className={`p-1.5 text-zinc-700 transition-transform duration-500 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}><ChevronDownIcon className="w-8 h-8" /></div>
                </div>
            </div>
            {isExpanded && (
                <div className="p-8 pt-0 space-y-8 animate-fade-in bg-gradient-to-b from-transparent to-rose-950/5">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="flex items-center gap-3 bg-zinc-950 px-4 py-3 rounded-xl border border-zinc-800 shadow-inner">
                            <PhoneIcon className="w-4 h-4 text-zinc-600 shrink-0" />
                            <EditableField
                                value={companyConfig.phone || ''}
                                onSave={props.onUpdatePhone}
                                placeholder="연락처"
                                className="text-sm font-bold text-zinc-400 focus:outline-none w-full"
                            />
                        </div>
                        <div className="flex items-center gap-3 bg-zinc-950 px-4 py-3 rounded-xl border border-zinc-800 shadow-inner">
                            <span className="text-sm shrink-0">🏦</span>
                            <EditableField
                                value={companyConfig.bankName || ''}
                                onSave={props.onUpdateBank}
                                placeholder="은행명"
                                className="text-sm font-bold text-zinc-400 focus:outline-none w-full"
                            />
                        </div>
                        <div className="flex items-center gap-3 bg-zinc-950 px-4 py-3 rounded-xl border border-zinc-800 shadow-inner col-span-2 md:col-span-2">
                            <span className="text-sm shrink-0">💳</span>
                            <EditableField
                                value={companyConfig.accountNumber || ''}
                                onSave={props.onUpdateAccount}
                                placeholder="계좌번호"
                                className="text-sm font-bold text-zinc-400 focus:outline-none w-full"
                            />
                        </div>
                        <div className="flex items-center gap-3 bg-zinc-950 px-4 py-3 rounded-xl border border-rose-500/30 shadow-inner">
                            <span className="text-sm shrink-0">⏰</span>
                            <EditableField
                                value={companyConfig.deadline || ''}
                                onSave={props.onUpdateDeadline}
                                placeholder="마감 (예: 09:00)"
                                className="text-sm font-bold text-rose-400 focus:outline-none w-full"
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-4 bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                        <span className="text-lg">📦</span>
                        <EditableField
                            value={companyConfig.courierName || ''}
                            onSave={props.onUpdateCourier}
                            placeholder="택배사명 (예: 롯데택배, CJ대한통운, 우체국)"
                            className="text-sm font-bold text-zinc-400 focus:outline-none"
                        />
                    </div>
                    <div className="flex items-center gap-4 bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                        <label className="flex items-center gap-3 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={companyConfig.autoConsolidate ?? false}
                                onChange={(e) => props.onUpdateAutoConsolidate(e.target.checked)}
                                className="w-4 h-4 rounded border-zinc-700 bg-zinc-950 text-rose-500 focus:ring-rose-500/20"
                            />
                            <span className="text-sm font-bold text-zinc-400">주문 자동 합산</span>
                        </label>
                        <p className="text-[13px] text-zinc-400 leading-relaxed mt-1">
                            고객이 같은 단위를 여러개 샀을 경우 하나로 합산해서 묶음배송<br/>
                            ex) 1kg 4개 구매 → 4kg 1개로 합산
                        </p>
                    </div>
                    <div className="bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                        <div className="flex items-center gap-3 mb-2">
                            <span className="text-[12px] font-black text-zinc-500 uppercase tracking-wide">매칭 키워드</span>
                            <span className="text-[10px] text-zinc-700">(엑셀 그룹컬럼 매칭용, 쉼표로 구분)</span>
                        </div>
                        <EditableField
                            value={(companyConfig.keywords || []).join(', ')}
                            onSave={(val) => {
                                const keywords = val.split(',').map(s => s.trim()).filter(Boolean);
                                props.onUpdateKeywords(keywords);
                            }}
                            placeholder="예: 총각김치, 포기김치, 배추김치"
                            className="text-sm font-bold text-zinc-400 focus:outline-none w-full"
                        />
                    </div>
                    <div className="bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                        <div className="flex items-center gap-3 mb-3">
                            <span className="text-lg">📋</span>
                            <span className="text-[12px] font-black text-zinc-500 uppercase tracking-wide">발주서 양식</span>
                            <div className="ml-auto flex items-center gap-2">
                                {companyConfig.orderFormHeaders && companyConfig.orderFormHeaders.length > 0 && (
                                    <button
                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black border border-zinc-700 text-zinc-500 hover:border-red-500/40 hover:text-red-400 transition-all"
                                        onClick={() => {
                                            props.onUpdateOrderFormHeaders([], []);
                                        }}
                                    >
                                        <TrashIcon className="w-3 h-3" />
                                        <span>초기화</span>
                                    </button>
                                )}
                                <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-lg text-[10px] font-black border border-zinc-700 text-zinc-500 hover:border-amber-500/40 hover:text-amber-400 transition-all">
                                    <DocumentArrowUpIcon className="w-3.5 h-3.5" />
                                    <span>파일에서 읽기</span>
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (!file) return;
                                        const reader = new FileReader();
                                        reader.onload = (ev) => {
                                            try {
                                                const data = new Uint8Array(ev.target?.result as ArrayBuffer);
                                                const wb = XLSX.read(data, { type: 'array' });
                                                const ws = wb.Sheets[wb.SheetNames[0]];
                                                const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
                                                if (aoa.length > 0) {
                                                    let headerRowIdx = -1;
                                                    for (let ri = 0; ri < Math.min(aoa.length, 20); ri++) {
                                                        const rowStr = (aoa[ri] || []).join('');
                                                        if (rowStr.includes('받는사람') || rowStr.includes('수취인') || rowStr.includes('수령인') ||
                                                            rowStr.includes('품목') || rowStr.includes('상품') || rowStr.includes('주소') ||
                                                            rowStr.includes('수량') || rowStr.includes('전화') || rowStr.includes('연락처') ||
                                                            rowStr.includes('주문') || rowStr.includes('번호')) {
                                                            headerRowIdx = ri;
                                                            break;
                                                        }
                                                    }
                                                    if (headerRowIdx === -1) {
                                                        let maxCols = 0;
                                                        for (let ri = 0; ri < Math.min(aoa.length, 20); ri++) {
                                                            const nonEmpty = (aoa[ri] || []).filter((c: any) => c != null && String(c).trim() !== '').length;
                                                            if (nonEmpty > maxCols) { maxCols = nonEmpty; headerRowIdx = ri; }
                                                        }
                                                        if (headerRowIdx === -1) headerRowIdx = 0;
                                                    }
                                                    const headers = (aoa[headerRowIdx] || []).map((h: any) => String(h || '').trim()).filter(Boolean);
                                                    if (headers.length > 0) {
                                                        const fieldMap = headers.map((h: string) => inferFieldFromHeader(h));
                                                        props.onUpdateOrderFormHeaders(headers, fieldMap);
                                                    }
                                                }
                                            } catch (err) { console.error('[발주서양식 업로드 오류]', err); }
                                        };
                                        reader.readAsArrayBuffer(file);
                                        e.target.value = '';
                                    }} />
                                </label>
                            </div>
                        </div>
                        {companyConfig.orderFormHeaders && companyConfig.orderFormHeaders.length > 0 ? (
                            <div className="space-y-1.5">
                                {companyConfig.orderFormHeaders.map((header, idx) => {
                                    const currentField = companyConfig.orderFormFieldMap?.[idx] || inferFieldFromHeader(header);
                                    const fixedValue = companyConfig.orderFormFixedValues?.[String(idx)] || '';
                                    const hasFixed = fixedValue !== '';
                                    return (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold text-zinc-600 w-5 text-right shrink-0">{idx + 1}</span>
                                            <select
                                                className={`w-32 shrink-0 bg-zinc-900 border rounded-lg px-2 py-1.5 text-[11px] outline-none focus:border-amber-500/40 transition-colors ${hasFixed ? 'border-zinc-800 text-zinc-600 line-through' : 'border-zinc-700 text-white'}`}
                                                value={currentField}
                                                disabled={hasFixed}
                                                title={hasFixed ? '고정값이 설정되어 있어 필드 매핑이 무시됩니다' : ''}
                                                onChange={(e) => {
                                                    const newFieldMap = [...(companyConfig.orderFormFieldMap || companyConfig.orderFormHeaders!.map(h => inferFieldFromHeader(h)))];
                                                    newFieldMap[idx] = e.target.value;
                                                    // 필드 변경 시 헤더명이 기본값이면 같이 변경 (단일 호출로 처리)
                                                    const selectedType = ORDER_FORM_FIELD_TYPES.find(ft => ft.key === e.target.value);
                                                    const oldType = ORDER_FORM_FIELD_TYPES.find(ft => ft.key === currentField);
                                                    if (selectedType && oldType && header === oldType.label) {
                                                        const newHeaders = [...companyConfig.orderFormHeaders!];
                                                        newHeaders[idx] = selectedType.label;
                                                        props.onUpdateOrderFormHeaders(newHeaders, newFieldMap);
                                                    } else {
                                                        props.onUpdateOrderFormFieldMap(newFieldMap);
                                                    }
                                                }}
                                            >
                                                {ORDER_FORM_FIELD_TYPES.map(ft => (
                                                    <option key={ft.key} value={ft.key}>{ft.label}</option>
                                                ))}
                                            </select>
                                            <span className="text-zinc-600 text-[10px]">&rarr;</span>
                                            <input
                                                type="text"
                                                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-300 outline-none focus:border-amber-500/40 transition-colors"
                                                value={header}
                                                placeholder="헤더명"
                                                onChange={(e) => {
                                                    const newHeaders = [...companyConfig.orderFormHeaders!];
                                                    newHeaders[idx] = e.target.value;
                                                    props.onUpdateOrderFormHeaders(newHeaders);
                                                }}
                                            />
                                            <input
                                                type="text"
                                                className={`w-28 shrink-0 bg-zinc-900 border rounded-lg px-2 py-1.5 text-[11px] outline-none transition-colors ${hasFixed ? 'border-amber-500/60 text-amber-300 focus:border-amber-400' : 'border-zinc-800 text-zinc-400 focus:border-amber-500/40'}`}
                                                value={fixedValue}
                                                placeholder="고정값"
                                                title="값을 입력하면 필드 매핑을 무시하고 이 값이 항상 출력됩니다"
                                                onChange={(e) => props.onUpdateOrderFormFixedValue(idx, e.target.value)}
                                            />
                                            <button
                                                className="p-1 text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                                                onClick={() => {
                                                    const newHeaders = companyConfig.orderFormHeaders!.filter((_, i) => i !== idx);
                                                    const newFieldMap = (companyConfig.orderFormFieldMap || companyConfig.orderFormHeaders!.map(h => inferFieldFromHeader(h))).filter((_, i) => i !== idx);
                                                    props.onUpdateOrderFormHeaders(newHeaders, newFieldMap);
                                                }}
                                            >
                                                <TrashIcon className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="text-[11px] text-zinc-600 py-2">기본 양식 사용 중. 파일 업로드 또는 아래 버튼으로 열을 추가하세요.</p>
                        )}
                        <button
                            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black border border-dashed border-zinc-700 text-zinc-500 hover:border-amber-500/40 hover:text-amber-400 transition-all w-full justify-center"
                            onClick={() => {
                                const defaultField = 'empty';
                                const defaultLabel = ORDER_FORM_FIELD_TYPES.find(ft => ft.key === defaultField)!.label;
                                const newHeaders = [...(companyConfig.orderFormHeaders || []), defaultLabel];
                                const newFieldMap = [...(companyConfig.orderFormFieldMap || (companyConfig.orderFormHeaders || []).map(h => inferFieldFromHeader(h))), defaultField];
                                props.onUpdateOrderFormHeaders(newHeaders, newFieldMap);
                            }}
                        >
                            <PlusCircleIcon className="w-3.5 h-3.5" />
                            <span>열 추가</span>
                        </button>
                    </div>
                    <div className="bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                        <div className="flex items-center gap-3 mb-2">
                            <span className="text-lg">📄</span>
                            <span className="text-[12px] font-black text-zinc-500 uppercase tracking-wide">송장파일 양식</span>
                            <label className="ml-auto flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-lg text-[10px] font-black border border-zinc-700 text-zinc-500 hover:border-amber-500/40 hover:text-amber-400 transition-all">
                                <DocumentArrowUpIcon className="w-3.5 h-3.5" />
                                <span>양식 파일에서 읽기</span>
                                <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => {
                                    console.log('[송장양식] onChange 실행됨');
                                    const file = e.target.files?.[0];
                                    if (!file) { console.log('[송장양식] 파일 없음'); return; }
                                    console.log('[송장양식] 파일 선택:', file.name);
                                    const reader = new FileReader();
                                    reader.onload = (ev) => {
                                        try {
                                            const data = new Uint8Array(ev.target?.result as ArrayBuffer);
                                            const wb = XLSX.read(data, { type: 'array' });
                                            const ws = wb.Sheets[wb.SheetNames[0]];
                                            const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
                                            console.log('[송장양식] 파싱 완료, 행 수:', aoa.length);
                                            if (aoa.length > 0) {
                                                console.log('[송장양식] 첫 5행:', aoa.slice(0, 5));
                                                // 헤더 행 자동 탐색: 첫 20행 중 키워드 포함 행 찾기
                                                let headerRowIdx = -1;
                                                for (let ri = 0; ri < Math.min(aoa.length, 20); ri++) {
                                                    const rowStr = (aoa[ri] || []).join('');
                                                    if (rowStr.includes('번호') || rowStr.includes('송장') || rowStr.includes('운송장') || rowStr.includes('접수') || rowStr.includes('주문')) {
                                                        headerRowIdx = ri;
                                                        break;
                                                    }
                                                }
                                                // 키워드 못 찾으면 비어있지 않은 셀이 가장 많은 행을 헤더로 사용
                                                if (headerRowIdx === -1) {
                                                    let maxCols = 0;
                                                    for (let ri = 0; ri < Math.min(aoa.length, 20); ri++) {
                                                        const nonEmpty = (aoa[ri] || []).filter((c: any) => c != null && String(c).trim() !== '').length;
                                                        if (nonEmpty > maxCols) { maxCols = nonEmpty; headerRowIdx = ri; }
                                                    }
                                                    if (headerRowIdx === -1) headerRowIdx = 0;
                                                }
                                                const headers = (aoa[headerRowIdx] || []).map((h: any) => String(h || '').trim()).filter(Boolean);
                                                console.log('[송장양식] headerRowIdx:', headerRowIdx, '헤더:', headers);
                                                if (headers.length > 0) {
                                                    const fieldMap = headers.map((h: string) => inferVendorInvoiceField(h));
                                                    props.onUpdateVendorInvoiceHeaders(headers, fieldMap);
                                                    console.log('[송장양식] 저장 완료, fieldMap:', fieldMap);
                                                } else {
                                                    console.log('[송장양식] 헤더가 비어있음');
                                                }
                                            }
                                        } catch (err) { console.error('[송장양식 업로드 오류]', err); }
                                    };
                                    reader.readAsArrayBuffer(file);
                                    e.target.value = '';
                                }} />
                            </label>
                        </div>
                        <EditableField
                            value={(companyConfig.vendorInvoiceHeaders || []).join(', ')}
                            onSave={(val) => {
                                const headers = val.split(/[,\t]+/).map(s => s.trim()).filter(Boolean);
                                const existingMap = companyConfig.vendorInvoiceFieldMap || [];
                                const fieldMap = headers.length > 0 ? headers.map((h, i) => existingMap[i] || inferVendorInvoiceField(h)) : undefined;
                                props.onUpdateVendorInvoiceHeaders(headers, fieldMap);
                            }}
                            placeholder="업체에서 보내주는 송장파일의 헤더 (비워두면 자동 감지)"
                            className="text-sm font-bold text-zinc-400 focus:outline-none w-full"
                        />
                        <p className="text-[10px] text-zinc-600 mt-1">업체 송장파일의 컬럼 양식. 비워두면 자동 감지. 양식 파일 업로드 또는 쉼표로 구분하여 입력</p>
                        {companyConfig.vendorInvoiceHeaders && companyConfig.vendorInvoiceHeaders.length > 0 && (
                            <div className="mt-3 space-y-1">
                                <span className="text-[11px] font-black text-amber-500/80 uppercase">필드 매핑</span>
                                {companyConfig.vendorInvoiceHeaders.map((header, idx) => {
                                    const currentField = companyConfig.vendorInvoiceFieldMap?.[idx] || inferVendorInvoiceField(header);
                                    return (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="text-[11px] font-bold text-zinc-500 w-36 truncate shrink-0" title={header}>
                                                {header}
                                            </span>
                                            <span className="text-zinc-600 text-[10px]">&rarr;</span>
                                            <select
                                                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-white outline-none focus:border-amber-500/40 transition-colors"
                                                value={currentField}
                                                onChange={(e) => {
                                                    const newMap = [...(companyConfig.vendorInvoiceFieldMap || companyConfig.vendorInvoiceHeaders!.map(h => inferVendorInvoiceField(h)))];
                                                    newMap[idx] = e.target.value;
                                                    props.onUpdateVendorInvoiceFieldMap(newMap);
                                                }}
                                            >
                                                {VENDOR_INVOICE_FIELD_TYPES.map(ft => (
                                                    <option key={ft.key} value={ft.key}>{ft.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    );
                                })}
                                {(() => {
                                    const headers = companyConfig.vendorInvoiceHeaders!;
                                    const fieldMap = companyConfig.vendorInvoiceFieldMap || headers.map(h => inferVendorInvoiceField(h));
                                    // 송장번호로 매핑된 열은 매칭 기준 후보에서 제외
                                    const candidateHeaders = headers.filter((_, i) => fieldMap[i] !== 'trackingNumber');
                                    if (candidateHeaders.length === 0) return null;
                                    const currentMatchHeaders = (companyConfig.vendorInvoiceMatchKey || '').split('|').filter(Boolean);
                                    return (
                                        <div className="mt-3">
                                            <span className="text-[11px] font-black text-amber-500/80 uppercase">매칭 기준</span>
                                            <p className="text-[10px] text-zinc-600 mb-1">업체 송장파일의 어떤 열로 주문서와 매칭할지 선택 (복수 선택 가능)</p>
                                            <div className="flex flex-wrap gap-1.5 mt-1">
                                                {candidateHeaders.map(header => {
                                                    const isChecked = currentMatchHeaders.includes(header);
                                                    return (
                                                        <label key={header} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer border transition-all ${isChecked ? 'border-amber-500/60 bg-amber-500/10 text-amber-400' : 'border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>
                                                            <input
                                                                type="checkbox"
                                                                className="sr-only"
                                                                checked={isChecked}
                                                                onChange={() => {
                                                                    let newKeys: string[];
                                                                    if (isChecked) {
                                                                        newKeys = currentMatchHeaders.filter(k => k !== header);
                                                                    } else {
                                                                        newKeys = [...currentMatchHeaders, header];
                                                                    }
                                                                    props.onUpdateVendorInvoiceMatchKey(newKeys.length > 0 ? newKeys.join('|') : '');
                                                                }}
                                                            />
                                                            <span className={`w-3 h-3 rounded border flex items-center justify-center ${isChecked ? 'border-amber-500 bg-amber-500' : 'border-zinc-600'}`}>
                                                                {isChecked && <span className="text-black text-[8px] font-black">✓</span>}
                                                            </span>
                                                            {header}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        )}
                    </div>
                    <ProductTable products={companyConfig.products} onAddProduct={props.onAddProduct} onBulkAddProducts={props.onBulkAddProducts} onDeleteProduct={props.onDeleteProduct} onOpenProductEditor={props.onOpenProductEditor} onBulkUpdateKeyword={props.onBulkUpdateKeyword} onUpdateProduct={props.onUpdateProduct} />
                </div>
            )}
        </div>
    );
});

const ProductRow: React.FC<{
    productKey: string;
    product: ProductPricing;
    isSelected: boolean;
    onToggleSelect: (e: React.MouseEvent) => void;
    onUpdate: (key: string, updated: ProductPricing) => void;
    onDelete: () => void;
}> = React.memo(({ productKey, product, isSelected, onToggleSelect, onUpdate, onDelete }) => {
    const [editField, setEditField] = useState<string | null>(null);
    const [editVal, setEditVal] = useState('');
    const [expanded, setExpanded] = useState(false);

    const startEdit = (field: string, raw: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditField(field);
        setEditVal(raw);
    };

    const commit = (field: string) => {
        const updated = { ...product };
        switch (field) {
            case 'displayName': updated.displayName = editVal.trim() || updated.displayName; break;
            case 'supplyPrice': updated.supplyPrice = Number(editVal.replace(/[,\s]/g, '')) || 0; break;
            case 'sellingPrice': { const v = Number(editVal.replace(/[,\s]/g, '')); updated.sellingPrice = v || undefined; break; }
            case 'margin': { const v = Number(editVal.replace(/[,\s]/g, '')); updated.margin = v || undefined; break; }
            case 'orderFormName': updated.orderFormName = editVal.trim() || undefined; break;
            case 'siteProductName': updated.siteProductName = editVal.trim() || undefined; break;
            case 'shippingCost': { const v = Number(editVal.replace(/[,\s]/g, '')); updated.shippingCost = v || undefined; break; }
            case 'orderSplitCount': { const v = Number(editVal); updated.orderSplitCount = v > 1 ? v : undefined; break; }
            case 'aliases': { const a = editVal.split(',').map(s => s.trim()).filter(Boolean); updated.aliases = a.length > 0 ? a : undefined; break; }
        }
        setEditField(null);
        onUpdate(productKey, updated);
    };

    const inputClass = 'w-full bg-zinc-800 border border-indigo-500/50 rounded px-2 py-0.5 text-[12px] text-white outline-none focus:border-indigo-400';

    const numCell = (field: string, value: number | undefined, textClass: string) => {
        if (editField === field) {
            return (
                <input autoFocus type="text" inputMode="numeric" value={editVal}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => commit(field)}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditField(null); }}
                    className={`${inputClass} text-right font-black`}
                    onClick={e => e.stopPropagation()}
                />
            );
        }
        return (
            <span onClick={(e) => startEdit(field, value !== undefined ? String(value) : '', e)}
                className={`cursor-text hover:opacity-70 transition-opacity ${textClass} ${!value ? 'text-zinc-600' : ''}`}>
                {value ? value.toLocaleString() : '—'}
            </span>
        );
    };

    const margin = product.margin || 0;

    const extraFields = [
        { field: 'orderFormName', label: '발주서용 품목명', value: product.orderFormName || '' },
        { field: 'siteProductName', label: '품목 키워드', value: product.siteProductName || '' },
        { field: 'shippingCost', label: '배송비', value: product.shippingCost ? String(product.shippingCost) : '' },
        { field: 'orderSplitCount', label: '수량 변환', value: product.orderSplitCount ? String(product.orderSplitCount) : '' },
        { field: 'aliases', label: '매칭 키워드', value: (product.aliases || []).join(', '), wide: true },
    ];

    return (
        <>
            <tr className="hover:bg-zinc-900/40 transition-colors group">
                <td className="pl-3 pr-1 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="accent-indigo-500 cursor-pointer"
                        checked={isSelected}
                        onChange={(e) => onToggleSelect(e as unknown as React.MouseEvent)}
                    />
                </td>
                <td className="px-2 py-1.5">
                    {editField === 'displayName' ? (
                        <input autoFocus type="text" value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            onBlur={() => commit('displayName')}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditField(null); }}
                            className={`${inputClass} font-black`}
                            onClick={e => e.stopPropagation()}
                        />
                    ) : (
                        <div className="cursor-text" onClick={(e) => startEdit('displayName', product.displayName, e)}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-black text-zinc-100 text-[13px] hover:opacity-70 transition-opacity">{product.displayName}</span>
                                {product.orderFormName && <span className="text-[9px] text-amber-500 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">{product.orderFormName}</span>}
                                {product.orderSplitCount && product.orderSplitCount > 1 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-violet-400 bg-violet-500/10 border-violet-500/20">x{product.orderSplitCount}</span>}
                                {product.shippingCost && product.shippingCost > 0 && <span className="text-[9px] text-teal-400 font-bold bg-teal-500/10 px-1.5 py-0.5 rounded border border-teal-500/20">+{product.shippingCost.toLocaleString()}</span>}
                                {product.siteProductName && <span className="text-[9px] text-emerald-500 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">🔑 {product.siteProductName}</span>}
                            </div>
                            {product.aliases && product.aliases.length > 0 && <div className="text-[10px] text-zinc-600 truncate max-w-xs mt-0.5">{product.aliases.join(', ')}</div>}
                        </div>
                    )}
                </td>
                <td className="px-3 py-1.5 text-right font-black text-rose-400 text-[13px] whitespace-nowrap">
                    {numCell('supplyPrice', product.supplyPrice, 'font-black text-rose-400 text-[13px]')}
                </td>
                <td className="px-3 py-1.5 text-right font-bold text-zinc-400 text-[13px] whitespace-nowrap">
                    {numCell('sellingPrice', product.sellingPrice, 'font-bold text-zinc-400 text-[13px]')}
                </td>
                <td className={`px-3 py-1.5 text-right font-black text-[13px] whitespace-nowrap`}>
                    {numCell('margin', product.margin, `font-black text-[13px] ${margin > 0 ? 'text-sky-400' : margin < 0 ? 'text-red-400' : 'text-zinc-600'}`)}
                </td>
                <td className="px-2 py-1.5 text-center">
                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={(e) => { e.stopPropagation(); setExpanded(p => !p); }}
                            className={`transition-colors ${expanded ? 'text-indigo-400' : 'text-zinc-600 hover:text-zinc-300'}`}
                            title="추가 설정">
                            <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-zinc-700 hover:text-red-500 transition-colors">
                            <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </td>
            </tr>
            {expanded && (
                <tr className="bg-zinc-900/30">
                    <td colSpan={6} className="px-3 pb-3 pt-1.5">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 pl-7">
                            {extraFields.map(({ field, label, value, wide }) => (
                                <div key={field} className={wide ? 'col-span-2' : ''}>
                                    <label className="text-[9px] font-black text-zinc-600 uppercase tracking-wider block mb-0.5">{label}</label>
                                    {editField === field ? (
                                        <input autoFocus type="text" value={editVal}
                                            onChange={e => setEditVal(e.target.value)}
                                            onBlur={() => commit(field)}
                                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditField(null); }}
                                            className="w-full bg-zinc-900 border border-indigo-500/40 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-400/60"
                                        />
                                    ) : (
                                        <div onClick={(e) => startEdit(field, value, e)}
                                            className="text-xs text-zinc-400 cursor-text hover:text-zinc-200 min-h-[1.5rem] flex items-center transition-colors">
                                            {value || <span className="text-zinc-700 italic">비어있음 — 클릭하여 입력</span>}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
});

const ProductTable: React.FC<{
    products: { [key: string]: ProductPricing };
    onAddProduct: () => void;
    onBulkAddProducts: (products: ProductPricing[]) => void;
    onDeleteProduct: (productKey: string) => void;
    onOpenProductEditor: (productKey: string, product: ProductPricing) => void;
    onBulkUpdateKeyword: (productKeys: string[], keyword: string) => void;
    onUpdateProduct: (productKey: string, product: ProductPricing) => void;
}> = React.memo(({ products, onAddProduct, onBulkAddProducts, onDeleteProduct, onOpenProductEditor: _onOpenProductEditor, onBulkUpdateKeyword, onUpdateProduct }) => {
    const [showPaste, setShowPaste] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [bulkKeyword, setBulkKeyword] = useState('');
    const [pasteText, setPasteText] = useState('');
    const [preview, setPreview] = useState<ProductPricing[] | null>(null);
    const [parseError, setParseError] = useState('');

    const handlePasteChange = (text: string) => {
        setPasteText(text);
        if (!text.trim()) { setPreview(null); setParseError(''); return; }
        const { products: parsed, error } = parsePastedTable(text);
        if (error || !parsed.length) { setParseError(error || '추출된 품목이 없습니다'); setPreview(null); }
        else { setPreview(parsed); setParseError(''); }
    };

    const handleConfirm = () => {
        if (preview?.length) {
            onBulkAddProducts(preview);
            setShowPaste(false); setPasteText(''); setPreview(null); setParseError('');
        }
    };

    const handleCancel = () => { setShowPaste(false); setPasteText(''); setPreview(null); setParseError(''); };

    return (
        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
            <table className="w-full text-sm text-left table-fixed">
                <thead className="bg-zinc-900/50 text-zinc-600 font-black uppercase tracking-widest text-[11px]">
                    <tr>
                        <th className="pl-3 pr-1 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox"
                                className="accent-indigo-500 cursor-pointer"
                                checked={Object.keys(products).length > 0 && Object.keys(products).every(k => selectedKeys.has(k))}
                                onChange={(e) => setSelectedKeys(e.target.checked ? new Set(Object.keys(products)) : new Set())}
                            />
                        </th>
                        <th className="px-2 py-2 w-[33%]">품목</th>
                        <th className="px-3 py-2 text-right w-[17%] whitespace-nowrap">공급가</th>
                        <th className="px-3 py-2 text-right w-[17%] whitespace-nowrap">판매가</th>
                        <th className="px-3 py-2 text-right w-[17%] whitespace-nowrap">마진</th>
                        <th className="px-3 py-2 text-center w-[10%]"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/60">
                    {Object.keys(products).sort((a, b) => products[a].displayName.localeCompare(products[b].displayName, 'ko')).map((productKey) => (
                        <ProductRow
                            key={productKey}
                            productKey={productKey}
                            product={products[productKey]}
                            isSelected={selectedKeys.has(productKey)}
                            onToggleSelect={() => {
                                const next = new Set(selectedKeys);
                                if (next.has(productKey)) next.delete(productKey); else next.add(productKey);
                                setSelectedKeys(next);
                            }}
                            onUpdate={onUpdateProduct}
                            onDelete={() => onDeleteProduct(productKey)}
                        />
                    ))}
                    {selectedKeys.size > 0 && (
                        <tr>
                            <td colSpan={6} className="p-0">
                                <div className="flex items-center gap-2 px-3 py-2 bg-indigo-950/40 border-t border-indigo-500/20">
                                    <span className="text-[11px] font-black text-indigo-400 shrink-0">{selectedKeys.size}개 선택</span>
                                    <input
                                        type="text"
                                        value={bulkKeyword}
                                        onChange={(e) => setBulkKeyword(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' && bulkKeyword.trim()) { onBulkUpdateKeyword([...selectedKeys], bulkKeyword.trim()); setSelectedKeys(new Set()); setBulkKeyword(''); } }}
                                        placeholder="품목 키워드 입력 (K열 매칭)"
                                        className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500/60 min-w-0"
                                    />
                                    <button
                                        onClick={() => { onBulkUpdateKeyword([...selectedKeys], bulkKeyword.trim()); setSelectedKeys(new Set()); setBulkKeyword(''); }}
                                        disabled={!bulkKeyword.trim()}
                                        className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-black rounded-lg disabled:opacity-30 transition-all shrink-0"
                                    >적용</button>
                                    <button
                                        onClick={() => { setSelectedKeys(new Set()); setBulkKeyword(''); }}
                                        className="px-3 py-1.5 bg-zinc-800 text-zinc-400 text-xs font-black rounded-lg hover:bg-zinc-700 transition-all shrink-0"
                                    >취소</button>
                                </div>
                            </td>
                        </tr>
                    )}
                    <tr>
                        <td colSpan={6} className="p-0">
                            <div className="flex divide-x divide-zinc-900/60 border-t border-zinc-900/60">
                                <button onClick={onAddProduct} className="flex-1 flex items-center justify-center gap-2 text-zinc-500 hover:text-rose-400 bg-zinc-900/20 hover:bg-zinc-900/50 transition-all font-black py-2.5 text-sm">
                                    <PlusCircleIcon className="w-5 h-5" />
                                    <span>새 품목 추가</span>
                                </button>
                                <button
                                    onClick={() => { setShowPaste(p => !p); if (showPaste) handleCancel(); }}
                                    className={`flex-1 flex items-center justify-center gap-2 bg-zinc-900/20 hover:bg-zinc-900/50 transition-all font-black py-2.5 text-sm ${showPaste ? 'text-indigo-400' : 'text-zinc-500 hover:text-indigo-400'}`}
                                >
                                    <ClipboardDocumentCheckIcon className="w-5 h-5" />
                                    <span>표 붙여넣기</span>
                                </button>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>

            {showPaste && (
                <div className="border-t border-zinc-800 p-4 space-y-3 animate-fade-in">
                    <p className="text-[11px] text-zinc-500 font-bold">
                        스프레드시트에서 표를 복사하여 붙여넣으세요 · <span className="text-indigo-400">품명 / 총합계 / 판매가</span> 열 자동 인식
                    </p>
                    <textarea
                        autoFocus
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500/40 resize-none font-mono"
                        rows={4}
                        placeholder="스프레드시트(엑셀/구글시트)에서 복사 후 Ctrl+V / Cmd+V"
                        value={pasteText}
                        onChange={(e) => handlePasteChange(e.target.value)}
                    />
                    {parseError && <p className="text-[11px] text-red-400">{parseError}</p>}
                    {preview && preview.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-[11px] font-black text-indigo-400">{preview.length}개 품목 감지됨</p>
                            <div className="rounded-xl overflow-hidden border border-zinc-800">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-zinc-900 text-zinc-600 font-black uppercase text-[10px]">
                                            <th className="px-3 py-1.5 text-left">품명</th>
                                            <th className="px-3 py-1.5 text-right">공급가</th>
                                            <th className="px-3 py-1.5 text-right">판매가</th>
                                            <th className="px-3 py-1.5 text-right">마진</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-zinc-900">
                                        {preview.map((p, i) => (
                                            <tr key={i} className="bg-zinc-950">
                                                <td className="px-3 py-1.5 font-bold text-zinc-200">{p.displayName}</td>
                                                <td className="px-3 py-1.5 text-right text-rose-400 font-bold">{p.supplyPrice.toLocaleString()}</td>
                                                <td className="px-3 py-1.5 text-right text-zinc-400">{(p.sellingPrice || 0).toLocaleString()}</td>
                                                <td className="px-3 py-1.5 text-right text-sky-400">{(p.margin || 0).toLocaleString()}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button onClick={handleCancel} className="flex-1 py-2 text-[12px] font-black text-zinc-500 bg-zinc-900 hover:bg-zinc-800 rounded-xl transition-all">
                            취소
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={!preview || !preview.length}
                            className="flex-1 py-2 text-[12px] font-black text-white bg-indigo-500 hover:bg-indigo-600 rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            {preview?.length ? `${preview.length}개 품목 추가` : '붙여넣기 대기 중'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
});

export default PricingEditor;
