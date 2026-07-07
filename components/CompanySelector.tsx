
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import CompanyWorkstationRow from './CompanyWorkstationRow';
import FileUpload from './FileUpload';
import AutoWatcherPanel from './AutoWatcherPanel';
import BatchInvoicePanel from './BatchInvoicePanel';
import type { PricingConfig, ManualOrder, ExcludedOrder, MarginRecord, SalesRecord, DailySales, ExpenseRecord, ReturnRecord, PlatformConfigs, PlatformConfig, CourierTemplate } from '../types';
import { getBusinessInfo } from '../types';
import { BuildingStorefrontIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, TrashIcon, PlusCircleIcon, BoltIcon, ClipboardDocumentCheckIcon, ArrowPathIcon, CheckIcon, PhoneIcon, DocumentCheckIcon, DocumentArrowUpIcon, ChartBarIcon, Cog6ToothIcon, HomeIcon, TruckIcon, PencilIcon, XMarkIcon } from './icons';
import { getKeywordsForCompany, getHeaderForCompany, clearProductMatchCache, preSetProductMatchCache } from '../hooks/useConsolidatedOrderConverter';
import { useDailyWorkspace, useCourierTemplates } from '../hooks/useFirestore';
import { loadManualOrders, saveManualOrders, upsertDailySales, loadCompanyOrder, saveCompanyOrder, loadDividerColors, saveDividerColors, loadQuickRecipients, saveQuickRecipients, clearSessionResults, loadSessionResults, saveSessionResult, deleteSessionResult, type QuickRecipientData, type SessionResultData } from '../services/firestoreService';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

declare var XLSX: any;

const DEFAULT_PREFERRED_ORDER = ['연두', '웰그린', '고랭지김치', '제이제이', '팜플로우', '꽃게', '신선마켓', '답도', '귤_초록', '홍게', '황금향', '귤', '홍게2'];


interface ManualTransfer {
    id: string; label: string; bankName: string; accountNumber: string; amount: number; isAdjustment?: boolean; companyName?: string;
}

const FAKE_INPUT_TTL = 48 * 60 * 60 * 1000;
function lsFakeKey(businessId?: string) { return `fakeOrderInput_${businessId || 'default'}`; }
function lsFakeTsKey(businessId?: string) { return `fakeOrderInputTs_${businessId || 'default'}`; }
function loadFakeInput(businessId?: string): string {
  try {
    const saved = localStorage.getItem(lsFakeKey(businessId));
    const ts = localStorage.getItem(lsFakeTsKey(businessId));
    if (saved && ts && Date.now() - Number(ts) < FAKE_INPUT_TTL) return saved;
  } catch {}
  return '';
}

interface SessionData {
    id: string;
    companyName: string;
    round: number;
}

interface CompanySelectorProps { pricingConfig: PricingConfig; onConfigChange: (newConfig: PricingConfig) => void; businessId?: string; businessDisplayName?: string; platformConfigs?: PlatformConfigs; isActive?: boolean; isCurrent?: boolean; onSaved?: (date: string) => void; onStatusUpdate?: (status: { litCount: number; downloadAll: () => void }) => void; portalId?: string; onRegisterActions?: (actions: { downloadDepositList: () => void; downloadWorkLog: () => void; downloadDepositListWithExtra: (extraRows: { bankName: string; accountNumber: string; amount: string; label: string }[]) => void; getDepositBaseRows: () => any[][]; downloadDepositListDirect: (baseRows: any[][], extraRows: { bankName: string; accountNumber: string; amount: string; label: string }[]) => void }) => void; onRegisterMasterUpload?: (handlers: { uploadMaster: (file: File) => Promise<void>; uploadBatch: (file: File) => Promise<void>; getNextRound: () => number; deleteBatchRound: (round: number) => boolean; clearMaster: () => void; getOrderState: () => { name: string; rounds: { round: number; hasData: boolean; count: number }[] }[]; downloadCompanyMerged: (companyName: string) => void; downloadCompanyRound: (companyName: string, round: number) => void; downloadAllCompanies: () => void; getCompanyClosed: (companyName: string) => boolean; getCompanyRecorded: (companyName: string) => boolean; toggleCompanyClosed: (companyName: string) => void; toggleCompanyRecord: (companyName: string) => void; uploadVendorInvoice: (files: File[]) => void; getInvoiceState: () => { name: string; uploadCount: number }[]; downloadInvoice: (companyName: string) => void; getLastSettlementSummaries: () => { companyName: string; kakaoText: string; excelText: string }[]; }) => void; onRegisterReset?: (fn: () => void) => void; onWorkstationReset?: () => void; globalFakeOrderInput?: string; onGlobalFakeMatch?: (matched: string[]) => void; globalUnsentOrderInput?: string; isPricingConfigLoaded?: boolean; onExposeOrderRows?: (header: any[] | null, dataRows: any[][]) => void; onHasWarnings?: (has: boolean) => void; }

// 드래그 가능한 행 컴포넌트
import { DragHandleContext } from './DragHandleContext';

const SortableCompanyRow: React.FC<{
    id: string;
    groupBg?: string;
    children: React.ReactNode;
}> = ({ id, groupBg, children }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id });

    const style = {
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
        opacity: isDragging ? 0.5 : 1,
        backgroundColor: groupBg || undefined,
    };

    return (
        <DragHandleContext.Provider value={{ attributes, listeners }}>
            <tbody ref={setNodeRef} style={style} className="border-b border-zinc-700/50">
                {children}
            </tbody>
        </DragHandleContext.Provider>
    );
};

// 구분선 ID 헬퍼
const isDivider = (id: string) => id.startsWith('__div:');
const parseDividerLabel = (id: string) => { const m = id.match(/^__div:(.*):(\d+)$/); return m ? m[1] : ''; };
const makeDividerId = (label: string) => `__div:${label}:${Date.now()}`;

// 그룹 색상 팔레트
const GROUP_COLORS: { key: string; swatch: string; bg: string; accent: string }[] = [
    { key: 'none',    swatch: '#3f3f46', bg: 'transparent',              accent: '#52525b' },
    { key: 'amber',   swatch: '#b45309', bg: 'rgba(120,53,15,0.28)',     accent: '#d97706' },
    { key: 'emerald', swatch: '#059669', bg: 'rgba(6,78,59,0.28)',       accent: '#10b981' },
    { key: 'sky',     swatch: '#0284c7', bg: 'rgba(12,74,110,0.28)',     accent: '#38bdf8' },
    { key: 'purple',  swatch: '#7c3aed', bg: 'rgba(59,7,100,0.28)',      accent: '#a78bfa' },
    { key: 'rose',    swatch: '#e11d48', bg: 'rgba(136,19,55,0.28)',     accent: '#fb7185' },
    { key: 'orange',  swatch: '#ea580c', bg: 'rgba(124,45,18,0.28)',     accent: '#fb923c' },
];
const getGroupColor = (key: string) => GROUP_COLORS.find(c => c.key === key) || GROUP_COLORS[0];

// 드래그 가능한 구분선 컴포넌트
const SortableDividerRow: React.FC<{
    id: string;
    label: string;
    colorKey: string;
    onLabelChange: (oldId: string, newLabel: string) => void;
    onColorChange: (id: string, colorKey: string) => void;
    onDelete: (id: string) => void;
    groupCompanies?: string[];
    closedCompanies?: Set<string>;
    onGroupClose?: (companies: string[]) => void;
    onGroupDownloadOrders?: (companies: string[]) => void;
}> = ({ id, label, colorKey, onLabelChange, onColorChange, onDelete, groupCompanies, closedCompanies, onGroupClose, onGroupDownloadOrders }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(label);
    const [showPalette, setShowPalette] = React.useState(false);
    const color = getGroupColor(colorKey);

    const commit = () => {
        const trimmed = draft.trim() || '구분선';
        onLabelChange(id, trimmed);
        setEditing(false);
    };

    const hasGroup = groupCompanies && groupCompanies.length > 0;
    const allClosed = hasGroup && closedCompanies && groupCompanies.every(c => closedCompanies.has(c));

    return (
        <tbody ref={setNodeRef} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition, opacity: isDragging ? 0.5 : 1 }}>
            <tr style={{ backgroundColor: colorKey !== 'none' ? color.bg : undefined }}>
                <td colSpan={3} className="px-3 py-1.5">
                    <div className="flex items-center gap-2 group/divider">
                        <span {...attributes} {...listeners} className="text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing select-none text-base leading-none">⠿</span>
                        {/* 색상 선택 */}
                        <div className="relative">
                            <button onClick={() => setShowPalette(p => !p)} className="w-3.5 h-3.5 rounded-full border border-zinc-600 transition-all hover:scale-110 shrink-0" style={{ backgroundColor: color.swatch }} />
                            {showPalette && (
                                <div className="absolute left-0 top-5 z-50 flex gap-1.5 bg-zinc-900 border border-zinc-700 rounded-xl p-2 shadow-xl">
                                    {GROUP_COLORS.map(c => (
                                        <button
                                            key={c.key}
                                            onClick={() => { onColorChange(id, c.key); setShowPalette(false); }}
                                            className={`w-4 h-4 rounded-full border-2 transition-all hover:scale-110 ${colorKey === c.key ? 'border-white' : 'border-transparent'}`}
                                            style={{ backgroundColor: c.swatch }}
                                            title={c.key}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="flex-1 flex items-center gap-2">
                            <div className="flex-1 border-t border-dashed" style={{ borderColor: colorKey !== 'none' ? color.accent + '80' : '#3f3f4660' }} />
                            {editing ? (
                                <input
                                    autoFocus
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    onBlur={commit}
                                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                                    className="text-sm font-black text-zinc-300 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 w-36 focus:outline-none focus:border-rose-500/50"
                                />
                            ) : (
                                <button onClick={() => { setDraft(label); setEditing(true); }} className="text-sm font-black transition-colors px-1 whitespace-nowrap" style={{ color: colorKey !== 'none' ? color.accent : '#71717a' }}>
                                    {label || '구분선'}
                                </button>
                            )}
                            <div className="flex-1 border-t border-dashed" style={{ borderColor: colorKey !== 'none' ? color.accent + '80' : '#3f3f4660' }} />
                        </div>
                        {/* 그룹 액션 버튼 */}
                        {hasGroup && onGroupClose && (
                            <button
                                onClick={() => onGroupClose(groupCompanies)}
                                className={`text-[10px] font-black px-2 py-0.5 rounded transition-colors border ${allClosed ? 'text-indigo-400 border-indigo-700 hover:text-indigo-300 hover:border-indigo-500' : 'text-zinc-500 border-zinc-700 hover:text-rose-400 hover:border-rose-700'}`}
                                title={allClosed ? '그룹 마감 해제' : '그룹 전체 마감'}
                            >
                                {allClosed ? '마감해제' : '마감'}
                            </button>
                        )}
                        {hasGroup && onGroupDownloadOrders && (
                            <button
                                onClick={() => onGroupDownloadOrders(groupCompanies)}
                                className="text-[10px] font-black px-2 py-0.5 rounded transition-colors border text-zinc-500 border-zinc-700 hover:text-emerald-400 hover:border-emerald-700"
                                title="그룹 내 모든 업체 발주서 다운로드"
                            >
                                발주서다운
                            </button>
                        )}
                        <button onClick={() => onDelete(id)} className="text-zinc-700 hover:text-rose-500 transition-colors opacity-0 group-hover/divider:opacity-100">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    </div>
                </td>
            </tr>
        </tbody>
    );
};

// 열 인덱스를 알파벳으로 변환 (0→A, 1→B, ...)
const colIndexToLetter = (idx: number) => String.fromCharCode(65 + idx);

// 가구매 입력에서 주문번호 + 한글 이름 추출 → 마스터 데이터로 이름→주문번호 해석
const resolveFakeOrderNumbers = (
    fakeInput: string,
    opts?: { normalize?: boolean }
): Set<string> => {
    const fakeNums = new Set<string>();

    fakeInput.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const alphaMatches = trimmed.match(/[A-Za-z0-9-]{5,}/g);
        if (alphaMatches) {
            alphaMatches.forEach(m => {
                const val = opts?.normalize ? m.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase() : m.trim();
                fakeNums.add(val);
            });
        }
    });

    return fakeNums;
};

// 택배 양식 관리 컴포넌트
const COURIER_DATA_FIELDS = [
    { key: 'orderNumber', label: '주문번호' },
    { key: 'recipientName', label: '받는사람' },
    { key: 'recipientPhone', label: '전화번호' },
    { key: 'recipientAddress', label: '주소' },
    { key: 'trackingNumber', label: '운송장번호' },
] as const;

const SortableCourierItem: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    return (
        <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }} className="relative group/courier">
            <span {...attributes} {...listeners} className="absolute left-1 top-1/2 -translate-y-1/2 z-10 text-zinc-700 hover:text-zinc-400 cursor-grab active:cursor-grabbing select-none text-sm leading-none px-0.5">⠿</span>
            <div className="pl-4">{children}</div>
        </div>
    );
};

const CourierTemplateManager: React.FC<{
    templates: CourierTemplate[];
    onSave: (templates: CourierTemplate[]) => void;
}> = ({ templates, onSave }) => {
    const [newName, setNewName] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [newUnitPrice, setNewUnitPrice] = useState('2270');
    const [newHeaders, setNewHeaders] = useState<string[]>([]);
    const [newMapping, setNewMapping] = useState<Record<string, number>>({});
    const [newFixedValues, setNewFixedValues] = useState<Record<number, string>>({});
    const [newReturnHeaders, setNewReturnHeaders] = useState<string[]>([]);
    const [newReturnMapping, setNewReturnMapping] = useState<Record<string, number>>({});
    const [showAddForm, setShowAddForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);

    const resetForm = () => {
        setNewName('');
        setNewLabel('');
        setNewUnitPrice('2270');
        setNewHeaders([]);
        setNewMapping({});
        setNewFixedValues({});
        setNewReturnHeaders([]);
        setNewReturnMapping({});
        setEditingId(null);
        setShowAddForm(false);
    };

    const handleEditTemplate = (tmpl: CourierTemplate) => {
        setEditingId(tmpl.id);
        setNewName(tmpl.name);
        setNewLabel(tmpl.label || '');
        setNewUnitPrice(String(tmpl.unitPrice));
        setNewHeaders(tmpl.headers);
        setNewMapping({ ...tmpl.mapping } as Record<string, number>);
        setNewFixedValues({ ...tmpl.fixedValues });
        setNewReturnHeaders(tmpl.returnHeaders || []);
        setNewReturnMapping(tmpl.returnMapping ? { ...tmpl.returnMapping } as Record<string, number> : {});
        setShowAddForm(true);
    };

    const handleTemplateFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        console.log('[택배양식] 파일 선택:', file?.name, file?.size);
        if (!file) return;
        const reader = new FileReader();
        reader.onerror = () => {
            console.error('[택배양식] FileReader 에러:', reader.error);
            alert('파일을 읽을 수 없습니다.');
        };
        reader.onload = (ev) => {
            try {
                const data = new Uint8Array(ev.target?.result as ArrayBuffer);
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
                // 빈 행 건너뛰고 첫 번째 실제 헤더 행 찾기
                let headerRow: any[] | null = null;
                for (let i = 0; i < aoa.length; i++) {
                    const row = aoa[i];
                    if (row && row.length > 0 && row.some((cell: any) => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
                        headerRow = row;
                        console.log('[택배양식] 헤더 행 발견: 행', i, row);
                        break;
                    }
                }
                if (headerRow) {
                    const headers = Array.from({ length: headerRow.length }, (_, i) => String(headerRow[i] ?? ''));
                    console.log('[택배양식] 헤더 설정:', headers.length, '열');
                    setNewHeaders(headers);
                    setNewMapping({});
                    setNewFixedValues({});
                } else {
                    alert('파일에 헤더 데이터가 없습니다.');
                }
            } catch (err) {
                console.error('[택배양식] 파싱 에러:', err);
                alert('양식 파일을 읽을 수 없습니다: ' + (err as Error).message);
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    const handleReturnFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = new Uint8Array(ev.target?.result as ArrayBuffer);
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
                // 빈 행 건너뛰고 첫 번째 실제 헤더 행 찾기
                let headerRow: any[] | null = null;
                for (let i = 0; i < aoa.length; i++) {
                    const row = aoa[i];
                    if (row && row.length > 0 && row.some((cell: any) => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
                        headerRow = row;
                        break;
                    }
                }
                if (headerRow) {
                    const headers = Array.from({ length: headerRow.length }, (_, i) => String(headerRow[i] ?? ''));
                    setNewReturnHeaders(headers);
                    // 자동 감지: 주문번호/운송장번호 열 찾기
                    const autoMapping: Record<string, number> = {};
                    headers.forEach((h, idx) => {
                        const lower = h.toLowerCase().replace(/\s+/g, '');
                        if (!autoMapping.orderNumber && (lower.includes('주문번호') || lower.includes('관리번호') || lower.includes('오더번호') || lower === 'id')) {
                            autoMapping.orderNumber = idx;
                        }
                        if (!autoMapping.trackingNumber && (lower.includes('운송장') || lower.includes('송장번호') || lower.includes('등기') || lower.includes('tracking'))) {
                            autoMapping.trackingNumber = idx;
                        }
                    });
                    setNewReturnMapping(autoMapping);
                }
            } catch (err) {
                alert('운송장 파일을 읽을 수 없습니다.');
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    const handleSaveTemplate = () => {
        if (!newName.trim()) { alert('택배사 이름을 입력해주세요.'); return; }
        if (newHeaders.length === 0) { alert('양식 파일을 업로드해주세요.'); return; }
        const missingFields = COURIER_DATA_FIELDS.filter(f => newMapping[f.key] === undefined);
        if (missingFields.length > 0) { alert(`다음 열을 매핑해주세요: ${missingFields.map(f => f.label).join(', ')}`); return; }

        const template: CourierTemplate = {
            id: editingId || `tmpl_${Date.now()}`,
            name: newName.trim(),
            label: newLabel.trim() || undefined,
            headers: newHeaders,
            mapping: {
                orderNumber: newMapping.orderNumber,
                recipientName: newMapping.recipientName,
                recipientPhone: newMapping.recipientPhone,
                recipientAddress: newMapping.recipientAddress,
                trackingNumber: newMapping.trackingNumber,
            },
            fixedValues: newFixedValues,
            unitPrice: Number(newUnitPrice) || 2270,
            returnHeaders: newReturnHeaders.length > 0 ? newReturnHeaders : undefined,
            returnMapping: (newReturnMapping.orderNumber !== undefined && newReturnMapping.trackingNumber !== undefined)
                ? { orderNumber: newReturnMapping.orderNumber, trackingNumber: newReturnMapping.trackingNumber }
                : undefined,
        };

        if (editingId) {
            onSave(templates.map((t: CourierTemplate) => t.id === editingId ? template : t));
        } else {
            onSave([...templates, template]);
        }
        resetForm();
    };

    const handleDeleteTemplate = (id: string) => {
        if (!confirm('이 양식을 삭제하시겠습니까?')) return;
        onSave(templates.filter((t: CourierTemplate) => t.id !== id));
    };

    // 매핑에 사용된 열 인덱스 Set
    const mappedIndices = new Set(Object.values(newMapping));

    return (
        <div className="mb-4 bg-zinc-900/50 p-4 rounded-xl border border-pink-500/20 animate-fade-in space-y-4">
            <h4 className="text-pink-500 font-black text-[10px] uppercase tracking-widest">택배 양식 관리</h4>

            {/* 기존 템플릿 목록 */}
            {templates.map((tmpl: CourierTemplate) => (
                <div key={tmpl.id} className="flex items-center justify-between bg-zinc-950/80 px-4 py-3 rounded-xl border border-zinc-800">
                    <div className="flex items-center gap-3">
                        <span className="text-sm font-black text-white">{tmpl.name}</span>
                        {tmpl.label && <span className="bg-pink-500/10 text-pink-400 text-[9px] px-2 py-0.5 rounded-full font-bold border border-pink-500/20">{tmpl.label}</span>}
                        <span className="text-[9px] text-zinc-500 font-mono">
                            {COURIER_DATA_FIELDS.map(f => `${f.label}:${colIndexToLetter(tmpl.mapping[f.key])}`).join('  ')}
                        </span>
                        {tmpl.returnMapping && (
                            <span className="text-[9px] text-emerald-500/70 font-mono">
                                운송장: 주문번호:{colIndexToLetter(tmpl.returnMapping.orderNumber)} 송장:{colIndexToLetter(tmpl.returnMapping.trackingNumber)}
                            </span>
                        )}
                        <span className="bg-zinc-800 text-zinc-400 text-[9px] px-2 py-0.5 rounded-full">{tmpl.unitPrice.toLocaleString()}원/건</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => handleEditTemplate(tmpl)} className="text-[9px] font-black text-zinc-500 hover:text-pink-400 transition-colors px-2 py-1 border border-zinc-800 hover:border-pink-500/40 rounded-lg">
                            수정
                        </button>
                        <button onClick={() => handleDeleteTemplate(tmpl.id)} className="text-zinc-700 hover:text-rose-500 transition-colors">
                            <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            ))}

            {/* 새 양식 추가 */}
            {!showAddForm ? (
                <button onClick={() => { setEditingId(null); setShowAddForm(true); }} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-zinc-700 rounded-xl text-[10px] font-black text-zinc-500 hover:border-pink-500/40 hover:text-pink-400 transition-colors">
                    <PlusCircleIcon className="w-4 h-4" />
                    새 양식 추가
                </button>
            ) : (
                <div className="bg-zinc-950/80 p-4 rounded-xl border border-zinc-800 space-y-3">
                    <div className="space-y-2">
                        <div>
                            <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">택배사 이름</label>
                            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="예: CJ대한통운" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-pink-500/50" />
                        </div>
                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">명칭 (구분용)</label>
                                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="예: 과일용, 3kg박스" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-pink-500/50" />
                            </div>
                            <div className="w-32">
                                <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">건당 단가</label>
                                <input value={newUnitPrice} onChange={(e) => setNewUnitPrice(e.target.value)} placeholder="2270" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-pink-500/50" />
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">택배예약용 양식</label>
                        <label className={`flex items-center justify-center gap-2 cursor-pointer px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md ${newHeaders.length > 0 ? 'bg-amber-950/30 border-pink-500/30 text-pink-400' : 'bg-zinc-900/50 border-zinc-700 text-zinc-500 hover:border-pink-500/40 hover:text-pink-400'}`}>
                            {newHeaders.length > 0 ? <CheckIcon className="w-4 h-4" /> : <ArrowDownTrayIcon className="w-4 h-4" />}
                            <span>{newHeaders.length > 0 ? `${newHeaders.length}개 열 감지됨` : '엑셀 파일 선택'}</span>
                            <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={handleTemplateFileUpload} />
                        </label>
                    </div>

                    {/* 열 매핑 */}
                    {newHeaders.length > 0 && (
                        <div className="space-y-2">
                            <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest block">열 매핑 (필수)</label>
                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                                {COURIER_DATA_FIELDS.map(field => (
                                    <div key={field.key} className="flex flex-col gap-1">
                                        <span className="text-[9px] text-zinc-400 font-bold">{field.label}</span>
                                        <select
                                            value={newMapping[field.key] ?? ''}
                                            onChange={(e) => {
                                                if (e.target.value === '') {
                                                    setNewMapping(prev => { const n = { ...prev }; delete n[field.key]; return n; });
                                                } else {
                                                    setNewMapping(prev => ({ ...prev, [field.key]: Number(e.target.value) }));
                                                }
                                            }}
                                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-[10px] text-zinc-200 focus:outline-none focus:border-pink-500/50"
                                        >
                                            <option value="">선택...</option>
                                            {newHeaders.map((h, idx) => (
                                                <option key={idx} value={idx}>{colIndexToLetter(idx)}: {h || '(빈 열)'}</option>
                                            ))}
                                        </select>
                                    </div>
                                ))}
                            </div>

                            {/* 고정값 설정 (매핑 안 된 열) */}
                            {newHeaders.filter((_, idx) => !mappedIndices.has(idx)).length > 0 && (
                                <div className="mt-3">
                                    <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-2 block">고정값 설정 (선택)</label>
                                    <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                                        {newHeaders.map((h, idx) => {
                                            if (mappedIndices.has(idx)) return null;
                                            return (
                                                <div key={idx} className="flex flex-col gap-1">
                                                    <span className="text-[9px] text-zinc-500 font-mono">{colIndexToLetter(idx)}: {h || '(빈 열)'}</span>
                                                    <input
                                                        value={newFixedValues[idx] || ''}
                                                        onChange={(e) => setNewFixedValues(prev => {
                                                            const next = { ...prev };
                                                            if (e.target.value) next[idx] = e.target.value;
                                                            else delete next[idx];
                                                            return next;
                                                        })}
                                                        placeholder="비워두기"
                                                        className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-[10px] text-zinc-200 focus:outline-none focus:border-pink-500/50"
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 운송장양식 (택배사에서 돌아오는 파일) */}
                    <div className="border-t border-zinc-800 pt-3 mt-3">
                        <div className="flex items-center gap-2 mb-2">
                            <label className="text-[9px] text-emerald-500 font-black uppercase tracking-widest">운송장양식</label>
                            <span className="text-[8px] text-zinc-600">(택배사에서 송장번호 채워서 보내주는 파일)</span>
                        </div>
                        <label className={`flex items-center justify-center gap-2 cursor-pointer px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md ${newReturnHeaders.length > 0 ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-400' : 'bg-zinc-900/50 border-zinc-700 text-zinc-500 hover:border-emerald-500/40 hover:text-emerald-400'}`}>
                            {newReturnHeaders.length > 0 ? <CheckIcon className="w-4 h-4" /> : <ArrowUpTrayIcon className="w-4 h-4" />}
                            <span>{newReturnHeaders.length > 0 ? `${newReturnHeaders.length}개 열 감지됨` : '운송장 완료 파일 선택'}</span>
                            <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={handleReturnFileUpload} />
                        </label>
                        {newReturnHeaders.length > 0 && (
                            <div className="mt-2 grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="text-[9px] text-emerald-400/80 font-bold">주문번호 열</span>
                                    <select
                                        value={newReturnMapping.orderNumber ?? ''}
                                        onChange={(e) => {
                                            if (e.target.value === '') {
                                                setNewReturnMapping(prev => { const n = { ...prev }; delete n.orderNumber; return n; });
                                            } else {
                                                setNewReturnMapping(prev => ({ ...prev, orderNumber: Number(e.target.value) }));
                                            }
                                        }}
                                        className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-[10px] text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                                    >
                                        <option value="">선택...</option>
                                        {newReturnHeaders.map((h, idx) => (
                                            <option key={idx} value={idx}>{colIndexToLetter(idx)}: {h || '(빈 열)'}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-[9px] text-emerald-400/80 font-bold">운송장번호 열</span>
                                    <select
                                        value={newReturnMapping.trackingNumber ?? ''}
                                        onChange={(e) => {
                                            if (e.target.value === '') {
                                                setNewReturnMapping(prev => { const n = { ...prev }; delete n.trackingNumber; return n; });
                                            } else {
                                                setNewReturnMapping(prev => ({ ...prev, trackingNumber: Number(e.target.value) }));
                                            }
                                        }}
                                        className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-[10px] text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                                    >
                                        <option value="">선택...</option>
                                        {newReturnHeaders.map((h, idx) => (
                                            <option key={idx} value={idx}>{colIndexToLetter(idx)}: {h || '(빈 열)'}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex gap-2 justify-end">
                        <button onClick={resetForm} className="px-4 py-2 rounded-xl text-[10px] font-black text-zinc-500 hover:text-white border border-zinc-800 transition-colors">
                            취소
                        </button>
                        <button onClick={handleSaveTemplate} className="px-4 py-2 rounded-xl text-[10px] font-black bg-pink-600 hover:bg-pink-500 text-white transition-colors shadow-lg">
                            {editingId ? '수정 저장' : '저장'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

// a업체 raw 주문명 → a업체 displayName 동기 매칭 (AI 없음)
function matchProductSync(
    rawProductName: string,
    products: Record<string, import('../types').ProductPricing>,
    groupColValue?: string
): string | null {
    const entries = Object.entries(products);
    if (entries.length === 0) return null;
    if (entries.length === 1) return entries[0][1].displayName;
    // K열 기반 사전 필터
    if (groupColValue) {
        const uIdx = groupColValue.indexOf('_');
        const pType = (uIdx !== -1 ? groupColValue.slice(uIdx + 1) : groupColValue).trim().toLowerCase();
        if (pType) {
            const typeMatched = entries.filter(([, p]) => p.siteProductName
                ? pType.includes(p.siteProductName.toLowerCase())
                : (p.displayName || '').toLowerCase().includes(pType));
            if (typeMatched.length === 1) return typeMatched[0][1].displayName;
        }
    }
    const lowerRaw = rawProductName.toLowerCase();
    // siteProductName 매칭
    const siteMatches: { dn: string; len: number }[] = [];
    for (const [, p] of entries) {
        if (p.siteProductName && lowerRaw.includes(p.siteProductName.toLowerCase()))
            siteMatches.push({ dn: p.displayName, len: p.siteProductName.length });
    }
    if (siteMatches.length > 0) return siteMatches.reduce((a, b) => b.len > a.len ? b : a).dn;
    // aliases 매칭
    let bestAlias: { dn: string; len: number } | null = null;
    for (const [, p] of entries) {
        for (const alias of (p.aliases || [])) {
            if (alias && lowerRaw.includes(alias.toLowerCase()) && (!bestAlias || alias.length > bestAlias.len))
                bestAlias = { dn: p.displayName, len: alias.length };
        }
    }
    if (bestAlias) return bestAlias.dn;
    // normalize 매칭
    const norm = (s: string) => s.toLowerCase().replace(/[★☆※,.\s]/g, '');
    const normRaw = norm(rawProductName);
    const normMatches: { dn: string; len: number }[] = [];
    for (const [, p] of entries) {
        const nd = norm(p.displayName);
        if (nd && normRaw.includes(nd)) normMatches.push({ dn: p.displayName, len: nd.length });
    }
    if (normMatches.length > 0) return normMatches.reduce((a, b) => b.len > a.len ? b : a).dn;
    return null;
}

const CompanySelector: React.FC<CompanySelectorProps> = ({ pricingConfig, onConfigChange, businessId, businessDisplayName, platformConfigs = {}, isActive = false, isCurrent = false, onSaved, onStatusUpdate, portalId, onRegisterActions, onRegisterMasterUpload, onRegisterReset, onWorkstationReset, globalFakeOrderInput, onGlobalFakeMatch, globalUnsentOrderInput, isPricingConfigLoaded = true, onExposeOrderRows, onHasWarnings }) => {
    const businessPrefix = businessId ? (getBusinessInfo(businessId)?.displayName || businessId) : '';
    const { workspace, updateField, updateSessionField: updateWorkspaceSessionField, isReady } = useDailyWorkspace(businessId);
    const [sessionResults, setSessionResults] = useState<Record<string, SessionResultData> | null>(null);

    useEffect(() => {
        setSessionResults(null);
        loadSessionResults(businessId).then(setSessionResults);
    }, [businessId]);

    const handleSaveSessionResult = useCallback(async (sessionId: string, data: SessionResultData) => {
        setSessionResults(prev => ({ ...(prev || {}), [sessionId]: data }));
        try {
            await saveSessionResult(sessionId, data, businessId);
        } catch (e: any) {
            console.error('[Firestore] 세션 결과 저장 실패:', e);
            alert('⚠️ Firestore 저장 실패: 정산 데이터가 저장되지 않았습니다. Firebase 용량 초과 여부를 확인해주세요.');
        }
    }, [businessId]);

    const handleDeleteSessionResult = useCallback(async (sessionId: string) => {
        setSessionResults(prev => {
            if (!prev) return prev;
            const { [sessionId]: _, ...rest } = prev;
            return rest;
        });
        await deleteSessionResult(sessionId, businessId);
    }, [businessId]);
    const { courierTemplates, saveTemplates: saveCourierTemplates, fakeCourierSettings, saveFakeCourierSettings } = useCourierTemplates();

    // 새로고침 시 워크스테이션 데이터 초기화 (마운트 = 새로고침에서만 발생, 사업자 전환 시에는 display:none으로 유지)
    // 다른 탭이 이미 세션 데이터를 보유 중일 수 있으므로, 기존 데이터가 없을 때만 초기화
    const [workstationsReady, setWorkstationsReady] = useState(false);
    useEffect(() => {
        if (!isReady || workstationsReady) return;
        const writes: Promise<void>[] = [];
        if (!workspace?.sessionWorkflows || Object.keys(workspace.sessionWorkflows).length === 0) {
            writes.push(updateField('sessionWorkflows', {}));
        }
        if (!workspace?.sessionAdjustments || Object.keys(workspace.sessionAdjustments).length === 0) {
            writes.push(updateField('sessionAdjustments', {}));
        }
        if (writes.length > 0) {
            Promise.all(writes).finally(() => setWorkstationsReady(true));
        } else {
            setWorkstationsReady(true);
        }
    }, [isReady, updateField]);

    const [companySessions, setCompanySessions] = useState<Record<string, SessionData[]>>(() => {
        const initial: Record<string, SessionData[]> = {};
        Object.keys(pricingConfig).forEach(name => {
            initial[name] = [{ id: `${name}-1`, companyName: name, round: 1 }];
        });
        return initial;
    });
    const [workstationResetKey, setWorkstationResetKey] = useState(0);

    const [vendorFiles, setVendorFiles] = useState<Record<string, File[]>>({});
    const [totalsMap, setTotalsMap] = useState<Record<string, number>>({});
    const [excludedCountsMap, setExcludedCountsMap] = useState<Record<string, number>>({});
    const [allExcludedDetails, setAllExcludedDetails] = useState<Record<string, ExcludedOrder[]>>({});
    const [allOrderRows, setAllOrderRows] = useState<Record<string, any[][]>>({});
    const [allInvoiceRows, setAllInvoiceRows] = useState<Record<string, any[][]>>({});
    const [allUploadInvoiceRows, setAllUploadInvoiceRows] = useState<Record<string, any[][]>>({});
    const [allHeaders, setAllHeaders] = useState<Record<string, any[]>>({});
    const [allSummaries, setAllSummaries] = useState<Record<string, string>>({});
    const [allItemSummaries, setAllItemSummaries] = useState<Record<string, Record<string, { count: number; totalPrice: number }>>>({});
    const [checkedCompanies, setCheckedCompanies] = useState<Set<string>>(new Set());
    const [workDate, setWorkDate] = useState<string>(new Date().toLocaleDateString('en-CA'));
    // 불 켜기/끄기: 세션별 미다운로드 추적
    const [orderLitSessions, setOrderLitSessions] = useState<Set<string>>(new Set());
    const [invoiceLitSessions, setInvoiceLitSessions] = useState<Set<string>>(new Set());
    const [batchInvoiceLit, setBatchInvoiceLit] = useState<Set<string>>(new Set()); // 업체명
    const [mergedDownloadedCompanies, setMergedDownloadedCompanies] = useState<Set<string>>(new Set());
    const [closedCompanies, setClosedCompanies] = useState<Set<string>>(new Set());
    const [recordedCompanies, setRecordedCompanies] = useState<Set<string>>(new Set());
    const [companyOverrides, setCompanyOverrides] = useState<Record<string, { deposit?: number; margin?: number }>>({});
    const [editingCell, setEditingCell] = useState<{ company: string; field: 'deposit' | 'margin' } | null>(null);
    const [editingValue, setEditingValue] = useState('');
    const [showDepositModal, setShowDepositModal] = useState(false);
    const [depositBaseRows, setDepositBaseRows] = useState<any[][]>([]);
    const [depositExtraRows, setDepositExtraRows] = useState<{ bankName: string; accountNumber: string; amount: string; label: string }[]>([]);

    // 워크스테이션 초기화 공통 로직 (confirm 없음)
    const doResetWorkstation = useCallback(() => {
        setSessionResults(null);
        Promise.all([
            clearSessionResults(businessId),
            updateField('sessionSummary', {}),
            updateField('sessionWorkflows', {}),
            updateField('sessionAdjustments', {}),
        ]);
        setTotalsMap({});
        setExcludedCountsMap({});
        setAllExcludedDetails({});
        setAllOrderRows({});
        setAllInvoiceRows({});
        setOrderLitSessions(new Set());
        setInvoiceLitSessions(new Set());
        setBatchInvoiceLit(new Set());
        setAllUploadInvoiceRows({});
        setAllHeaders({});
        setAllSummaries({});
        setAllItemSummaries({});
        setAllOrderItems({});
        setAllRegisteredNames({});
        setAllPreConsolidationByGroup({});
        setCompanyOverrides({});
        clearMasterRef.current();
        onWorkstationReset?.();
    }, [updateField, onWorkstationReset]);

    const onRegisterResetRef = useRef(onRegisterReset);
    onRegisterResetRef.current = onRegisterReset;
    const doResetWorkstationRef = useRef(doResetWorkstation);
    doResetWorkstationRef.current = doResetWorkstation;
    useEffect(() => {
        onRegisterResetRef.current?.(() => doResetWorkstationRef.current());
    // 마운트 시 1회만 실행 - ref로 최신 함수 유지
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 워크스테이션 수동 초기화 함수
    const handleResetWorkstations = useCallback(() => {
        if (!window.confirm('워크스테이션 데이터(처리결과/진행상황/조정내역)를 초기화할까요?')) return;
        doResetWorkstation();
    }, [doResetWorkstation]);

    const [masterOrderFile, setMasterOrderFile] = useState<File | null>(null);
    const masterOrderFileRef = useRef<File | null>(null); // React 재렌더 전에도 getNextRound가 최신값 읽도록 동기 추적
    const [masterOrderData, setMasterOrderData] = useState<any[][] | null>(null);
    const [fakeMasterOrderFile, setFakeMasterOrderFile] = useState<File | null>(null);
    const [fakeMasterOrderData, setFakeMasterOrderData] = useState<any[][] | null>(null);
    const [detectedCompanies, setDetectedCompanies] = useState<Set<string>>(new Set());
    const [batchFiles, setBatchFiles] = useState<Record<string, File>>({});
    const [batchExpectedCounts, setBatchExpectedCounts] = useState<Record<string, number>>({});
    const [batchMasterRows, setBatchMasterRows] = useState<Record<string, any[][]>>({});
    const [batchPlatforms, setBatchPlatforms] = useState<Record<string, string>>({}); // sessionId → 플랫폼명
    // React state 재렌더 대기 없이 즉시 갱신되는 배치 차수 카운터
    const nextBatchRoundRef = useRef(0);
    const batchFileInputRef = useRef<HTMLInputElement>(null);
    const fakeMasterFileInputRef = useRef<HTMLInputElement>(null);
    // 멀티 플랫폼: 업로드된 플랫폼 목록 + 건수
    const [uploadedPlatforms, setUploadedPlatforms] = useState<{ name: string; count: number }[]>([]);
    // 행별 출처 플랫폼 (인덱스 = masterOrderData 행 인덱스, 값 = 플랫폼 이름 또는 null=쿠팡)
    const [rowPlatformSources, setRowPlatformSources] = useState<(string | null)[]>([]);
    // 등록상품명 교체 (K열 + L열 품목명 매칭)
    const [kReplaceFrom, setKReplaceFrom] = useState('');
    const [kReplaceFromCompany, setKReplaceFromCompany] = useState(''); // kReplaceFrom이 속한 업체
    const [kReplaceTo, setKReplaceTo] = useState('');
    const [kReplaceToCompany, setKReplaceToCompany] = useState('');
    const [kReplaceProductMap, setKReplaceProductMap] = useState<Record<string, string>>({}); // a업체 displayName → b업체 displayName
    const [kReplaceHistory, setKReplaceHistory] = useState<{ from: string; to: string; productMap?: Record<string, string> }[]>([]);
    const [kReplaceRound, setKReplaceRound] = useState<number | null>(null); // null=1차수(마스터), n=n차 batch

    // rowPlatformSources + masterOrderData → 주문번호→플랫폼 Map 생성
    const orderPlatformMap = useMemo(() => {
        const map = new Map<string, string>();
        if (!masterOrderData || rowPlatformSources.length === 0) return map;
        for (let i = 1; i < masterOrderData.length; i++) {
            const platform = rowPlatformSources[i];
            if (!platform) continue; // null = 쿠팡(기본) → Map에 안 넣음
            const orderNum = String(masterOrderData[i]?.[2] || '').trim();
            if (orderNum) map.set(orderNum.replace(/[^A-Z0-9]/gi, '').toUpperCase(), platform);
        }
        return map;
    }, [masterOrderData, rowPlatformSources]);

    const [isBulkMode, setIsBulkMode] = useState(false);
    const [bulkText, setBulkText] = useState('');

    const [manualOrders, setManualOrders] = useState<ManualOrder[]>([]);
    const [selectedManualOrderIds, setSelectedManualOrderIds] = useState<Set<string>>(new Set());
    const lastWrittenManualOrdersRef = useRef('[]');

    // 빠른 수령자 Firestore 관리
    const [quickRecipients, setQuickRecipients] = useState<QuickRecipientData[]>([]);
    const [showAddRecipient, setShowAddRecipient] = useState(false);
    const [newRecipient, setNewRecipient] = useState({ name: '', phone: '', address: '' });
    useEffect(() => {
        loadQuickRecipients(businessId).then(setQuickRecipients);
    }, [businessId]);

    // 업체 순서 관리
    const [companyOrder, setCompanyOrder] = useState<string[]>([]);
    const lastWrittenCompanyOrderRef = useRef('[]');
    const [firestoreOrderLoaded, setFirestoreOrderLoaded] = useState(false);

    // 구분선 색상
    const [dividerColors, setDividerColors] = useState<Record<string, string>>({});
    const lastWrittenDividerColorsRef = useRef('{}');

    // 업체 순서 Firestore 로드 (최초 1회)
    useEffect(() => {
        setFirestoreOrderLoaded(false);
        Promise.all([
            loadCompanyOrder(businessId),
            loadDividerColors(businessId),
        ]).then(([order, colors]) => {
            setFirestoreOrderLoaded(true);
            const str = JSON.stringify(order);
            if (str !== lastWrittenCompanyOrderRef.current) {
                setCompanyOrder(order);
                lastWrittenCompanyOrderRef.current = str;
            }
            setDividerColors(colors);
            lastWrittenDividerColorsRef.current = JSON.stringify(colors);
        });
    }, [businessId]);

    // 업체 순서 변경 → Firestore에 저장 (Firestore 로드 완료 후에만)
    useEffect(() => {
        if (!firestoreOrderLoaded) return;
        // pricingConfig 로딩 전에 실행되면 모든 업체가 "삭제됨"으로 오인식되어 순서가 리셋됨
        if (!isPricingConfigLoaded) return;
        const companies = Object.keys(pricingConfig);
        if (companyOrder.length === 0) {
            // Firestore에 저장된 순서가 없으면 기본 순서 생성
            if (companies.length === 0) return;
            const ordered = [...companies].sort((a, b) => {
                const indexA = DEFAULT_PREFERRED_ORDER.indexOf(a);
                const indexB = DEFAULT_PREFERRED_ORDER.indexOf(b);
                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                if (indexA !== -1) return -1;
                if (indexB !== -1) return 1;
                return a.localeCompare(b);
            });
            console.log(`[CompanyOrder:${businessId}] 기본 순서 생성:`, ordered.slice(0, 5));
            setCompanyOrder(ordered);
            lastWrittenCompanyOrderRef.current = JSON.stringify(ordered);
            saveCompanyOrder(ordered, businessId).catch(e => console.error('[Firestore] 업체 순서 저장 실패:', e));
            return;
        }
        // 새로 추가된 업체를 companyOrder에 자동 반영 (드래그 가능하도록, 구분선 항목 보존)
        const newCompanies = companies.filter(c => !companyOrder.includes(c));
        const removedCompanies = companyOrder.filter(c => !isDivider(c) && !companies.includes(c));
        if (newCompanies.length > 0 || removedCompanies.length > 0) {
            const updated = [
                ...companyOrder.filter(c => isDivider(c) || companies.includes(c)),
                ...newCompanies,
            ];
            console.log(`[CompanyOrder:${businessId}] 업체 추가/제거 동기화: new=${newCompanies} removed=${removedCompanies} → 결과:`, updated.slice(0, 5));
            setCompanyOrder(updated);
            lastWrittenCompanyOrderRef.current = JSON.stringify(updated);
            saveCompanyOrder(updated, businessId).catch(e => console.error('[Firestore] 업체 순서 저장 실패:', e));
            return;
        }
        const currentStr = JSON.stringify(companyOrder);
        if (currentStr === lastWrittenCompanyOrderRef.current) return;
        console.log(`[CompanyOrder:${businessId}] 드래그 순서 저장:`, companyOrder.slice(0, 5));
        lastWrittenCompanyOrderRef.current = currentStr;
        saveCompanyOrder(companyOrder, businessId).catch(e => console.error('[Firestore] 업체 순서 저장 실패:', e));
    }, [companyOrder, pricingConfig, businessId, firestoreOrderLoaded, isPricingConfigLoaded]);

    // pricingConfig에 새 업체 추가 시 companySessions에 자동 반영 (새로고침 없이 실시간 반영)
    useEffect(() => {
        const configCompanies = Object.keys(pricingConfig);
        const sessionCompanies = Object.keys(companySessions);
        const newCompanies = configCompanies.filter(c => !sessionCompanies.includes(c));
        if (newCompanies.length > 0) {
            setCompanySessions(prev => {
                const next = { ...prev };
                newCompanies.forEach(name => {
                    next[name] = [{ id: `${name}-1`, companyName: name, round: 1 }];
                });
                return next;
            });
        }
    }, [pricingConfig, companySessions]);

    // pricingConfig 변경 시 detectedCompanies 재계산 (마스터 파일이 이미 업로드된 상태에서 새 업체 키워드 반영)
    useEffect(() => {
        if (!masterOrderData || masterOrderData.length < 2) return;
        const groupColIdx = 10;
        const companiesInFile = new Set<string>();
        const companyKeywordsMap = new Map<string, string[]>();
        Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
        for (let i = 1; i < masterOrderData.length; i++) {
            const rawVal = String(masterOrderData[i]?.[groupColIdx] || '');
            const groupVal = rawVal.replace(/\s+/g, '').normalize('NFC');
            if (!groupVal) continue;
            let bestCompany = '';
            let bestPos = Infinity;
            for (const [name, keywords] of companyKeywordsMap.entries()) {
                for (const k of keywords) {
                    const pos = groupVal.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                    if (pos !== -1 && pos < bestPos) {
                        bestPos = pos;
                        bestCompany = name;
                    }
                }
            }
            if (bestCompany) companiesInFile.add(bestCompany);
        }
        // 기존 detectedCompanies와 다를 때만 업데이트
        setDetectedCompanies(prev => {
            const prevArr = [...prev].sort().join(',');
            const newArr = [...companiesInFile].sort().join(',');
            return prevArr === newArr ? prev : companiesInFile;
        });
    }, [pricingConfig, masterOrderData]);

    // 오늘 기록된 업체를 Firestore에서 로드하여 recordedCompanies 초기화
    useEffect(() => {
        const today = new Date().toLocaleDateString('en-CA');
        import('../services/firestoreService').then(({ loadDailySales }) => {
            loadDailySales(today, businessId).then(existing => {
                if (!existing) return;
                const companies = new Set<string>();
                (existing.records || []).forEach(r => { if (r.company) companies.add(r.company); });
                Object.keys(existing.companyOrderRows || {}).forEach(c => companies.add(c));
                (existing.depositRecords || []).forEach(d => { if (d.company) companies.add(d.company); });
                if (companies.size > 0) setRecordedCompanies(companies);
            }).catch(() => {});
        });
    }, [businessId]);

    // 수동발주 초기 로드 (getDoc 1회)
    useEffect(() => {
        loadManualOrders(businessId).then(orders => {
            const str = JSON.stringify(orders);
            lastWrittenManualOrdersRef.current = str;
            const typedOrders = orders as ManualOrder[];
            setManualOrders(typedOrders);
            setSelectedManualOrderIds(new Set(typedOrders.map(o => o.id)));
        });
    }, [businessId]);

    // 수동발주 변경 → Firestore에 저장
    const isInitialManualOrdersLoad = useRef(true);
    useEffect(() => {
        if (isInitialManualOrdersLoad.current) { isInitialManualOrdersLoad.current = false; return; }
        const currentStr = JSON.stringify(manualOrders);
        if (currentStr === lastWrittenManualOrdersRef.current) return;
        lastWrittenManualOrdersRef.current = currentStr;
        saveManualOrders(manualOrders, businessId).catch(e => console.error('[Firestore] 수동발주 저장 실패:', e));
    }, [manualOrders, businessId]);


    const [manualInput, setManualInput] = useState({
        companyName: '', recipientName: '', phone: '', address: '', productName: '', productKey: '', qty: '1', memo: ''
    });
    const [editingOrderId, setEditingOrderId] = useState<string | null>(null);


    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
    const [showSelectedSummaryModal, setShowSelectedSummaryModal] = useState(false);

    const [fakeOrderInput, setFakeOrderInput] = useState(() => loadFakeInput(businessId));
    const effectiveFakeInput = globalFakeOrderInput?.trim() ? globalFakeOrderInput : fakeOrderInput;
    const [unsentOrderInput, setUnsentOrderInput] = useState('');
    const effectiveUnsentInput = globalUnsentOrderInput?.trim() ? globalUnsentOrderInput : unsentOrderInput;
    const [showFakeDetail, setShowFakeDetail] = useState(false);

    const [courierFiles, setCourierFiles] = useState<Record<string, File>>({});
    const [courierResults, setCourierResults] = useState<Record<string, { matched: number; total: number; notFound: string[] }>>({});
    const [courierMatchedRows, setCourierMatchedRows] = useState<Record<string, any[][]>>({});
    const [showTemplateManager, setShowTemplateManager] = useState(false);
    const [showFakeCourierSettings, setShowFakeCourierSettings] = useState(false);

    const [manualTransfers, setManualTransfers] = useState<ManualTransfer[]>([]);

    const [newTransfer, setNewTransfer] = useState({ label: '', bankName: '', accountNumber: '', amount: '' });

    // 드래그앤드롭 센서 설정
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // 업체 순서 정렬 함수
    const sortCompanies = useCallback((companies: string[]) => {
        if (companyOrder.length === 0) return companies;
        return companies.sort((a, b) => {
            const indexA = companyOrder.indexOf(a);
            const indexB = companyOrder.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            return a.localeCompare(b);
        });
    }, [companyOrder]);

    // 드래그 종료 핸들러
    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (!over || active.id === over.id) return;

        setCompanyOrder((items) => {
            const oldIndex = items.indexOf(active.id as string);
            const newIndex = items.indexOf(over.id as string);

            return arrayMove(items, oldIndex, newIndex);
        });
    };

    // 구분선 추가/수정/삭제/색상
    const handleAddDivider = () => {
        setCompanyOrder(prev => [...prev, makeDividerId('구분선')]);
    };
    const handleChangeDividerLabel = (oldId: string, newLabel: string) => {
        const m = oldId.match(/^__div:(.*):(\d+)$/);
        if (!m) return;
        const newId = `__div:${newLabel}:${m[2]}`;
        setCompanyOrder(prev => prev.map(id => id === oldId ? newId : id));
        setDividerColors(prev => {
            if (!(oldId in prev)) return prev;
            const next = { ...prev, [newId]: prev[oldId] };
            delete next[oldId];
            return next;
        });
    };
    const handleDeleteDivider = (id: string) => {
        setCompanyOrder(prev => prev.filter(item => item !== id));
        setDividerColors(prev => { const next = { ...prev }; delete next[id]; return next; });
    };
    const handleChangeDividerColor = (id: string, colorKey: string) => {
        setDividerColors(prev => {
            const next = colorKey === 'none' ? { ...prev } : { ...prev, [id]: colorKey };
            if (colorKey === 'none') delete next[id];
            return next;
        });
    };

    // dividerColors 변경 → Firestore 저장
    useEffect(() => {
        if (!firestoreOrderLoaded) return;
        const currentStr = JSON.stringify(dividerColors);
        if (currentStr === lastWrittenDividerColorsRef.current) return;
        lastWrittenDividerColorsRef.current = currentStr;
        saveDividerColors(dividerColors, businessId).catch(e => console.error('[Firestore] dividerColors 저장 실패:', e));
    }, [dividerColors, businessId, firestoreOrderLoaded]);


    // 비용(지출내역) 관리
    const EXPENSE_CATEGORIES = ['임대료', '통신비', '소모품비', '물류비', '마케팅', '식비', '기타', '이자'];
    const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
    const [newExpense, setNewExpense] = useState({ category: '물류비', amount: '', description: '', company: '', productKey: '' });
    const expenseProducts = useMemo(() => {
        if (!newExpense.company || !pricingConfig[newExpense.company]) return [];
        return Object.entries(pricingConfig[newExpense.company].products).map(([key, p]: [string, any]) => ({
            key, name: p.orderFormName || p.displayName,
        }));
    }, [newExpense.company, pricingConfig]);

    // 품목별관리
    const [returns, setReturns] = useState<ReturnRecord[]>([]);
    const [itemType, setItemType] = useState<'반품' | '광고비' | '슬롯'>('반품');
    const [returnCompany, setReturnCompany] = useState('');
    const [returnRegisteredName, setReturnRegisteredName] = useState('');
    const [returnProductKey, setReturnProductKey] = useState('');
    const [returnCount, setReturnCount] = useState('1');
    const [returnMemo, setReturnMemo] = useState('');
    const [returnOrderDate, setReturnOrderDate] = useState(() => new Date().toLocaleDateString('en-CA'));
    const returnRegisteredNames = useMemo(() => {
        if (!returnCompany || !pricingConfig[returnCompany]) return [];
        return (pricingConfig[returnCompany] as any).keywords || [];
    }, [returnCompany, pricingConfig]);
    const returnProducts = useMemo(() => {
        if (!returnCompany || !returnRegisteredName || !pricingConfig[returnCompany]) return [];
        return Object.entries((pricingConfig[returnCompany] as any).products || {}).map(([key, p]: [string, any]) => ({
            key, name: p.orderFormName || p.displayName, margin: p.margin || 0,
        }));
    }, [returnCompany, returnRegisteredName, pricingConfig]);
    const selectedReturnMargin = useMemo(() => {
        const p = returnProducts.find(p => p.key === returnProductKey);
        return p ? p.margin : 0;
    }, [returnProducts, returnProductKey]);
    const filteredReturns = useMemo(() => returns.filter(r => (r.type || '반품') === itemType), [returns, itemType]);
    const [returnDirectAmount, setReturnDirectAmount] = useState('');
    const [returnDirectName, setReturnDirectName] = useState('');
    useEffect(() => {
        setReturnRegisteredName('');
        setReturnProductKey('');
        setReturnDirectAmount('');
        setReturnDirectName('');
        setReturnMemo('');
    }, [itemType]);

    // Firestore 동기화 - 값 비교로 에코 방지
    const lastWrittenFakeRef = useRef('');
    const lastWrittenUnsentRef = useRef('');
    const lastWrittenTransfersRef = useRef('[]');
    const lastWrittenExpensesRef = useRef('[]');
    // 저장 중 구독 업데이트 차단 (stale snapshot이 로컬 변경을 덮어쓰는 것 방지)
    const savingFieldsUntil = useRef<Record<string, number>>({});
    // isReady를 ref로 관리하여 save effect의 dependency에서 제외 (race condition 방지)
    const isReadyRef = useRef(false);
    useEffect(() => { isReadyRef.current = isReady; }, [isReady]);

    useEffect(() => {
        if (!workspace) return;
        const now = Date.now();
        if (workspace.fakeOrderInput !== undefined && workspace.fakeOrderInput !== lastWrittenFakeRef.current) {
            if (now >= (savingFieldsUntil.current['fakeOrderInput'] || 0)) {
                setFakeOrderInput(workspace.fakeOrderInput);
                lastWrittenFakeRef.current = workspace.fakeOrderInput;
            }
        }
        if (workspace.unsentOrderInput !== undefined && workspace.unsentOrderInput !== lastWrittenUnsentRef.current) {
            if (now >= (savingFieldsUntil.current['unsentOrderInput'] || 0)) {
                setUnsentOrderInput(workspace.unsentOrderInput);
                lastWrittenUnsentRef.current = workspace.unsentOrderInput;
            }
        }
        if (workspace.manualTransfers !== undefined) {
            if (now >= (savingFieldsUntil.current['manualTransfers'] || 0)) {
                const wsStr = JSON.stringify(workspace.manualTransfers);
                if (wsStr !== lastWrittenTransfersRef.current) {
                    setManualTransfers(workspace.manualTransfers);
                    lastWrittenTransfersRef.current = wsStr;
                }
            }
        }
        if (workspace.expenses !== undefined) {
            if (now >= (savingFieldsUntil.current['expenses'] || 0)) {
                const wsStr = JSON.stringify(workspace.expenses);
                if (wsStr !== lastWrittenExpensesRef.current) {
                    setExpenses(workspace.expenses);
                    lastWrittenExpensesRef.current = wsStr;
                }
            }
        }
    }, [workspace]);

    // fakeOrderInput 변경 → Firestore에 debounce로 저장
    const fakeOrderDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!isReadyRef.current) return;
        if (fakeOrderInput === lastWrittenFakeRef.current) return;
        if (fakeOrderDebounceRef.current) clearTimeout(fakeOrderDebounceRef.current);
        fakeOrderDebounceRef.current = setTimeout(() => {
            savingFieldsUntil.current['fakeOrderInput'] = Date.now() + 30000;
            lastWrittenFakeRef.current = fakeOrderInput;
            updateField('fakeOrderInput', fakeOrderInput)
                .then(() => { setTimeout(() => { savingFieldsUntil.current['fakeOrderInput'] = 0; }, 1500); })
                .catch(e => { savingFieldsUntil.current['fakeOrderInput'] = 0; console.error('[Firestore] fakeOrderInput 저장 실패:', e); });
        }, 300);
        return () => { if (fakeOrderDebounceRef.current) clearTimeout(fakeOrderDebounceRef.current); };
    }, [fakeOrderInput, updateField]);

    // fakeOrderInput 변경 → localStorage에 저장 (48시간 TTL)
    useEffect(() => {
        try {
            localStorage.setItem(lsFakeKey(businessId), fakeOrderInput);
            localStorage.setItem(lsFakeTsKey(businessId), String(Date.now()));
        } catch {}
    }, [fakeOrderInput, businessId]);

    // unsentOrderInput 변경 → Firestore에 debounce로 저장
    const unsentOrderDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!isReadyRef.current) return;
        if (unsentOrderInput === lastWrittenUnsentRef.current) return;
        if (unsentOrderDebounceRef.current) clearTimeout(unsentOrderDebounceRef.current);
        unsentOrderDebounceRef.current = setTimeout(() => {
            savingFieldsUntil.current['unsentOrderInput'] = Date.now() + 30000;
            lastWrittenUnsentRef.current = unsentOrderInput;
            updateField('unsentOrderInput', unsentOrderInput)
                .then(() => { setTimeout(() => { savingFieldsUntil.current['unsentOrderInput'] = 0; }, 1500); })
                .catch(e => { savingFieldsUntil.current['unsentOrderInput'] = 0; console.error('[Firestore] unsentOrderInput 저장 실패:', e); });
        }, 300);
        return () => { if (unsentOrderDebounceRef.current) clearTimeout(unsentOrderDebounceRef.current); };
    }, [unsentOrderInput, updateField]);

    // manualTransfers 변경 → Firestore에 저장
    useEffect(() => {
        if (!isReadyRef.current) return;
        const currentStr = JSON.stringify(manualTransfers);
        if (currentStr === lastWrittenTransfersRef.current) return;
        savingFieldsUntil.current['manualTransfers'] = Date.now() + 30000;
        lastWrittenTransfersRef.current = currentStr;
        updateField('manualTransfers', manualTransfers)
            .then(() => { setTimeout(() => { savingFieldsUntil.current['manualTransfers'] = 0; }, 1500); })
            .catch(e => { savingFieldsUntil.current['manualTransfers'] = 0; console.error('[Firestore] manualTransfers 저장 실패:', e); });
    }, [manualTransfers, updateField]);

    // expenses 변경 → Firestore에 저장
    useEffect(() => {
        if (!isReadyRef.current) return;
        const currentStr = JSON.stringify(expenses);
        if (currentStr === lastWrittenExpensesRef.current) return;
        savingFieldsUntil.current['expenses'] = Date.now() + 30000;
        lastWrittenExpensesRef.current = currentStr;
        updateField('expenses', expenses)
            .then(() => { setTimeout(() => { savingFieldsUntil.current['expenses'] = 0; }, 1500); })
            .catch(e => { savingFieldsUntil.current['expenses'] = 0; console.error('[Firestore] expenses 저장 실패:', e); });
    }, [expenses, updateField]);


    // 가구매 명단 분석 (입력된 번호/이름 vs 실제 발견된 번호)
    const fakeOrderAnalysis = useMemo(() => {
        const inputNumbers = new Set<string>();
        const nameMap: Record<string, string> = {}; // 주문번호 -> 이름
        const duplicates: { number: string; names: string[] }[] = [];
        const numberToNames = new Map<string, string[]>();
        let inputLineCount = 0;

        const lineData: { line: string; name: string; nums: string[] }[] = [];

        effectiveFakeInput.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            inputLineCount++;
            const matches = trimmed.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) {
                let namepart = trimmed;
                matches.forEach(m => { namepart = namepart.replace(m, ''); });
                const name = namepart.trim();
                const nums: string[] = [];
                matches.forEach(m => {
                    const num = m.trim();
                    inputNumbers.add(num);
                    nums.push(num);
                    if (name) {
                        nameMap[num] = name;
                        const existing = numberToNames.get(num) || [];
                        if (!existing.includes(name)) existing.push(name);
                        numberToNames.set(num, existing);
                    }
                });
                lineData.push({ line: trimmed, name, nums });
            } else {
                lineData.push({ line: trimmed, name: trimmed, nums: [] });
            }
        });

        for (const [num, names] of numberToNames.entries()) {
            if (names.length > 1) duplicates.push({ number: num, names });
        }

        // 제외된 주문 정보 수집
        const foundDetails: Record<string, ExcludedOrder> = {};
        (Object.values(allExcludedDetails).flat() as ExcludedOrder[]).forEach(ex => {
            const cleanNum = ex.orderNumber.replace(' (제외)', '').trim();
            foundDetails[cleanNum] = ex;
        });

        // 마스터 주문서에서 모든 주문번호 추출 (가구매용 마스터 우선)
        const effectiveMasterData = fakeMasterOrderData ?? masterOrderData;
        const masterOrderNumbers = new Set<string>();
        if (effectiveMasterData && effectiveMasterData.length > 1) {
            for (let i = 1; i < effectiveMasterData.length; i++) {
                const row = effectiveMasterData[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim();
                if (orderNum) masterOrderNumbers.add(orderNum);
            }
        }

        // 주문번호로만 매칭
        const matched = Array.from(inputNumbers).filter(num =>
            foundDetails[num] || masterOrderNumbers.has(num)
        );
        const missing = Array.from(inputNumbers).filter(num =>
            !foundDetails[num] && !masterOrderNumbers.has(num)
        );

        // 주문번호 없이도 유효한 특수 키워드 (예: 실배 = 실물배송)
        const SPECIAL_MATCH_KEYWORDS = ['실배'];
        const isSpecialMatch = (line: string) => SPECIAL_MATCH_KEYWORDS.some(kw => line.includes(kw));

        // 매칭되지 않은 라인: 주문번호 없는 라인 + 주문번호가 있지만 미발견 라인 (특수 키워드 제외)
        const matchedSet = new Set(matched);
        const specialMatchLines = lineData.filter(ld => isSpecialMatch(ld.line));
        const unmatchedLines = lineData.filter(ld =>
            !isSpecialMatch(ld.line) &&
            (ld.nums.length === 0 || ld.nums.every(n => !matchedSet.has(n)))
        );

        return { inputNumbers, inputLineCount, matched, missing, foundDetails, nameMap, duplicates, unmatchedLines, specialMatchLines };
    }, [effectiveFakeInput, allExcludedDetails, fakeMasterOrderData, masterOrderData]);

    // 미발송 명단 분석 (입력된 번호 vs 실제 발견된 번호)
    const unsentOrderAnalysis = useMemo(() => {
        if (!effectiveUnsentInput.trim()) return { inputLineCount: 0, matched: [] as string[], missing: [] as string[], nameMap: {} as Record<string, string> };
        const inputNumbers = new Set<string>();
        const nameMap: Record<string, string> = {};
        let inputLineCount = 0;
        effectiveUnsentInput.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            inputLineCount++;
            const matches = trimmed.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) {
                let namepart = trimmed;
                matches.forEach(m => { namepart = namepart.replace(m, ''); });
                const name = namepart.trim();
                matches.forEach(m => { inputNumbers.add(m.trim()); if (name) nameMap[m.trim()] = name; });
            }
        });
        const foundDetails: Record<string, ExcludedOrder> = {};
        (Object.values(allExcludedDetails).flat() as ExcludedOrder[]).forEach(ex => {
            const cleanNum = ex.orderNumber.replace(' (제외)', '').trim();
            foundDetails[cleanNum] = ex;
        });
        const effectiveMasterData = fakeMasterOrderData ?? masterOrderData;
        const masterOrderNumbers = new Set<string>();
        if (effectiveMasterData && effectiveMasterData.length > 1) {
            for (let i = 1; i < effectiveMasterData.length; i++) {
                const row = effectiveMasterData[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim();
                if (orderNum) masterOrderNumbers.add(orderNum);
            }
        }
        const matched = Array.from(inputNumbers).filter(num => foundDetails[num] || masterOrderNumbers.has(num));
        const missing = Array.from(inputNumbers).filter(num => !foundDetails[num] && !masterOrderNumbers.has(num));
        return { inputLineCount, matched, missing, nameMap };
    }, [effectiveUnsentInput, allExcludedDetails, fakeMasterOrderData, masterOrderData]);

    // 전체 가구매 명단 박스에 매칭 결과 콜백
    useEffect(() => {
        if (onGlobalFakeMatch && globalFakeOrderInput) {
            onGlobalFakeMatch(fakeOrderAnalysis.matched);
        }
    }, [fakeOrderAnalysis.matched, onGlobalFakeMatch, globalFakeOrderInput]);

    // 공통 택배 기능용: 주문 행 데이터를 App.tsx로 전달
    useEffect(() => {
        if (!onExposeOrderRows) return;
        const header = masterOrderData?.[0] ?? null;
        const dataRows: any[][] = masterOrderData ? [...masterOrderData.slice(1)] : [];
        (Object.values(batchMasterRows) as any[][][]).forEach(batchRows => { dataRows.push(...batchRows); });
        onExposeOrderRows(header, dataRows);
    }, [masterOrderData, batchMasterRows, onExposeOrderRows]);

    // 가구매 수량 미매칭 여부: 명단 주문번호 수 vs 실제 제외된 주문번호 수
    const fakeMismatch = useMemo(() => {
        const fakeCount = fakeOrderAnalysis.inputNumbers.size;
        if (fakeCount === 0) return false;
        const excludedFakeNums = new Set<string>();
        (Object.values(allExcludedDetails).flat() as ExcludedOrder[]).forEach(ex => {
            if (String(ex.orderNumber).includes('(제외)')) {
                excludedFakeNums.add(String(ex.orderNumber).replace(/\s*\(제외\)\s*/g, '').trim());
            }
        });
        return fakeCount !== excludedFakeNums.size;
    }, [fakeOrderAnalysis, allExcludedDetails]);

    // 마스터 주문서 품목별 건수 분석 (가구매 제외 / 가구매 분리)
    const masterProductSummary = useMemo(() => {
        if (!masterOrderData || masterOrderData.length < 2) return null;
        const fakeNums = resolveFakeOrderNumbers(effectiveFakeInput);
        // 헤더에서 수량 열 동적 탐색 (W열 = index 22가 아닐 수 있음)
        const headers = masterOrderData[0] || [];
        let qtyColIdx = headers.findIndex((h: any) => h && String(h).includes('수량'));
        if (qtyColIdx === -1) qtyColIdx = headers.findIndex((h: any) => h && String(h).includes('구매수'));
        if (qtyColIdx === -1) qtyColIdx = 22; // 기본값: W열
        // 업체-키워드 맵 생성
        const companyKeywordsMap = new Map<string, string[]>();
        Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
        const productToCompany: Record<string, string> = {};
        const realOrders: Record<string, number> = {};
        const fakeOrders: Record<string, number> = {};
        const unclaimedOrders: { recipientName: string; productName: string; groupName: string; orderNumber: string; qty: number }[] = [];
        const allOrderDetails: { recipientName: string; productName: string; groupName: string; orderNumber: string; qty: number; company: string; isFake: boolean; platform: string }[] = [];
        const skippedOrders: { recipientName: string; productName: string; orderNumber: string; qty: number; reason: string }[] = [];
        let masterRawTotalQty = 0;
        let masterFileRowCount = 0; // 파일 내 비어있지 않은 데이터 행 수
        let nullRowCount = 0; // null/undefined 행 수
        console.log(`[마스터검증] 수량 열 인덱스: ${qtyColIdx} (헤더: "${headers[qtyColIdx]}")`);
        for (let i = 1; i < masterOrderData.length; i++) {
            const row = masterOrderData[i];
            if (!row) { nullRowCount++; continue; }
            // 완전히 빈 행 건너뛰기 (데이터 행으로 카운트하지 않음)
            const hasAnyData = row.some((cell: any) => cell !== undefined && cell !== null && String(cell).trim() !== '');
            if (!hasAnyData) continue;
            masterFileRowCount++;
            const orderNum = String(row[2] || '').trim();
            const rawGroupName = String(row[10] || '').trim();
            const rawQtyVal = row[qtyColIdx];
            const qty = parseInt(String(rawQtyVal != null ? rawQtyVal : '1'), 10) || 1;
            const recipientName = String(row[26] || '').trim();
            const productName = String(row[11] || '').trim();
            // groupName이 없으면 productName으로 폴백 (토스 등 그룹명 없는 플랫폼)
            const groupName = rawGroupName || productName;
            if (i <= 3) console.log(`[마스터검증] 행${i}: row길이=${row.length}, qtyCol[${qtyColIdx}]=${JSON.stringify(rawQtyVal)}, qty=${qty}, groupName="${groupName}"`);
            masterRawTotalQty += qty;
            if (!groupName) {
                skippedOrders.push({ recipientName, productName, orderNumber: orderNum, qty, reason: '등록상품명 없음' });
                continue;
            }
            // 업체명 매핑
            if (!productToCompany[groupName]) {
                const groupNorm = groupName.replace(/\s+/g, '').normalize('NFC');
                let bestCompany = '';
                let bestPos = Infinity;
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    for (const k of keywords) {
                        const kNorm = k.replace(/\s+/g, '').normalize('NFC');
                        const pos = groupNorm.indexOf(kNorm);
                        if (pos !== -1 && pos < bestPos) {
                            bestPos = pos;
                            bestCompany = name;
                        }
                    }
                }
                // K열이 비어있을 때만 전체 행 폴백 (토스 등 비표준 열 구조)
                // K열에 값이 있는데 매칭 실패 → 폴백 금지 (수취인 주소 등에서 키워드 우연 매칭 방지)
                if (!bestCompany && !rawGroupName) {
                    const fullRowText = row.map((v: any) => String(v || '')).join(' ').replace(/\s+/g, '').normalize('NFC');
                    for (const [name, keywords] of companyKeywordsMap.entries()) {
                        for (const k of keywords) {
                            const kNorm = k.replace(/\s+/g, '').normalize('NFC');
                            const pos = fullRowText.indexOf(kNorm);
                            if (pos !== -1 && pos < bestPos) {
                                bestPos = pos;
                                bestCompany = name;
                            }
                        }
                    }
                }
                if (bestCompany) productToCompany[groupName] = bestCompany;
            }
            const isFake = fakeNums.has(orderNum);
            const company = productToCompany[groupName] || '';
            const platform = rowPlatformSources[i] || '쿠팡';
            allOrderDetails.push({ recipientName, productName, groupName, orderNumber: orderNum, qty, company, isFake, platform });
            if (isFake) {
                fakeOrders[groupName] = (fakeOrders[groupName] || 0) + qty;
            } else {
                realOrders[groupName] = (realOrders[groupName] || 0) + qty;
                if (!company) {
                    unclaimedOrders.push({ recipientName, productName, groupName, orderNumber: orderNum, qty });
                }
            }
        }
        const realTotal = Object.values(realOrders).reduce((a, b) => a + b, 0);
        const fakeTotal = Object.values(fakeOrders).reduce((a, b) => a + b, 0);
        // 업체별 마스터 주문 건수 (수량 기준)
        const companyOrderCounts: Record<string, number> = {};
        allOrderDetails.forEach(d => {
            if (d.company) {
                companyOrderCounts[d.company] = (companyOrderCounts[d.company] || 0) + d.qty;
            }
        });
        // K열 값이 어느 업체 키워드에도 직접 포함되지 않는 등록상품명
        // (full-row fallback으로만 라우팅됐거나 아예 미매칭 → 잘못된 발주서 생성 위험)
        const allSeenGroupNames = new Set<string>();
        allOrderDetails.forEach(d => { if (d.groupName) allSeenGroupNames.add(d.groupName); });
        unclaimedOrders.forEach(u => { if (u.groupName) allSeenGroupNames.add(u.groupName); });
        const unknownGroupNames: string[] = [];
        for (const gn of allSeenGroupNames) {
            if (!gn) continue;
            const gnNorm = gn.replace(/\s+/g, '').normalize('NFC');
            let directMatch = false;
            for (const [, keywords] of companyKeywordsMap.entries()) {
                for (const k of keywords) {
                    if (gnNorm.includes(k.replace(/\s+/g, '').normalize('NFC'))) {
                        directMatch = true;
                        break;
                    }
                }
                if (directMatch) break;
            }
            if (!directMatch) unknownGroupNames.push(gn);
        }
        console.log(`[마스터검증] XLSX행수: ${masterOrderData.length - 1}, 데이터행: ${masterFileRowCount}, null행: ${nullRowCount}, masterRawTotalQty: ${masterRawTotalQty}, realTotal: ${realTotal}, fakeTotal: ${fakeTotal}, 합계: ${realTotal + fakeTotal}, skipped: ${skippedOrders.length}, unclaimed: ${unclaimedOrders.length}, unknown: ${unknownGroupNames.length}`);
        console.log(`[마스터검증] companyOrderCounts:`, companyOrderCounts);
        if (unclaimedOrders.length > 0) console.log(`[마스터검증] unclaimedOrders:`, unclaimedOrders);
        if (unknownGroupNames.length > 0) console.log(`[마스터검증] unknownGroupNames:`, unknownGroupNames);
        if (skippedOrders.length > 0) console.log(`[마스터검증] skippedOrders:`, skippedOrders);
        return { realOrders, fakeOrders, realTotal, fakeTotal, productToCompany, unclaimedOrders, allOrderDetails, companyOrderCounts, skippedOrders, masterRawTotalQty, masterFileRowCount, unknownGroupNames };
    }, [masterOrderData, effectiveFakeInput, pricingConfig, rowPlatformSources]);

    // 2차+ 세션 주문 집계 (배치 업로드로 들어온 추가 차수 데이터)
    // 차수별로 분리: [2차, 3차, 4차, ...] — 데이터 없는 차수는 0으로 채움
    type RoundBucket = {
        realByCompany: Record<string, number>;
        fakeByCompany: Record<string, number>;
        realByGroup: Record<string, number>;
        fakeByGroup: Record<string, number>;
        realTotal: number;
        fakeTotal: number;
        platform: string;
    };
    const additionalRoundsSummary = useMemo(() => {
        const buckets: Record<number, RoundBucket> = {};
        const groupToCompany: Record<string, string> = {};
        const makeBucket = (): RoundBucket => ({
            realByCompany: {}, fakeByCompany: {}, realByGroup: {}, fakeByGroup: {}, realTotal: 0, fakeTotal: 0, platform: '쿠팡',
        });
        let maxRound = 1;
        let hasData = false;

        const fakeNums = new Set<string>();
        effectiveFakeInput.split('\n').forEach(line => {
            const matches = line.trim().match(/[A-Za-z0-9-]{5,}/g);
            if (matches) matches.forEach(m => fakeNums.add(m.trim()));
        });

        (Object.entries(companySessions) as [string, SessionData[]][]).forEach(([company, sessions]) => {
            sessions.forEach((session: SessionData) => {
                if (session.round <= 1) return;
                if (session.round > maxRound) maxRound = session.round;
                const rows = batchMasterRows[session.id] || allOrderRows[session.id];
                if (!rows || rows.length === 0) return;
                hasData = true;
                const b = buckets[session.round] || (buckets[session.round] = makeBucket());
                // 배치 세션의 플랫폼명 설정
                if (batchPlatforms[session.id]) b.platform = batchPlatforms[session.id];
                rows.forEach(row => {
                    const orderNum = String(row[2] || '').trim();
                    const rawGroup = String(row[10] || '').trim();
                    // groupName이 없으면 productName으로 폴백 (토스 등 그룹명 없는 플랫폼)
                    const groupName = rawGroup || String(row[11] || '').trim();
                    const qty = parseInt(String(row[22] || '1'), 10) || 1;
                    if (groupName) groupToCompany[groupName] = company;
                    const isFake = fakeNums.has(orderNum);
                    if (isFake) {
                        b.fakeTotal += qty;
                        b.fakeByCompany[company] = (b.fakeByCompany[company] || 0) + qty;
                        if (groupName) b.fakeByGroup[groupName] = (b.fakeByGroup[groupName] || 0) + qty;
                    } else {
                        b.realTotal += qty;
                        b.realByCompany[company] = (b.realByCompany[company] || 0) + qty;
                        if (groupName) b.realByGroup[groupName] = (b.realByGroup[groupName] || 0) + qty;
                    }
                });
            });
        });

        // 세션은 있지만 실제 데이터가 없는 경우에도 maxRound를 반영해 0건으로 표시
        let sessionMax = 1;
        (Object.values(companySessions) as SessionData[][]).forEach(sessions => {
            sessions.forEach(s => { if (s.round > sessionMax) sessionMax = s.round; });
        });
        if (sessionMax > maxRound) maxRound = sessionMax;
        if (maxRound < 2 && !hasData) return null;

        const rounds: RoundBucket[] = [];
        for (let r = 2; r <= maxRound; r++) {
            rounds.push(buckets[r] || makeBucket());
        }
        if (rounds.length === 0) return null;
        // 모든 차수가 완전히 0이면 숨김 (기존 동작 유지)
        const anyNonZero = rounds.some(b => b.realTotal > 0 || b.fakeTotal > 0);
        if (!anyNonZero) return null;

        const realTotal = rounds.reduce((s, b) => s + b.realTotal, 0);
        const fakeTotal = rounds.reduce((s, b) => s + b.fakeTotal, 0);
        return { rounds, groupToCompany, realTotal, fakeTotal };
    }, [companySessions, allOrderRows, effectiveFakeInput, batchMasterRows, batchPlatforms]);

    // 전체 비용 목록: 수동 입력 + 자동 물류비(택배사별)
    const allExpenses = useMemo(() => {
        const autoExpenses: ExpenseRecord[] = [];
        const courierEntries = Object.entries(courierResults) as [string, { matched: number; total: number; notFound: string[] }][];
        const hasCourierResults = courierEntries.some(([_, r]) => r.matched > 0);

        if (hasCourierResults) {
            courierEntries.filter(([_, r]) => r.matched > 0).forEach(([templateId, r]) => {
                const tmpl = courierTemplates.find((t: CourierTemplate) => t.id === templateId);
                autoExpenses.push({
                    id: `auto-courier-${templateId}`,
                    category: '물류비',
                    amount: r.matched * (tmpl?.unitPrice || 2270),
                    description: `${tmpl?.name || '택배'} ${r.matched}건`,
                    isAuto: true,
                });
            });
        }
        // 운송장 매칭 전이라도 가구매 명단이 있으면 기본 물류비 자동 추가
        if (!hasCourierResults && fakeOrderAnalysis.inputNumbers.size > 0) {
            autoExpenses.push({
                id: 'auto-fake-default',
                category: '물류비',
                amount: fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice,
                description: `${fakeCourierSettings.name} ${fakeOrderAnalysis.inputNumbers.size}건`,
                isAuto: true,
            });
        }
        return [...autoExpenses, ...expenses];
    }, [expenses, courierResults, courierTemplates, fakeOrderAnalysis.inputNumbers.size]);

    // 플랫폼 자동 감지 (헤더 행 자동 탐색 + 이름 기반 열 리맵)
    const detectPlatform = (allRows: any[][]): { platform: PlatformConfig; name: string; score: number; columnRemap?: Record<number, number>; actualHeaderRowIdx: number; actualDataStartRow: number } | null => {
        const normalize = (s: any) => String(s || '').replace(/\s+/g, '').toLowerCase().normalize('NFC');
        let bestMatch: { platform: PlatformConfig; name: string; score: number; columnRemap?: Record<number, number>; actualHeaderRowIdx: number; actualDataStartRow: number } | null = null;

        for (const [platformName, pc] of Object.entries(platformConfigs) as [string, PlatformConfig][]) {
            if (!pc.sampleHeaders || pc.sampleHeaders.length === 0) continue;
            const sampleNormalized = pc.sampleHeaders.map(normalize);
            const nonEmptySamples = sampleNormalized.filter(h => h);
            if (nonEmptySamples.length === 0) continue;

            // 저장된 headerRowIndex 및 주변 행(±2)을 모두 시도하여 가장 잘 맞는 행 찾기
            const storedIdx = pc.headerRowIndex || 0;
            const candidateRows = new Set([storedIdx, storedIdx - 2, storedIdx - 1, storedIdx + 1, storedIdx + 2]);
            // 0~14행도 추가 후보로 검사 (안내문 줄 수 변동 대비)
            for (let r = 0; r < Math.min(allRows.length, 15); r++) candidateRows.add(r);

            for (const rowIdx of candidateRows) {
                if (rowIdx < 0 || rowIdx >= allRows.length) continue;
                const headerRow = allRows[rowIdx];
                if (!headerRow || headerRow.length < 3) continue;

                const uploadedHeaders = headerRow.map(normalize);

                // 1) 위치 기반 매칭 (기존)
                let positionalMatchCount = 0;
                for (let i = 0; i < Math.min(sampleNormalized.length, uploadedHeaders.length); i++) {
                    if (sampleNormalized[i] && sampleNormalized[i] === uploadedHeaders[i]) positionalMatchCount++;
                }
                const positionalScore = positionalMatchCount / nonEmptySamples.length;

                // 2) 이름 기반 매칭 — 헤더 이름으로 열을 찾아 리맵
                const columnRemap: Record<number, number> = {};
                const usedActualIndices = new Set<number>();
                let nameMatchCount = 0;
                for (let si = 0; si < sampleNormalized.length; si++) {
                    if (!sampleNormalized[si]) continue;
                    // 같은 위치에 있으면 우선 사용
                    if (si < uploadedHeaders.length && sampleNormalized[si] === uploadedHeaders[si] && !usedActualIndices.has(si)) {
                        columnRemap[si] = si;
                        usedActualIndices.add(si);
                        nameMatchCount++;
                        continue;
                    }
                    // 다른 위치에서 찾기
                    const actualIdx = uploadedHeaders.findIndex((h, idx) => h === sampleNormalized[si] && !usedActualIndices.has(idx));
                    if (actualIdx !== -1) {
                        columnRemap[si] = actualIdx;
                        usedActualIndices.add(actualIdx);
                        nameMatchCount++;
                    }
                }
                const nameScore = nameMatchCount / nonEmptySamples.length;

                const effectiveScore = Math.max(positionalScore, nameScore);
                const needsRemap = nameScore > positionalScore && Object.keys(columnRemap).some(k => columnRemap[Number(k)] !== Number(k));
                // 헤더 행이 저장된 것과 다르면 dataStartRow도 보정
                const headerOffset = rowIdx - storedIdx;
                const storedDataStart = pc.dataStartRow ?? (storedIdx + 1);
                const actualDataStart = storedDataStart + headerOffset;

                if (effectiveScore >= 0.6 && (!bestMatch || effectiveScore > bestMatch.score)) {
                    bestMatch = {
                        platform: pc,
                        name: platformName,
                        score: effectiveScore,
                        columnRemap: needsRemap ? columnRemap : undefined,
                        actualHeaderRowIdx: rowIdx,
                        actualDataStartRow: actualDataStart,
                    };
                }
            }
        }
        if (bestMatch) {
            const storedIdx = bestMatch.platform.headerRowIndex || 0;
            const rowShifted = bestMatch.actualHeaderRowIdx !== storedIdx;
            const colShifted = !!bestMatch.columnRemap;
            console.log(`[플랫폼 감지] ✅ "${bestMatch.name}" (${Math.round(bestMatch.score * 100)}%)${rowShifted ? ` — 헤더 행 변경: ${storedIdx}→${bestMatch.actualHeaderRowIdx}` : ''}${colShifted ? ' — 열 위치 변경, 리맵 적용' : ''}`);
            if (bestMatch.columnRemap) console.log(`[플랫폼 감지] columnRemap:`, bestMatch.columnRemap);
        } else {
            console.log(`[플랫폼 감지] ❌ 매칭되는 플랫폼 없음`);
        }
        return bestMatch;
    };

    // 플랫폼 데이터를 쿠팡 컬럼 위치로 정규화 (columnRemap: 열 위치 변경 시 리맵)
    const normalizePlatformRow = (row: any[], mapping: PlatformConfig['orderColumns'], columnRemap?: Record<number, number>): any[] => {
        // columnRemap이 있으면 config의 열 인덱스를 실제 파일의 열 인덱스로 변환
        const col = (configIdx: number | undefined | null): number | undefined | null => {
            if (configIdx == null) return configIdx;
            if (!columnRemap) return configIdx;
            return columnRemap[configIdx] ?? configIdx;
        };

        const normalized: any[] = new Array(31).fill('');
        normalized[2] = row[col(mapping.orderNumber)!] ?? '';

        const effectiveGroupName = col(mapping.groupName);
        if (effectiveGroupName != null) {
            normalized[10] = row[effectiveGroupName] ?? '';
        } else {
            // groupName 미매핑: 상품명~수량 사이의 미매핑 텍스트 열을 결합 (상품 관리 코드 등)
            const effectiveProductName = col(mapping.productName)!;
            const effectiveQuantity = col(mapping.quantity);
            const mappedIndices = new Set(
                [col(mapping.orderNumber), effectiveProductName, col(mapping.optionName), effectiveQuantity,
                 col(mapping.recipientName), col(mapping.recipientPhone), col(mapping.postalCode),
                 col(mapping.address), col(mapping.deliveryMessage), col(mapping.orderDate)]
                .filter(v => v != null) as number[]
            );
            const rangeStart = Math.max(0, effectiveProductName - 2);
            const rangeEnd = Math.min(row.length - 1, (effectiveQuantity ?? effectiveProductName) + 2);
            const extras: string[] = [];
            for (let c = rangeStart; c <= rangeEnd; c++) {
                if (mappedIndices.has(c)) continue;
                const val = String(row[c] || '').trim();
                if (val && isNaN(Number(val)) && val.length > 1 && val.length < 40) {
                    extras.push(val);
                }
            }
            normalized[10] = extras.join(' ');
        }

        const effectiveProdIdx = col(mapping.productName)!;
        const effectiveOptIdx = col(mapping.optionName);
        let productName = String(row[effectiveProdIdx] ?? '').trim();
        if (effectiveOptIdx != null && row[effectiveOptIdx]) {
            const optionName = String(row[effectiveOptIdx]).trim();
            if (optionName) productName = productName ? `${productName} ${optionName}` : optionName;
        }
        normalized[11] = productName;
        normalized[22] = row[col(mapping.quantity)!] ?? '';
        normalized[26] = row[col(mapping.recipientName)!] ?? '';
        normalized[27] = row[col(mapping.recipientPhone)!] ?? '';
        const effectivePostal = col(mapping.postalCode);
        normalized[28] = effectivePostal != null ? (row[effectivePostal] ?? '') : '';
        normalized[29] = row[col(mapping.address)!] ?? '';
        const effectiveMsg = col(mapping.deliveryMessage);
        normalized[30] = effectiveMsg != null ? (row[effectiveMsg] ?? '') : '';
        return normalized;
    };

    const handleMasterUpload = async (file: File) => {
        console.log('🚀 [파일 업로드] 시작:', file.name);
        console.log('🚀 [platformConfigs]:', platformConfigs);
        if (fakeMismatch) alert('미매칭(수량)을 확인해주세요.');
        masterOrderFileRef.current = file; // 공통 패널의 getNextRound가 React 재렌더 전에도 올바른 값을 읽도록
        setMasterOrderFile(file);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            let json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];
            if (!json || json.length < 2) return;

            // 플랫폼 감지 및 정규화
            const detectedPlatform = detectPlatform(json);
            let platformName: string | null = null;

            if (detectedPlatform) {
                platformName = detectedPlatform.name;
                const pc = detectedPlatform.platform;
                // 자동 감지된 헤더 행/데이터 시작 행 사용 (토스 등 양식 변경 대응)
                const dataStart = detectedPlatform.actualDataStartRow;

                // 쿠팡 형식 헤더 생성
                const coupangHeader = new Array(31).fill('');
                coupangHeader[2] = '주문번호';
                coupangHeader[10] = '그룹명';
                coupangHeader[11] = '상품명';
                coupangHeader[22] = '수량';
                coupangHeader[26] = '받는분';
                coupangHeader[27] = '전화번호';
                coupangHeader[28] = '우편번호';
                coupangHeader[29] = '주소';
                coupangHeader[30] = '배송메세지';

                const normalized = [coupangHeader];
                for (let i = dataStart; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.every((c: any) => !c)) continue;
                    normalized.push(normalizePlatformRow(row, pc.orderColumns, detectedPlatform.columnRemap));
                }

                json = normalized;
                setUploadedPlatforms([{ name: platformName, count: normalized.length - 1 }]);
                setRowPlatformSources([null, ...Array(normalized.length - 1).fill(platformName)]);

                // 정규화된 데이터를 파일로 저장
                const normalizedSheet = XLSX.utils.aoa_to_sheet(json);
                const normalizedWb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(normalizedWb, normalizedSheet, 'Sheet1');
                const normalizedBuffer = XLSX.write(normalizedWb, { bookType: 'xlsx', type: 'array' });
                const normalizedFile = new File([normalizedBuffer], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });
                masterOrderFileRef.current = normalizedFile;
                setMasterOrderFile(normalizedFile);

                console.log(`✅ [Platform] "${platformName}" 감지됨 (${Math.round(detectedPlatform.score * 100)}% 일치)${detectedPlatform.columnRemap ? ' [열 리맵]' : ''}, 헤더행=${detectedPlatform.actualHeaderRowIdx}, 데이터시작=${dataStart}: ${json.length - 1}건 정규화`);
            } else {
                setUploadedPlatforms([{ name: '쿠팡', count: json.length - 1 }]);
                setRowPlatformSources([]);
                const stdFile = new File([data], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });
                masterOrderFileRef.current = stdFile;
                setMasterOrderFile(stdFile);
            }

            const groupColIdx = 10;
            const productColIdx = 11;
            const companiesInFile = new Set<string>();
            const companyKeywordsMap = new Map<string, string[]>();
            Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
            for (let i = 1; i < json.length; i++) {
                const rawGroup = String(json[i][groupColIdx] || '');
                const groupVal = rawGroup.replace(/\s+/g, '').normalize('NFC');
                // groupName이 없으면 productName으로 폴백 (토스 등 그룹명 없는 플랫폼)
                const matchTarget = groupVal || String(json[i][productColIdx] || '').replace(/\s+/g, '').normalize('NFC');
                if (!matchTarget) continue;
                let bestCompany = '';
                let bestPos = Infinity;
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    for (const k of keywords) {
                        const pos = matchTarget.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                        if (pos !== -1 && pos < bestPos) {
                            bestPos = pos;
                            bestCompany = name;
                        }
                    }
                }
                // K열이 비어있을 때만 전체 행 폴백 (토스 등 비표준 열 구조)
                if (!bestCompany && !groupVal) {
                    const fullRowText = json[i].map((v: any) => String(v || '')).join(' ').replace(/\s+/g, '').normalize('NFC');
                    for (const [name, keywords] of companyKeywordsMap.entries()) {
                        for (const k of keywords) {
                            const pos = fullRowText.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                            if (pos !== -1 && pos < bestPos) {
                                bestPos = pos;
                                bestCompany = name;
                            }
                        }
                    }
                }
                if (bestCompany) companiesInFile.add(bestCompany);
            }
            setDetectedCompanies(companiesInFile);
            setMasterOrderData(json);
            setKReplaceFrom('');
            setKReplaceTo('');
            setKReplaceToCompany('');
            setKReplaceProductMap({});
            setKReplaceHistory([]);

            // 기존 수동 입금내역이 있으면 포함 여부 확인
            if (manualTransfers.length > 0) {
                const transferList = manualTransfers.map(t => `  • ${t.label || '수동 입금'} - ${t.amount.toLocaleString()}원`).join('\n');
                const totalAmount = manualTransfers.reduce((sum, t) => sum + t.amount, 0);
                if (!confirm(`기존 수동 입금내역 ${manualTransfers.length}건 (총 ${totalAmount.toLocaleString()}원)이 있습니다.\n포함하시겠습니까?\n\n${transferList}\n\n[확인] 유지  |  [취소] 삭제`)) {
                    setManualTransfers([]);
                }
            }
        } catch (error) { console.error("Master upload analysis failed:", error); }
    };

    const clearMasterFile = () => {
        masterOrderFileRef.current = null;
        nextBatchRoundRef.current = 0;
        setMasterOrderFile(null);
        setMasterOrderData(null);
        setDetectedCompanies(new Set());
        setUploadedPlatforms([]);
        setRowPlatformSources([]);
        setKReplaceFrom('');
        setKReplaceFromCompany('');
        setKReplaceTo('');
        setKReplaceToCompany('');
        setKReplaceProductMap({});
        setKReplaceHistory([]);
        setKReplaceRound(null);
        setBatchFiles({});
        setBatchExpectedCounts({});
        setBatchMasterRows({});
        setBatchPlatforms({});
        setFakeMasterOrderFile(null);
        setFakeMasterOrderData(null);
        const initial: Record<string, SessionData[]> = {};
        Object.keys(pricingConfig).forEach(name => {
            initial[name] = [{ id: `${name}-1`, companyName: name, round: 1 }];
        });
        setCompanySessions(initial);
        setWorkstationResetKey(prev => prev + 1);
    };

    const applyKValueReplacement = () => {
        if (!kReplaceFrom || !kReplaceTo) return;
        const fromProducts = kReplaceFromCompany ? (pricingConfig as import('../types').PricingConfig)[kReplaceFromCompany]?.products || {} : {};
        const hasProductMap = Object.keys(kReplaceProductMap).length > 0;

        const applyRowReplacement = (rows: any[][], optionColIdx: number): any[][] =>
            rows.map(row => {
                const currentK = String(row[10] || '').trim();
                if (currentK !== kReplaceFrom) return row;
                const newRow = [...row];
                newRow[10] = kReplaceTo;
                if (hasProductMap) {
                    const rowL = String(row[11] || '').trim();
                    const optionVal = optionColIdx !== -1 ? String(row[optionColIdx] || '').trim() : '';
                    let rawPN = `${currentK} ${rowL}`.trim();
                    if (optionVal) rawPN += ' ' + optionVal;
                    const matchedFrom = matchProductSync(rawPN, fromProducts, currentK);
                    if (matchedFrom && kReplaceProductMap[matchedFrom]) {
                        newRow[11] = kReplaceProductMap[matchedFrom];
                    }
                }
                return newRow;
            });

        const isBatchRound = kReplaceRound !== null && kReplaceRound > 1;

        if (!isBatchRound) {
            // ── 1차수(마스터) 교체 ──────────────────────────────────────
            if (!masterOrderData || !masterOrderFile) return;
            const headers0 = ((masterOrderData[0] as any[]) || []).map((h: any) => String(h || '').trim());
            let optionColIdx = headers0.findIndex((h: string) => h.includes('옵션정보'));
            if (optionColIdx === -1) optionColIdx = headers0.findIndex((h: string) => h.includes('옵션') && !h.includes('관리코드') && !h.includes('번호'));

            const updated = [masterOrderData[0], ...applyRowReplacement(masterOrderData.slice(1), optionColIdx)];
            const changedCount = updated.slice(1).filter((r, i) => String(r[10] || '') !== String(masterOrderData[i + 1]?.[10] || '')).length;
            setMasterOrderData(updated);
            if (changedCount > 0) {
                // 실제로 행이 변경된 경우에만 새 File 생성 (불필요한 1차수 재트리거 방지)
                const ws = XLSX.utils.aoa_to_sheet(updated);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
                const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                setMasterOrderFile(new File([buf], masterOrderFile.name, { type: masterOrderFile.type }));
                setDetectedCompanies(prev => {
                    const next = new Set(prev);
                    if (kReplaceToCompany) next.add(kReplaceToCompany);
                    const fromStillHasRows = updated.slice(1).some((r: any[]) => String(r[10] || '').trim() === kReplaceFrom);
                    if (!fromStillHasRows && kReplaceFromCompany) next.delete(kReplaceFromCompany);
                    return next;
                });
            }
        } else {
            // ── N차수(batch) 교체 ─────────────────────────────────────
            if (!kReplaceFromCompany || !kReplaceToCompany) return;
            const headers0 = masterOrderData ? ((masterOrderData[0] as any[]) || []).map((h: any) => String(h || '').trim()) : [];
            let optionColIdx = headers0.findIndex((h: string) => h.includes('옵션정보'));
            if (optionColIdx === -1) optionColIdx = headers0.findIndex((h: string) => h.includes('옵션') && !h.includes('관리코드') && !h.includes('번호'));

            const targetSessions = (companySessions[kReplaceFromCompany] || [])
                .filter(s => s.round === kReplaceRound && !!batchFiles[s.id]);
            if (targetSessions.length === 0) return;

            const newCompanySessions = { ...companySessions };
            const addedBatchFiles: Record<string, File> = {};
            const addedBatchMasterRows: Record<string, any[][]> = {};
            const addedBatchExpectedCounts: Record<string, number> = {};
            const addedBatchPlatforms: Record<string, string> = {};
            const removedIds = new Set<string>();
            const newSelectedIds = new Set(selectedSessionIds);

            for (const session of targetSessions) {
                const newRows = applyRowReplacement(batchMasterRows[session.id] || [], optionColIdx);
                const newSessionId = `${kReplaceToCompany}-batch-${session.round}-${Date.now()}`;
                newCompanySessions[kReplaceToCompany] = [
                    ...(newCompanySessions[kReplaceToCompany] || []).filter(s => s.round !== session.round),
                    { id: newSessionId, companyName: kReplaceToCompany, round: session.round },
                ];
                const headers = masterOrderData?.[0] || [];
                const ws2 = XLSX.utils.aoa_to_sheet([headers, ...newRows]);
                const wb2 = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb2, ws2, 'Sheet1');
                const buf2 = XLSX.write(wb2, { bookType: 'xlsx', type: 'array' });
                addedBatchFiles[newSessionId] = new File([buf2], `k교체_${kReplaceToCompany}_${session.round}차.xlsx`);
                addedBatchMasterRows[newSessionId] = newRows;
                addedBatchExpectedCounts[newSessionId] = newRows.length;
                addedBatchPlatforms[newSessionId] = batchPlatforms[session.id] || '쿠팡';
                removedIds.add(session.id);
                newSelectedIds.delete(session.id);
                newSelectedIds.add(newSessionId);
            }
            newCompanySessions[kReplaceFromCompany] = (newCompanySessions[kReplaceFromCompany] || []).filter(s => !removedIds.has(s.id));
            if (newCompanySessions[kReplaceFromCompany].length === 0) delete newCompanySessions[kReplaceFromCompany];

            setCompanySessions(newCompanySessions);
            setSelectedSessionIds(newSelectedIds);
            setBatchFiles(prev => { const n = { ...prev }; removedIds.forEach(id => delete n[id]); return { ...n, ...addedBatchFiles }; });
            setBatchMasterRows(prev => { const n = { ...prev }; removedIds.forEach(id => delete n[id]); return { ...n, ...addedBatchMasterRows }; });
            setBatchExpectedCounts(prev => { const n = { ...prev }; removedIds.forEach(id => delete n[id]); return { ...n, ...addedBatchExpectedCounts }; });
            setBatchPlatforms(prev => { const n = { ...prev }; removedIds.forEach(id => delete n[id]); return { ...n, ...addedBatchPlatforms }; });
        }

        setKReplaceHistory(prev => [...prev, { from: kReplaceFrom, to: kReplaceTo, productMap: hasProductMap ? { ...kReplaceProductMap } : undefined, round: kReplaceRound ?? 1 } as any]);
        setKReplaceFrom('');
        setKReplaceFromCompany('');
        setKReplaceTo('');
        setKReplaceToCompany('');
        setKReplaceProductMap({});
    };

    const handleFakeMasterUpload = async (file: File) => {
        setFakeMasterOrderFile(file);
        setFakeMasterOrderData(null);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            let json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];
            if (!json || json.length < 2) return;

            const detectedPlatform = detectPlatform(json);
            if (detectedPlatform) {
                const pc = detectedPlatform.platform;
                const dataStart = detectedPlatform.actualDataStartRow;
                const coupangHeader = new Array(31).fill('');
                coupangHeader[2] = '주문번호';
                coupangHeader[10] = '그룹명';
                coupangHeader[11] = '상품명';
                coupangHeader[22] = '수량';
                coupangHeader[26] = '받는분';
                coupangHeader[27] = '전화번호';
                coupangHeader[28] = '우편번호';
                coupangHeader[29] = '주소';
                coupangHeader[30] = '배송메세지';
                const normalized = [coupangHeader];
                for (let i = dataStart; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.every((c: any) => !c)) continue;
                    normalized.push(normalizePlatformRow(row, pc.orderColumns, detectedPlatform.columnRemap));
                }
                json = normalized;
                const normalizedSheet = XLSX.utils.aoa_to_sheet(json);
                const normalizedWb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(normalizedWb, normalizedSheet, 'Sheet1');
                const normalizedBuffer = XLSX.write(normalizedWb, { bookType: 'xlsx', type: 'array' });
                setFakeMasterOrderFile(new File([normalizedBuffer], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }));
            } else {
                setFakeMasterOrderFile(new File([data], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }));
            }
            setFakeMasterOrderData(json);
        } catch (error) { console.error("Fake master upload failed:", error); }
    };

    const handleBatchUpload = async (file: File) => {
        console.log('🚀 [배치 업로드] 시작:', file.name);
        if (fakeMismatch) alert('미매칭(수량)을 확인해주세요.');
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            let json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
            if (!json || json.length < 2) { throw new Error('유효한 주문서가 아닙니다.'); }

            // 플랫폼 감지 및 정규화 (마스터 업로드와 동일)
            const detectedPlatform = detectPlatform(json);
            if (detectedPlatform) {
                const platformName = detectedPlatform.name;
                const pc = detectedPlatform.platform;
                const dataStart = detectedPlatform.actualDataStartRow;

                // 쿠팡 형식 헤더 생성
                const coupangHeader = new Array(31).fill('');
                coupangHeader[2] = '주문번호';
                coupangHeader[10] = '그룹명';
                coupangHeader[11] = '상품명';
                coupangHeader[22] = '수량';
                coupangHeader[26] = '받는분';
                coupangHeader[27] = '전화번호';
                coupangHeader[28] = '우편번호';
                coupangHeader[29] = '주소';
                coupangHeader[30] = '배송메세지';

                const normalized = [coupangHeader];
                for (let i = dataStart; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.every((c: any) => !c)) continue;
                    normalized.push(normalizePlatformRow(row, pc.orderColumns, detectedPlatform.columnRemap));
                }

                json = normalized;
                console.log(`✅ [배치 정규화] "${platformName}" 감지됨 (${Math.round(detectedPlatform.score * 100)}% 일치)${detectedPlatform.columnRemap ? ' [열 리맵]' : ''}, 헤더행=${detectedPlatform.actualHeaderRowIdx}, 데이터시작=${dataStart}: ${json.length - 1}건 정규화`);
            }

            // 정규화된 데이터를 파일로 생성 (플랫폼 파일인 경우)
            let processedFile = file;
            if (detectedPlatform) {
                const normalizedSheet = XLSX.utils.aoa_to_sheet(json);
                const normalizedWb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(normalizedWb, normalizedSheet, 'Sheet1');
                const normalizedBuffer = XLSX.write(normalizedWb, { bookType: 'xlsx', type: 'array' });
                processedFile = new File([normalizedBuffer], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });
            }

            const groupColIdx = 10;
            const productColIdx = 11;
            const companyRowCounts: Record<string, number> = {};
            const companyKeywordsMap = new Map<string, string[]>();
            Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
            for (let i = 1; i < json.length; i++) {
                const rawGroup = String(json[i][groupColIdx] || '').replace(/\s+/g, '').normalize('NFC');
                // groupName이 없으면 productName으로 폴백 (토스 등 그룹명 없는 플랫폼)
                const groupVal = rawGroup || String(json[i][productColIdx] || '').replace(/\s+/g, '').normalize('NFC');
                if (!groupVal) continue;
                let bestCompany = '';
                let bestPos = Infinity;
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    for (const k of keywords) {
                        const pos = groupVal.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                        if (pos !== -1 && pos < bestPos) {
                            bestPos = pos;
                            bestCompany = name;
                        }
                    }
                }
                // K열이 비어있을 때만 전체 행 폴백 (토스 등 비표준 열 구조)
                if (!bestCompany && !rawGroup) {
                    const fullRowText = json[i].map((v: any) => String(v || '')).join(' ').replace(/\s+/g, '').normalize('NFC');
                    for (const [name, keywords] of companyKeywordsMap.entries()) {
                        for (const k of keywords) {
                            const pos = fullRowText.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                            if (pos !== -1 && pos < bestPos) {
                                bestPos = pos;
                                bestCompany = name;
                            }
                        }
                    }
                }
                if (bestCompany) companyRowCounts[bestCompany] = (companyRowCounts[bestCompany] || 0) + 1;
            }
            const companiesInFile = new Set(Object.keys(companyRowCounts));
            if (companiesInFile.size === 0) { throw new Error('주문서에서 매칭되는 업체를 찾지 못했습니다. (키워드 확인 필요)'); }
            const nextRound = nextBatchRoundRef.current + 2;
            nextBatchRoundRef.current += 1;
            const newBatchFiles: Record<string, File> = {};
            const newExpectedCounts: Record<string, number> = {};
            const newBatchMasterRows: Record<string, any[][]> = {};
            // 이번 배치에서 추가할 세션 목록 (업체명 → 세션)
            const newSessionsByCompany: [string, SessionData][] = [];
            for (const companyName of companiesInFile) {
                if (closedCompanies.has(companyName)) continue;
                const newSessionId = `${companyName}-batch-${nextRound}-${Date.now()}`;
                const newSession: SessionData = { id: newSessionId, companyName, round: nextRound };
                newSessionsByCompany.push([companyName, newSession]);
                newBatchFiles[newSessionId] = processedFile;
                newExpectedCounts[newSessionId] = companyRowCounts[companyName] || 0;
                // 이 업체에 해당하는 마스터-포맷 행만 필터해서 저장
                const companyRows: any[][] = [];
                for (let i = 1; i < json.length; i++) {
                    const groupVal = String(json[i][groupColIdx] || '').replace(/\s+/g, '').normalize('NFC');
                    if (!groupVal) continue;
                    // 가장 앞 위치 매칭 업체가 이 업체와 같은지 확인
                    let bestCompany = '';
                    let bestPos = Infinity;
                    for (const [name, kws] of companyKeywordsMap.entries()) {
                        for (const k of kws) {
                            const pos = groupVal.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                            if (pos !== -1 && pos < bestPos) { bestPos = pos; bestCompany = name; }
                        }
                    }
                    if (bestCompany === companyName) companyRows.push(json[i]);
                }
                newBatchMasterRows[newSessionId] = companyRows;
            }
            // functional update로 이전 배치 세션 덮어쓰기 방지
            setCompanySessions(prev => {
                const n = { ...prev };
                for (const [companyName, session] of newSessionsByCompany) {
                    n[companyName] = [...(n[companyName] || []), session];
                }
                return n;
            });
            setSelectedSessionIds(prev => {
                const next = new Set(prev);
                for (const [, session] of newSessionsByCompany) next.add(session.id);
                return next;
            });
            setBatchFiles(prev => ({ ...prev, ...newBatchFiles }));
            setBatchExpectedCounts(prev => ({ ...prev, ...newExpectedCounts }));
            setBatchMasterRows(prev => ({ ...prev, ...newBatchMasterRows }));
            // 배치 세션별 플랫폼명 저장
            const batchPlatformName = detectedPlatform ? detectedPlatform.name : '쿠팡';
            const newBatchPlatforms: Record<string, string> = {};
            for (const sessionId of Object.keys(newBatchFiles)) {
                newBatchPlatforms[sessionId] = batchPlatformName;
            }
            setBatchPlatforms(prev => ({ ...prev, ...newBatchPlatforms }));
        } catch (error) {
            console.error("Batch upload failed:", error);
            throw error;
        }
    };

    // 공통 업로드 핸들러 등록 — ref 선언 (current 할당은 아래 각 함수 선언 이후)
    const masterUploadRef = useRef<(file: File) => Promise<void>>(async () => {});
    const batchUploadRef = useRef<(file: File) => Promise<void>>(async () => {});
    const getNextRoundRef = useRef<() => number>(() => 1);
    const deleteBatchRoundRef = useRef<(round: number) => boolean>(() => false);
    const clearMasterRef = useRef<() => void>(() => {});
    const getOrderStateRef = useRef<() => { name: string; rounds: { round: number; hasData: boolean }[] }[]>(() => []);
    const companyLastSettlementRef = useRef<Record<string, { kakaoText: string; excelText: string }>>({});
    const getLastSettlementSummariesRef = useRef<() => { companyName: string; kakaoText: string; excelText: string }[]>(() => []);
    const downloadCompanyMergedRef = useRef<(companyName: string) => void>(() => {});
    const downloadCompanyRoundRef = useRef<(companyName: string, round: number) => void>(() => {});
    const getCompanyClosedRef = useRef<(companyName: string) => boolean>(() => false);
    const getCompanyRecordedRef = useRef<(companyName: string) => boolean>(() => false);
    const toggleCompanyClosedRef = useRef<(companyName: string) => void>(() => {});
    const toggleCompanyRecordRef = useRef<(companyName: string) => void>(() => {});
    const downloadAllCompaniesRef = useRef<() => void>(() => {});
    const uploadVendorInvoiceRef = useRef((_files: File[]) => {});
    const getInvoiceStateRef = useRef(() => [] as { name: string; uploadCount: number }[]);
    const downloadAllInvoicesRef = useRef(() => {});
    const getInvoiceWorkbookFileRef = useRef<() => File | null>(() => null);
    // 배치 차수 카운터: React state 재렌더 대기 없이 즉시 갱신하는 ref
    masterUploadRef.current = handleMasterUpload;
    batchUploadRef.current = handleBatchUpload;
    getNextRoundRef.current = () => {
        if (!masterOrderFileRef.current) return 1;
        return nextBatchRoundRef.current + 2;
    };
    clearMasterRef.current = clearMasterFile;
    getOrderStateRef.current = () => {
        const orderedNames = companyOrder.filter(id => !isDivider(id) && id in companySessions);
        const unordered = Object.keys(companySessions).filter(n => !orderedNames.includes(n));
        return [...orderedNames, ...unordered]
            .map(companyName => ({
                name: companyName,
                rounds: (companySessions[companyName] as SessionData[]).map(s => ({
                    round: s.round,
                    hasData: (allOrderRows[s.id]?.length || 0) > 0,
                    count: allOrderRows[s.id]?.length || 0,
                })),
            }))
            .filter(c => c.rounds.some(r => r.hasData));
    };
    getLastSettlementSummariesRef.current = () => {
        const orderedNames = companyOrder.filter(id => !isDivider(id) && id in companySessions);
        const unordered = Object.keys(companySessions).filter(n => !orderedNames.includes(n));
        return [...orderedNames, ...unordered]
            .filter(name => companyLastSettlementRef.current[name])
            .map(name => ({
                companyName: name,
                kakaoText: companyLastSettlementRef.current[name].kakaoText,
                excelText: companyLastSettlementRef.current[name].excelText,
            }));
    };
    downloadCompanyMergedRef.current = (companyName: string) => {
        handleDownloadMergedOrder(companyName);
    };
    downloadCompanyRoundRef.current = (companyName: string, round: number) => {
        const sessions = companySessions[companyName] || [];
        const session = (sessions as SessionData[]).find(s => s.round === round);
        if (!session) return;
        const rows = allOrderRows[session.id];
        if (!rows || rows.length === 0) { alert('해당 차수 발주 데이터가 없습니다.'); return; }
        const companyConfig = pricingConfig[companyName];
        if (!companyConfig) return;
        const header = getHeaderForCompany(companyName, companyConfig);
        const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
        ws['!cols'] = header.map(() => ({ wch: 15 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '발주서');
        const dateStr = new Date().toLocaleDateString('en-CA');
        XLSX.writeFile(wb, `${dateStr} ${businessPrefix ? businessPrefix + ' ' : ''}${companyName} ${round}차발주서.xlsx`);
    };
    downloadAllCompaniesRef.current = () => {
        const allCompanies = Object.keys(companySessions).filter(name =>
            (companySessions[name] as SessionData[]).some(s => (allOrderRows[s.id]?.length || 0) > 0)
        );
        handleGroupDownloadOrders(allCompanies);
    };
    getCompanyClosedRef.current = (companyName: string) => closedCompanies.has(companyName);
    getCompanyRecordedRef.current = (companyName: string) => recordedCompanies.has(companyName);
    // deleteBatchRoundRef.current 는 handleDeleteBatchRound 선언 이후에 할당
    const onRegisterMasterUploadRef = useRef(onRegisterMasterUpload);
    onRegisterMasterUploadRef.current = onRegisterMasterUpload;
    useEffect(() => {
        onRegisterMasterUploadRef.current?.({
            uploadMaster: (file) => masterUploadRef.current(file),
            uploadBatch: (file) => batchUploadRef.current(file),
            getNextRound: () => getNextRoundRef.current(),
            deleteBatchRound: (round) => deleteBatchRoundRef.current(round),
            clearMaster: () => clearMasterRef.current(),
            getOrderState: () => getOrderStateRef.current(),
            downloadCompanyMerged: (companyName) => downloadCompanyMergedRef.current(companyName),
            downloadCompanyRound: (companyName, round) => downloadCompanyRoundRef.current(companyName, round),
            downloadAllCompanies: () => downloadAllCompaniesRef.current(),
            getCompanyClosed: (companyName) => getCompanyClosedRef.current(companyName),
            getCompanyRecorded: (companyName) => getCompanyRecordedRef.current(companyName),
            toggleCompanyClosed: (companyName) => toggleCompanyClosedRef.current(companyName),
            toggleCompanyRecord: (companyName) => toggleCompanyRecordRef.current(companyName),
            uploadVendorInvoice: (files) => uploadVendorInvoiceRef.current(files),
            getInvoiceState: () => getInvoiceStateRef.current(),
            downloadInvoice: (companyName) => wsInvoiceDownloadRef.current(companyName),
            downloadAllInvoices: () => downloadAllInvoicesRef.current(),
            getInvoiceWorkbookFile: () => getInvoiceWorkbookFileRef.current(),
            getLastSettlementSummaries: () => getLastSettlementSummariesRef.current(),
        });
    // 마운트 시 1회만 실행 - onRegisterMasterUpload dep 변경 시 재실행하면 루프 발생
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 범용 택배 양식 다운로드: 템플릿 매핑에 따라 주문 데이터 채워서 다운로드
    const handleCourierDownload = async (template: CourierTemplate) => {
        const activeCourierFile = fakeMasterOrderFile ?? masterOrderFile;
        if (!activeCourierFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }

        try {
            // 1차 마스터 파일 읽기
            const masterData = await activeCourierFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            const fakeOrderNums = resolveFakeOrderNumbers(effectiveFakeInput, { normalize: true });
            if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

            // 2차+ 배치 파일 행도 합치기
            const allRows: any[][] = [...masterAoa.slice(1)];
            (Object.values(batchMasterRows) as any[][][]).forEach(batchRows => {
                allRows.push(...batchRows);
            });

            const rows: any[][] = [[...template.headers]];
            const notFoundOrders: string[] = [];
            const seenOrderNums = new Set<string>();
            const { mapping, fixedValues } = template;

            for (const row of allRows) {
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;
                if (seenOrderNums.has(orderNum)) continue;
                seenOrderNums.add(orderNum);

                const recipientName = String(row[26] || '').trim();
                const phone = String(row[27] || '').trim();
                const address = String(row[29] || '').trim();
                const originalOrderNum = String(row[2] || '').trim();

                if (!recipientName) { notFoundOrders.push(originalOrderNum); }

                const newRow = new Array(template.headers.length).fill('');
                newRow[mapping.orderNumber] = originalOrderNum;
                newRow[mapping.recipientName] = recipientName;
                newRow[mapping.recipientPhone] = phone;
                newRow[mapping.recipientAddress] = address;
                // 운송장번호 열은 비워둠 (택배사가 채움)
                // 고정값 채우기
                Object.entries(fixedValues).forEach(([colIdx, value]) => {
                    newRow[Number(colIdx)] = value;
                });
                rows.push(newRow);
            }

            const matchedCount = rows.length - 1;
            if (matchedCount === 0) { alert('원본 주문서에서 가구매 명단과 매칭되는 주문을 찾지 못했습니다.'); return; }

            const ws = XLSX.utils.aoa_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            const fullTmplName = template.label ? `${template.name} (${template.label})` : template.name;
            const tmplSuffix = fullTmplName.includes('사무실') ? '사무실' : fullTmplName.includes('대행') ? '택배대행' : fullTmplName;
            XLSX.writeFile(wb, `${new Date().toLocaleDateString('en-CA')} ${businessPrefix} ${tmplSuffix}.xlsx`);

            if (notFoundOrders.length > 0) {
                alert(`${template.name} ${matchedCount}건 다운로드 완료!\n\n배송정보 누락 ${notFoundOrders.length}건: ${notFoundOrders.join(', ')}`);
            }
        } catch (err: any) {
            console.error(`${template.name} 처리 오류:`, err);
            alert(`${template.name} 파일 생성 중 오류가 발생했습니다: ` + err.message);
        }
    };

    // 범용 운송장 파일 업로드: 템플릿 매핑에 따라 주문번호/운송장번호 매칭
    const handleCourierFileUpload = async (template: CourierTemplate, file: File) => {
        const activeCourierFile = fakeMasterOrderFile ?? masterOrderFile;
        if (!activeCourierFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
        setCourierFiles(prev => ({ ...prev, [template.id]: file }));
        setCourierResults(prev => { const n = { ...prev }; delete n[template.id]; return n; });
        setCourierMatchedRows(prev => { const n = { ...prev }; delete n[template.id]; return n; });
        try {
            // 운송장 파일 읽기: returnMapping 우선, 없으면 기존 mapping 사용
            const courierData = await file.arrayBuffer();
            const courierWb = XLSX.read(courierData, { type: 'array' });
            const courierWs = courierWb.Sheets[courierWb.SheetNames[0]];
            const courierAoa: any[][] = XLSX.utils.sheet_to_json(courierWs, { header: 1 });

            const rm = template.returnMapping;
            const orderColIdx = rm ? rm.orderNumber : template.mapping.orderNumber;
            const trackingColIdx = rm ? rm.trackingNumber : template.mapping.trackingNumber;
            console.log(`[가구매송장] ${template.name} 운송장 업로드 - returnMapping: ${rm ? '있음' : '없음(기존 mapping 사용)'}, 주문번호열: ${orderColIdx}, 송장번호열: ${trackingColIdx}`);

            const trackingMap = new Map<string, string>();
            for (let i = 1; i < courierAoa.length; i++) {
                const row = courierAoa[i];
                if (!row) continue;
                const orderNum = String(row[orderColIdx] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                const trackingNum = String(row[trackingColIdx] || '').trim();
                if (orderNum && trackingNum && trackingNum.length >= 5) {
                    trackingMap.set(orderNum, trackingNum);
                }
            }
            console.log(`[가구매송장] trackingMap: ${trackingMap.size}건`);

            // 원본 주문서 + 2차+ 배치 행에서 매칭
            const masterData = await activeCourierFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            const fakeOrderNums = resolveFakeOrderNumbers(effectiveFakeInput, { normalize: true });
            if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }
            console.log(`[가구매송장] 가구매 주문번호: ${fakeOrderNums.size}건`);

            const header = masterAoa[0] || [];
            const allRows: any[][] = [...masterAoa.slice(1)];
            (Object.values(batchMasterRows) as any[][][]).forEach(batchRows => {
                allRows.push(...batchRows);
            });

            // 플랫폼 감지 → invoiceColumns로 송장번호/택배사 열 위치 결정
            const masterPlatformName = uploadedPlatforms.length > 0 ? uploadedPlatforms[0].name : '';
            const masterPlatformConfig = masterPlatformName && platformConfigs?.[masterPlatformName] ? platformConfigs[masterPlatformName] : null;
            const invCols = masterPlatformConfig?.invoiceColumns;
            const outTrackingCol = invCols?.trackingNumber ?? 4;
            const outCourierCol = invCols?.courierName ?? 3;

            const matchedRows: any[][] = [header];
            const notFoundOrders: string[] = [];
            const seenOrderNums = new Set<string>();
            for (const row of allRows) {
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;
                if (seenOrderNums.has(orderNum)) continue;
                seenOrderNums.add(orderNum);
                const tracking = trackingMap.get(orderNum);
                if (tracking) {
                    const newRow = [...row];
                    while (newRow.length <= Math.max(outTrackingCol, outCourierCol)) newRow.push('');
                    newRow[outCourierCol] = template.name;
                    newRow[outTrackingCol] = tracking;
                    matchedRows.push(newRow);
                } else {
                    notFoundOrders.push(String(row[2] || ''));
                }
            }

            const matchedCount = matchedRows.length - 1;
            setCourierResults(prev => ({ ...prev, [template.id]: { matched: matchedCount, total: fakeOrderNums.size, notFound: notFoundOrders } }));
            if (matchedCount > 0) setCourierMatchedRows(prev => ({ ...prev, [template.id]: matchedRows }));
        } catch (err: any) {
            console.error(`${template.name} 운송장 처리 오류:`, err);
            alert(`${template.name} 운송장 파일 처리 중 오류가 발생했습니다: ` + err.message);
        }
    };

    // 범용 운송장 매칭 결과 다운로드
    const handleCourierResultDownload = (templateId: string) => {
        const rows = courierMatchedRows[templateId];
        if (!rows) return;
        const tmpl = courierTemplates.find((t: CourierTemplate) => t.id === templateId);
        const fullTmplName = tmpl ? (tmpl.label ? `${tmpl.name} (${tmpl.label})` : tmpl.name) : '택배';
        const tmplSuffix = fullTmplName.includes('사무실') ? '사무실' : fullTmplName.includes('대행') ? '택배대행' : fullTmplName;
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '주문서');
        XLSX.writeFile(wb, `${new Date().toLocaleDateString('en-CA')} ${businessPrefix} ${tmplSuffix} 운송장완료.xlsx`);
    };

    const handleCourierTemplateDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = courierTemplates.findIndex((t: CourierTemplate) => t.id === active.id);
        const newIndex = courierTemplates.findIndex((t: CourierTemplate) => t.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;
        saveCourierTemplates(arrayMove(courierTemplates, oldIndex, newIndex));
    };

    const handleAddManualOrder = (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualInput.companyName || !manualInput.recipientName || !manualInput.productName) {
            alert('업체, 수령자 이름, 품목명은 필수입니다.'); return;
        }
        if (editingOrderId) {
            setManualOrders(prev => prev.map(o => o.id === editingOrderId ? {
                ...o, companyName: manualInput.companyName, recipientName: manualInput.recipientName,
                phone: manualInput.phone, address: manualInput.address, productName: manualInput.productName,
                qty: parseInt(manualInput.qty) || 1, memo: manualInput.memo
            } : o));
            setEditingOrderId(null);
        } else {
            const newOrder: ManualOrder = {
                id: `mo-${Date.now()}`, companyName: manualInput.companyName, recipientName: manualInput.recipientName,
                phone: manualInput.phone, address: manualInput.address, productName: manualInput.productName, qty: parseInt(manualInput.qty) || 1,
                memo: manualInput.memo
            };
            setManualOrders(prev => [...prev, newOrder]);
            setSelectedManualOrderIds(prev => new Set([...prev, newOrder.id]));
        }
        setManualInput(prev => ({ ...prev, recipientName: '', phone: '', address: '', productName: '', productKey: '', qty: '1', memo: '' }));
    };

    const handleStartEditManualOrder = (o: ManualOrder) => {
        setEditingOrderId(o.id);
        const productKey = Object.entries(pricingConfig[o.companyName]?.products ?? {}).find(([, p]: [string, any]) => (p.orderFormName || p.displayName) === o.productName)?.[0] ?? '';
        setManualInput({ companyName: o.companyName, recipientName: o.recipientName, phone: o.phone, address: o.address, productName: o.productName, productKey, qty: String(o.qty), memo: o.memo ?? '' });
    };

    const handleCancelEditManualOrder = () => {
        setEditingOrderId(null);
        setManualInput({ companyName: '', recipientName: '', phone: '', address: '', productName: '', productKey: '', qty: '1', memo: '' });
    };

    const handleQuickSelect = (person: { name: string, phone: string, address: string }) => {
        setManualInput(prev => ({ ...prev, recipientName: person.name, phone: person.phone, address: person.address }));
    };

    const handleRemoveManualOrder = (id: string) => {
        setManualOrders(prev => prev.filter(o => o.id !== id));
        setSelectedManualOrderIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    };

    const handleToggleManualOrderSelection = (id: string) => {
        setSelectedManualOrderIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleAddManualTransfer = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTransfer.label || !newTransfer.amount) return;
        const transfer: ManualTransfer = {
            id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            label: newTransfer.label, bankName: newTransfer.bankName || '은행', accountNumber: newTransfer.accountNumber || '계좌', amount: parseInt(newTransfer.amount) || 0
        };
        setManualTransfers(prev => [...prev, transfer]);
        setNewTransfer({ label: '', bankName: '', accountNumber: '', amount: '' });
    };

    const handleAddCompanyAdjustment = (companyName: string, amountStr: string) => {
        const parsedAmount = parseInt(amountStr);
        if (!amountStr || isNaN(parsedAmount) || parsedAmount <= 0) return;
        const config = pricingConfig[companyName];
        const transfer: ManualTransfer = {
            id: `adj-${companyName}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            label: `${companyName}(수동)`, companyName: companyName, bankName: config?.bankName || '은행', accountNumber: config?.accountNumber || '계좌', amount: parsedAmount, isAdjustment: true
        };
        setManualTransfers(prev => [...prev, transfer]);
    };

    const handleDeleteManualTransfer = (id: string) => setManualTransfers(prev => prev.filter(t => t.id !== id));

    const handleResetSessionData = (companyName: string, sessionId: string, round: number) => {
        if (!confirm(`${companyName} ${round}차의 정산 데이터를 초기화할까요?`)) return;
        const newId = `${companyName}-${round}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
        setTotalsMap(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setExcludedCountsMap(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllExcludedDetails(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllOrderRows(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllInvoiceRows(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllUploadInvoiceRows(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllHeaders(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllSummaries(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setCompanySessions(prev => ({ ...prev, [companyName]: prev[companyName].map(s => s.id === sessionId ? { ...s, id: newId } : s) }));
        setSelectedSessionIds(prev => { const next = new Set(prev); next.delete(sessionId); next.add(newId); return next; });
    };

    const handleToggleClosed = (companyName: string) => {
        setClosedCompanies(prev => {
            const next = new Set(prev);
            const isClosing = !next.has(companyName);
            if (next.has(companyName)) next.delete(companyName);
            else next.add(companyName);
            if (isClosing) {
                const sendNotif = (title: string, body: string) => {
                    if (Notification.permission === 'granted') {
                        new Notification(title, { body });
                    } else if (Notification.permission !== 'denied') {
                        Notification.requestPermission().then(p => {
                            if (p === 'granted') new Notification(title, { body });
                        });
                    }
                };
                sendNotif(`${companyName} 마감`, '마감 처리되었습니다.');
            }
            return next;
        });
    };

    const handleGroupClose = (companies: string[]) => {
        setClosedCompanies(prev => {
            const allClosed = companies.every(c => prev.has(c));
            const next = new Set(prev);
            if (allClosed) {
                companies.forEach(c => next.delete(c));
            } else {
                companies.forEach(c => next.add(c));
            }
            return next;
        });
    };

    const handleGroupDownloadOrders = (companies: string[]) => {
        let downloaded = 0;
        companies.forEach(companyName => {
            const sessions = companySessions[companyName] || [];
            const mergedRows: any[][] = [];
            sessions.forEach(s => {
                if (allOrderRows[s.id] && allOrderRows[s.id].length > 0) mergedRows.push(...allOrderRows[s.id]);
            });
            if (mergedRows.length === 0) return;
            const companyConfig = pricingConfig[companyName];
            if (!companyConfig) return;
            const header = getHeaderForCompany(companyName, companyConfig);
            const ws = XLSX.utils.aoa_to_sheet([header, ...mergedRows]);
            ws['!cols'] = header.map(() => ({ wch: 15 }));
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '발주서');
            const dateStr = new Date().toLocaleDateString('en-CA');
            XLSX.writeFile(wb, `${dateStr} ${businessPrefix ? businessPrefix + ' ' : ''}${companyName} 합산발주서.xlsx`);
            sessions.forEach(s => setOrderLitSessions(prev => { const n = new Set(prev); n.delete(s.id); return n; }));
            downloaded++;
        });
        if (downloaded === 0) alert('다운받을 발주 데이터가 없습니다.');
    };

    // 세션별 경고 집계 → 부모에게 전달
    const [sessionWarningsMap, setSessionWarningsMap] = useState<Record<string, boolean>>({});
    const handleSessionWarningUpdate = useCallback((sessionId: string, hasWarning: boolean) => {
        setSessionWarningsMap(prev => {
            if (prev[sessionId] === hasWarning) return prev;
            return { ...prev, [sessionId]: hasWarning };
        });
    }, []);
    const onHasWarningsRef = useRef(onHasWarnings);
    onHasWarningsRef.current = onHasWarnings;
    useEffect(() => {
        onHasWarningsRef.current?.(Object.values(sessionWarningsMap).some(Boolean));
    }, [sessionWarningsMap]);

    // 빠른 다운로드 바: 부모에게 미다운로드 업체 수와 다운로드 함수 전달
    const onStatusUpdateRef = useRef(onStatusUpdate);
    useEffect(() => { onStatusUpdateRef.current = onStatusUpdate; });
    const handleGroupDownloadOrdersRef = useRef(handleGroupDownloadOrders);
    useEffect(() => { handleGroupDownloadOrdersRef.current = handleGroupDownloadOrders; });
    const pricingConfigRef = useRef(pricingConfig);
    useEffect(() => { pricingConfigRef.current = pricingConfig; });

    useEffect(() => {
        const litCompanies = [...new Set(
            [...orderLitSessions].flatMap(sid => {
                for (const [name, sessions] of Object.entries(companySessions) as [string, SessionData[]][]) {
                    if (sessions.some((s: SessionData) => s.id === sid)) return [name];
                }
                return [];
            })
        )];
        onStatusUpdateRef.current?.({
            litCount: litCompanies.length,
            downloadAll: () => handleGroupDownloadOrdersRef.current(
                litCompanies.length > 0 ? litCompanies : Object.keys(pricingConfigRef.current)
            ),
        });
    }, [orderLitSessions, companySessions]);

    uploadVendorInvoiceRef.current = (files: File[]) => {
        const allCompanies = Object.keys(companySessions);
        setVendorFiles(prev => {
            const next = { ...prev };
            allCompanies.forEach(c => { next[c] = files; });
            return next;
        });
    };
    getInvoiceStateRef.current = () => {
        const result: { name: string; uploadCount: number }[] = [];
        (Object.entries(companySessions) as [string, SessionData[]][]).forEach(([name, sessions]) => {
            let count = 0;
            sessions.forEach(s => {
                const mem = allUploadInvoiceRows[s.id];
                if (mem && mem.length > 0) { count += mem.length; return; }
                const saved = sessionResults?.[s.id];
                if (saved) {
                    const rows = typeof saved.uploadInvoiceRows === 'string' ? JSON.parse(saved.uploadInvoiceRows) : (saved.uploadInvoiceRows || []);
                    count += rows.length;
                }
            });
            if (count > 0) result.push({ name, uploadCount: count });
        });

        // 가구매 항목: 명단 주문번호와 매칭되는 upload invoice 행 수
        if (effectiveFakeInput.trim()) {
            const fakeNums = resolveFakeOrderNumbers(effectiveFakeInput, { normalize: true });
            if (fakeNums.size > 0) {
                let fakeCount = 0;
                (Object.entries(companySessions) as [string, SessionData[]][]).forEach(([, sessions]) => {
                    sessions.forEach(s => {
                        const rows = allUploadInvoiceRows[s.id];
                        if (rows && rows.length > 0) {
                            rows.forEach(row => {
                                const num = String(row[2] || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                                if (fakeNums.has(num)) fakeCount++;
                            });
                            return;
                        }
                        const saved = sessionResults?.[s.id];
                        if (saved) {
                            const savedRows: any[][] = typeof saved.uploadInvoiceRows === 'string' ? JSON.parse(saved.uploadInvoiceRows) : (saved.uploadInvoiceRows || []);
                            savedRows.forEach(row => {
                                const num = String(row[2] || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                                if (fakeNums.has(num)) fakeCount++;
                            });
                        }
                    });
                });
                if (fakeCount > 0) result.push({ name: '가구매', uploadCount: fakeCount });
            }
        }

        return result;
    };

    // 항상 최신 state를 참조하는 ref 기반 다운로드 함수 (stale closure 방지)
    const wsInvoiceDownloadRef = useRef((_companyName: string) => {});
    wsInvoiceDownloadRef.current = (companyName: string) => {
        // 가구매 전용 다운로드: 명단 주문번호와 매칭되는 행만 추출
        if (companyName === '가구매') {
            const fakeNums = resolveFakeOrderNumbers(effectiveFakeInput, { normalize: true });
            if (fakeNums.size === 0) { alert('가구매 명단이 비어있습니다.'); return; }
            const mergedRows: any[][] = [];
            let headerRow: any[] = [];
            (Object.entries(companySessions) as [string, SessionData[]][]).forEach(([, sessions]) => {
                (sessions as SessionData[]).forEach(s => {
                    let rows: any[][] = allUploadInvoiceRows[s.id] || [];
                    let hdr: any[] | undefined = allHeaders[s.id];
                    if (rows.length === 0 && sessionResults?.[s.id]) {
                        const saved = sessionResults[s.id];
                        rows = typeof saved.uploadInvoiceRows === 'string' ? JSON.parse(saved.uploadInvoiceRows) : (saved.uploadInvoiceRows || []);
                        hdr = saved.header;
                    }
                    if (rows.length > 0) {
                        if (!headerRow.length && hdr?.length) headerRow = hdr;
                        rows.forEach(row => {
                            const num = String(row[2] || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                            if (fakeNums.has(num)) mergedRows.push(row);
                        });
                    }
                });
            });
            if (!mergedRows.length) { alert('가구매 매칭된 송장 데이터가 없습니다.'); return; }
            const wb = XLSX.utils.book_new();
            const aoa = headerRow.length ? [headerRow, ...mergedRows] : mergedRows;
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '업로드용');
            const dateStr = new Date().toLocaleDateString('en-CA');
            XLSX.writeFile(wb, `${dateStr}_${businessPrefix ? businessPrefix + '_' : ''}가구매[업로드용_송장].xlsx`);
            return;
        }

        const sessions = (companySessions[companyName] || []) as SessionData[];
        const mergedRows: any[][] = [];
        let headerRow: any[] = [];
        sessions.forEach(s => {
            // 인메모리(현재 세션) 우선
            let rows: any[][] = allUploadInvoiceRows[s.id] || [];
            let hdr: any[] | undefined = allHeaders[s.id];
            // Firestore 데이터 fallback (페이지 리로드 후 등)
            if (rows.length === 0 && sessionResults?.[s.id]) {
                const saved = sessionResults[s.id];
                rows = typeof saved.uploadInvoiceRows === 'string' ? JSON.parse(saved.uploadInvoiceRows) : (saved.uploadInvoiceRows || []);
                hdr = saved.header;
            }
            if (rows.length > 0) {
                if (!headerRow.length && hdr?.length) headerRow = hdr;
                mergedRows.push(...rows);
            }
        });
        if (!mergedRows.length) { alert('다운로드할 송장 데이터가 없습니다.'); return; }
        const wb = XLSX.utils.book_new();
        const aoa = headerRow.length ? [headerRow, ...mergedRows] : mergedRows;
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '업로드용');
        const dateStr = new Date().toLocaleDateString('en-CA');
        XLSX.writeFile(wb, `${dateStr}_${businessPrefix ? businessPrefix + '_' : ''}${companyName}[업로드용_송장].xlsx`);
    };


    const buildInvoiceWorkbook = (): { wb: any; fileName: string } | null => {
        const mergedRows: any[][] = [];
        let headerRow: any[] = [];
        (Object.entries(companySessions) as [string, SessionData[]][]).forEach(([, sessions]) => {
            (sessions as SessionData[]).forEach(s => {
                let rows: any[][] = allUploadInvoiceRows[s.id] || [];
                let hdr: any[] | undefined = allHeaders[s.id];
                if (rows.length === 0 && sessionResults?.[s.id]) {
                    const saved = sessionResults[s.id];
                    rows = typeof saved.uploadInvoiceRows === 'string' ? JSON.parse(saved.uploadInvoiceRows) : (saved.uploadInvoiceRows || []);
                    hdr = saved.header;
                }
                if (rows.length > 0) {
                    if (!headerRow.length && hdr?.length) headerRow = hdr;
                    mergedRows.push(...rows);
                }
            });
        });
        if (mergedRows.length === 0) return null;
        const wb = XLSX.utils.book_new();
        const aoa = headerRow.length ? [headerRow, ...mergedRows] : mergedRows;
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '업로드용');
        const dateStr = new Date().toLocaleDateString('en-CA');
        const fileName = `${dateStr}_${businessPrefix ? businessPrefix + '_' : ''}통합[업로드용_송장].xlsx`;
        return { wb, fileName };
    };

    downloadAllInvoicesRef.current = () => {
        const result = buildInvoiceWorkbook();
        if (!result) { alert('다운로드할 송장 데이터가 없습니다.'); return; }
        XLSX.writeFile(result.wb, result.fileName);
    };

    getInvoiceWorkbookFileRef.current = () => {
        const result = buildInvoiceWorkbook();
        if (!result) return null;
        const binary: ArrayBuffer = XLSX.write(result.wb, { bookType: 'xlsx', type: 'array' });
        return new File([binary], result.fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    };

    const handleAddSession = (companyName: string) => {
        if (closedCompanies.has(companyName)) return;
        const newSessionId = `${companyName}-${Date.now()}`;
        setCompanySessions(prev => {
            const current = prev[companyName] || [];
            const nextRound = current.length + 1;
            const newSession: SessionData = { id: newSessionId, companyName, round: nextRound };
            return { ...prev, [companyName]: [...current, newSession] };
        });
        setSelectedSessionIds(prev => { const next = new Set(prev); next.add(newSessionId); return next; });
    };

    const handleRemoveSession = (companyName: string, sessionId: string) => {
        if (!confirm('이 차수의 작업 줄을 삭제하시겠습니까?')) return;
        setCompanySessions(prev => ({ ...prev, [companyName]: prev[companyName].filter(s => s.id !== sessionId) }));
        setTotalsMap(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setExcludedCountsMap(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setAllExcludedDetails(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setSelectedSessionIds(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
    };

    const handleDeleteBatchRound = (round: number): boolean => {
        if (!confirm(`${round}차 주문서를 삭제하시겠습니까?\n워크스테이션의 ${round}차 발주서도 함께 사라집니다.`)) return false;
        const sessionIds = Object.keys(batchFiles).filter(id => id.match(new RegExp(`-batch-${round}-`)));
        setBatchFiles(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setBatchExpectedCounts(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setBatchMasterRows(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setBatchPlatforms(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setCompanySessions(prev => {
            const n = { ...prev };
            for (const company of Object.keys(n)) n[company] = n[company].filter(s => !sessionIds.includes(s.id));
            return n;
        });
        setTotalsMap(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setExcludedCountsMap(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setAllExcludedDetails(prev => { const n = { ...prev }; sessionIds.forEach(id => delete n[id]); return n; });
        setSelectedSessionIds(prev => { const next = new Set(prev); sessionIds.forEach(id => next.delete(id)); return next; });
        return true;
    };
    deleteBatchRoundRef.current = handleDeleteBatchRound;

    const handleVendorFileChange = (companyName: string, files: File[]) => {
        setVendorFiles(prev => {
            const newState = { ...prev };
            if (files.length > 0) newState[companyName] = files; else delete newState[companyName];
            return newState;
        });
    };

    const handleResultUpdate = useCallback((sessionId: string, totalPrice: number, excludedCount: number = 0, excludedDetails: ExcludedOrder[] = []) => {
        setTotalsMap(prev => ({ ...prev, [sessionId]: totalPrice }));
        setExcludedCountsMap(prev => ({ ...prev, [sessionId]: excludedCount }));
        setAllExcludedDetails(prev => ({ ...prev, [sessionId]: excludedDetails }));
    }, []);

    // Toast 알림 시스템
    type ToastItem = { id: number; companyName: string; orderCount: number; sessionId: string };
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const toastIdRef = useRef(0);
    const prevOrderRowsRef = useRef<Record<string, number>>({});
    const toastSuppressUntilRef = useRef(Date.now() + 3000); // 초기 3초간 복원 토스트 억제

    const addToast = useCallback((companyName: string, orderCount: number, sessionId: string) => {
        const id = ++toastIdRef.current;
        setToasts(prev => [...prev, { id, companyName, orderCount, sessionId }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
    }, []);

    const handleToastClick = useCallback((sessionId: string) => {
        const el = document.getElementById(`session-${sessionId}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('ring-2', 'ring-rose-500', 'ring-offset-2', 'ring-offset-zinc-950');
            setTimeout(() => el.classList.remove('ring-2', 'ring-rose-500', 'ring-offset-2', 'ring-offset-zinc-950'), 2000);
        }
        setToasts(prev => prev.filter(t => t.sessionId !== sessionId));
    }, []);

    const [allRegisteredNames, setAllRegisteredNames] = useState<Record<string, Record<string, string>>>({});
    const [allOrderItems, setAllOrderItems] = useState<Record<string, { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number; recipientName: string }[]>>({});
    const [allPreConsolidationByGroup, setAllPreConsolidationByGroup] = useState<Record<string, Record<string, number>>>({});

    // 수동발주 취소/승인 상태 (업체별)
    const [manualOrdersRejectedCompanies, setManualOrdersRejectedCompanies] = useState<Set<string>>(new Set());
    const handleManualOrdersApproval = useCallback((companyName: string, approved: boolean) => {
        setManualOrdersRejectedCompanies(prev => {
            const next = new Set(prev);
            if (approved) next.delete(companyName);
            else next.add(companyName);
            return next;
        });
    }, []);

    const handleDataUpdate = useCallback((sessionId: string, orderRows: any[][], invoiceRows: any[][], uploadInvoiceRows: any[][], summaryExcel: string, header?: any[], registeredProductNames?: Record<string, string>, itemSummary?: Record<string, { count: number; totalPrice: number }>, orderItems?: { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number; recipientName: string }[], preConsolidationByGroup?: Record<string, number>) => {
        // 새 발주서 생성 감지 → 토스트 (초기 복원 시 억제)
        const prevCount = prevOrderRowsRef.current[sessionId] || 0;
        const newCount = orderRows.length;
        if (newCount > 0 && Date.now() > toastSuppressUntilRef.current) {
            const companyName = sessionId.replace(/-\d+$/, '');
            // 토스트·알림은 0→N 전환 시만
            if (prevCount === 0) {
                addToast(companyName, newCount, sessionId);
                const sendNotif = (title: string, body: string) => {
                    if (Notification.permission === 'granted') {
                        new Notification(title, { body });
                    } else if (Notification.permission !== 'denied') {
                        Notification.requestPermission().then(p => {
                            if (p === 'granted') new Notification(title, { body });
                        });
                    }
                };
                sendNotif(`${companyName} 발주서 생성`, `${newCount}건`);
            }
            // 발주서 불 켜기 (복원 억제 기간 이후 데이터가 있으면 항상 켬)
            setOrderLitSessions(prev => new Set([...prev, sessionId]));
        }
        // 발주서 rows 삭제 시 불 끄기
        if (newCount === 0) setOrderLitSessions(prev => { const s = new Set(prev); s.delete(sessionId); return s; });
        prevOrderRowsRef.current[sessionId] = newCount;

        setAllOrderRows(prev => ({ ...prev, [sessionId]: orderRows }));
        // header가 있으면 병합이 실행된 것 → 결과가 0건이어도 갱신
        // orderRows가 비어있으면 명시적 초기화(세션 삭제) → 항상 초기화
        // 그 외(발주서만 재업로드, mergeResults=null) → 기존 송장 데이터 유지
        if (header || uploadInvoiceRows.length > 0 || orderRows.length === 0) {
            setAllInvoiceRows(prev => ({ ...prev, [sessionId]: invoiceRows }));
            setAllUploadInvoiceRows(prev => ({ ...prev, [sessionId]: uploadInvoiceRows }));
            if (header) {
                setAllHeaders(prev => ({ ...prev, [sessionId]: header }));
                // 송장 처리 완료 → 불 켜기 (복원 시 억제)
                if (Date.now() > toastSuppressUntilRef.current && invoiceRows.length > 0) {
                    setInvoiceLitSessions(prev => new Set([...prev, sessionId]));
                }
            }
            // 송장 rows 삭제 시 불 끄기
            if (orderRows.length === 0) setInvoiceLitSessions(prev => { const s = new Set(prev); s.delete(sessionId); return s; });
        }
        setAllSummaries(prev => ({ ...prev, [sessionId]: summaryExcel }));
        if (registeredProductNames) setAllRegisteredNames(prev => ({ ...prev, [sessionId]: registeredProductNames }));
        if (itemSummary) setAllItemSummaries(prev => ({ ...prev, [sessionId]: itemSummary }));
        else if (orderRows.length === 0) setAllItemSummaries(prev => ({ ...prev, [sessionId]: {} }));
        if (orderItems) setAllOrderItems(prev => ({ ...prev, [sessionId]: orderItems }));
        else if (orderRows.length === 0) setAllOrderItems(prev => ({ ...prev, [sessionId]: [] }));
        if (preConsolidationByGroup) setAllPreConsolidationByGroup(prev => ({ ...prev, [sessionId]: preConsolidationByGroup }));
    }, [addToast]);

    const handleToggleSessionSelection = (sessionId: string) => {
        setSelectedSessionIds(prev => {
            const next = new Set(prev);
            if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
            return next;
        });
    };

    const handleSelectAllSessions = () => {
        const allActiveIds = (Object.values(companySessions).flat() as SessionData[]).map(s => s.id);
        if (selectedSessionIds.size === allActiveIds.length) setSelectedSessionIds(new Set());
        else setSelectedSessionIds(new Set(allActiveIds));
    };

    const handleDownloadMergedOrder = (companyName: string) => {
        const sessions = companySessions[companyName] || [];
        const mergedRows: any[][] = [];
        sessions.forEach(s => {
            if (allOrderRows[s.id] && allOrderRows[s.id].length > 0) mergedRows.push(...allOrderRows[s.id]);
        });
        if (mergedRows.length === 0) { alert('합산할 발주 데이터가 없습니다.'); return; }
        const companyConfig = pricingConfig[companyName];
        if (!companyConfig) return;
        const header = getHeaderForCompany(companyName, companyConfig);
        const ws = XLSX.utils.aoa_to_sheet([header, ...mergedRows]);
        ws['!cols'] = header.map(() => ({ wch: 15 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '발주서');
        const dateStr = new Date().toLocaleDateString('en-CA');
        XLSX.writeFile(wb, `${dateStr} ${businessPrefix ? businessPrefix + ' ' : ''}${companyName} 합산발주서.xlsx`);
        // 합산 발주서 다운로드 시 해당 업체 모든 세션 불 끄기
        sessions.forEach(s => setOrderLitSessions(prev => { const n = new Set(prev); n.delete(s.id); return n; }));
        setMergedDownloadedCompanies(prev => { const n = new Set(prev); n.add(companyName); return n; });
    };

    // 업체별 가구매 택배 매칭 행 필터링
    const getCourierRowsForCompany = (companyName: string): any[][] => {
        if (Object.keys(courierMatchedRows).length === 0) return [];
        const fakeOrderNums = new Set<string>();
        (Object.values(allExcludedDetails).flat() as ExcludedOrder[]).forEach(ex => {
            if (ex.companyName === companyName && String(ex.orderNumber || '').includes('(제외)')) {
                const cleanNum = String(ex.orderNumber).replace(/\s*\(제외\)\s*/, '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (cleanNum) fakeOrderNums.add(cleanNum);
            }
        });
        if (fakeOrderNums.size === 0) return [];
        const filtered: any[][] = [];
        (Object.values(courierMatchedRows) as any[][][]).forEach(rows => {
            if (!rows || rows.length <= 1) return;
            for (let i = 1; i < rows.length; i++) {
                const orderNum = String(rows[i][2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (fakeOrderNums.has(orderNum)) filtered.push(rows[i]);
            }
        });
        return filtered;
    };

    const handleDownloadMergedInvoice = (companyName: string, type: 'mgmt' | 'upload') => {
        const sessions = companySessions[companyName] || [];
        const mergedRows: any[][] = [];
        let headerRow: any[] = [];
        sessions.forEach(s => {
            const rows = type === 'mgmt' ? allInvoiceRows[s.id] : allUploadInvoiceRows[s.id];
            if (rows && rows.length > 0) {
                if (headerRow.length === 0 && allHeaders[s.id]) headerRow = allHeaders[s.id];
                mergedRows.push(...rows);
            }
        });
        // 가구매 택배 병합
        const courierRows = getCourierRowsForCompany(companyName);
        if (courierRows.length > 0) mergedRows.push(...courierRows);
        if (mergedRows.length === 0) { alert('합산할 송장 데이터가 없습니다.'); return; }
        const wb = XLSX.utils.book_new();
        const aoa = headerRow.length > 0 ? [headerRow, ...mergedRows] : mergedRows;
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        XLSX.utils.book_append_sheet(wb, ws, type === 'mgmt' ? '기록용' : '업로드용');
        const dateStr = new Date().toLocaleDateString('en-CA');
        const label = type === 'mgmt' ? '기록용_' : '';
        XLSX.writeFile(wb, `${dateStr}_${businessPrefix ? businessPrefix + '_' : ''}${companyName}[${label}합산_송장].xlsx`);
        // 합산 송장 다운로드 시 해당 업체 모든 세션 불 끄기
        sessions.forEach(s => setInvoiceLitSessions(prev => { const n = new Set(prev); n.delete(s.id); return n; }));
    };

    const handleDownloadMergedUploadInvoices = () => {
        if (selectedSessionIds.size === 0) { alert('병합할 업체를 선택해주세요.'); return; }
        const mergedRows: any[][] = [];
        let headerRow: any[] = [];
        const selectedCompanyNames: string[] = [];
        const sortedSessions = (Object.values(companySessions).flat() as SessionData[]).filter((s: SessionData) => selectedSessionIds.has(s.id));
        sortedSessions.forEach((s: SessionData) => {
            if (allUploadInvoiceRows[s.id] && allUploadInvoiceRows[s.id].length > 0) {
                if (headerRow.length === 0 && allHeaders[s.id]) headerRow = allHeaders[s.id];
                mergedRows.push(...allUploadInvoiceRows[s.id]);
                if (!selectedCompanyNames.includes(s.companyName)) selectedCompanyNames.push(s.companyName);
            }
        });
        // 가구매 송장(택배사별) 병합
        (Object.values(courierMatchedRows) as any[][][]).forEach(rows => {
            if (rows && rows.length > 1) {
                if (headerRow.length === 0) headerRow = rows[0];
                mergedRows.push(...rows.slice(1));
            }
        });
        if (mergedRows.length === 0) { alert('선택된 업체 중 매칭된 송장 데이터가 없습니다.'); return; }
        const wb = XLSX.utils.book_new();
        const aoa = headerRow.length > 0 ? [headerRow, ...mergedRows] : mergedRows;
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        XLSX.utils.book_append_sheet(wb, ws, "병합송장");
        const dateStr = new Date().toLocaleDateString('en-CA');
        const companiesStr = selectedCompanyNames.length > 3 ? `${selectedCompanyNames.slice(0, 3).join('_')} 외 ${selectedCompanyNames.length - 3}곳` : selectedCompanyNames.join('_');
        XLSX.writeFile(wb, `${dateStr}_${businessPrefix ? businessPrefix + '_' : ''}${companiesStr}[병합_송장].xlsx`);
    };

    const handleDownloadDepositList = () => {
        const depositRows: any[][] = [];
        const bizDisplayName = businessDisplayName || (businessId ? (getBusinessInfo(businessId)?.displayName || businessId) : '');
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            const sessionAmounts = sessions.map(s => ({ round: s.round, amount: totalsMap[s.id] || 0 })).filter(s => s.amount > 0);
            if (sessionAmounts.length === 0) return;
            const companyTotal = sessionAmounts.reduce((sum, s) => sum + s.amount, 0);
            const label = name;
            depositRows.push([config?.bankName || '', config?.accountNumber || '', companyTotal, label, bizDisplayName]);
        });
        manualTransfers.forEach(t => { depositRows.push([t.bankName, t.accountNumber, t.amount, t.label || '', bizDisplayName ? `${bizDisplayName} 환불` : '']); });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice;
            depositRows.push([fakeCourierSettings.bankName, fakeCourierSettings.accountNumber, deliveryFee, `${fakeCourierSettings.name}(${fakeOrderAnalysis.inputNumbers.size}건)`]);
        }
        setDepositBaseRows(depositRows);
        setDepositExtraRows([{ bankName: '', accountNumber: '', amount: '', label: '' }]);
        setShowDepositModal(true);
    };

    const handleDepositModalDownload = () => {
        const ROWS_PER_FILE = 15;
        const bizDisplayName = businessDisplayName || (businessId ? (getBusinessInfo(businessId)?.displayName || businessId) : '');
        const extraRows: any[][] = depositExtraRows
            .filter(r => r.bankName || r.accountNumber || r.amount)
            .map(r => [r.bankName, r.accountNumber, Number(r.amount) || 0, r.label, bizDisplayName ? `${bizDisplayName} 환불` : '']);
        const allRows = [...depositBaseRows, ...extraRows];
        if (allRows.length === 0) { alert('입금할 내역이 없습니다.'); return; }

        const dateStr = new Date().toLocaleDateString('en-CA');
        const chunks: any[][][] = [];
        for (let i = 0; i < allRows.length; i += ROWS_PER_FILE) {
            chunks.push(allRows.slice(i, i + ROWS_PER_FILE));
        }

        chunks.forEach((chunk, idx) => {
            const wb = XLSX.utils.book_new();
            const sheetRows = [...chunk];
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows), "입금내역");
            const suffix = chunks.length > 1 ? `_${idx + 1}` : '';
            XLSX.writeFile(wb, `${dateStr}_${businessPrefix}_입금목록${suffix}.xlsx`);
        });

        setShowDepositModal(false);
    };

    const getDepositBaseRows = (): any[][] => {
        const depositRows: any[][] = [];
        const bizDisplayName = businessDisplayName || (businessId ? (getBusinessInfo(businessId)?.displayName || businessId) : '');
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const cfg = pricingConfig[name];
            const total = (sessions as any[]).reduce((sum: number, s: any) => sum + (totalsMap[s.id] || 0), 0);
            if (total === 0) return;
            depositRows.push([cfg?.bankName || '', cfg?.accountNumber || '', total, name, bizDisplayName]);
        });
        manualTransfers.forEach((t: any) => { depositRows.push([t.bankName, t.accountNumber, t.amount, t.label || '', bizDisplayName ? `${bizDisplayName} 환불` : '']); });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice;
            depositRows.push([fakeCourierSettings.bankName, fakeCourierSettings.accountNumber, deliveryFee, `${fakeCourierSettings.name}(${fakeOrderAnalysis.inputNumbers.size}건)`]);
        }
        return depositRows;
    };

    const downloadDepositListDirect = (baseRows: any[][], injectedExtra: { bankName: string; accountNumber: string; amount: string; label: string }[]) => {
        const ROWS_PER_FILE = 15;
        const bizDisplayName = businessDisplayName || (businessId ? (getBusinessInfo(businessId)?.displayName || businessId) : '');
        const extraFormatted: any[][] = injectedExtra
            .filter(r => r.bankName || r.accountNumber || r.amount)
            .map(r => [r.bankName, r.accountNumber, Number(r.amount) || 0, r.label, bizDisplayName ? `${bizDisplayName} 환불` : '']);
        const allRows = [...baseRows, ...extraFormatted];
        if (allRows.length === 0) return;
        const dateStr = new Date().toLocaleDateString('en-CA');
        const chunks: any[][][] = [];
        for (let i = 0; i < allRows.length; i += ROWS_PER_FILE) chunks.push(allRows.slice(i, i + ROWS_PER_FILE));
        chunks.forEach((chunk, idx) => {
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(chunk), "입금내역");
            const suffix = chunks.length > 1 ? `_${idx + 1}` : '';
            XLSX.writeFile(wb, `${dateStr}_${businessPrefix}_입금목록${suffix}.xlsx`);
        });
    };

    const handleDownloadDepositListWithExtra = (injectedExtra: { bankName: string; accountNumber: string; amount: string; label: string }[]) => {
        const ROWS_PER_FILE = 15;
        const bizDisplayName = businessDisplayName || (businessId ? (getBusinessInfo(businessId)?.displayName || businessId) : '');
        const baseRows: any[][] = [];
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const cfg = pricingConfig[name];
            const sessionAmounts = sessions.map(s => ({ amount: totalsMap[s.id] || 0 })).filter(s => s.amount > 0);
            if (sessionAmounts.length === 0) return;
            const companyTotal = sessionAmounts.reduce((sum, s) => sum + s.amount, 0);
            baseRows.push([cfg?.bankName || '', cfg?.accountNumber || '', companyTotal, name, bizDisplayName]);
        });
        manualTransfers.forEach(t => { baseRows.push([t.bankName, t.accountNumber, t.amount, t.label || '', bizDisplayName ? `${bizDisplayName} 환불` : '']); });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice;
            baseRows.push([fakeCourierSettings.bankName, fakeCourierSettings.accountNumber, deliveryFee, `${fakeCourierSettings.name}(${fakeOrderAnalysis.inputNumbers.size}건)`]);
        }
        const extraFormatted: any[][] = injectedExtra
            .filter(r => r.bankName || r.accountNumber || r.amount)
            .map(r => [r.bankName, r.accountNumber, Number(r.amount) || 0, r.label, bizDisplayName ? `${bizDisplayName} 환불` : '']);
        const allRows = [...baseRows, ...extraFormatted];
        if (allRows.length === 0) return;
        const dateStr = new Date().toLocaleDateString('en-CA');
        const chunks: any[][][] = [];
        for (let i = 0; i < allRows.length; i += ROWS_PER_FILE) chunks.push(allRows.slice(i, i + ROWS_PER_FILE));
        chunks.forEach((chunk, idx) => {
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(chunk), "입금내역");
            const suffix = chunks.length > 1 ? `_${idx + 1}` : '';
            XLSX.writeFile(wb, `${dateStr}_${businessPrefix}_입금목록${suffix}.xlsx`);
        });
    };

    const handleDownloadWorkLog = () => {
        if (recordedCompanies.size === 0) {
            alert('기록된 업체가 없습니다.\n업체별 기록 버튼을 먼저 눌러주세요.');
            return;
        }
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig)).filter(n => recordedCompanies.has(n));

        // 마진시트에서 매칭 실패할 품목 미리 감지 (단가관리에서 삭제/키변경된 경우)
        const missingMargin: { company: string; regName: string; productKey: string; count: number }[] = [];
        sortedCompanyNames.forEach(name => {
            const companyConfig = pricingConfig[name];
            if (!companyConfig) return;
            (companySessions[name] || []).forEach(s => {
                const items = allOrderItems[s.id];
                if (!items) return;
                const missingMap = new Map<string, number>();
                for (const item of items) {
                    if (companyConfig.products[item.matchedProductKey]) continue;
                    const key = `${item.registeredProductName}::${item.matchedProductKey}`;
                    missingMap.set(key, (missingMap.get(key) || 0) + item.qty);
                }
                missingMap.forEach((count, key) => {
                    const [regName, productKey] = key.split('::');
                    missingMargin.push({ company: name, regName, productKey, count });
                });
            });
        });

        if (missingMargin.length > 0) {
            const lines = missingMargin.map(m => `• [${m.company}] ${m.regName || '(등록상품명 없음)'} / ${m.productKey} ×${m.count}`).join('\n');
            const ok = window.confirm(`아래 품목은 단가관리에서 찾을 수 없어 마진시트에서 제외됩니다.\n(단가관리에서 삭제/변경되었을 수 있습니다)\n\n${lines}\n\n그대로 다운로드할까요?`);
            if (!ok) return;
        }

        const wb = XLSX.utils.book_new();
        const summarySheetData: any[][] = [];
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            let hasAddedHeader = false;
            sessions.forEach(s => {
                const text = allSummaries[s.id];
                if (text && text.trim()) {
                    if (!hasAddedHeader) { summarySheetData.push([`[${name} 정산내역]`]); hasAddedHeader = true; }
                    text.split('\n').forEach(line => summarySheetData.push(line.split('\t')));
                    summarySheetData.push([]);
                }
            });
        });
        if (summarySheetData.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheetData), "요약시트");
        const depositRows: any[][] = [['업체명', '은행', '계좌번호', '금액', '비고']];
        let depTotal = 0;
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            const sessionAmounts = sessions.map(s => ({ round: s.round, amount: totalsMap[s.id] || 0 })).filter(s => s.amount > 0);
            if (sessionAmounts.length === 0) return;
            const companyTotal = sessionAmounts.reduce((sum, s) => sum + s.amount, 0);
            const roundDetail = sessionAmounts.length > 1
                ? sessionAmounts.map(s => `${s.round}차 ${s.amount.toLocaleString()}`).join(' / ')
                : '';
            depositRows.push([name, config?.bankName || '', config?.accountNumber || '', companyTotal, roundDetail]);
            depTotal += companyTotal;
        });
        manualTransfers.forEach(t => { depositRows.push([t.label || '', t.bankName, t.accountNumber, t.amount, '']); depTotal += t.amount; });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice;
            depositRows.push([`${fakeCourierSettings.name}(${fakeOrderAnalysis.inputNumbers.size}건)`, fakeCourierSettings.bankName, fakeCourierSettings.accountNumber, deliveryFee, '']);
            depTotal += deliveryFee;
        }
        if (depositRows.length > 1) depositRows.push([], ['', '', '합계', depTotal, '']);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(depositRows), "입금내역");
        const orderSheetData: any[][] = [];
        const invoiceSheetData: any[][] = [];
        sortedCompanyNames.forEach(name => {
            (companySessions[name] || []).forEach(s => {
                if (allOrderRows[s.id]) orderSheetData.push(...allOrderRows[s.id]);
                if (allInvoiceRows[s.id]) invoiceSheetData.push(...allInvoiceRows[s.id]);
            });
        });
        if (orderSheetData.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(orderSheetData), "발주시트");
        if (invoiceSheetData.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(invoiceSheetData), "송장시트");

        // 마진시트 생성: orderItems를 (회사, 등록상품명, productKey) 기준으로 집계
        const marginSheetData: any[][] = [['등록상품명', '품목명', '수량', '판매가', '공급가', '마진(개당)', '총마진']];
        type MarginGroup = { regName: string; productName: string; count: number; sellingPrice: number; supplyPrice: number; margin: number };
        const marginGroups: { company: string; key: string; data: MarginGroup }[] = [];
        const marginGroupIndex = new Map<string, number>();
        sortedCompanyNames.forEach(name => {
            const companyConfig = pricingConfig[name];
            if (!companyConfig) return;
            (companySessions[name] || []).forEach(s => {
                const items = allOrderItems[s.id];
                if (!items) return;
                for (const item of items) {
                    const product = companyConfig.products[item.matchedProductKey] as any;
                    if (!product) continue;
                    const regName = item.registeredProductName || name;
                    const productName = product.orderFormName || product.displayName;
                    const key = `${name}::${regName}::${item.matchedProductKey}`;
                    const existingIdx = marginGroupIndex.get(key);
                    if (existingIdx !== undefined) {
                        marginGroups[existingIdx].data.count += item.qty;
                    } else {
                        marginGroupIndex.set(key, marginGroups.length);
                        marginGroups.push({
                            company: name,
                            key,
                            data: {
                                regName,
                                productName,
                                count: item.qty,
                                sellingPrice: product.sellingPrice || 0,
                                supplyPrice: product.supplyPrice || 0,
                                margin: product.margin || 0,
                            },
                        });
                    }
                }
            });
        });

        for (const g of marginGroups) {
            const d = g.data;
            marginSheetData.push([d.regName, d.productName, d.count, d.sellingPrice, d.supplyPrice, d.margin, d.margin * d.count]);
        }

        const totalMargin = marginSheetData.length > 1
            ? marginSheetData.slice(1).reduce((sum: number, r: any[]) => sum + (r[6] || 0), 0)
            : 0;
        if (marginSheetData.length > 1) {
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 마진', totalMargin]);
        }

        if (marginSheetData.length > 1) {
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(marginSheetData), "마진시트");
        }

        // 비용시트 생성
        if (allExpenses.length > 0) {
            const expenseSheetData: any[][] = [['구분', '금액', '내역', '연동업체', '연동품목']];
            allExpenses.forEach(exp => {
                expenseSheetData.push([exp.category, exp.amount, exp.description, exp.company || '', exp.productName || '']);
            });
            const totalExpense = allExpenses.reduce((sum, e) => sum + e.amount, 0);
            expenseSheetData.push([]);
            expenseSheetData.push(['합계', totalExpense, '', '', '']);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expenseSheetData), "비용시트");
        }

        // 품목별비용 시트 생성
        if (returns.length > 0) {
            const returnSheetData: any[][] = [['구분', '날짜', '사유', '업체', '등록상품명', '품목명', '수량', '개당마진', '금액']];
            returns.forEach(r => {
                returnSheetData.push([r.type || '반품', r.orderDate || '', r.memo || '', r.company, r.registeredName || '', r.productName, r.count, r.marginPerUnit, r.totalMargin]);
            });
            returnSheetData.push([]);
            returnSheetData.push(['', '', '', '', '', '', '', '총 금액', returns.reduce((s, r) => s + r.totalMargin, 0)]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(returnSheetData), "품목별비용");
        }

        XLSX.writeFile(wb, `${workDate}_${businessPrefix}_업무일지.xlsx`);
    };

    const depositListFnRef = useRef<() => void>(() => {});
    depositListFnRef.current = handleDownloadDepositList;
    const workLogFnRef = useRef<() => void>(() => {});
    workLogFnRef.current = handleDownloadWorkLog;
    const depositListWithExtraFnRef = useRef<(rows: { bankName: string; accountNumber: string; amount: string; label: string }[]) => void>(() => {});
    depositListWithExtraFnRef.current = handleDownloadDepositListWithExtra;
    const getDepositBaseRowsFnRef = useRef<() => any[][]>(() => []);
    getDepositBaseRowsFnRef.current = getDepositBaseRows;
    const downloadDepositListDirectFnRef = useRef<(baseRows: any[][], rows: { bankName: string; accountNumber: string; amount: string; label: string }[]) => void>(() => {});
    downloadDepositListDirectFnRef.current = downloadDepositListDirect;
    const onRegisterActionsRef = useRef(onRegisterActions);
    onRegisterActionsRef.current = onRegisterActions;
    useEffect(() => {
        onRegisterActionsRef.current?.({
            downloadDepositList: () => depositListFnRef.current(),
            downloadWorkLog: () => workLogFnRef.current(),
            downloadDepositListWithExtra: (rows) => depositListWithExtraFnRef.current(rows),
            getDepositBaseRows: () => getDepositBaseRowsFnRef.current(),
            downloadDepositListDirect: (baseRows, rows) => downloadDepositListDirectFnRef.current(baseRows, rows),
        });
    // 마운트 시 1회만 실행 - onRegisterActions dep 변경 시 재실행하면 setActions 루프 발생
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleDownloadOrderSummary = (data: { company: string; orderCount: number; deposit: number; margin: number }[]) => {
        if (data.length === 0) return;
        const header = ['업체', '주문', '입금액', '마진'];
        const rows = data.map(r => [r.company, r.orderCount, r.deposit, r.margin]);
        const totalOrders = data.reduce((s, r) => s + r.orderCount, 0);
        const totalDeposit = data.reduce((s, r) => s + r.deposit, 0);
        const totalMargin = data.reduce((s, r) => s + r.margin, 0);
        rows.push(['합계', totalOrders, totalDeposit, totalMargin]);
        const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
        ws['!cols'] = [{ wch: 15 }, { wch: 8 }, { wch: 15 }, { wch: 15 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '업체별요약');
        const dateStr = new Date().toLocaleDateString('en-CA');
        XLSX.writeFile(wb, `${dateStr}_${businessPrefix}_업체별요약.xlsx`);
    };

    const handleCopyOrderSummary = (data: { company: string; orderCount: number; deposit: number; margin: number }[]) => {
        if (data.length === 0) return;
        const totalOrders = data.reduce((s, r) => s + r.orderCount, 0);
        const totalDeposit = data.reduce((s, r) => s + r.deposit, 0);
        const totalMargin = data.reduce((s, r) => s + r.margin, 0);
        const lines = [
            ['업체', '주문', '입금액', '마진'].join('\t'),
            ...data.map(r => [r.company, r.orderCount, r.deposit, r.margin].join('\t')),
            ['합계', totalOrders, totalDeposit, totalMargin].join('\t'),
        ];
        navigator.clipboard.writeText(lines.join('\n'));
    };

    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
    const [saveError, setSaveError] = useState<string>('');

    const handleSaveToSalesHistory = async (companyOverride?: Set<string>) => {
        const selectedCompanyNames = companyOverride ?? checkedCompanies;
        if (selectedCompanyNames.size === 0) { alert('기록할 업체를 선택해주세요.'); return; }
        // 마스터파일 이름에서 날짜 파싱 (예: "0309_주문목록.xlsx" → "2026-03-09")
        let recordDate = workDate;
        if (masterOrderFile) {
            const fname = masterOrderFile.name;
            const fullMatch = fname.match(/(\d{4})-(\d{2})-(\d{2})/);
            const shortMatch = fname.match(/(\d{2})(\d{2})/);
            if (fullMatch) {
                recordDate = `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`;
            } else if (shortMatch) {
                const mm = parseInt(shortMatch[1]);
                const dd = parseInt(shortMatch[2]);
                if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
                    recordDate = `${new Date(workDate).getFullYear()}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                }
            }
        }
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));

        const isPartialSave = selectedCompanyNames.size < sortedCompanyNames.length;

        // 발주/송장 데이터 수집 (선택된 업체별 map)
        const newCompanyOrderRows: Record<string, any[][]> = {};
        const newCompanyInvoiceRows: Record<string, any[][]> = {};
        sortedCompanyNames.forEach(name => {
            if (!selectedCompanyNames.has(name)) return;
            const orderRows: any[][] = [];
            const invoiceRows: any[][] = [];
            (companySessions[name] || []).forEach(s => {
                if (allOrderRows[s.id]) orderRows.push(...allOrderRows[s.id]);
                if (allInvoiceRows[s.id]) invoiceRows.push(...allInvoiceRows[s.id]);
            });
            if (orderRows.length > 0) newCompanyOrderRows[name] = orderRows;
            if (invoiceRows.length > 0) newCompanyInvoiceRows[name] = invoiceRows;
        });

        // 입금 데이터 수집 (선택된 업체만, company 필드 포함)
        const depositRows: { bankName: string; accountNumber: string; amount: number; company?: string }[] = [];
        let depTotal = 0;
        sortedCompanyNames.forEach(name => {
            if (!selectedCompanyNames.has(name)) return;
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            sessions.forEach(s => {
                const amount = totalsMap[s.id] || 0;
                if (amount > 0) {
                    depositRows.push({ bankName: config?.bankName || '', accountNumber: config?.accountNumber || '', amount, company: name });
                    depTotal += amount;
                }
            });
        });
        manualTransfers.forEach(t => {
            depositRows.push({ bankName: t.bankName, accountNumber: t.accountNumber, amount: t.amount });
            depTotal += t.amount;
        });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice;
            depositRows.push({ bankName: fakeCourierSettings.bankName, accountNumber: fakeCourierSettings.accountNumber, amount: deliveryFee });
            depTotal += deliveryFee;
        }

        // 마진 데이터 수집 (선택된 업체만, company 필드 포함)
        const marginMap = new Map<string, MarginRecord>();
        sortedCompanyNames.forEach(name => {
            if (!selectedCompanyNames.has(name)) return;
            const companyConfig = pricingConfig[name];
            if (!companyConfig) return;
            (companySessions[name] || []).forEach(s => {
                const items = allOrderItems[s.id];
                if (!items) return;
                for (const item of items) {
                    const product = companyConfig.products[item.matchedProductKey] as any;
                    if (!product) continue;
                    const regName = item.registeredProductName || name;
                    const productName = product.orderFormName || product.displayName;
                    const margin = product.margin || 0;
                    const key = `${name}::${regName}::${item.matchedProductKey}`;
                    const existing = marginMap.get(key);
                    if (existing) {
                        existing.count += item.qty;
                        existing.totalMargin += margin * item.qty;
                    } else {
                        marginMap.set(key, {
                            registeredName: regName, productName, count: item.qty,
                            sellingPrice: product.sellingPrice || 0,
                            supplyPrice: product.supplyPrice || 0,
                            marginPerUnit: margin, totalMargin: margin * item.qty,
                            company: name,
                        });
                    }
                }
            });
        });
        const marginRecords = Array.from(marginMap.values());

        // summaryLines는 매출 records 생성 (선택된 업체만)
        const summaryLines: string[][] = [];
        sortedCompanyNames.forEach(name => {
            if (!selectedCompanyNames.has(name)) return;
            const sessions = companySessions[name] || [];
            let hasAdded = false;
            sessions.forEach(s => {
                const text = allSummaries[s.id];
                if (text && text.trim()) {
                    if (!hasAdded) { summaryLines.push([`[${name} 정산내역]`]); hasAdded = true; }
                    text.split('\n').forEach(line => summaryLines.push(line.split('\t')));
                    summaryLines.push([]);
                }
            });
        });

        // 합산 summaryLines에서 매출 records 생성 (같은 업체+상품은 합산)
        const recordMap = new Map<string, SalesRecord>();
        let recordCurrentCompany = '';
        for (const row of summaryLines) {
            const firstCell = String(row[0] || '').trim();
            const companyMatch = firstCell.match(/^\[(.+?)\s*정산내역\]$/);
            if (companyMatch) { recordCurrentCompany = companyMatch[1]; continue; }
            if (recordCurrentCompany && row.length >= 3) {
                const productName = String(row[1] || '').trim();
                const countMatch = String(row[2] || '').trim().match(/(\d+)개/);
                if (productName && countMatch) {
                    const count = parseInt(countMatch[1]);
                    const priceStr = String(row[3] || '').replace(/[,원\s]/g, '');
                    const totalPrice = parseInt(priceStr) || 0;
                    const companyConfig = pricingConfig[recordCurrentCompany];
                    let margin = 0;
                    if (companyConfig?.products) {
                        const productEntry = Object.values(companyConfig.products).find((p: any) => (p.orderFormName || p.displayName) === productName || p.displayName === productName);
                        if ((productEntry as any)?.margin) margin = (productEntry as any).margin;
                    }
                    const key = `${recordCurrentCompany}::${productName}`;
                    const existing = recordMap.get(key);
                    if (existing) {
                        existing.count += count;
                        existing.totalPrice += totalPrice;
                        existing.supplyPrice = existing.count > 0 ? Math.round(existing.totalPrice / existing.count) : 0;
                    } else {
                        const supplyPrice = count > 0 ? Math.round(totalPrice / count) : 0;
                        recordMap.set(key, { date: recordDate, company: recordCurrentCompany, product: productName, count, supplyPrice, totalPrice, margin });
                    }
                }
            }
        }
        const records = Array.from(recordMap.values());

        // Firestore는 undefined를 저장할 수 없으므로 null로 치환
        const sanitizeRows = (rows: any[][]): any[][] =>
            rows.map(row => row.map(cell => cell === undefined ? null : cell));

        // 기존 Firestore 데이터 로드 (반품 병합 + 부분 저장 merge에 공통 사용)
        let existingDailySales: DailySales | undefined;
        let allReturns = [...returns];
        try {
            const { loadDailySales } = await import('../services/firestoreService');
            existingDailySales = await loadDailySales(recordDate, businessId);
            if (existingDailySales?.returnRecords) {
                allReturns = [...existingDailySales.returnRecords, ...returns];
            }
        } catch {}
        const returnTotal = allReturns.reduce((s, r) => s + r.totalMargin, 0);

        // 부분 저장: 선택된 업체 데이터만 교체하고 나머지 기존 데이터 유지
        let mergedRecords = records;
        let mergedMarginRecords = marginRecords;
        let mergedDepositRows = depositRows;
        if (isPartialSave && existingDailySales) {
            mergedRecords = [
                ...(existingDailySales.records || []).filter(r => !selectedCompanyNames.has(r.company)),
                ...records,
            ];
            mergedMarginRecords = [
                ...(existingDailySales.marginRecords || []).filter(r => !r.company || !selectedCompanyNames.has(r.company)),
                ...marginRecords,
            ];
            // depositRecords: company 필드가 있는 것만 유지 (없는 건 수동이체/가구매로 항상 현재값 사용)
            mergedDepositRows = [
                ...(existingDailySales.depositRecords || []).filter(d => d.company && !selectedCompanyNames.has(d.company)),
                ...depositRows,
            ];
        }

        const totalAmount = mergedRecords.reduce((sum, r) => sum + r.totalPrice, 0);
        const marginTotal = mergedMarginRecords.reduce((sum, r) => sum + r.totalMargin, 0);
        const depositTotal = mergedDepositRows.reduce((sum, d) => sum + d.amount, 0);

        // 발주/송장: 업체별 map merge 후 flat 배열 도출
        const mergedCompanyOrderRows: Record<string, any[][]> = isPartialSave
            ? { ...(existingDailySales?.companyOrderRows || {}), ...newCompanyOrderRows }
            : newCompanyOrderRows;
        const mergedCompanyInvoiceRows: Record<string, any[][]> = isPartialSave
            ? { ...(existingDailySales?.companyInvoiceRows || {}), ...newCompanyInvoiceRows }
            : newCompanyInvoiceRows;
        const flatOrderRows = Object.values(mergedCompanyOrderRows).flat();
        const flatInvoiceRows = Object.values(mergedCompanyInvoiceRows).flat();

        const dailySales: DailySales = {
            date: recordDate, records: mergedRecords, totalAmount, savedAt: new Date().toISOString(),
            companyOrderRows: Object.keys(mergedCompanyOrderRows).length > 0 ? mergedCompanyOrderRows : undefined,
            companyInvoiceRows: Object.keys(mergedCompanyInvoiceRows).length > 0 ? mergedCompanyInvoiceRows : undefined,
            depositRecords: mergedDepositRows.length > 0 ? mergedDepositRows : undefined,
            depositTotal: depositTotal > 0 ? depositTotal : undefined,
            marginRecords: mergedMarginRecords.length > 0 ? mergedMarginRecords : undefined,
            marginTotal: marginTotal > 0 ? marginTotal : undefined,
            expenseRecords: allExpenses.length > 0 ? allExpenses : undefined,
            returnRecords: allReturns.length > 0 ? allReturns : undefined,
            returnTotal: returnTotal !== 0 ? returnTotal : undefined,
        };

        setSaveStatus('saving');
        try {
            await upsertDailySales(dailySales, businessId);
            setSaveStatus('success');
            setRecordedCompanies(prev => { const next = new Set(prev); selectedCompanyNames.forEach(n => next.add(n)); return next; });
            onSaved?.(recordDate);
            setTimeout(() => setSaveStatus('idle'), 2000);
        } catch (err: any) {
            console.error('매출 기록 저장 실패:', err);
            const rawMsg = err?.message || err?.code || '';
            let koreanMsg = '알 수 없는 오류가 발생했습니다.';
            if (rawMsg.includes('permission') || rawMsg.includes('PERMISSION_DENIED')) koreanMsg = 'Firestore 권한이 없습니다. 보안 규칙을 확인하세요.';
            else if (rawMsg.includes('not-found')) koreanMsg = 'Firestore 컬렉션을 찾을 수 없습니다.';
            else if (rawMsg.includes('unavailable') || rawMsg.includes('network')) koreanMsg = '네트워크 연결을 확인하세요.';
            else if (rawMsg.includes('undefined') || rawMsg.includes('unsupported field value')) koreanMsg = '저장 데이터에 잘못된 값이 포함되어 있습니다.';
            else if (rawMsg.includes('quota')) koreanMsg = 'Firestore 사용량 한도를 초과했습니다.';
            else if (rawMsg) koreanMsg = rawMsg;
            setSaveError(koreanMsg);
            setSaveStatus('error');
            setTimeout(() => setSaveStatus('idle'), 5000);
        }
    };

    const handleDeleteCompanyFromSalesHistory = async (companyName: string) => {
        let recordDate = workDate;
        if (masterOrderFile) {
            const fname = masterOrderFile.name;
            const fullMatch = fname.match(/(\d{4})-(\d{2})-(\d{2})/);
            const shortMatch = fname.match(/(\d{2})(\d{2})/);
            if (fullMatch) {
                recordDate = `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`;
            } else if (shortMatch) {
                const mm = parseInt(shortMatch[1]);
                const dd = parseInt(shortMatch[2]);
                if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
                    recordDate = `${new Date(workDate).getFullYear()}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                }
            }
        }
        try {
            const { loadDailySales } = await import('../services/firestoreService');
            const existing = await loadDailySales(recordDate, businessId);
            if (!existing) return;
            const updated = {
                ...existing,
                records: (existing.records || []).filter(r => r.company !== companyName),
                marginRecords: (existing.marginRecords || []).filter(r => !r.company || r.company !== companyName),
                depositRecords: (existing.depositRecords || []).filter(d => !d.company || d.company !== companyName),
                companyOrderRows: Object.fromEntries(Object.entries(existing.companyOrderRows || {}).filter(([k]) => k !== companyName)),
                companyInvoiceRows: Object.fromEntries(Object.entries(existing.companyInvoiceRows || {}).filter(([k]) => k !== companyName)),
            };
            updated.totalAmount = (updated.records || []).reduce((s: number, r: any) => s + r.totalPrice, 0);
            updated.marginTotal = (updated.marginRecords || []).reduce((s: number, r: any) => s + r.totalMargin, 0) || undefined;
            updated.depositTotal = (updated.depositRecords || []).reduce((s: number, d: any) => s + d.amount, 0) || undefined;
            if (!Object.keys(updated.companyOrderRows).length) delete (updated as any).companyOrderRows;
            if (!Object.keys(updated.companyInvoiceRows).length) delete (updated as any).companyInvoiceRows;
            await upsertDailySales(updated, businessId);
            setRecordedCompanies((prev: Set<string>) => { const next = new Set(prev); next.delete(companyName); return next; });
            onSaved?.(recordDate);
        } catch (err) {
            console.error('매출 기록 삭제 실패:', err);
        }
    };

    toggleCompanyClosedRef.current = handleToggleClosed;
    toggleCompanyRecordRef.current = (companyName: string) => {
        if (recordedCompanies.has(companyName)) {
            handleDeleteCompanyFromSalesHistory(companyName);
        } else {
            handleSaveToSalesHistory(new Set([companyName]));
        }
    };

    const grandTotal = (Object.values(totalsMap) as number[]).reduce((a: number, b: number) => a + b, 0) +
                       manualTransfers.reduce((a: number, b: ManualTransfer) => a + b.amount, 0);

    // 마스터 파일 vs 발주서 비교: 등록상품명별 수량 기준 누락 분석
    const missingOrderAnalysis = useMemo(() => {
        if (!masterProductSummary) return null;

        // 1. 처리 완료된 업체 + 세션ID 매핑
        const processedCompanies = new Set<string>();
        const companySessionIds: Record<string, string[]> = {};
        (Object.entries(companySessions) as [string, SessionData[]][]).forEach(([company, sessions]) => {
            companySessionIds[company] = [];
            sessions.forEach((s: SessionData) => {
                if (allOrderRows[s.id]?.length > 0 || allItemSummaries[s.id]) {
                    processedCompanies.add(company);
                    companySessionIds[company].push(s.id);
                }
            });
        });
        if (processedCompanies.size === 0) return null;

        // 2. 마스터 기준: 등록상품명(K열)별 실제 구매 수량(W열) 합산 (가구매 제외)
        //    realOrders는 이미 { groupName: qty } 형태로 가구매 제외된 수량
        const masterByGroup: Record<string, { qty: number; company: string }> = {};
        Object.entries(masterProductSummary.realOrders).forEach(([groupName, qty]) => {
            const company = masterProductSummary.productToCompany[groupName] || '';
            masterByGroup[groupName] = { qty: qty as number, company };
        });

        // 3. 발주서에서 처리된 등록상품명별 수량 합산 + 수취인 이름 추적
        //    preConsolidationByGroup 있으면 합산 전 수량 사용 (자동 합산으로 인한 오탐 방지)
        //    없으면 allRegisteredNames + allItemSummaries에서 계산
        const processedByGroup: Record<string, number> = {};
        // groupName → 처리된 수취인 이름 목록 (중복 허용, 동명이인 각각 카운트)
        const processedNamesByGroup: Record<string, string[]> = {};
        Object.entries(allRegisteredNames).forEach(([sessionId, regNames]: [string, Record<string, string>]) => {
            const preConsolidation = allPreConsolidationByGroup[sessionId];
            if (preConsolidation) {
                // 합산 전 groupName별 수량 직접 사용
                Object.entries(preConsolidation).forEach(([groupName, count]) => {
                    processedByGroup[groupName] = (processedByGroup[groupName] || 0) + (count as number);
                });
            } else {
                const itemSummary = allItemSummaries[sessionId];
                if (!itemSummary) return;
                Object.entries(regNames).forEach(([displayName, groupName]: [string, string]) => {
                    const count = itemSummary[displayName]?.count || 0;
                    processedByGroup[groupName] = (processedByGroup[groupName] || 0) + count;
                });
            }
        });
        // orderItems에서 수취인 이름을 groupName별로 수집
        (Object.values(allOrderItems) as { registeredProductName: string; recipientName: string }[][]).forEach(items => {
            items.forEach(item => {
                const groupName = item.registeredProductName;
                if (!processedNamesByGroup[groupName]) processedNamesByGroup[groupName] = [];
                if (item.recipientName) processedNamesByGroup[groupName].push(item.recipientName);
            });
        });

        /** 마스터 이름 목록에서 처리된 이름을 제거해 누락 이름만 반환 (동명이인 고려) */
        const computeMissingNames = (masterDetails: any[], groupName: string): string[] => {
            const processed = [...(processedNamesByGroup[groupName] || [])];
            const missing: string[] = [];
            for (const d of masterDetails) {
                const name = d.recipientName;
                if (!name) continue;
                const idx = processed.indexOf(name);
                if (idx !== -1) {
                    processed.splice(idx, 1); // 매칭된 이름 하나 소비
                } else {
                    missing.push(name);
                }
            }
            return missing;
        };

        // 4. 비교: 마스터 기준 - 발주서 처리 = 누락
        const missingGroups: { groupName: string; company: string; masterQty: number; processedQty: number; diffQty: number; reason: string; names: string[] }[] = [];

        Object.entries(masterByGroup).forEach(([groupName, { qty: masterQty, company }]) => {
            if (!company) {
                // 업체 미매칭: 마스터 전체가 누락
                const masterDetails = masterProductSummary.allOrderDetails
                    .filter((d: any) => d.groupName === groupName && !d.isFake);
                const names = masterDetails.map((d: any) => d.recipientName).filter((n: string) => n);
                missingGroups.push({ groupName, company: '', masterQty, processedQty: 0, diffQty: masterQty, reason: '업체 미매칭 (키워드 없음)', names });
            } else if (!processedCompanies.has(company)) {
                // 업체가 아직 미처리 → 건너뜀
                return;
            } else {
                const processedQty = processedByGroup[groupName] || 0;
                if (processedQty < masterQty) {
                    const diffQty = masterQty - processedQty;
                    const masterDetails = masterProductSummary.allOrderDetails
                        .filter((d: any) => d.groupName === groupName && d.company === company && !d.isFake);
                    const names = computeMissingNames(masterDetails, groupName);
                    missingGroups.push({
                        groupName, company, masterQty, processedQty, diffQty,
                        reason: processedQty === 0 ? `${company} 발주서에 없음` : `${company} 발주서 ${processedQty}건만 처리 (${diffQty}건 부족)`,
                        names,
                    });
                }
            }
        });

        // 등록상품명 없는 주문 (K열 비어있음)
        if (masterProductSummary.skippedOrders.length > 0) {
            const skippedQty = masterProductSummary.skippedOrders.reduce((s, o) => s + o.qty, 0);
            const skippedNames = masterProductSummary.skippedOrders.map((o: any) => o.recipientName).filter((n: string) => n);
            missingGroups.push({ groupName: '(등록상품명 없음)', company: '', masterQty: skippedQty, processedQty: 0, diffQty: skippedQty, reason: 'K열 비어있음', names: skippedNames });
        }

        // 업체별 누락 집계 (누락된 사람 이름 포함 - 이미 missingGroups.names가 진짜 누락 이름임)
        const missingByCompany: Record<string, { groupName: string; diffQty: number; names: string[] }[]> = {};
        missingGroups.forEach(m => {
            if (m.company) {
                if (!missingByCompany[m.company]) missingByCompany[m.company] = [];
                missingByCompany[m.company].push({ groupName: m.groupName, diffQty: m.diffQty, names: m.names });
            }
        });

        const totalMissingQty = missingGroups.reduce((sum, m) => sum + m.diffQty, 0);
        return { missingGroups, totalMissingQty, processedCompanies, missingByCompany };
    }, [masterProductSummary, companySessions, allOrderRows, allItemSummaries, allRegisteredNames, allOrderItems, allPreConsolidationByGroup]);

    const companySummaryData = useMemo(() => {
        const companies = sortCompanies(Object.keys(pricingConfig));
        return companies
            .map(c => {
                const sessions = companySessions[c] || [];
                const orderCount = sessions.reduce((sum, s) => sum + (allOrderRows[s.id]?.length || 0), 0);
                const calculatedDeposit = sessions.reduce((sum, s) => sum + (totalsMap[s.id] || 0), 0);
                const calculatedMargin = sessions.reduce((sum, s) => {
                    const items = allOrderItems[s.id] || [];
                    return sum + items.reduce((itemSum, item) => {
                        const product = (pricingConfig[c]?.products as any)?.[item.matchedProductKey];
                        return itemSum + ((product?.margin || 0) * item.qty);
                    }, 0);
                }, 0);
                const override = companyOverrides[c] || {};
                return {
                    company: c,
                    orderCount,
                    deposit: override.deposit !== undefined ? override.deposit : calculatedDeposit,
                    margin: override.margin !== undefined ? override.margin : calculatedMargin,
                    calculatedDeposit,
                    calculatedMargin,
                };
            })
            .filter(r => r.orderCount > 0);
    }, [pricingConfig, companySessions, allOrderRows, totalsMap, allOrderItems, companyOverrides, sortCompanies]);

    const isAllSelected = selectedSessionIds.size > 0 && selectedSessionIds.size === (Object.values(companySessions).flat() as SessionData[]).length;

    return (
        <div className="space-y-6 animate-fade-in">
            {/* 입금목록 추가 입력 모달 */}
            {showDepositModal && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) setShowDepositModal(false); }}>
                    <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
                            <div>
                                <h3 className="text-white font-black text-sm">입금목록 다운로드</h3>
                                <p className="text-zinc-500 text-[11px] mt-0.5">추가 행을 입력하고 다운로드하세요. 15행 초과 시 파일이 분할됩니다.</p>
                            </div>
                            <button onClick={() => setShowDepositModal(false)} className="text-zinc-500 hover:text-white transition-colors p-1">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
                            {/* 기존 행 (삭제 가능) */}
                            {depositBaseRows.length > 0 && (
                                <div>
                                    <p className="text-zinc-500 text-[11px] font-black uppercase tracking-widest mb-2">기존 입금 항목 ({depositBaseRows.length}건)</p>
                                    <div className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="text-zinc-600 text-[10px] font-black border-b border-zinc-800">
                                                    <th className="px-3 py-2 text-left">은행</th>
                                                    <th className="px-3 py-2 text-left">계좌번호</th>
                                                    <th className="px-3 py-2 text-right">금액</th>
                                                    <th className="px-3 py-2 text-left">비고</th>
                                                    <th className="px-3 py-2 w-6" />
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-zinc-900">
                                                {depositBaseRows.map((r, i) => (
                                                    <tr key={i} className="text-zinc-400 group">
                                                        <td className="px-3 py-1.5">{r[0]}</td>
                                                        <td className="px-3 py-1.5 font-mono">{r[1]}</td>
                                                        <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">{Number(r[2]).toLocaleString()}</td>
                                                        <td className="px-3 py-1.5 text-zinc-500">{r[3]}</td>
                                                        <td className="px-3 py-1.5">
                                                            <button
                                                                onClick={() => setDepositBaseRows(prev => prev.filter((_, j) => j !== i))}
                                                                className="text-zinc-700 hover:text-rose-400 transition-colors opacity-0 group-hover:opacity-100"
                                                            >
                                                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                            {/* 추가 행 입력 */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <p className="text-zinc-500 text-[11px] font-black uppercase tracking-widest">추가 입력</p>
                                    <button
                                        onClick={() => setDepositExtraRows(prev => [...prev, { bankName: '', accountNumber: '', amount: '', label: '' }])}
                                        className="text-[11px] font-bold text-violet-400 hover:text-violet-300 transition-colors px-2 py-1 rounded-lg bg-violet-500/10 hover:bg-violet-500/20"
                                    >
                                        + 행 추가
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    {depositExtraRows.map((row, idx) => (
                                        <div key={idx} className="flex gap-2 items-center">
                                            <input
                                                type="text"
                                                placeholder="은행"
                                                value={row.bankName}
                                                onChange={e => setDepositExtraRows(prev => prev.map((r, i) => i === idx ? { ...r, bankName: e.target.value } : r))}
                                                className="w-20 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 outline-none"
                                            />
                                            <input
                                                type="text"
                                                placeholder="계좌번호"
                                                value={row.accountNumber}
                                                onChange={e => setDepositExtraRows(prev => prev.map((r, i) => i === idx ? { ...r, accountNumber: e.target.value } : r))}
                                                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-white font-mono placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 outline-none"
                                            />
                                            <input
                                                type="number"
                                                placeholder="금액"
                                                value={row.amount}
                                                onChange={e => setDepositExtraRows(prev => prev.map((r, i) => i === idx ? { ...r, amount: e.target.value } : r))}
                                                className="w-28 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 outline-none"
                                            />
                                            <input
                                                type="text"
                                                placeholder="비고"
                                                value={row.label}
                                                onChange={e => setDepositExtraRows(prev => prev.map((r, i) => i === idx ? { ...r, label: e.target.value } : r))}
                                                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 outline-none"
                                            />
                                            <button
                                                onClick={() => setDepositExtraRows(prev => prev.filter((_, i) => i !== idx))}
                                                className="text-zinc-600 hover:text-rose-400 transition-colors p-1 flex-shrink-0"
                                            >
                                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                {/* 벌크 붙여넣기 */}
                                <div className="mt-3">
                                    <p className="text-zinc-600 text-[10px] font-bold mb-1.5">엑셀에서 복사 후 여기에 붙여넣기 (열 순서: 은행 / 계좌번호 / 금액 / 비고)</p>
                                    <textarea
                                        rows={3}
                                        placeholder={"우리\t1002-123-456789\t500000\t업체명\n하나\t111-222-333333\t300000\t다른업체"}
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-300 font-mono placeholder-zinc-700 focus:ring-1 focus:ring-violet-500/30 outline-none resize-none"
                                        onPaste={e => {
                                            e.preventDefault();
                                            const text = e.clipboardData.getData('text');
                                            const newRows = text.trim().split('\n').flatMap(line => {
                                                const cols = line.split('\t');
                                                if (cols.length < 2) return [];
                                                return [{ bankName: cols[0]?.trim() || '', accountNumber: cols[1]?.trim() || '', amount: cols[2]?.trim() || '', label: cols[3]?.trim() || '' }];
                                            });
                                            if (newRows.length > 0) setDepositExtraRows(prev => [...prev.filter(r => r.bankName || r.accountNumber || r.amount), ...newRows]);
                                        }}
                                    />
                                </div>
                            </div>
                            {/* 총합 미리보기 */}
                            {(() => {
                                const extraValid = depositExtraRows.filter(r => r.bankName || r.accountNumber || r.amount);
                                const totalRows = depositBaseRows.length + extraValid.length;
                                const totalAmount = depositBaseRows.reduce((s, r) => s + (Number(r[2]) || 0), 0)
                                    + extraValid.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                                const fileCount = Math.ceil(totalRows / 15) || 1;
                                return (
                                    <div className="bg-zinc-800/50 rounded-xl px-4 py-3 flex items-center justify-between">
                                        <div className="flex items-center gap-4 text-[11px]">
                                            <span className="text-zinc-500 font-bold">총 <span className="text-white">{totalRows}건</span></span>
                                            <span className="text-zinc-500 font-bold">합계 <span className="text-emerald-400 font-black">{totalAmount.toLocaleString()}원</span></span>
                                        </div>
                                        {fileCount > 1 && (
                                            <span className="text-amber-400 text-[11px] font-black">{fileCount}개 파일로 분할</span>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                        <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-2">
                            <button onClick={() => setShowDepositModal(false)} className="px-4 py-2 text-xs font-bold text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-all">
                                취소
                            </button>
                            <button onClick={handleDepositModalDownload} className="flex items-center gap-2 px-5 py-2 text-xs font-black text-white bg-violet-600 hover:bg-violet-500 rounded-xl transition-all">
                                <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                                다운로드
                            </button>
                        </div>
                    </div>
                </div>
            , document.body)}

            <div>
                <section className="glass rounded-[1.8rem] p-6 shadow-xl">
                    <div className="flex flex-col gap-6">
                    </div>
                </section>
            </div>

            {/* 사이드바 포탈: 수동 발주 + 발주서 업로드 + 가구매 명단 */}
            {isCurrent && document.getElementById(portalId || 'manual-order-portal') && createPortal(
                <>
                {/* 1) 수동 발주 추가 */}
                <details className="glass-light rounded-2xl mb-3 group/manual">
                    <summary className="flex items-center justify-between gap-2 p-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/20 rounded-2xl transition-colors duration-200">
                        <h3 className="text-zinc-400 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
                            <div className="bg-rose-500/10 p-1 rounded-lg"><PlusCircleIcon className="w-3.5 h-3.5 text-rose-400" /></div>
                            수동 발주 추가
                            {manualOrders.length > 0 && (
                                <span className="bg-rose-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-black">{manualOrders.filter(o => selectedManualOrderIds.has(o.id)).length}/{manualOrders.length}</span>
                            )}
                        </h3>
                        <span className="text-zinc-600 text-[10px] transition-transform group-open/manual:rotate-180">▼</span>
                    </summary>
                    <div className="px-4 pb-4">
                    <div className="flex flex-wrap gap-1.5 mb-3">
                        <span className="text-zinc-600 text-[9px] font-black uppercase self-center mr-0.5">빠른 선택 :</span>
                        {quickRecipients.map(p => (
                            <div key={p.name} className="group relative flex items-center">
                                <button type="button" onClick={() => handleQuickSelect(p)} className="px-2.5 py-1 bg-zinc-800 hover:bg-rose-500 hover:text-white border border-zinc-700 rounded-full text-[10px] font-black text-zinc-400 transition-all shadow-sm">{p.name}</button>
                                <button type="button" onClick={() => { if (confirm(`'${p.name}' 수령자를 삭제할까요?`)) { const updated = quickRecipients.filter(r => r.name !== p.name); setQuickRecipients(updated); saveQuickRecipients(updated, businessId); } }} className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-zinc-700 hover:bg-red-500 text-zinc-400 hover:text-white rounded-full text-[8px] font-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">×</button>
                            </div>
                        ))}
                        {!showAddRecipient ? (
                            <button type="button" onClick={() => setShowAddRecipient(true)} className="px-2 py-1 border border-dashed border-zinc-700 hover:border-rose-500 rounded-full text-[10px] font-black text-zinc-600 hover:text-rose-400 transition-all">+ 추가</button>
                        ) : (
                            <div className="flex flex-col gap-1.5 w-full bg-zinc-900 border border-zinc-700 rounded-xl px-2 py-1.5 mt-1">
                                <div className="flex gap-1.5">
                                    <input placeholder="이름" value={newRecipient.name} onChange={e => setNewRecipient(prev => ({...prev, name: e.target.value}))} className="flex-1 bg-transparent text-[10px] font-bold text-white outline-none placeholder:text-zinc-600" />
                                    <input placeholder="전화번호" value={newRecipient.phone} onChange={e => setNewRecipient(prev => ({...prev, phone: e.target.value}))} className="flex-1 bg-transparent text-[10px] font-bold text-white outline-none placeholder:text-zinc-600" />
                                </div>
                                <input placeholder="주소" value={newRecipient.address} onChange={e => setNewRecipient(prev => ({...prev, address: e.target.value}))} className="w-full bg-transparent text-[10px] font-bold text-white outline-none placeholder:text-zinc-600" />
                                <div className="flex gap-1.5 justify-end">
                                    <button type="button" onClick={() => { if (!newRecipient.name.trim()) return; const updated = [...quickRecipients, { name: newRecipient.name.trim(), phone: newRecipient.phone.trim(), address: newRecipient.address.trim() }]; setQuickRecipients(updated); saveQuickRecipients(updated, businessId); setNewRecipient({ name: '', phone: '', address: '' }); setShowAddRecipient(false); }} className="px-2 py-0.5 bg-rose-500 hover:bg-rose-600 text-white rounded-lg text-[9px] font-black transition-all">등록</button>
                                    <button type="button" onClick={() => { setShowAddRecipient(false); setNewRecipient({ name: '', phone: '', address: '' }); }} className="px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300 text-[9px] font-black transition-all">취소</button>
                                </div>
                            </div>
                        )}
                    </div>
                    <form onSubmit={handleAddManualOrder} className="flex flex-col gap-2">
                        <div className="grid grid-cols-2 gap-2">
                            <select value={manualInput.companyName} onChange={e => setManualInput({...manualInput, companyName: e.target.value, productName: '', productKey: ''})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
                                <option value="">업체 선택</option>
                                {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                            </select>
                            <input placeholder="수령자" value={manualInput.recipientName} onChange={e => setManualInput({...manualInput, recipientName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <input placeholder="전화번호" value={manualInput.phone} onChange={e => setManualInput({...manualInput, phone: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                            <input placeholder="주소" value={manualInput.address} onChange={e => setManualInput({...manualInput, address: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <select value={manualInput.productKey} onChange={e => {
                                const selectedKey = e.target.value;
                                const p = pricingConfig[manualInput.companyName]?.products?.[selectedKey] as any;
                                const resolvedName = p ? (p.orderFormName || p.displayName || selectedKey) : selectedKey;
                                setManualInput({...manualInput, productKey: selectedKey, productName: resolvedName});
                            }} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
                                <option value="">품목 선택</option>
                                {manualInput.companyName && pricingConfig[manualInput.companyName]?.products &&
                                    Object.entries(pricingConfig[manualInput.companyName].products).map(([key, p]: [string, any]) => (
                                        <option key={key} value={key}>{p.displayName || key}{p.orderFormName && p.orderFormName !== p.displayName ? ` → ${p.orderFormName}` : ''} ({(Number(p.supplyPrice) || 0).toLocaleString()}원)</option>
                                    ))
                                }
                            </select>
                            <div className="flex gap-2">
                                <input type="number" placeholder="수량" value={manualInput.qty} onChange={e => setManualInput({...manualInput, qty: e.target.value})} className="w-14 bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                <button type="submit" className={`flex-1 rounded-xl text-xs font-black transition-all ${editingOrderId ? 'bg-amber-500 hover:bg-amber-400 text-white' : 'btn-accent'}`}>{editingOrderId ? '수정 완료' : '추가'}</button>
                            </div>
                        </div>
                        <div className="flex gap-2 items-center">
                            <input placeholder="메모 (배송메세지로 입력됨)" value={manualInput.memo} onChange={e => setManualInput({...manualInput, memo: e.target.value})} className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                            {editingOrderId && <button type="button" onClick={handleCancelEditManualOrder} className="px-2.5 py-2 text-[10px] font-black text-zinc-500 hover:text-zinc-300 transition-colors whitespace-nowrap">취소</button>}
                        </div>
                    </form>
                    {manualOrders.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {manualOrders.map(o => {
                                const isSelected = selectedManualOrderIds.has(o.id);
                                const isEditing = editingOrderId === o.id;
                                return (
                                <div key={o.id} className={`px-2.5 py-1 rounded-lg border flex items-center gap-1.5 group animate-pop-in cursor-pointer transition-all ${isEditing ? 'bg-amber-900/30 border-amber-600/50' : isSelected ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-950 border-zinc-900 opacity-40'}`} onClick={() => handleToggleManualOrderSelection(o.id)}>
                                    <input type="checkbox" checked={isSelected} onChange={() => handleToggleManualOrderSelection(o.id)} onClick={e => e.stopPropagation()} className="w-3 h-3 accent-rose-500 cursor-pointer" />
                                    <span className="text-[10px] font-black text-rose-500">{o.companyName}</span>
                                    <span className="text-[10px] font-bold text-zinc-300">{o.recipientName}</span>
                                    <span className="text-[9px] text-zinc-600 truncate max-w-[60px]">{o.productName}</span>
                                    <button onClick={(e) => { e.stopPropagation(); handleStartEditManualOrder(o); }} className="text-amber-500 hover:text-amber-300 transition-colors"><PencilIcon className="w-3 h-3" /></button>
                                    <button onClick={(e) => { e.stopPropagation(); handleRemoveManualOrder(o.id); }} className="text-zinc-700 hover:text-rose-500 transition-colors"><TrashIcon className="w-3 h-3" /></button>
                                </div>
                                );
                            })}
                        </div>
                    )}
                    </div>
                </details>

                {/* 1-2) 수동 입금 추가 */}
                <details className="glass-light rounded-2xl mb-3 group/transfer">
                    <summary className="flex items-center justify-between gap-2 p-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/20 rounded-2xl transition-colors duration-200">
                        <h3 className="text-zinc-400 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
                            <div className="bg-indigo-500/10 p-1 rounded-lg"><ArrowDownTrayIcon className="w-3.5 h-3.5 text-indigo-400" /></div>
                            수동 입금 추가
                            {manualTransfers.length > 0 && (
                                <span className="bg-indigo-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-black">{manualTransfers.length}</span>
                            )}
                        </h3>
                        <span className="text-zinc-600 text-[10px] transition-transform group-open/transfer:rotate-180">▼</span>
                    </summary>
                    <div className="px-4 pb-4">
                        <div className="flex p-1 bg-zinc-950 rounded-lg border border-zinc-800 mb-3">
                            <button onClick={() => setIsBulkMode(false)} className={`flex-1 px-3 py-1.5 rounded-md text-[10px] font-black transition-all ${!isBulkMode ? 'bg-zinc-800 text-white' : 'text-zinc-600'}`}>수동 입력</button>
                            <button onClick={() => setIsBulkMode(true)} className={`flex-1 px-3 py-1.5 rounded-md text-[10px] font-black transition-all ${isBulkMode ? 'bg-indigo-600 text-white' : 'text-zinc-600'}`}>지능형 분석</button>
                        </div>
                        {!isBulkMode ? (
                            <form onSubmit={handleAddManualTransfer} className="grid grid-cols-2 gap-2 items-end">
                                <input type="text" placeholder="은행명" value={newTransfer.bankName} onChange={e => setNewTransfer({...newTransfer, bankName: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-white focus:outline-none" />
                                <input type="text" placeholder="계좌번호" value={newTransfer.accountNumber} onChange={e => setNewTransfer({...newTransfer, accountNumber: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono font-bold text-white focus:outline-none" />
                                <input type="number" placeholder="금액" value={newTransfer.amount} onChange={e => setNewTransfer({...newTransfer, amount: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-black text-rose-500 focus:outline-none" />
                                <input type="text" placeholder="입금자명" value={newTransfer.label} onChange={e => setNewTransfer({...newTransfer, label: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-white focus:outline-none" />
                                <button type="submit" className="col-span-2 bg-indigo-600 hover:bg-indigo-500 text-white font-black py-2 rounded-lg transition-all shadow-lg text-xs">추가</button>
                            </form>
                        ) : (
                            <div className="space-y-3">
                                <textarea placeholder={"한 줄에 하나씩, 순서/형식 자유\n예: 홍길동 국민 123-456-7890123 31000\n예: 50,000원 신한은행 김철수 110-123-456789"} value={bulkText} onChange={e => setBulkText(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-xs font-mono text-zinc-300 focus:outline-none h-24 resize-none" />
                                <div className="flex justify-end">
                                    <button onClick={() => {
                                        const BANK_ALIAS: Record<string, string> = { '카뱅': '카카오뱅크', '카카오': '카카오뱅크', '토스': '토스뱅크' };
                                        const BANKS = ['KB국민','국민','신한','우리','하나','NH농협','농협','IBK기업','기업','SC제일','씨티','카카오뱅크','카뱅','카카오','토스뱅크','토스','새마을','수협','부산','대구','경남','광주','전북','제주','KDB산업','산업','우체국','케이뱅크','K뱅크'];
                                        const lines = bulkText.split('\n');
                                        const newEntries: ManualTransfer[] = [];
                                        lines.forEach((line, idx) => {
                                            let r = line.trim();
                                            if (!r) return;
                                            let acct = '';
                                            const dashMatch = r.match(/\d+(-\d+)+/);
                                            if (dashMatch) { acct = dashMatch[0]; r = r.replace(dashMatch[0], ' '); }
                                            let bank = '';
                                            for (const b of BANKS) {
                                                const m = r.match(new RegExp(b + '(은행)?'));
                                                if (m) { bank = BANK_ALIAS[b] || m[0]; r = r.replace(m[0], ' '); break; }
                                            }
                                            let amt = 0;
                                            const commaMatch = r.match(/(\d{1,3}(,\d{3})+)\s*원?/);
                                            if (commaMatch) { amt = parseInt(commaMatch[1].replace(/,/g, '')); r = r.replace(commaMatch[0], ' '); }
                                            else { const wonMatch = r.match(/(\d+)\s*원/); if (wonMatch) { amt = parseInt(wonMatch[1]); r = r.replace(wonMatch[0], ' '); } }
                                            const tokens = r.trim().split(/\s+/).filter(Boolean);
                                            const leftover: string[] = [];
                                            for (const t of tokens) {
                                                const clean = t.replace(/[,원]/g, '');
                                                if (/^\d+$/.test(clean)) {
                                                    if (!acct && clean.length >= 8) acct = clean;
                                                    else if (!amt && parseInt(clean) > 0) amt = parseInt(clean);
                                                    else leftover.push(t);
                                                } else leftover.push(t);
                                            }
                                            const label = leftover.join(' ').trim();
                                            if (amt > 0 || label) newEntries.push({ id: `bulk-${Date.now()}-${idx}`, label: label || '', bankName: bank, accountNumber: acct, amount: amt });
                                        });
                                        setManualTransfers(prev => [...prev, ...newEntries]); setBulkText(''); setIsBulkMode(false);
                                    }} className="bg-indigo-600 hover:bg-indigo-500 text-white font-black py-2.5 px-6 rounded-xl transition-all shadow-xl flex items-center gap-2 text-xs">
                                        <BoltIcon className="w-4 h-4" /><span>분석 및 추가</span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </details>

                {/* 워크스테이션 초기화 */}
                <div className="flex justify-end mb-2">
                    <button onClick={handleResetWorkstations} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black text-zinc-500 hover:text-rose-400 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-rose-500/30 rounded-lg transition-all" title="워크스테이션 초기화">
                        <ArrowPathIcon className="w-3.5 h-3.5" />
                        <span>워크스테이션 초기화</span>
                    </button>
                </div>

                {/* 2) 발주서 엑셀 파일 업로드 */}
                <div className="mb-3 flex flex-col gap-2">
                    <label
                        htmlFor={`file-upload-sidebar-${businessId}`}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-2xl bg-zinc-800 border border-zinc-700/40 hover:border-zinc-600 cursor-pointer transition-all duration-200"
                        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f) handleMasterUpload(f); }}
                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    >
                        <div className="bg-pink-500/10 p-1 rounded-lg shrink-0"><DocumentArrowUpIcon className="w-3.5 h-3.5 text-pink-400" /></div>
                        <span className="text-[12px] font-black text-zinc-400">발주서 엑셀 업로드</span>
                        <input id={`file-upload-sidebar-${businessId}`} type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMasterUpload(f); }} />
                    </label>
                    {masterOrderFile && (
                        <div className="bg-zinc-950 p-3 rounded-2xl border border-zinc-800 shadow-inner flex flex-col gap-2 animate-pop-in">
                            <div className="flex justify-between items-center">
                                <h4 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest">Master File</h4>
                                <button onClick={clearMasterFile} className="text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg p-1 transition-all" title="업로드 취소 및 초기화"><XMarkIcon className="w-3.5 h-3.5" /></button>
                            </div>
                            <div className="text-white font-black text-xs truncate">{masterOrderFile.name}</div>
                            <div className="flex items-center gap-2">
                                <span className="bg-rose-500 text-white px-2 py-0.5 rounded-full text-[9px] font-black">{detectedCompanies.size}개 업체 탐지</span>
                            </div>
                            {masterProductSummary && (() => {
                                const totalMaster = masterProductSummary.masterRawTotalQty;
                                const totalRecognized = masterProductSummary.realTotal + masterProductSummary.fakeTotal;
                                const diff = totalMaster - totalRecognized;
                                const hasUnclaimed = masterProductSummary.unclaimedOrders.length > 0;
                                const hasUnknown = masterProductSummary.unknownGroupNames.length > 0;
                                const isOk = diff === 0 && !hasUnclaimed && !hasUnknown;
                                return (
                                <>
                                <div className={`rounded-lg px-2 py-1.5 text-[10px] font-black ${
                                    isOk ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                        : 'bg-red-600/20 border-2 border-red-500/60 text-red-400'
                                }`}>
                                    <div className="flex items-center gap-1 flex-wrap">
                                        <span>{isOk ? '✓' : '⚠'}</span>
                                        <span className="text-sky-400">마스터 {totalMaster}건</span>
                                        <span className="text-zinc-600">=</span>
                                        <span className="text-emerald-400">실제 {masterProductSummary.realTotal}</span>
                                        <span className="text-zinc-600">+</span>
                                        <span className="text-pink-400">가구매 {masterProductSummary.fakeTotal}</span>
                                        {diff > 0 && <span className="text-red-400 ml-1">({diff}건 누락)</span>}
                                    </div>
                                    {diff > 0 && masterProductSummary.skippedOrders.length > 0 && (
                                        <div className="text-red-300 mt-0.5 pl-3">
                                            등록상품명 없음 {masterProductSummary.skippedOrders.length}건
                                        </div>
                                    )}
                                    {hasUnclaimed && (
                                        <div className="text-amber-300 mt-0.5 pl-3">
                                            업체 미매칭: {masterProductSummary.unclaimedOrders.map(u => u.groupName).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                                        </div>
                                    )}
                                </div>
                                {hasUnknown && (
                                    <div className="mt-1.5 rounded-lg px-2 py-2 bg-orange-500/15 border-2 border-orange-500/70 text-orange-300 text-[10px] font-black">
                                        <div className="flex items-center gap-1 mb-1">
                                            <span className="text-orange-400 text-[12px]">⚠</span>
                                            <span className="text-orange-300 uppercase tracking-wide">미인식 등록상품명 — 발주서 오매칭 위험</span>
                                        </div>
                                        <div className="text-orange-200/80 text-[9px] mb-1 leading-relaxed">
                                            아래 등록상품명이 어느 업체 키워드에도 없습니다. 잘못된 업체·품목으로 발주서가 생성될 수 있습니다.
                                        </div>
                                        <div className="flex flex-col gap-0.5">
                                            {masterProductSummary.unknownGroupNames.map(gn => (
                                                <span key={gn} className="px-1.5 py-0.5 bg-orange-500/20 rounded text-orange-200 text-[9px] font-mono break-all">{gn}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                </>
                                );
                            })()}
                        </div>
                    )}
                    {masterOrderFile && masterOrderData && (() => {
                        // 차수별 K값 소스 계산
                        const batchRounds = [...new Set(
                            (Object.values(companySessions).flat() as SessionData[])
                                .filter(s => !!batchFiles[s.id])
                                .map(s => s.round)
                        )].sort((a, b) => a - b);
                        const availableRounds = batchRounds.length > 0 ? [1, ...batchRounds] : [];
                        const activeRound = kReplaceRound ?? 1;
                        const roundRows: any[][] = activeRound === 1
                            ? masterOrderData.slice(1)
                            : (Object.values(companySessions).flat() as SessionData[])
                                .filter(s => s.round === activeRound && !!batchFiles[s.id])
                                .flatMap(s => batchMasterRows[s.id] || []);
                        const uniqueKValues = ([...new Set(
                            roundRows.map((r: any[]) => String(r[10] || '').trim()).filter((v: string) => v.length > 0)
                        )] as string[]).sort((a, b) => a.localeCompare(b, 'ko'));
                        const allVendorKeywords = (Object.entries(pricingConfig) as [string, import('../types').CompanyConfig][]).flatMap(([company, cfg]) =>
                            (cfg.keywords || []).map((kw: string) => ({ kw, company }))
                        ).sort((a, b) => a.kw.localeCompare(b.kw, 'ko'));
                        return (
                        <div className="bg-zinc-950 p-3 rounded-2xl border border-zinc-800 shadow-inner flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <div className="bg-amber-500/10 p-1 rounded-lg shrink-0">
                                    <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
                                </div>
                                <h4 className="text-zinc-400 font-black text-[10px] uppercase tracking-widest">등록상품명 교체</h4>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                {/* 차수 선택 (배치 세션이 있을 때만 표시) */}
                                {availableRounds.length > 1 && (
                                    <div className="flex gap-1">
                                        {availableRounds.map(r => (
                                            <button
                                                key={r}
                                                onClick={() => {
                                                    setKReplaceRound(r === 1 ? null : r);
                                                    setKReplaceFrom(''); setKReplaceTo('');
                                                    setKReplaceFromCompany(''); setKReplaceToCompany('');
                                                    setKReplaceProductMap({});
                                                }}
                                                className={`px-2 py-0.5 text-[10px] font-black rounded-md border transition-all ${activeRound === r ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:text-zinc-300'}`}
                                            >{r}차</button>
                                        ))}
                                    </div>
                                )}
                                {/* K열 교체 */}
                                <select
                                    value={kReplaceFrom}
                                    onChange={e => {
                                        const val = e.target.value;
                                        setKReplaceFrom(val);
                                        setKReplaceProductMap({});
                                        // K값 → 업체 역추적
                                        const normVal = val.replace(/\s+/g, '').normalize('NFC');
                                        let bestComp = ''; let bestPos = Infinity;
                                        for (const [cName] of (Object.entries(pricingConfig) as [string, import('../types').CompanyConfig][])) {
                                            for (const kw of getKeywordsForCompany(cName, pricingConfig)) {
                                                const pos = normVal.indexOf(kw.replace(/\s+/g, '').normalize('NFC'));
                                                if (pos !== -1 && pos < bestPos) { bestPos = pos; bestComp = cName; }
                                            }
                                        }
                                        setKReplaceFromCompany(bestComp);
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-bold rounded-lg px-2 py-1.5 focus:outline-none focus:border-amber-500/50"
                                >
                                    <option value="">현재 K열 값 선택...</option>
                                    {uniqueKValues.map(v => (
                                        <option key={v} value={v}>{v}</option>
                                    ))}
                                </select>
                                <select
                                    value={kReplaceTo ? `${kReplaceToCompany}::${kReplaceTo}` : ''}
                                    onChange={e => {
                                        if (!e.target.value) { setKReplaceTo(''); setKReplaceToCompany(''); return; }
                                        const idx = e.target.value.indexOf('::');
                                        const company = e.target.value.slice(0, idx);
                                        const kw = e.target.value.slice(idx + 2);
                                        if (company !== kReplaceToCompany) setKReplaceProductMap({});
                                        setKReplaceTo(kw);
                                        setKReplaceToCompany(company);
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-bold rounded-lg px-2 py-1.5 focus:outline-none focus:border-amber-500/50"
                                >
                                    <option value="">교체할 등록상품명 선택...</option>
                                    {allVendorKeywords.map(({ kw, company }) => (
                                        <option key={`${company}::${kw}`} value={`${company}::${kw}`}>{kw} ({company})</option>
                                    ))}
                                </select>
                                {/* 품목 매핑: a업체 품목명 → b업체 품목명 */}
                                {kReplaceFrom && kReplaceFromCompany && (() => {
                                    const fromProducts = (pricingConfig as import('../types').PricingConfig)[kReplaceFromCompany]?.products || {};
                                    const hdrs = ((masterOrderData![0] as any[]) || []).map((h: any) => String(h || '').trim());
                                    let optIdx = hdrs.findIndex((h: string) => h.includes('옵션정보'));
                                    if (optIdx === -1) optIdx = hdrs.findIndex((h: string) => h.includes('옵션') && !h.includes('관리코드') && !h.includes('번호'));
                                    // 선택된 차수 데이터에서 실제로 매칭되는 a업체 품목 추출
                                    const matchedFromSet = new Set<string>();
                                    roundRows.forEach((r: any[]) => {
                                        if (String(r[10] || '').trim() !== kReplaceFrom) return;
                                        const rowL = String(r[11] || '').trim();
                                        const optVal = optIdx !== -1 ? String(r[optIdx] || '').trim() : '';
                                        let rpn = `${kReplaceFrom} ${rowL}`.trim();
                                        if (optVal) rpn += ' ' + optVal;
                                        const dn = matchProductSync(rpn, fromProducts, kReplaceFrom);
                                        if (dn) matchedFromSet.add(dn);
                                    });
                                    const fromList = [...matchedFromSet].sort((a, b) => a.localeCompare(b, 'ko'));
                                    const targetProducts = kReplaceToCompany
                                        ? Object.values((pricingConfig[kReplaceToCompany] as import('../types').CompanyConfig | undefined)?.products || {}).map(p => p.displayName).sort((a, b) => a.localeCompare(b, 'ko'))
                                        : [];
                                    if (fromList.length === 0) return null;
                                    return (
                                        <>
                                            <div className="h-px bg-zinc-800 my-0.5" />
                                            <span className="text-[9px] font-black text-zinc-600 uppercase tracking-wide">품목 매핑 ({kReplaceFromCompany} → {kReplaceToCompany || '?'})</span>
                                            {fromList.map(fromDN => (
                                                <div key={fromDN} className="flex flex-col gap-0.5">
                                                    <span className="text-[10px] text-zinc-500 truncate">{fromDN}</span>
                                                    <select
                                                        value={kReplaceProductMap[fromDN] || ''}
                                                        onChange={e => setKReplaceProductMap(prev => {
                                                            const next = { ...prev };
                                                            if (e.target.value) next[fromDN] = e.target.value;
                                                            else delete next[fromDN];
                                                            return next;
                                                        })}
                                                        disabled={!kReplaceToCompany}
                                                        className="w-full bg-zinc-900 border border-zinc-700 text-zinc-300 text-[11px] font-bold rounded-lg px-2 py-1.5 focus:outline-none focus:border-amber-500/50 disabled:opacity-40"
                                                    >
                                                        <option value="">{kReplaceToCompany ? '→ 새 업체 품목명 선택' : '(K열 대상 먼저 선택)'}</option>
                                                        {targetProducts.map(v => (
                                                            <option key={v} value={v}>{v}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            ))}
                                        </>
                                    );
                                })()}
                                <button
                                    onClick={applyKValueReplacement}
                                    disabled={!kReplaceFrom || !kReplaceTo || kReplaceFrom === kReplaceTo}
                                    className="w-full py-1.5 text-[11px] font-black rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/30 hover:border-amber-400/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    교체 적용
                                </button>
                            </div>
                            {kReplaceHistory.length > 0 && (
                                <div className="flex flex-col gap-1 mt-0.5">
                                    {kReplaceHistory.map((h, i) => (
                                        <div key={i} className="flex flex-col gap-0.5 text-[10px]">
                                            <div className="flex items-center gap-1">
                                                <span className="text-zinc-500 truncate max-w-[80px]">{h.from}</span>
                                                <span className="text-amber-600 shrink-0">→</span>
                                                <span className="text-amber-300 truncate max-w-[80px]">{h.to}</span>
                                            </div>
                                            {h.productMap && Object.entries(h.productMap).map(([lFrom, lTo]) => (
                                                <div key={lFrom} className="flex items-center gap-1 pl-2">
                                                    <span className="text-zinc-600 truncate max-w-[70px]">{lFrom}</span>
                                                    <span className="text-zinc-700 shrink-0">→</span>
                                                    <span className="text-zinc-400 truncate max-w-[70px]">{lTo}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        );
                    })()}
                    {masterOrderFile && (
                        <div className="bg-zinc-950 rounded-2xl border border-dashed border-zinc-700 hover:border-rose-500/50 transition-all overflow-hidden">
                            {(() => {
                                const roundMap = new Map<number, string>();
                                (Object.entries(batchFiles) as [string, File][]).forEach(([sessionId, file]) => {
                                    const match = sessionId.match(/-batch-(\d+)-/);
                                    if (match) {
                                        const round = parseInt(match[1]);
                                        if (!roundMap.has(round)) roundMap.set(round, file.name);
                                    }
                                });
                                const rounds = Array.from(roundMap.entries()).sort((a, b) => a[0] - b[0]);
                                return rounds.length > 0 ? (
                                    <div className="px-2 pt-1.5 pb-0.5 flex flex-col gap-0.5">
                                        {rounds.map(([round, fileName]) => (
                                            <div key={round} className="flex items-center gap-1.5 group/round">
                                                <span className="text-rose-400 font-black text-[9px] shrink-0">{round}차</span>
                                                <span className="text-zinc-500 text-[9px] truncate flex-1">{fileName}</span>
                                                <button onClick={() => handleDeleteBatchRound(round)} className="shrink-0 opacity-0 group-hover/round:opacity-100 text-zinc-600 hover:text-red-400 transition-all text-[9px] leading-none px-0.5" title={`${round}차 삭제`}>✕</button>
                                            </div>
                                        ))}
                                    </div>
                                ) : null;
                            })()}
                            <input ref={batchFileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleBatchUpload(f).catch(err => alert(err?.message || '배치 업로드 오류')); e.target.value = ''; } }} />
                            <button onClick={() => batchFileInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 py-1.5 text-[10px] font-black text-zinc-500 hover:text-rose-400 transition-colors">
                                <PlusCircleIcon className="w-3.5 h-3.5" />
                                <span>{(() => { let max = 0; (Object.values(companySessions) as SessionData[][]).forEach(ss => ss.forEach(s => { if (s.round > max) max = s.round; })); return `${max + 1}차 주문서 일괄 업로드`; })()}</span>
                            </button>
                        </div>
                    )}
                </div>

                {/* 3) 가구매 명단 설정 */}
                <div className="glass-light p-4 rounded-2xl mb-3">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <div className="bg-violet-500/10 p-1.5 rounded-lg"><BoltIcon className="w-3.5 h-3.5 text-violet-400" /></div>
                            <h3 className="text-zinc-200 font-black text-[12px] uppercase tracking-widest flex items-center gap-1.5">
                                가구매 명단 설정
                                {globalFakeOrderInput?.trim() && (
                                    <span className="text-[9px] bg-violet-900/40 text-violet-400 border border-violet-500/30 px-1.5 py-0.5 rounded-full font-black">전역</span>
                                )}
                                {fakeOrderAnalysis.inputLineCount > 0 && (
                                    <div className="flex gap-1 flex-wrap">
                                        <span className="bg-zinc-800 text-zinc-400 text-[11px] px-2 py-0.5 rounded-full animate-pop-in border border-zinc-700 font-black">
                                            총 {fakeOrderAnalysis.inputLineCount}명
                                        </span>
                                        {(fakeOrderAnalysis.matched.length + fakeOrderAnalysis.specialMatchLines.length) > 0 && (
                                            <span className="bg-emerald-500 text-white text-[11px] px-2 py-0.5 rounded-full animate-pop-in font-black">
                                                매칭 {fakeOrderAnalysis.matched.length + fakeOrderAnalysis.specialMatchLines.length}
                                            </span>
                                        )}
                                        {fakeOrderAnalysis.unmatchedLines.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[11px] px-2 py-0.5 rounded-full animate-pop-in font-black">
                                                미매칭 {fakeOrderAnalysis.unmatchedLines.length}
                                            </span>
                                        )}
                                        {fakeOrderAnalysis.duplicates.length > 0 && (
                                            <span className="bg-pink-500 text-black text-[11px] px-2 py-0.5 rounded-full animate-pop-in font-black">
                                                중복번호 {fakeOrderAnalysis.duplicates.length}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </h3>
                        </div>
                        <div className="flex gap-1">
                            <input ref={fakeMasterFileInputRef} type="file" className="hidden" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleFakeMasterUpload(f); e.target.value = ''; } }} />
                            <button onClick={() => fakeMasterFileInputRef.current?.click()} className={`p-1 transition-colors relative ${fakeMasterOrderFile ? 'text-violet-400' : 'text-zinc-600 hover:text-white'}`} title={fakeMasterOrderFile ? `가구매용 주문서: ${fakeMasterOrderFile.name}` : '가구매용 주문서 업로드'}>
                                <DocumentArrowUpIcon className="w-3.5 h-3.5" />
                                {fakeMasterOrderFile && <span className="absolute top-0 right-0 w-1.5 h-1.5 bg-violet-400 rounded-full" />}
                            </button>
                            <button onClick={() => setShowFakeCourierSettings(!showFakeCourierSettings)} className={`p-1 transition-colors ${showFakeCourierSettings ? 'text-cyan-500' : 'text-zinc-600 hover:text-white'}`} title="가구매 택배 설정">
                                <Cog6ToothIcon className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setShowTemplateManager(!showTemplateManager)} className={`p-1 transition-colors ${showTemplateManager ? 'text-pink-500' : 'text-zinc-600 hover:text-white'}`} title="택배 양식 관리">
                                <BoltIcon className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setShowFakeDetail(!showFakeDetail)} className={`p-1 transition-colors ${showFakeDetail ? 'text-rose-500' : 'text-zinc-600 hover:text-white'}`} title="상세 누락 내역">
                                <DocumentCheckIcon className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>

                    {showFakeDetail && fakeOrderAnalysis.inputLineCount > 0 && (
                        <div className="mb-3 bg-zinc-950/80 p-3 rounded-xl border border-zinc-800 animate-fade-in max-h-[250px] overflow-auto custom-scrollbar">
                            <div className="space-y-3">
                                {fakeOrderAnalysis.duplicates.length > 0 && (
                                    <div>
                                        <h4 className="text-pink-500 font-black text-sm mb-2 tracking-widest flex items-center gap-1.5">
                                            <span className="w-2 h-2 bg-pink-500 rounded-full animate-pulse" />
                                            중복 번호 ({fakeOrderAnalysis.duplicates.length}건)
                                        </h4>
                                        <div className="space-y-1">
                                            {fakeOrderAnalysis.duplicates.map(dup => (
                                                <div key={dup.number} className="flex items-center gap-2 bg-amber-950/30 border border-pink-500/20 px-2.5 py-1.5 rounded-lg flex-wrap">
                                                    <span className="text-[11px] font-black text-pink-400">{dup.names.join(', ')}</span>
                                                    <span className="text-[10px] font-mono text-pink-500/70">{dup.number}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {fakeOrderAnalysis.missing.length > 0 && (
                                    <div>
                                        <h4 className="text-rose-500 font-black text-sm mb-2 tracking-widest flex items-center gap-1.5">
                                            <span className="w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
                                            미발견 ({fakeOrderAnalysis.missing.length}건)
                                        </h4>
                                        <div className="space-y-1">
                                            {fakeOrderAnalysis.missing.map(num => {
                                                const name = fakeOrderAnalysis.nameMap[num];
                                                return (
                                                    <div key={num} className="flex items-center gap-2 bg-rose-950/30 border border-rose-500/20 px-2.5 py-1.5 rounded-lg">
                                                        {name && <span className="text-[11px] font-black text-white">{name}</span>}
                                                        <span className="text-[10px] font-mono text-rose-400">{num}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                                {fakeOrderAnalysis.specialMatchLines.length > 0 && (
                                    <div>
                                        <h4 className="text-emerald-400 font-black text-sm mb-2 tracking-widest flex items-center gap-1.5">
                                            <span className="w-2 h-2 bg-emerald-400 rounded-full" />
                                            실배 등 자동 매칭 ({fakeOrderAnalysis.specialMatchLines.length}건)
                                        </h4>
                                        <div className="space-y-1">
                                            {fakeOrderAnalysis.specialMatchLines.map((ld, idx) => (
                                                <div key={idx} className="flex items-center gap-2 bg-emerald-950/30 border border-emerald-500/20 px-2.5 py-1.5 rounded-lg">
                                                    <span className="text-[11px] font-black text-emerald-300">{ld.line}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <h4 className="text-emerald-500 font-black text-sm mb-2 tracking-widest flex items-center gap-1.5">
                                        <span className="w-2 h-2 bg-emerald-500 rounded-full" />
                                        매칭 ({fakeOrderAnalysis.matched.length}건)
                                    </h4>
                                    <div className="space-y-1">
                                        {fakeOrderAnalysis.matched.map(num => {
                                            const detail = fakeOrderAnalysis.foundDetails[num];
                                            const name = detail?.recipientName || fakeOrderAnalysis.nameMap[num] || '';
                                            const company = detail?.companyName || '';
                                            return (
                                                <div key={num} className="flex items-center justify-between bg-zinc-900/50 px-2.5 py-1.5 rounded-lg border border-zinc-800/50">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-[11px] font-black text-white">{name}</span>
                                                        <span className="text-[9px] font-mono text-zinc-500">{num}</span>
                                                    </div>
                                                    {company && <span className="text-[9px] bg-zinc-800 text-emerald-500 px-1.5 py-0.5 rounded-full font-black border border-emerald-500/20">{company}</span>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {showTemplateManager && (
                        <CourierTemplateManager
                            templates={courierTemplates}
                            onSave={saveCourierTemplates}
                        />
                    )}

                    {showFakeCourierSettings && (
                        <div className="mb-3 bg-zinc-900/50 p-3 rounded-xl border border-cyan-500/20 animate-fade-in">
                            <h4 className="text-cyan-500 font-black text-[9px] uppercase tracking-widest mb-2">가구매 택배 설정</h4>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[8px] text-zinc-500 font-black uppercase tracking-widest mb-0.5 block">택배사명</label>
                                    <input type="text" value={fakeCourierSettings.name} onChange={(e) => {
                                        saveFakeCourierSettings({ ...fakeCourierSettings, name: e.target.value });
                                    }} className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-cyan-500/50" />
                                </div>
                                <div>
                                    <label className="text-[8px] text-zinc-500 font-black uppercase tracking-widest mb-0.5 block">건당 단가</label>
                                    <input type="number" value={fakeCourierSettings.unitPrice} onChange={(e) => {
                                        const v = Number(e.target.value) || 0;
                                        saveFakeCourierSettings({ ...fakeCourierSettings, unitPrice: v });
                                    }} className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-cyan-500/50" />
                                </div>
                                <div>
                                    <label className="text-[8px] text-zinc-500 font-black uppercase tracking-widest mb-0.5 block">은행명</label>
                                    <input type="text" value={fakeCourierSettings.bankName} onChange={(e) => {
                                        saveFakeCourierSettings({ ...fakeCourierSettings, bankName: e.target.value });
                                    }} className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-cyan-500/50" />
                                </div>
                                <div>
                                    <label className="text-[8px] text-zinc-500 font-black uppercase tracking-widest mb-0.5 block">계좌번호</label>
                                    <input type="text" value={fakeCourierSettings.accountNumber} onChange={(e) => {
                                        saveFakeCourierSettings({ ...fakeCourierSettings, accountNumber: e.target.value });
                                    }} className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-cyan-500/50" />
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <span className="text-[9px] text-violet-400 font-black uppercase tracking-widest">가구매 명단</span>
                            <textarea
                                value={effectiveFakeInput}
                                onChange={(e: any) => { if (!globalFakeOrderInput?.trim()) setFakeOrderInput(e.target.value); }}
                                readOnly={!!globalFakeOrderInput?.trim()}
                                placeholder="예: 홍길동 20231010-00001"
                                className={`w-full min-h-[80px] bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-[10px] font-mono text-zinc-300 focus:outline-none focus:border-rose-500/50 resize-none custom-scrollbar ${globalFakeOrderInput?.trim() ? 'opacity-70 cursor-default' : ''}`}
                            />
                            {fakeOrderAnalysis.unmatchedLines.length > 0 && (
                                <div className="mt-1.5 bg-rose-950/30 border border-rose-500/20 rounded-xl px-3 py-2 space-y-0.5">
                                    <p className="text-[9px] text-rose-400 font-black uppercase tracking-widest mb-1">미매칭 명단</p>
                                    {fakeOrderAnalysis.unmatchedLines.map((ld, idx) => (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="text-[10px] font-mono text-rose-300">{ld.line}</span>
                                            {ld.nums.length === 0 && <span className="text-[8px] text-rose-500/70 font-black">주문번호 없음</span>}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[9px] text-amber-400 font-black uppercase tracking-widest">미발송 명단</span>
                                {unsentOrderAnalysis.inputLineCount > 0 && (
                                    <>
                                        {unsentOrderAnalysis.matched.length > 0 && (
                                            <span className="bg-emerald-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black animate-pop-in">
                                                매칭 {unsentOrderAnalysis.matched.length}
                                            </span>
                                        )}
                                        {unsentOrderAnalysis.missing.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black animate-pop-in">
                                                미발견 {unsentOrderAnalysis.missing.length}
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                            <textarea
                                value={effectiveUnsentInput}
                                onChange={(e: any) => { if (!globalUnsentOrderInput?.trim()) setUnsentOrderInput(e.target.value); }}
                                readOnly={!!globalUnsentOrderInput?.trim()}
                                placeholder="예: 홍길동 20231010-00001"
                                className={`w-full min-h-[80px] bg-zinc-950 border border-amber-900/30 rounded-xl px-3 py-2 text-[10px] font-mono text-zinc-300 focus:outline-none focus:border-amber-500/50 resize-none custom-scrollbar ${globalUnsentOrderInput?.trim() ? 'opacity-70 cursor-default' : ''}`}
                            />
                        </div>
                        <div className="space-y-2">
                            {courierTemplates.length === 0 && (
                                <div className="text-center py-2 text-zinc-600 text-[9px] font-black border border-dashed border-zinc-800 rounded-xl cursor-pointer hover:border-pink-500/30 hover:text-pink-500 transition-colors" onClick={() => setShowTemplateManager(true)}>
                                    택배 양식을 먼저 추가해주세요
                                </div>
                            )}
                            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleCourierTemplateDragEnd}>
                                <SortableContext items={courierTemplates.map((t: CourierTemplate) => t.id)} strategy={verticalListSortingStrategy}>
                                    <div className="space-y-2">
                                    {courierTemplates.map((tmpl: CourierTemplate) => {
                                        const file = courierFiles[tmpl.id];
                                        const result = courierResults[tmpl.id];
                                        const matched = courierMatchedRows[tmpl.id];
                                        const fullName = tmpl.label ? `${tmpl.name} (${tmpl.label})` : tmpl.name;
                                        const isOffice = fullName.includes('사무실');
                                        const isAgent = fullName.includes('대행');
                                        const cs = isOffice
                                            ? { border: 'border-pink-500/30', bg: 'bg-amber-950/30', text: 'text-pink-400', hoverBg: 'hover:bg-amber-900/40', hoverBorder: 'hover:border-pink-500/50', activeBg: 'bg-amber-950/30 border-pink-500/30 text-pink-400', inactiveBorder: 'hover:border-pink-500/40 hover:text-pink-400' }
                                            : isAgent
                                            ? { border: 'border-cyan-500/30', bg: 'bg-cyan-950/30', text: 'text-cyan-400', hoverBg: 'hover:bg-cyan-900/40', hoverBorder: 'hover:border-cyan-500/50', activeBg: 'bg-cyan-950/30 border-cyan-500/30 text-cyan-400', inactiveBorder: 'hover:border-cyan-500/40 hover:text-cyan-400' }
                                            : { border: 'border-indigo-500/30', bg: 'bg-indigo-950/30', text: 'text-indigo-400', hoverBg: 'hover:bg-indigo-900/40', hoverBorder: 'hover:border-indigo-500/50', activeBg: 'bg-indigo-950/30 border-indigo-500/30 text-indigo-400', inactiveBorder: 'hover:border-indigo-500/40 hover:text-indigo-400' };
                                        return (
                                            <SortableCourierItem key={tmpl.id} id={tmpl.id}>
                                                <div className={`space-y-1.5 p-2 rounded-xl border ${cs.border} bg-zinc-950/40`}>
                                                    <button
                                                        onClick={() => handleCourierDownload(tmpl)}
                                                        disabled={!(fakeMasterOrderFile || masterOrderFile) || fakeOrderAnalysis.inputNumbers.size === 0}
                                                        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black border transition-all shadow-md disabled:opacity-30 disabled:cursor-not-allowed ${cs.bg} ${cs.border} ${cs.text} ${cs.hoverBg} ${cs.hoverBorder}`}
                                                    >
                                                        <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                                                        <span className="flex items-center gap-1">{isOffice ? <HomeIcon className="w-3 h-3" /> : isAgent ? <TruckIcon className="w-3 h-3" /> : null}{fullName} ({fakeOrderAnalysis.inputNumbers.size}건)</span>
                                                    </button>
                                                    <div className="flex items-center gap-1.5">
                                                        <label className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 cursor-pointer px-3 py-2 rounded-xl text-[9px] font-black border transition-all shadow-md overflow-hidden ${file ? cs.activeBg : `bg-zinc-900/50 border-zinc-700 text-zinc-500 ${cs.inactiveBorder}`}`}>
                                                            <ArrowUpTrayIcon className="w-3.5 h-3.5 shrink-0" />
                                                            <span className="truncate">{file ? file.name : (<span className="flex items-center gap-1">{isOffice ? <HomeIcon className="w-3 h-3" /> : isAgent ? <TruckIcon className="w-3 h-3" /> : null}{fullName} 운송장 업로드</span>)}</span>
                                                            <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e: any) => { const f = e.target.files?.[0]; if (f) handleCourierFileUpload(tmpl, f); e.target.value = ''; }} />
                                                        </label>
                                                        {file && (
                                                            <button onClick={() => {
                                                                setCourierFiles(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                                                setCourierResults(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                                                setCourierMatchedRows(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                                            }} className="p-1.5 bg-zinc-900 rounded-xl text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors">
                                                                <ArrowPathIcon className="w-3 h-3" />
                                                            </button>
                                                        )}
                                                    </div>
                                                    {result && (
                                                        <div className="bg-zinc-950/80 p-2 rounded-xl border border-zinc-800 animate-fade-in space-y-1.5">
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className="bg-emerald-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">매칭 {result.matched}건</span>
                                                                <span className="text-zinc-500 text-[8px] font-black">/ 가구매 {result.total}건</span>
                                                                {result.notFound.length > 0 && (
                                                                    <span className="bg-rose-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">미매칭 {result.notFound.length}건</span>
                                                                )}
                                                            </div>
                                                            {result.notFound.length > 0 && (
                                                                <div className="flex flex-wrap gap-1">
                                                                    {result.notFound.map((num: string) => (
                                                                        <span key={num} className="bg-rose-950/40 text-rose-400 border border-rose-500/20 px-1 py-0.5 rounded text-[8px] font-mono">{num}</span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            {matched && (
                                                                <button onClick={() => handleCourierResultDownload(tmpl.id)} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[9px] font-black transition-colors shadow-lg">
                                                                    <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                                                                    운송장완료 다운로드 ({result.matched}건)
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </SortableCourierItem>
                                        );
                                    })}
                                    </div>
                                </SortableContext>
                            </DndContext>
                        </div>
                    </div>
                </div>

                {/* 4) 비용 관리 */}
                <div className="glass-light p-4 rounded-2xl mb-3">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-orange-500/10 p-2 rounded-lg"><ChartBarIcon className="w-4 h-4 text-orange-500" /></div>
                        <h3 className="text-zinc-200 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
                            비용 관리
                            {allExpenses.length > 0 && (
                                <span className="bg-orange-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pop-in">
                                    {allExpenses.length}건 · {allExpenses.reduce((s, e) => s + e.amount, 0).toLocaleString()}원
                                </span>
                            )}
                        </h3>
                    </div>
                    <div className="flex flex-col gap-2 mb-2">
                        <select
                            value={newExpense.company}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, company: e.target.value, productKey: '' }))}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-orange-500/50"
                        >
                            <option value="">업체 선택 (선택)</option>
                            {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <select
                            value={newExpense.productKey}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, productKey: e.target.value }))}
                            disabled={!newExpense.company}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-orange-500/50 disabled:opacity-40"
                        >
                            <option value="">품목 선택 (선택)</option>
                            {expenseProducts.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                        </select>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                        <select
                            value={newExpense.category}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, category: e.target.value }))}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-orange-500/50"
                        >
                            {EXPENSE_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                        </select>
                        <input
                            type="text"
                            value={newExpense.amount}
                            onChange={(e) => {
                                const v = e.target.value.replace(/[^0-9]/g, '');
                                setNewExpense(prev => ({ ...prev, amount: v }));
                            }}
                            placeholder="금액"
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-orange-500/50 text-right"
                        />
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                        <input
                            type="text"
                            value={newExpense.description}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, description: e.target.value }))}
                            placeholder="지출내역"
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] text-zinc-300 focus:outline-none focus:border-orange-500/50"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && newExpense.amount && parseInt(newExpense.amount) > 0) {
                                    const selProduct = expenseProducts.find(p => p.key === newExpense.productKey);
                                    setExpenses(prev => [...prev, {
                                        id: `exp-${Date.now()}`,
                                        category: newExpense.category,
                                        amount: parseInt(newExpense.amount),
                                        description: newExpense.description,
                                        ...(newExpense.company && newExpense.productKey ? {
                                            company: newExpense.company,
                                            productKey: newExpense.productKey,
                                            productName: selProduct?.name,
                                        } : {}),
                                    }]);
                                    setNewExpense(prev => ({ ...prev, amount: '', description: '', company: '', productKey: '' }));
                                }
                            }}
                        />
                        <button
                            onClick={() => {
                                if (!newExpense.amount || parseInt(newExpense.amount) <= 0) return;
                                const selProduct = expenseProducts.find(p => p.key === newExpense.productKey);
                                setExpenses(prev => [...prev, {
                                    id: `exp-${Date.now()}`,
                                    category: newExpense.category,
                                    amount: parseInt(newExpense.amount),
                                    description: newExpense.description,
                                    ...(newExpense.company && newExpense.productKey ? {
                                        company: newExpense.company,
                                        productKey: newExpense.productKey,
                                        productName: selProduct?.name,
                                    } : {}),
                                }]);
                                setNewExpense(prev => ({ ...prev, amount: '', description: '', company: '', productKey: '' }));
                            }}
                            className="bg-orange-600 hover:bg-orange-500 text-white font-black py-2.5 px-4 rounded-xl transition-all shadow-md text-[10px] flex items-center gap-1.5"
                        >
                            <PlusCircleIcon className="w-3.5 h-3.5" />추가
                        </button>
                    </div>
                    {allExpenses.length > 0 && (
                        <div className="space-y-1.5">
                            {allExpenses.map((exp) => (
                                <div key={exp.id} className={`flex items-center justify-between px-3 py-2 rounded-xl border ${exp.isAuto ? 'bg-teal-950/20 border-teal-500/20' : 'bg-zinc-950/50 border-zinc-800/50'}`}>
                                    <div className="flex items-center gap-2 flex-1 min-w-0">
                                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-full shrink-0 ${exp.isAuto ? 'bg-teal-500/20 text-teal-400 border border-teal-500/30' : 'bg-orange-500/20 text-orange-400 border border-orange-500/30'}`}>
                                            {exp.category}
                                        </span>
                                        {exp.company && (
                                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-pink-500/15 text-pink-400 border border-pink-500/25 shrink-0">
                                                {exp.company} · {exp.productName || exp.productKey}
                                            </span>
                                        )}
                                        <span className="text-[10px] text-zinc-400 truncate">{exp.description}</span>
                                        {exp.isAuto && <span className="text-[9px] text-teal-600 font-bold shrink-0">자동</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-mono font-bold text-zinc-300">{exp.amount.toLocaleString()}원</span>
                                        {!exp.isAuto && (
                                            <button onClick={() => setExpenses(prev => prev.filter(e => e.id !== exp.id))} className="text-zinc-700 hover:text-rose-500 transition-colors">
                                                <TrashIcon className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <div className="flex justify-end pt-2 pr-2">
                                <span className="text-[10px] font-black text-orange-400">
                                    총 비용: {allExpenses.reduce((s, e) => s + e.amount, 0).toLocaleString()}원
                                </span>
                            </div>
                        </div>
                    )}
                </div>

                {/* 5) 품목별관리 */}
                <div className="glass-light p-4 rounded-2xl mb-3">
                    <div className="flex items-center gap-3 mb-4 flex-wrap">
                        <div className="bg-violet-500/10 p-2 rounded-lg"><ArrowPathIcon className="w-4 h-4 text-violet-400" /></div>
                        <h3 className="text-zinc-200 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
                            품목별관리
                            {returns.length > 0 && (
                                <span className="bg-violet-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pop-in">
                                    {returns.length}건 · {returns.reduce((s, r) => s + r.totalMargin, 0).toLocaleString()}원
                                </span>
                            )}
                        </h3>
                        <select
                            value={itemType}
                            onChange={(e) => setItemType(e.target.value as '반품' | '광고비' | '슬롯')}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-[11px] font-bold text-violet-300 focus:outline-none focus:border-violet-500/50"
                        >
                            <option value="반품">반품</option>
                            <option value="광고비">광고비</option>
                            <option value="슬롯">슬롯</option>
                        </select>
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                        <input
                            type="date"
                            value={returnOrderDate}
                            onChange={(e) => setReturnOrderDate(e.target.value)}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-violet-500/50 shrink-0"
                        />
                    </div>
                    {itemType === '반품' ? (
                        <>
                            <div className="flex flex-wrap gap-2 mb-3">
                                <select
                                    value={returnCompany}
                                    onChange={(e) => { setReturnCompany(e.target.value); setReturnRegisteredName(''); setReturnProductKey(''); }}
                                    className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50"
                                >
                                    <option value="">업체 선택</option>
                                    {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                                </select>
                                <select
                                    value={returnRegisteredName}
                                    onChange={(e) => { setReturnRegisteredName(e.target.value); setReturnProductKey(''); }}
                                    disabled={!returnCompany}
                                    className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50 disabled:opacity-40"
                                >
                                    <option value="">등록상품명 선택</option>
                                    {returnRegisteredNames.map((name: string) => <option key={name} value={name}>{name}</option>)}
                                </select>
                                <select
                                    value={returnProductKey}
                                    onChange={(e) => setReturnProductKey(e.target.value)}
                                    disabled={!returnRegisteredName}
                                    className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50 disabled:opacity-40"
                                >
                                    <option value="">품목 선택</option>
                                    {returnProducts.map(p => <option key={p.key} value={p.key}>{p.name} ({p.margin.toLocaleString()}원)</option>)}
                                </select>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                <input
                                    type="text"
                                    value={returnCount}
                                    onChange={(e) => setReturnCount(e.target.value.replace(/[^0-9]/g, ''))}
                                    placeholder="수량"
                                    className="w-16 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-violet-500/50 text-right shrink-0"
                                />
                                <input
                                    type="text"
                                    value={returnMemo}
                                    onChange={(e) => setReturnMemo(e.target.value)}
                                    placeholder="반품 사유 (선택)"
                                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] text-zinc-300 focus:outline-none focus:border-violet-500/50"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && returnCompany && returnProductKey && returnCount && parseInt(returnCount) > 0) {
                                            const p = returnProducts.find(p => p.key === returnProductKey);
                                            if (!p) return;
                                            const qty = parseInt(returnCount);
                                            setReturns(prev => [...prev, {
                                                company: returnCompany, productKey: returnProductKey, productName: p.name,
                                                registeredName: returnRegisteredName || undefined,
                                                count: qty, marginPerUnit: p.margin, totalMargin: -(p.margin * qty), memo: returnMemo || undefined,
                                                orderDate: returnOrderDate || undefined, type: '반품',
                                            }]);
                                            setReturnProductKey(''); setReturnCount('1'); setReturnMemo('');
                                        }
                                    }}
                                />
                                <button
                                    onClick={() => {
                                        if (!returnCompany || !returnProductKey || !returnCount || parseInt(returnCount) <= 0) return;
                                        const p = returnProducts.find(p => p.key === returnProductKey);
                                        if (!p) return;
                                        const qty = parseInt(returnCount);
                                        setReturns(prev => [...prev, {
                                            company: returnCompany, productKey: returnProductKey, productName: p.name,
                                            registeredName: returnRegisteredName || undefined,
                                            count: qty, marginPerUnit: p.margin, totalMargin: -(p.margin * qty),
                                            memo: returnMemo || undefined, orderDate: returnOrderDate || undefined, type: '반품',
                                        }]);
                                        setReturnProductKey(''); setReturnCount('1'); setReturnMemo('');
                                    }}
                                    disabled={!returnCompany || !returnProductKey || !returnCount || parseInt(returnCount) <= 0}
                                    className="bg-violet-600 hover:bg-violet-500 text-white font-black py-2.5 px-4 rounded-xl transition-all shadow-md text-[10px] flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    <PlusCircleIcon className="w-3.5 h-3.5" />추가
                                </button>
                            </div>
                            {returnProductKey && parseInt(returnCount) > 0 && (
                                <div className="mb-3 text-right">
                                    <span className="text-[10px] font-black text-violet-400">
                                        반품 마진: -{(selectedReturnMargin * (parseInt(returnCount) || 0)).toLocaleString()}원
                                    </span>
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className="flex flex-wrap gap-2 mb-3">
                                <select
                                    value={returnCompany}
                                    onChange={(e) => { setReturnCompany(e.target.value); setReturnRegisteredName(''); setReturnProductKey(''); }}
                                    className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50"
                                >
                                    <option value="">업체 선택</option>
                                    {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                                </select>
                                <select
                                    value={returnRegisteredName}
                                    onChange={(e) => { setReturnRegisteredName(e.target.value); setReturnProductKey(''); }}
                                    disabled={!returnCompany}
                                    className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50 disabled:opacity-40"
                                >
                                    <option value="">등록상품명 선택</option>
                                    {returnRegisteredNames.map((name: string) => <option key={name} value={name}>{name}</option>)}
                                </select>
                                <select
                                    value={returnProductKey}
                                    onChange={(e) => setReturnProductKey(e.target.value)}
                                    disabled={!returnRegisteredName}
                                    className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50 disabled:opacity-40"
                                >
                                    <option value="">품목 선택</option>
                                    {returnProducts.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                                </select>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                <input
                                    type="text"
                                    value={returnDirectAmount}
                                    onChange={(e) => setReturnDirectAmount(e.target.value.replace(/[^0-9]/g, ''))}
                                    placeholder="금액"
                                    className="w-28 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-violet-500/50 text-right shrink-0"
                                />
                                <input
                                    type="text"
                                    value={returnMemo}
                                    onChange={(e) => setReturnMemo(e.target.value)}
                                    placeholder="메모 (선택)"
                                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] text-zinc-300 focus:outline-none focus:border-violet-500/50"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && returnCompany && returnProductKey && returnDirectAmount && parseInt(returnDirectAmount) > 0) {
                                            const p = returnProducts.find(p => p.key === returnProductKey);
                                            const amount = parseInt(returnDirectAmount);
                                            setReturns(prev => [...prev, {
                                                company: returnCompany, productKey: returnProductKey, productName: p?.name || itemType,
                                                registeredName: returnRegisteredName || undefined,
                                                count: 1, marginPerUnit: amount, totalMargin: -amount,
                                                memo: returnMemo || undefined, orderDate: returnOrderDate || undefined, type: itemType,
                                            }]);
                                            setReturnProductKey(''); setReturnDirectAmount(''); setReturnMemo('');
                                        }
                                    }}
                                />
                                <button
                                    onClick={() => {
                                        if (!returnCompany || !returnProductKey || !returnDirectAmount || parseInt(returnDirectAmount) <= 0) return;
                                        const p = returnProducts.find(p => p.key === returnProductKey);
                                        const amount = parseInt(returnDirectAmount);
                                        setReturns(prev => [...prev, {
                                            company: returnCompany, productKey: returnProductKey, productName: p?.name || itemType,
                                            registeredName: returnRegisteredName || undefined,
                                            count: 1, marginPerUnit: amount, totalMargin: -amount,
                                            memo: returnMemo || undefined, orderDate: returnOrderDate || undefined, type: itemType,
                                        }]);
                                        setReturnProductKey(''); setReturnDirectAmount(''); setReturnMemo('');
                                    }}
                                    disabled={!returnCompany || !returnProductKey || !returnDirectAmount || parseInt(returnDirectAmount) <= 0}
                                    className="bg-violet-600 hover:bg-violet-500 text-white font-black py-2.5 px-4 rounded-xl transition-all shadow-md text-[10px] flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    <PlusCircleIcon className="w-3.5 h-3.5" />추가
                                </button>
                            </div>
                            {returnProductKey && returnDirectAmount && parseInt(returnDirectAmount) > 0 && (
                                <div className="mb-3 text-right">
                                    <span className="text-[10px] font-black text-violet-400">
                                        {itemType} 금액: -{parseInt(returnDirectAmount).toLocaleString()}원
                                    </span>
                                </div>
                            )}
                        </>
                    )}
                    {filteredReturns.length > 0 && (
                        <div className="space-y-1.5">
                            {filteredReturns.map((ret) => {
                                const originalIndex = returns.indexOf(ret);
                                return (
                                    <div key={originalIndex} className="flex items-center justify-between px-3 py-2 rounded-xl border bg-zinc-950/50 border-zinc-800/50">
                                        <div className="flex items-center gap-2">
                                            {ret.orderDate && <span className="text-[9px] font-mono text-zinc-500">{ret.orderDate}</span>}
                                            <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400 border border-violet-500/30">
                                                {ret.company}
                                            </span>
                                            <span className="text-[10px] text-zinc-400">{ret.productName}</span>
                                            {(ret.type || '반품') === '반품' && <span className="text-[10px] text-zinc-500">{ret.count}개</span>}
                                            {ret.memo && <span className="text-[10px] text-zinc-600">{ret.memo}</span>}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-mono font-bold text-violet-400">{ret.totalMargin.toLocaleString()}원</span>
                                            <button onClick={() => setReturns(prev => prev.filter((_, idx) => idx !== originalIndex))} className="text-zinc-700 hover:text-violet-400 transition-colors">
                                                <TrashIcon className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                            <div className="flex justify-end pt-2 pr-2">
                                <span className="text-[10px] font-black text-violet-400">
                                    총 {itemType}: {filteredReturns.reduce((s, r) => s + r.totalMargin, 0).toLocaleString()}원
                                </span>
                            </div>
                        </div>
                    )}
                </div>
                </>,
                document.getElementById(portalId || 'manual-order-portal')!
            )}

            <div className="sticky top-0 z-30 rounded-2xl px-4 py-2.5 shadow-2xl backdrop-blur-2xl bg-zinc-950/70 border border-zinc-800/40">
                <div className="flex flex-wrap items-center gap-2">
                    <button onClick={handleDownloadDepositList} className="group flex items-center gap-2 bg-zinc-800/60 text-zinc-400 hover:text-white px-4 py-2 rounded-full text-[11px] font-bold tracking-wide transition-all duration-200 border border-zinc-700/30 hover:border-zinc-600 hover:bg-zinc-700/60 active:scale-95">
                        <ArrowDownTrayIcon className="w-3.5 h-3.5" /><span>입금목록</span>
                    </button>
                    <button onClick={handleDownloadWorkLog} className="group flex items-center gap-2 bg-zinc-800/60 text-zinc-400 hover:text-white px-4 py-2 rounded-full text-[11px] font-bold tracking-wide transition-all duration-200 border border-zinc-700/30 hover:border-zinc-600 hover:bg-zinc-700/60 active:scale-95">
                        <ClipboardDocumentCheckIcon className="w-3.5 h-3.5" /><span>업무일지</span>
                    </button>
                    <div className="flex items-center gap-1.5 ml-auto">
                        <span className="text-zinc-600 text-[10px] font-bold tracking-wide">작업날짜</span>
                        <input
                            type="date"
                            value={workDate}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWorkDate(e.target.value)}
                            className="bg-zinc-900 text-zinc-300 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] font-bold focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                    </div>
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-6">
            <section className="flex-1 glass rounded-[1.8rem] p-6 shadow-xl">
                <div className="flex flex-col gap-4">
                        {missingOrderAnalysis && missingOrderAnalysis.missingGroups.length > 0 && (
                            <div className="bg-red-500/10 border-2 border-red-500/50 rounded-xl px-4 py-3 animate-fade-in">
                                <div className="text-red-400 text-[12px] font-black flex items-center gap-1 mb-2">
                                    <span>⚠</span> 발주서 누락 {missingOrderAnalysis.totalMissingQty}건 (마스터 기준)
                                </div>
                                <div className="space-y-1 max-h-[250px] overflow-auto custom-scrollbar">
                                    {missingOrderAnalysis.missingGroups.map((m, idx) => (
                                        <div key={idx} className="bg-red-500/5 rounded px-2 py-1">
                                            <div className="flex items-center gap-2 text-[10px] font-mono">
                                                <span className="text-red-400 font-black shrink-0 min-w-[80px]">{m.groupName}</span>
                                                <span className="text-white font-black shrink-0">마스터 {m.masterQty}건</span>
                                                <span className="text-zinc-600 shrink-0">→</span>
                                                <span className="text-zinc-400 shrink-0">발주서 {m.processedQty}건</span>
                                                <span className="text-red-400 font-black shrink-0">= {m.diffQty}건 누락</span>
                                                {m.company && <span className="text-zinc-500 text-[9px] shrink-0 ml-auto">[{m.company}]</span>}
                                                {!m.company && <span className="text-red-300/60 text-[9px] shrink-0 ml-auto">{m.reason}</span>}
                                            </div>
                                            {m.names && m.names.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {m.names.map((n, ni) => <span key={ni} className="text-[8px] text-red-300/70 bg-red-500/10 px-1.5 py-0.5 rounded">{n}</span>)}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-1 min-h-[36px]">
                            {sortCompanies(Object.keys(pricingConfig)).map(name => {
                                const sessions = companySessions[name] || [];
                                const sessionAmounts = sessions.map(s => ({ round: s.round, amount: totalsMap[s.id] || 0 })).filter(s => s.amount > 0);
                                if (sessionAmounts.length === 0) return null;
                                const companyTotal = sessionAmounts.reduce((sum, s) => sum + s.amount, 0);
                                return (
                                    <div key={name} className="bg-zinc-950/50 px-3 py-1.5 rounded-lg border border-zinc-800 flex items-center gap-2 group/item hover:border-rose-500/30 transition-all shadow-sm">
                                        <span className="text-[10px] font-black text-zinc-500">{name}</span>
                                        {sessionAmounts.length > 1 && sessionAmounts.map(s => (
                                            <span key={s.round} className="text-[9px] font-bold text-zinc-600">{s.round}차 {s.amount.toLocaleString()}</span>
                                        ))}
                                        <span className="text-[11px] font-black text-white">{sessionAmounts.length > 1 ? '합계 ' : ''}{companyTotal.toLocaleString()}원</span>
                                    </div>
                                );
                            })}
                            {manualTransfers.map(t => (
                                <div key={t.id} className={`${t.isAdjustment ? 'bg-rose-950/30 border-rose-500/30' : 'bg-indigo-950/30 border-indigo-500/30'} px-3 py-1.5 rounded-lg border flex items-center gap-2 group/item hover:border-rose-500/30 transition-all shadow-sm`}>
                                    <span className={`text-[10px] font-black ${t.isAdjustment ? 'text-rose-400' : 'text-indigo-400'}`}>{t.label}</span>
                                    <span className="text-[11px] font-black text-white">{t.amount.toLocaleString()}원</span>
                                    <button onClick={() => handleDeleteManualTransfer(t.id)} className="text-zinc-600 hover:text-rose-500 transition-all p-0.5"><TrashIcon className="w-3 h-3" /></button>
                                </div>
                            ))}
                        </div>
                    </div>
            </section>

            </div>

            <div className="flex gap-3 items-start">
            <section className="glass rounded-[1.8rem] overflow-hidden shadow-xl flex-1 min-w-0">
                <div className="p-6 border-b border-zinc-900 bg-zinc-900/40 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-800 p-2 rounded-xl border border-zinc-700"><BuildingStorefrontIcon className="w-5 h-5 text-rose-500" /></div>
                        <h2 className="text-xl font-black text-white tracking-tight uppercase">Workstation</h2>
                        <button onClick={handleAddDivider} title="구분선 추가" className="flex items-center gap-1 text-[10px] font-black text-zinc-500 hover:text-zinc-300 border border-dashed border-zinc-700 hover:border-zinc-500 rounded-lg px-2 py-1 transition-colors">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m-8-8h16" /></svg>
                            구분선
                        </button>
                    </div>
                    {(() => {
                        const totalOrders: number = Object.values(allOrderRows).reduce<number>((sum, rows) => sum + (rows as any[][]).length, 0);
                        const totalAmount: number = Object.values(totalsMap).reduce<number>((sum, v) => sum + (v as number), 0);
                        return totalOrders > 0 ? (
                            <div className="flex items-center gap-3 text-xs font-black">
                                <span className="bg-rose-500/10 text-rose-400 px-3 py-1.5 rounded-full">{totalOrders}건</span>
                                <span className="bg-zinc-800 text-zinc-400 px-3 py-1.5 rounded-full">{totalAmount.toLocaleString()}원</span>
                            </div>
                        ) : null;
                    })()}
                </div>
                {masterOrderFile && masterProductSummary && (
                    <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 shadow-inner animate-pop-in">
                        {(() => {
                            const add = additionalRoundsSummary;
                            const has2 = !!add && add.rounds.length > 0;
                            const rounds = add?.rounds || [];
                            // 1차 플랫폼 약어
                            const masterPlatform = uploadedPlatforms.length > 0 ? uploadedPlatforms[0].name : '쿠팡';
                            const roundPlatforms = [masterPlatform, ...rounds.map(r => r.platform || '쿠팡')];
                            // 플랫폼 약어 매핑
                            const platformAbbr = (p: string) => {
                                const n = p.replace(/\s/g, '');
                                if (n === '쿠팡') return 'C';
                                if (n.startsWith('토스') || n === 'toss') return 'T';
                                if (n.startsWith('지마켓') || n === 'gmarket') return 'G';
                                if (n.startsWith('옥션') || n === 'auction') return 'A';
                                if (n.startsWith('네이버') || n === 'naver') return 'N';
                                if (n.startsWith('11번가') || n === '11st') return '11';
                                if (n.startsWith('위메프') || n === 'wemakeprice') return 'W';
                                if (n.startsWith('인터파크') || n === 'interpark') return 'I';
                                return p.charAt(0).toUpperCase();
                            };
                            const platformColor = (p: string) => {
                                const n = p.replace(/\s/g, '');
                                if (n === '쿠팡') return 'text-rose-400';
                                if (n.startsWith('토스') || n === 'toss') return 'text-blue-400';
                                if (n.startsWith('지마켓') || n === 'gmarket') return 'text-green-400';
                                return 'text-purple-400';
                            };
                            const fmtTotal = (base: number, extras: number[]) =>
                                has2 ? `${platformAbbr(roundPlatforms[0])}${base}건${extras.map((e, i) => `+${platformAbbr(roundPlatforms[i + 1])}${e}건`).join('')}` : `${platformAbbr(roundPlatforms[0])}${base}건`;
                            const renderExtras = (extras: number[]) => extras.map((e, i) => (
                                <span key={i} className={e > 0 ? 'text-cyan-400' : 'text-zinc-700'}>+<span className={e > 0 ? platformColor(roundPlatforms[i + 1]) : 'text-zinc-700'}>{platformAbbr(roundPlatforms[i + 1])}</span>{e}건</span>
                            ));
                            const fmtCountFromExtras = (base: number, extras: number[]) => {
                                const baseColor = base > 0 ? platformColor(roundPlatforms[0]) : 'text-zinc-700';
                                if (!has2) return <span className="font-black ml-1"><span className={baseColor}>{platformAbbr(roundPlatforms[0])}</span>{base}건</span>;
                                return <span className="font-black ml-1"><span className={baseColor}>{platformAbbr(roundPlatforms[0])}</span>{base}건{renderExtras(extras)}</span>;
                            };
                            const realExtrasFor = (name: string) => rounds.map(r => r.realByGroup[name] || 0);
                            const fakeExtrasFor = (name: string) => rounds.map(r => r.fakeByGroup[name] || 0);
                            const masterExtrasFor = (name: string) => rounds.map(r => (r.realByGroup[name] || 0) + (r.fakeByGroup[name] || 0));
                            const realTotalExtras = rounds.map(r => r.realTotal);
                            const fakeTotalExtras = rounds.map(r => r.fakeTotal);
                            const masterTotalExtras = rounds.map(r => r.realTotal + r.fakeTotal);
                            // 2차+에만 존재하는 품목 수집
                            const extraOnlyGroups = new Set<string>();
                            if (has2) {
                                rounds.forEach(r => {
                                    Object.keys(r.realByGroup).forEach(g => {
                                        if (!masterProductSummary.realOrders[g] && !masterProductSummary.fakeOrders[g]) extraOnlyGroups.add(g);
                                    });
                                    Object.keys(r.fakeByGroup).forEach(g => {
                                        if (!masterProductSummary.realOrders[g] && !masterProductSummary.fakeOrders[g]) extraOnlyGroups.add(g);
                                    });
                                });
                            }
                            const extraGroupCompany = (g: string) => add?.groupToCompany?.[g] || masterProductSummary.productToCompany[g] || '기타';
                            return (
                            <div className="flex gap-6 items-start">
                                <div className="flex-1 min-w-0">
                                    <div className="text-xs font-black text-sky-400 uppercase tracking-widest mb-1">마스터 구매수량 ({fmtTotal(masterProductSummary.masterRawTotalQty, masterTotalExtras)})</div>
                                    <div>
                                        {(() => {
                                            const qtyByProduct: Record<string, number> = {};
                                            masterProductSummary.allOrderDetails.forEach((d: any) => {
                                                if (d.groupName) qtyByProduct[d.groupName] = (qtyByProduct[d.groupName] || 0) + d.qty;
                                            });
                                            const grouped: Record<string, [string, number][]> = {};
                                            Object.entries(qtyByProduct).forEach(([name, qty]) => {
                                                const company = masterProductSummary.productToCompany[name] || '기타';
                                                if (!grouped[company]) grouped[company] = [];
                                                grouped[company].push([name, qty]);
                                            });
                                            // 2차+에만 있는 품목 추가
                                            extraOnlyGroups.forEach(g => {
                                                const company = extraGroupCompany(g);
                                                if (!grouped[company]) grouped[company] = [];
                                                grouped[company].push([g, 0]);
                                            });
                                            const masterFmtCount = (base: number, groupName: string) => fmtCountFromExtras(base, masterExtrasFor(groupName));
                                            return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([company, items]) => (
                                                <div key={company}>
                                                    <div className="text-[11px] text-zinc-500 font-black mt-1">{company}</div>
                                                    {items.sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([name, qty]) => (
                                                        <div key={name} className="flex text-sm gap-1 pl-2 items-baseline">
                                                            <span className="text-zinc-400">{name}</span>
                                                            <span className="text-sky-300">{masterFmtCount(qty, name)}</span>
                                                                                                                </div>
                                                    ))}
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-xs font-black text-emerald-400 uppercase tracking-widest mb-1">실제 구매 ({fmtTotal(masterProductSummary.realTotal, realTotalExtras)})</div>
                                    <div>
                                        {(() => {
                                            const grouped: Record<string, [string, number][]> = {};
                                            Object.entries(masterProductSummary.realOrders).forEach(([name, count]) => {
                                                const company = masterProductSummary.productToCompany[name] || '기타';
                                                if (!grouped[company]) grouped[company] = [];
                                                grouped[company].push([name, count as number]);
                                            });
                                            // 2차+에만 있는 품목 추가 (1차 실제구매 0건)
                                            extraOnlyGroups.forEach(g => {
                                                const company = extraGroupCompany(g);
                                                if (!grouped[company]) grouped[company] = [];
                                                grouped[company].push([g, 0]);
                                            });
                                            return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([company, items]) => (
                                                <div key={company}>
                                                    <div className="text-[11px] text-zinc-500 font-black mt-1">{company}</div>
                                                    {items.sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([name, count]) => (
                                                        <div key={name} className="flex text-sm gap-1 pl-2 items-baseline">
                                                            <span className="text-zinc-400">{name}</span>
                                                            <span className="text-white font-black">{fmtCountFromExtras(count, realExtrasFor(name))}</span>
                                                                                                                </div>
                                                    ))}
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-xs font-black text-pink-400 uppercase tracking-widest mb-1">가구매 ({fmtTotal(masterProductSummary.fakeTotal, fakeTotalExtras)})</div>
                                    <div>
                                        {(() => {
                                            const grouped: Record<string, [string, number][]> = {};
                                            Object.entries(masterProductSummary.realOrders).forEach(([name]) => {
                                                const company = masterProductSummary.productToCompany[name] || '기타';
                                                if (!grouped[company]) grouped[company] = [];
                                                const fakeCount = (masterProductSummary.fakeOrders[name] as number) || 0;
                                                grouped[company].push([name, fakeCount]);
                                            });
                                            Object.entries(masterProductSummary.fakeOrders).forEach(([name, cnt]) => {
                                                if (!masterProductSummary.realOrders[name]) {
                                                    const company = masterProductSummary.productToCompany[name] || '기타';
                                                    if (!grouped[company]) grouped[company] = [];
                                                    grouped[company].push([name, cnt as number]);
                                                }
                                            });
                                            // 2차+에만 있는 품목 추가 (1차 가구매 0건)
                                            extraOnlyGroups.forEach(g => {
                                                const company = extraGroupCompany(g);
                                                if (!grouped[company]) grouped[company] = [];
                                                // 실제구매에서 이미 추가한 경우 중복 방지
                                                if (!grouped[company].some(([n]) => n === g)) {
                                                    grouped[company].push([g, 0]);
                                                }
                                            });
                                            return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([company, items]) => (
                                                <div key={company}>
                                                    <div className="text-[11px] text-zinc-500 font-black mt-1">{company}</div>
                                                    {items.sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([name, count]) => (
                                                        <div key={name} className="flex text-sm gap-1 pl-2 items-baseline">
                                                            <span className="text-zinc-400">{name}</span>
                                                            <span className={`font-black ${count > 0 ? 'text-pink-400' : 'text-zinc-700'}`}>{fmtCountFromExtras(count, fakeExtrasFor(name))}</span>
                                                                                                                </div>
                                                    ))}
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                </div>
                            </div>
                            );
                        })()}
                        {masterProductSummary.allOrderDetails.length > 0 && (
                            <details className="mt-3">
                                <summary className="text-[10px] font-black text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors select-none">
                                    ▶ 주문 상세 펼치기 ({masterProductSummary.masterRawTotalQty}건{masterProductSummary.masterRawTotalQty !== masterProductSummary.realTotal + masterProductSummary.fakeTotal ? ` / 인식 ${masterProductSummary.realTotal + masterProductSummary.fakeTotal}건` : ''})
                                </summary>
                                <div className="mt-1 max-h-[300px] overflow-auto custom-scrollbar space-y-2 bg-zinc-950/50 rounded-lg p-2 border border-zinc-800/50">
                                    {(() => {
                                        const details = masterProductSummary.allOrderDetails;
                                        const grouped: Record<string, typeof details> = {};
                                        details.forEach(d => {
                                            const key = d.company || '미매칭';
                                            if (!grouped[key]) grouped[key] = [];
                                            grouped[key].push(d);
                                        });
                                        return Object.entries(grouped)
                                            .sort(([a], [b]) => a === '미매칭' ? 1 : b === '미매칭' ? -1 : b.localeCompare(a))
                                            .map(([company, orders]) => {
                                            const realCount = orders.filter(o => !o.isFake).reduce((s, o) => s + o.qty, 0);
                                            const fakeCount = orders.filter(o => o.isFake).reduce((s, o) => s + o.qty, 0);
                                            return (
                                                <div key={company}>
                                                    <div className="text-[11px] font-black text-zinc-300 flex items-center gap-2">
                                                        <span className={company === '미매칭' ? 'text-red-400' : ''}>{company}</span>
                                                        <span className="text-zinc-600">{realCount}건{fakeCount > 0 ? ` + 가구매 ${fakeCount}건` : ''}</span>
                                                    </div>
                                                    <div className="space-y-0.5 mt-0.5">
                                                        {orders.map((o, idx) => (
                                                            <div key={idx} className={`text-[10px] font-mono pl-3 flex gap-2 ${o.isFake ? 'text-pink-500/70 line-through' : company === '미매칭' ? 'text-red-300/80' : 'text-zinc-400'}`}>
                                                                <span className="min-w-[50px]">{o.recipientName}</span>
                                                                <span className="text-zinc-600">{o.groupName}</span>
                                                                <span className="truncate">{o.productName}</span>
                                                                {o.qty > 1 && <span className="text-white font-bold">x{o.qty}</span>}
                                                                {o.isFake && <span className="text-pink-500/50 text-[8px]">가구매</span>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        });
                                    })()}
                                </div>
                            </details>
                        )}
                    </div>
                )}

                <AutoWatcherPanel
                    masterOrderFile={masterOrderFile}
                    pricingConfig={pricingConfig}
                    businessId={businessId}
                    activeCompanies={
                        Object.entries(companySessions)
                            .filter(([, sessions]) => (sessions as SessionData[]).some(s => (allOrderRows[s.id] || []).length > 0))
                            .map(([company]) => company)
                    }
                />
                <BatchInvoicePanel
                    masterOrderFile={masterOrderFile}
                    pricingConfig={pricingConfig}
                    businessId={businessId}
                    activeCompanies={
                        Object.entries(companySessions)
                            .filter(([, sessions]) => (sessions as SessionData[]).some(s => (allOrderRows[s.id] || []).length > 0))
                            .map(([company]) => company)
                    }
                    allOrderFiles={Object.values(batchFiles)}
                    onInvoiceReady={(company) => setBatchInvoiceLit(prev => new Set([...prev, company]))}
                    onInvoiceDownloaded={(company) => setBatchInvoiceLit(prev => { const s = new Set(prev); s.delete(company); return s; })}
                />
                <div className="overflow-x-auto">
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="sticky top-0 z-10 bg-zinc-950 text-zinc-500 text-[10px] font-black uppercase tracking-[0.15em]">
                                    <th className="px-6 py-2 w-[35%] whitespace-nowrap">
                                        <div className="flex items-center gap-3">
                                            <button onClick={handleSelectAllSessions} className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all ${isAllSelected ? 'bg-rose-500 border-rose-400 text-white' : 'bg-zinc-900 border-zinc-700 text-transparent hover:border-rose-500/50'}`} title="전체 선택"><CheckIcon className="w-3 h-3" /></button>
                                            <span>업체 정보</span>
                                        </div>
                                    </th>
                                    <th className="px-6 py-2 w-[30%] text-center whitespace-nowrap">
                                        발주서
                                        {(() => {
                                            const total: number = Object.values(allOrderRows).reduce<number>((s, r) => s + (r as any[][]).length, 0);
                                            return total > 0 ? <span className="ml-2 text-white font-black text-xl normal-case tracking-normal">{total}건</span> : null;
                                        })()}
                                    </th>
                                    <th className="px-6 py-2 w-[35%] text-center whitespace-nowrap">송장 매칭</th>
                                </tr>
                            </thead>
                            <SortableContext
                                items={companyOrder.filter(id => isDivider(id) || !!pricingConfig[id])}
                                strategy={verticalListSortingStrategy}
                            >
                                {(() => {
                                    const orderedItems = companyOrder.filter(id => isDivider(id) || !!pricingConfig[id]);
                                    // 업체별 그룹 배경색 사전 계산 + 구분선별 그룹 업체 목록 계산
                                    const companyGroupBg: Record<string, string> = {};
                                    const dividerGroupCompanies: Record<string, string[]> = {};
                                    let curColorKey = 'none';
                                    let currentDividerId: string | null = null;
                                    for (const id of orderedItems) {
                                        if (isDivider(id)) {
                                            curColorKey = dividerColors[id] || 'none';
                                            currentDividerId = id;
                                            dividerGroupCompanies[id] = [];
                                        } else {
                                            if (curColorKey !== 'none') companyGroupBg[id] = getGroupColor(curColorKey).bg;
                                            if (currentDividerId) dividerGroupCompanies[currentDividerId].push(id);
                                        }
                                    }
                                    return orderedItems.map(id => {
                                    if (isDivider(id)) {
                                        return (
                                            <SortableDividerRow
                                                key={id}
                                                id={id}
                                                label={parseDividerLabel(id)}
                                                colorKey={dividerColors[id] || 'none'}
                                                onLabelChange={handleChangeDividerLabel}
                                                onColorChange={handleChangeDividerColor}
                                                onDelete={handleDeleteDivider}
                                                groupCompanies={dividerGroupCompanies[id] || []}
                                                closedCompanies={closedCompanies}
                                                onGroupClose={handleGroupClose}
                                                onGroupDownloadOrders={handleGroupDownloadOrders}
                                            />
                                        );
                                    }
                                    const company = id;
                                    return (
                                    <SortableCompanyRow key={company} id={company} groupBg={companyGroupBg[company]}>
                                        {(() => {
                                        // 업체의 라운드별 수량+플랫폼 계산
                                        const sessions = companySessions[company] || [];
                                        const masterPlatformName = uploadedPlatforms.length > 0 ? uploadedPlatforms[0].name : '쿠팡';
                                        const roundOrderCountsForCompany = sessions.map(s => {
                                            const count = allOrderRows[s.id]?.length
                                                || (allItemSummaries[s.id] ? Object.values(allItemSummaries[s.id]).reduce((a: number, b: any) => a + b.count, 0) : 0);
                                            const platform = s.round <= 1 ? masterPlatformName : (batchPlatforms[s.id] || '쿠팡');
                                            return { round: s.round, count, platform };
                                        });
                                        const companyTotal = roundOrderCountsForCompany.reduce((s, r) => s + r.count, 0);
                                        // 업체별 입금·공급가·마진 계산 (첫 세션 렌더 시 1회)
                                        const companyCalcDeposit = sessions.reduce((sum, s) => sum + (totalsMap[s.id] || 0), 0);
                                        const companyCalcMargin = sessions.reduce((sum, s) => {
                                            const items = allOrderItems[s.id] || [];
                                            return sum + items.reduce((acc, item) => {
                                                const product = (pricingConfig[company]?.products as any)?.[item.matchedProductKey];
                                                return acc + ((product?.margin || 0) * item.qty);
                                            }, 0);
                                        }, 0);
                                        const companyOverride = companyOverrides[company] || {};
                                        const companyDeposit = companyOverride.deposit !== undefined ? companyOverride.deposit : companyCalcDeposit;
                                        const companyMargin = companyOverride.margin !== undefined ? companyOverride.margin : companyCalcMargin;
                                        const showStats = companyCalcDeposit > 0 || companyCalcMargin > 0;
                                        const companyHasOrders = sessions.some(s =>
                                            (allOrderRows[s.id]?.length || 0) > 0 ||
                                            (sessionResults?.[s.id]?.orderCount || 0) > 0
                                        );

                                        return sessions.map((session, sIdx) => {
                                        const prevItems = sessions
                                            .slice(0, sIdx)
                                            .map(ps => ({ round: ps.round, summary: allItemSummaries[ps.id] || {} }))
                                            .filter(item => Object.keys(item.summary).length > 0);
                                        const prevSessionIds = sessions.slice(0, sIdx).map(ps => ps.id);
                                        const sessionPlatform = session.round <= 1 ? masterPlatformName : (batchPlatforms[session.id] || '쿠팡');
                                        const isChecked = checkedCompanies.has(company);
                                        const isEditingDeposit = editingCell?.company === company && editingCell?.field === 'deposit';
                                        const isEditingMargin = editingCell?.company === company && editingCell?.field === 'margin';
                                        return workstationsReady ? (
                                            <React.Fragment key={`${session.id}-${workstationResetKey}`}>
                                                <CompanyWorkstationRow
                                                    sessionId={session.id} companyName={company} roundNumber={session.round} isFirstSession={sIdx === 0} isLastSession={sIdx === (companySessions[company] || []).length - 1} pricingConfig={pricingConfig}
                                                    companySummaryBar={sIdx === 0 && showStats ? (
                                                        <div className={`flex items-center gap-3 flex-wrap ${closedCompanies.has(company) ? 'opacity-30 pointer-events-none' : ''}`}>
                                                            <input
                                                                type="checkbox"
                                                                checked={isChecked}
                                                                onChange={() => setCheckedCompanies(prev => {
                                                                    const next = new Set(prev);
                                                                    if (next.has(company)) next.delete(company); else next.add(company);
                                                                    return next;
                                                                })}
                                                                className="w-3.5 h-3.5 accent-indigo-500 cursor-pointer shrink-0"
                                                            />
                                                            <div className="flex items-center gap-1.5">
                                                                <span className={`text-[9px] font-black uppercase tracking-wider ${isChecked ? 'text-indigo-400/50' : 'text-zinc-600'}`}>입금</span>
                                                                {isEditingDeposit ? (
                                                                    <input type="number" value={editingValue} onChange={e => setEditingValue(e.target.value)}
                                                                        onBlur={() => { const v = parseInt(editingValue); setCompanyOverrides(prev => ({ ...prev, [company]: { ...prev[company], deposit: isNaN(v) ? companyCalcDeposit : v } })); setEditingCell(null); }}
                                                                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingCell(null); }}
                                                                        className="w-28 text-[11px] font-black text-white bg-zinc-800 border border-rose-500/50 rounded px-2 py-0.5 focus:outline-none" autoFocus />
                                                                ) : (
                                                                    <button onClick={() => { setEditingCell({ company, field: 'deposit' }); setEditingValue(String(companyDeposit)); }} title="클릭하여 수정"
                                                                        className={`text-[12px] font-black transition-colors hover:text-rose-400 ${isChecked ? 'text-indigo-300/60' : 'text-white'} ${companyOverride.deposit !== undefined ? 'underline decoration-dotted decoration-rose-400/60' : ''}`}>
                                                                        {companyDeposit.toLocaleString()}원
                                                                    </button>
                                                                )}
                                                            </div>
                                                            <span className="text-zinc-700 text-[10px]">·</span>
                                                            <div className="flex items-center gap-1.5">
                                                                <span className={`text-[9px] font-black uppercase tracking-wider ${isChecked ? 'text-indigo-400/50' : 'text-zinc-600'}`}>마진</span>
                                                                {isEditingMargin ? (
                                                                    <input type="number" value={editingValue} onChange={e => setEditingValue(e.target.value)}
                                                                        onBlur={() => { const v = parseInt(editingValue); setCompanyOverrides(prev => ({ ...prev, [company]: { ...prev[company], margin: isNaN(v) ? companyCalcMargin : v } })); setEditingCell(null); }}
                                                                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingCell(null); }}
                                                                        className="w-24 text-[11px] font-black text-emerald-400 bg-zinc-800 border border-emerald-500/50 rounded px-2 py-0.5 focus:outline-none" autoFocus />
                                                                ) : (
                                                                    <button onClick={() => { setEditingCell({ company, field: 'margin' }); setEditingValue(String(companyMargin)); }} title="클릭하여 수정"
                                                                        className={`text-[12px] font-black transition-colors ${isChecked ? 'text-indigo-300/60 hover:text-indigo-200' : companyMargin > 0 ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-600 hover:text-zinc-400'} ${companyOverride.margin !== undefined ? 'underline decoration-dotted decoration-emerald-400/60' : ''}`}>
                                                                        {companyMargin > 0 ? `+${companyMargin.toLocaleString()}원` : '—'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ) : undefined}
                                                    vendorFiles={vendorFiles[company] || []} masterFile={masterOrderFile} batchFile={batchFiles[session.id] || null} isDetected={detectedCompanies.has(company)} fakeOrderNumbers={[effectiveFakeInput, effectiveUnsentInput].filter(s => s.trim()).join('\n')}
                                                    manualOrders={sIdx === 0 ? manualOrders.filter(o => o.companyName === company) : []} isSelected={selectedSessionIds.has(session.id)} onSelectToggle={handleToggleSessionSelection}
                                                    onVendorFileChange={(files) => handleVendorFileChange(company, files)} onResultUpdate={handleResultUpdate} onDataUpdate={handleDataUpdate}
                                                    onAddSession={() => handleAddSession(company)} onRemoveSession={() => handleRemoveSession(company, session.id)} onAddAdjustment={handleAddCompanyAdjustment}
                                                    isClosed={closedCompanies.has(company)} onToggleClosed={() => handleToggleClosed(company)}
                                                    isActive={companyHasOrders}
                                                    onDownloadMergedOrder={(companySessions[company] || []).length > 1 ? () => handleDownloadMergedOrder(company) : undefined}
                                                    onDownloadMergedInvoice={(companySessions[company] || []).length > 1 ? (type: 'mgmt' | 'upload') => handleDownloadMergedInvoice(company, type) : undefined}
                                                    previousRoundItems={prevItems}
                                                    previousSessionIds={prevSessionIds}
                                                    manualOrdersRejected={manualOrdersRejectedCompanies.has(company)}
                                                    onManualOrdersApproval={handleManualOrdersApproval}
                                                    businessId={businessId}
                                                    onConfigChange={onConfigChange}
                                                    masterExpectedCount={sIdx === 0
                                                        ? (masterProductSummary?.companyOrderCounts?.[company] || 0)
                                                        : (batchExpectedCounts[session.id] || 0)
                                                    }
                                                    missingItems={sIdx === 0 ? (missingOrderAnalysis?.missingByCompany?.[company] || []) : []}
                                                    fakeCourierRows={getCourierRowsForCompany(company)}
                                                    orderPlatformMap={orderPlatformMap}
                                                    platformConfigs={platformConfigs}
                                                    roundPlatform={sessionPlatform}
                                                    companyTotalOrders={companyTotal}
                                                    roundOrderCounts={roundOrderCountsForCompany}
                                                    fakeMismatch={fakeMismatch}
                                                    companyChecked={isChecked}
                                                    isRecorded={recordedCompanies.has(company)}
                                                    onRecord={sIdx === 0 ? () => { if (recordedCompanies.has(company)) { handleDeleteCompanyFromSalesHistory(company); } else { handleSaveToSalesHistory(new Set([company])); } } : undefined}
                                                    workDate={workDate}
                                                    workspace={workspace}
                                                    updateField={updateField}
                                                    updateSessionField={updateWorkspaceSessionField}
                                                    sessionResults={sessionResults}
                                                    onSaveSessionResult={handleSaveSessionResult}
                                                    onDeleteSessionResult={handleDeleteSessionResult}
                                                    pendingOrderLight={sIdx === 0 && orderLitSessions.has(session.id)}
                                                    pendingInvoiceLight={sIdx === 0 && (invoiceLitSessions.has(session.id) || batchInvoiceLit.has(company))}
                                                    onOrderDownloaded={() => setOrderLitSessions(prev => { const s = new Set(prev); s.delete(session.id); return s; })}
                                                    onInvoiceDownloaded={() => { setInvoiceLitSessions(prev => { const s = new Set(prev); s.delete(session.id); return s; }); setBatchInvoiceLit(prev => { const s = new Set(prev); s.delete(company); return s; }); }}
                                                    mergedDownloaded={mergedDownloadedCompanies.has(company)}
                                                    onWarningUpdate={handleSessionWarningUpdate}
                                                    onEffectiveTextChange={sIdx === (companySessions[company] || []).length - 1 ? (kakaoText, excelText) => { companyLastSettlementRef.current[company] = { kakaoText, excelText }; } : undefined}
                                                />
                                            </React.Fragment>
                                        ) : null;
                                    });
                                    })()}
                                </SortableCompanyRow>
                                    );
                                });
                                })()}
                            </SortableContext>
                        </table>
                    </DndContext>
                </div>
            </section>

            {/* 완료 업체 세로 사이드바 */}
            {(() => {
                const allCompanies = sortCompanies(Object.keys(pricingConfig));
                const completed = allCompanies.filter(c => {
                    const sessions = companySessions[c] || [];
                    return sessions.some(s => (allOrderRows[s.id]?.length || 0) > 0);
                });
                const pending = allCompanies.filter(c => !completed.includes(c));
                if (completed.length === 0) return null;
                return (
                    <div className="sticky top-4 flex flex-col gap-0.5 w-20 shrink-0 pt-1">
                        <span className="text-[8px] font-black text-zinc-600 uppercase tracking-widest mb-1 px-1">{completed.length}/{allCompanies.length}</span>
                        {completed.map(c => {
                            const firstSession = (companySessions[c] || []).find(s => (allOrderRows[s.id]?.length || 0) > 0);
                            return (
                                <button key={c} onClick={() => firstSession && handleToastClick(firstSession.id)}
                                    className="text-left text-[10px] font-black text-emerald-400 hover:text-white px-2 py-1 rounded-lg bg-emerald-950/20 hover:bg-emerald-950/50 border border-emerald-900/40 hover:border-emerald-500/30 transition-all truncate">
                                    {c}
                                </button>
                            );
                        })}
                        {pending.length > 0 && <div className="h-px bg-zinc-800/50 my-1" />}
                        {pending.map(c => {
                            const firstSession = (companySessions[c] || [])[0];
                            return (
                                <button key={c} onClick={() => firstSession && handleToastClick(firstSession.id)}
                                    className="text-left text-[10px] font-bold text-zinc-700 hover:text-zinc-500 px-2 py-1 rounded-lg hover:bg-zinc-800/30 transition-all truncate">
                                    {c}
                                </button>
                            );
                        })}
                    </div>
                );
            })()}
            </div>

            {/* 선택 발주건 정산요약 모달 */}
            {showSelectedSummaryModal && (() => {
                // 선택된 세션들의 정산 합산
                const allSessions = Object.values(companySessions).flat() as SessionData[];
                const selectedSessions = allSessions.filter(s => selectedSessionIds.has(s.id));

                // 업체별로 그룹화하면서 품목 합산
                const byCompany: Record<string, { round: number; items: Record<string, { count: number; totalPrice: number }> }[]> = {};
                selectedSessions.forEach(s => {
                    const summary = allItemSummaries[s.id];
                    if (!byCompany[s.companyName]) byCompany[s.companyName] = [];
                    byCompany[s.companyName].push({ round: s.round, items: summary || {} });
                });

                // 업체별 합산
                const companyMerged: Record<string, { sessions: { round: number; total: number }[]; items: Record<string, { count: number; totalPrice: number }>; total: number }> = {};
                Object.entries(byCompany).forEach(([company, rounds]) => {
                    const merged: Record<string, { count: number; totalPrice: number }> = {};
                    rounds.forEach(r => {
                        Object.entries(r.items).forEach(([key, val]) => {
                            if (!merged[key]) merged[key] = { count: 0, totalPrice: 0 };
                            merged[key].count += val.count;
                            merged[key].totalPrice += val.totalPrice;
                        });
                    });
                    const total = Object.values(merged).reduce((s, v) => s + v.totalPrice, 0);
                    const sessionTotals = rounds.map(r => ({
                        round: r.round,
                        total: Object.values(r.items).reduce((s, v) => s + v.totalPrice, 0),
                    }));
                    companyMerged[company] = { sessions: sessionTotals, items: merged, total };
                });

                const grandTotal = Object.values(companyMerged).reduce((s, c) => s + c.total, 0);
                const sortedCompanies = Object.entries(companyMerged).sort(([, a], [, b]) => b.total - a.total);

                const selectedRoundLabels = selectedSessions.map(s => `${s.companyName} ${s.round}차`).join(', ');

                return createPortal(
                    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowSelectedSummaryModal(false)}>
                        <div className="relative bg-zinc-900 border border-zinc-700 rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col animate-fade-in" onClick={e => e.stopPropagation()}>
                            {/* 헤더 */}
                            <div className="px-6 py-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
                                <div>
                                    <div className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">선택 발주건 정산요약</div>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-3xl font-black text-white">{grandTotal.toLocaleString()}</span>
                                        <span className="text-lg font-black text-rose-500">원</span>
                                    </div>
                                    <div className="text-[10px] text-zinc-500 mt-1 font-bold">{selectedSessionIds.size}개 세션 선택됨</div>
                                </div>
                                <button onClick={() => setShowSelectedSummaryModal(false)} className="text-zinc-600 hover:text-white transition-colors text-2xl font-bold w-9 h-9 flex items-center justify-center rounded-xl hover:bg-zinc-800">×</button>
                            </div>

                            {/* 내용 */}
                            <div className="overflow-y-auto custom-scrollbar flex-1 px-4 py-4 space-y-3">
                                {sortedCompanies.length === 0 ? (
                                    <p className="text-zinc-600 text-sm text-center py-8 font-bold">정산 데이터가 없습니다.<br/><span className="text-zinc-700 text-xs">발주서를 먼저 처리해주세요.</span></p>
                                ) : sortedCompanies.map(([company, data]) => (
                                    <div key={company} className="bg-zinc-800/50 rounded-2xl border border-zinc-700/50 overflow-hidden">
                                        {/* 업체 헤더 */}
                                        <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-700/50 bg-zinc-800/30">
                                            <div className="flex items-center gap-2">
                                                <span className="text-rose-400 font-black text-sm">[{company}]</span>
                                                <div className="flex gap-1">
                                                    {data.sessions.map(s => (
                                                        <span key={s.round} className="text-[9px] bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded-full font-bold border border-zinc-600">
                                                            {s.round}차 {s.total.toLocaleString()}원
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                            <span className="text-white font-black text-sm">{data.total.toLocaleString()}원</span>
                                        </div>
                                        {/* 품목 테이블 */}
                                        {Object.keys(data.items).length > 0 ? (
                                            <table className="w-full text-left">
                                                <tbody className="divide-y divide-zinc-800/50">
                                                    {Object.entries(data.items)
                                                        .sort(([, a], [, b]) => b.totalPrice - a.totalPrice)
                                                        .map(([key, val]) => (
                                                        <tr key={key} className="text-xs hover:bg-zinc-700/20 transition-colors">
                                                            <td className="py-2 pl-4 pr-2 font-bold text-zinc-300">{key}</td>
                                                            <td className="py-2 pr-3 text-right text-zinc-400 font-bold">{val.count}개</td>
                                                            <td className="py-2 pr-4 text-right text-white font-black">{val.totalPrice.toLocaleString()}원</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        ) : (
                                            <p className="text-zinc-600 text-[11px] text-center py-3 font-bold">품목 데이터 없음</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>,
                    document.body
                );
            })()}

            {/* 토스트 알림 */}
            {toasts.length > 0 && (
                <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
                    {toasts.map(toast => (
                        <button key={toast.id} onClick={() => handleToastClick(toast.sessionId)}
                            className="flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-emerald-500/30 rounded-xl shadow-2xl shadow-emerald-500/10 animate-slide-up cursor-pointer hover:border-emerald-500/60 transition-all group">
                            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                            <div className="text-left">
                                <div className="text-[11px] font-black text-white">{toast.companyName}</div>
                                <div className="text-[10px] text-emerald-400 font-bold">발주서 {toast.orderCount}건 생성</div>
                            </div>
                            <span className="text-[9px] text-zinc-600 group-hover:text-zinc-400 ml-2">클릭하여 이동</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default CompanySelector;
