
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import CompanyWorkstationRow from './CompanyWorkstationRow';
import FileUpload from './FileUpload';
import type { PricingConfig, ManualOrder, ExcludedOrder, MarginRecord, SalesRecord, DailySales, ExpenseRecord, ReturnRecord, PlatformConfigs, PlatformConfig, CourierTemplate } from '../types';
import { getBusinessInfo } from '../types';
import { BuildingStorefrontIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, TrashIcon, PlusCircleIcon, BoltIcon, ClipboardDocumentCheckIcon, ArrowPathIcon, CheckIcon, PhoneIcon, DocumentCheckIcon, DocumentArrowUpIcon, ChartBarIcon, Cog6ToothIcon, HomeIcon, TruckIcon } from './icons';
import { getKeywordsForCompany, getHeaderForCompany } from '../hooks/useConsolidatedOrderConverter';
import { useDailyWorkspace, useCourierTemplates } from '../hooks/useFirestore';
import { subscribeManualOrders, saveManualOrders, upsertDailySales, subscribeCompanyOrder, saveCompanyOrder, subscribeQuickRecipients, saveQuickRecipients, type QuickRecipientData } from '../services/firestoreService';
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

interface SessionData {
    id: string;
    companyName: string;
    round: number;
}

interface CompanySelectorProps { pricingConfig: PricingConfig; onConfigChange: (newConfig: PricingConfig) => void; businessId?: string; platformConfigs?: PlatformConfigs; isActive?: boolean; isCurrent?: boolean; }

// 드래그 가능한 행 컴포넌트
import { DragHandleContext } from './DragHandleContext';

const SortableCompanyRow: React.FC<{
    id: string;
    children: React.ReactNode;
}> = ({ id, children }) => {
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
    };

    return (
        <DragHandleContext.Provider value={{ attributes, listeners }}>
            <tbody ref={setNodeRef} style={style} className="border-b border-zinc-700/50">
                {children}
            </tbody>
        </DragHandleContext.Provider>
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
                    const headers = headerRow.map((h: any) => String(h || ''));
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
                    const headers = headerRow.map((h: any) => String(h || ''));
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
                    <div className="flex gap-3">
                        <div className="flex-1">
                            <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">택배사 이름</label>
                            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="예: CJ대한통운" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-pink-500/50" />
                        </div>
                        <div className="flex-1">
                            <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">명칭 (구분용)</label>
                            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="예: 과일용, 3kg박스" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-pink-500/50" />
                        </div>
                        <div className="w-28">
                            <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-1 block">건당 단가</label>
                            <input value={newUnitPrice} onChange={(e) => setNewUnitPrice(e.target.value)} placeholder="2270" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-pink-500/50" />
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

const CompanySelector: React.FC<CompanySelectorProps> = ({ pricingConfig, onConfigChange, businessId, platformConfigs = {}, isActive = false, isCurrent = false }) => {
    const businessPrefix = businessId ? (getBusinessInfo(businessId)?.shortName || businessId) : '';
    const { workspace, updateField, isReady } = useDailyWorkspace(businessId);
    const { courierTemplates, saveTemplates: saveCourierTemplates, fakeCourierSettings, saveFakeCourierSettings } = useCourierTemplates(businessId);

    // 새로고침 시 워크스테이션 데이터 초기화 (마운트 = 새로고침에서만 발생, 사업자 전환 시에는 display:none으로 유지)
    // 다른 탭이 이미 세션 데이터를 보유 중일 수 있으므로, 기존 데이터가 없을 때만 초기화
    const [workstationsReady, setWorkstationsReady] = useState(false);
    useEffect(() => {
        if (!isReady || workstationsReady) return;
        const writes: Promise<void>[] = [];
        if (!workspace?.sessionResults || Object.keys(workspace.sessionResults).length === 0) {
            writes.push(updateField('sessionResults', {}));
        }
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
    const [companyOverrides, setCompanyOverrides] = useState<Record<string, { deposit?: number; margin?: number }>>({});
    const [editingCell, setEditingCell] = useState<{ company: string; field: 'deposit' | 'margin' } | null>(null);
    const [editingValue, setEditingValue] = useState('');

    // 워크스테이션 수동 초기화 함수
    const handleResetWorkstations = useCallback(() => {
        if (!window.confirm('워크스테이션 데이터(처리결과/진행상황/조정내역)를 초기화할까요?')) return;
        Promise.all([
            updateField('sessionResults', {}),
            updateField('sessionWorkflows', {}),
            updateField('sessionAdjustments', {}),
        ]);
        setTotalsMap({});
        setExcludedCountsMap({});
        setAllExcludedDetails({});
        setAllOrderRows({});
        setAllInvoiceRows({});
        setAllUploadInvoiceRows({});
        setAllHeaders({});
        setAllSummaries({});
        setAllItemSummaries({});
    }, [updateField]);

    const [masterOrderFile, setMasterOrderFile] = useState<File | null>(null);
    const [masterOrderData, setMasterOrderData] = useState<any[][] | null>(null);
    const [detectedCompanies, setDetectedCompanies] = useState<Set<string>>(new Set());
    const [batchFiles, setBatchFiles] = useState<Record<string, File>>({});
    const [batchExpectedCounts, setBatchExpectedCounts] = useState<Record<string, number>>({});
    const [batchMasterRows, setBatchMasterRows] = useState<Record<string, any[][]>>({});
    const [batchPlatforms, setBatchPlatforms] = useState<Record<string, string>>({}); // sessionId → 플랫폼명
    const batchFileInputRef = useRef<HTMLInputElement>(null);
    // 멀티 플랫폼: 업로드된 플랫폼 목록 + 건수
    const [uploadedPlatforms, setUploadedPlatforms] = useState<{ name: string; count: number }[]>([]);
    // 행별 출처 플랫폼 (인덱스 = masterOrderData 행 인덱스, 값 = 플랫폼 이름 또는 null=쿠팡)
    const [rowPlatformSources, setRowPlatformSources] = useState<(string | null)[]>([]);

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
        const unsubscribe = subscribeQuickRecipients((recipients) => {
            setQuickRecipients(recipients);
        }, businessId);
        return unsubscribe;
    }, [businessId]);

    // 업체 순서 관리
    const [companyOrder, setCompanyOrder] = useState<string[]>([]);
    const lastWrittenCompanyOrderRef = useRef('[]');
    const [firestoreOrderLoaded, setFirestoreOrderLoaded] = useState(false);

    // 업체 순서 Firestore 구독
    useEffect(() => {
        setFirestoreOrderLoaded(false);
        const unsubscribe = subscribeCompanyOrder((order) => {
            setFirestoreOrderLoaded(true);
            const str = JSON.stringify(order);
            if (str !== lastWrittenCompanyOrderRef.current) {
                console.log(`[CompanyOrder:${businessId}] Firestore → 로컬 동기화:`, order.slice(0, 5), `(ref was: ${lastWrittenCompanyOrderRef.current.slice(0, 50)})`);
                setCompanyOrder(order);
                lastWrittenCompanyOrderRef.current = str;
            }
        }, businessId);
        return unsubscribe;
    }, [businessId]);

    // 업체 순서 변경 → Firestore에 저장 (Firestore 로드 완료 후에만)
    useEffect(() => {
        if (!firestoreOrderLoaded) return;
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
        // 새로 추가된 업체를 companyOrder에 자동 반영 (드래그 가능하도록)
        const newCompanies = companies.filter(c => !companyOrder.includes(c));
        const removedCompanies = companyOrder.filter(c => !companies.includes(c));
        if (newCompanies.length > 0 || removedCompanies.length > 0) {
            const updated = [
                ...companyOrder.filter(c => companies.includes(c)),
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
    }, [companyOrder, pricingConfig, businessId, firestoreOrderLoaded]);

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

    // 수동발주 Firestore 영구 저장 - 구독
    useEffect(() => {
        const unsubscribe = subscribeManualOrders((orders) => {
            const str = JSON.stringify(orders);
            if (str !== lastWrittenManualOrdersRef.current) {
                const typedOrders = orders as ManualOrder[];
                setManualOrders(typedOrders);
                setSelectedManualOrderIds(prev => {
                    const next = new Set(prev);
                    typedOrders.forEach(o => { if (!prev.has(o.id)) next.add(o.id); });
                    return next;
                });
                lastWrittenManualOrdersRef.current = str;
            }
        }, businessId);
        return unsubscribe;
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

    // 썸네일 + 메모 노트
    interface ThumbnailNote { id: string; imageData: string; memos: [string, string, string]; }
    const [thumbnailNotes, setThumbnailNotes] = useState<ThumbnailNote[]>([]);
    const lastWrittenThumbnailNotesRef = useRef('[]');
    const thumbnailSyncedRef = useRef(false); // workspace에서 첫 동기화 전 빈 배열 저장 방지

    const handleAddThumbnailNote = () => {
        setThumbnailNotes(prev => [...prev, { id: `tn-${Date.now()}`, imageData: '', memos: ['', '', ''] }]);
    };
    const handleRemoveThumbnailNote = (id: string) => {
        const target = thumbnailNotes.find((n: ThumbnailNote) => n.id === id);
        const label = target?.memos[0]?.trim() || '이 메모';
        if (!window.confirm(`"${label}" 썸네일/메모를 삭제하시겠습니까?\n(이 동작은 되돌릴 수 없습니다)`)) return;
        setThumbnailNotes(prev => prev.filter(n => n.id !== id));
    };
    const handleThumbnailImage = (id: string, file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxSize = 200;
                let w = img.width, h = img.height;
                if (w > h) { h = (h / w) * maxSize; w = maxSize; } else { w = (w / h) * maxSize; h = maxSize; }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
                const compressed = canvas.toDataURL('image/jpeg', 0.7);
                setThumbnailNotes(prev => prev.map(n => n.id === id ? { ...n, imageData: compressed } : n));
            };
            img.src = e.target?.result as string;
        };
        reader.readAsDataURL(file);
    };
    const handleThumbnailMemo = (id: string, idx: number, value: string) => {
        setThumbnailNotes(prev => prev.map(n => {
            if (n.id !== id) return n;
            const memos = [...n.memos] as [string, string, string];
            memos[idx] = value;
            return { ...n, memos };
        }));
    };

    const [manualInput, setManualInput] = useState({
        companyName: '', recipientName: '', phone: '', address: '', productName: '', qty: '1', memo: ''
    });


    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => {
        const initialIds = new Set<string>();
        Object.keys(pricingConfig).forEach(name => initialIds.add(`${name}-1`));
        return initialIds;
    });

    const [fakeOrderInput, setFakeOrderInput] = useState('');
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

    // 반품 관리
    const [returns, setReturns] = useState<ReturnRecord[]>([]);
    const [returnCompany, setReturnCompany] = useState('');
    const [returnProductKey, setReturnProductKey] = useState('');
    const [returnCount, setReturnCount] = useState('1');
    const [returnMemo, setReturnMemo] = useState('');
    const returnProducts = useMemo(() => {
        if (!returnCompany || !pricingConfig[returnCompany]) return [];
        return Object.entries(pricingConfig[returnCompany].products).map(([key, p]: [string, any]) => ({
            key, name: p.orderFormName || p.displayName, margin: p.margin || 0,
        }));
    }, [returnCompany, pricingConfig]);
    const selectedReturnMargin = useMemo(() => {
        const p = returnProducts.find(p => p.key === returnProductKey);
        return p ? p.margin : 0;
    }, [returnProducts, returnProductKey]);

    // Firestore 동기화 - 값 비교로 에코 방지
    const lastWrittenFakeRef = useRef('');
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
        if (workspace.thumbnailNotes !== undefined) {
            thumbnailSyncedRef.current = true;
            if (now >= (savingFieldsUntil.current['thumbnailNotes'] || 0)) {
                const serverNotes = workspace.thumbnailNotes as ThumbnailNote[];
                const wsStr = JSON.stringify(serverNotes);
                if (wsStr !== lastWrittenThumbnailNotesRef.current) {
                    // 안전 가드: 서버가 빈 배열을 돌려줬는데 로컬에 노트가 있으면
                    // 덮어쓰지 않고 로컬 데이터를 서버로 복구 업로드 → 내가 삭제하기 전엔 안 지워짐
                    if (Array.isArray(serverNotes) && serverNotes.length === 0 && thumbnailNotes.length > 0) {
                        console.warn('[썸네일] 서버 빈 상태 감지 → 로컬 데이터 복구 업로드');
                        savingFieldsUntil.current['thumbnailNotes'] = Date.now() + 30000;
                        updateField('thumbnailNotes', thumbnailNotes)
                            .then(() => { setTimeout(() => { savingFieldsUntil.current['thumbnailNotes'] = 0; }, 1500); })
                            .catch((e: unknown) => { savingFieldsUntil.current['thumbnailNotes'] = 0; console.error('[썸네일] 복구 업로드 실패:', e); });
                    } else {
                        setThumbnailNotes(serverNotes);
                        lastWrittenThumbnailNotesRef.current = wsStr;
                    }
                }
            }
        } else if (!thumbnailSyncedRef.current) {
            thumbnailSyncedRef.current = true; // workspace에 thumbnailNotes 필드 자체가 없는 경우
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

    // thumbnailNotes 변경 → Firestore에 디바운스 저장
    const thumbnailDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!isReadyRef.current || !thumbnailSyncedRef.current) return;
        const currentStr = JSON.stringify(thumbnailNotes);
        if (currentStr === lastWrittenThumbnailNotesRef.current) return;
        if (thumbnailDebounceRef.current) clearTimeout(thumbnailDebounceRef.current);
        thumbnailDebounceRef.current = setTimeout(() => {
            savingFieldsUntil.current['thumbnailNotes'] = Date.now() + 30000;
            lastWrittenThumbnailNotesRef.current = currentStr;
            updateField('thumbnailNotes', thumbnailNotes)
                .then(() => { setTimeout(() => { savingFieldsUntil.current['thumbnailNotes'] = 0; }, 1500); })
                .catch(e => { savingFieldsUntil.current['thumbnailNotes'] = 0; console.error('[Firestore] 썸네일 노트 저장 실패:', e); });
        }, 500);
        return () => { if (thumbnailDebounceRef.current) clearTimeout(thumbnailDebounceRef.current); };
    }, [thumbnailNotes, updateField]);

    // 가구매 명단 분석 (입력된 번호/이름 vs 실제 발견된 번호)
    const fakeOrderAnalysis = useMemo(() => {
        const inputNumbers = new Set<string>();
        const nameMap: Record<string, string> = {}; // 주문번호 -> 이름
        const duplicates: { number: string; names: string[] }[] = [];
        const numberToNames = new Map<string, string[]>();
        let inputLineCount = 0;

        fakeOrderInput.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            inputLineCount++;
            const matches = trimmed.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) {
                let namepart = trimmed;
                matches.forEach(m => { namepart = namepart.replace(m, ''); });
                const name = namepart.trim();
                matches.forEach(m => {
                    const num = m.trim();
                    inputNumbers.add(num);
                    if (name) {
                        nameMap[num] = name;
                        const existing = numberToNames.get(num) || [];
                        if (!existing.includes(name)) existing.push(name);
                        numberToNames.set(num, existing);
                    }
                });
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

        // 마스터 주문서에서 모든 주문번호 추출
        const masterOrderNumbers = new Set<string>();
        if (masterOrderData && masterOrderData.length > 1) {
            for (let i = 1; i < masterOrderData.length; i++) {
                const row = masterOrderData[i];
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

        return { inputNumbers, inputLineCount, matched, missing, foundDetails, nameMap, duplicates };
    }, [fakeOrderInput, allExcludedDetails, masterOrderData]);

    // 마스터 주문서 품목별 건수 분석 (가구매 제외 / 가구매 분리)
    const masterProductSummary = useMemo(() => {
        if (!masterOrderData || masterOrderData.length < 2) return null;
        const fakeNums = resolveFakeOrderNumbers(fakeOrderInput);
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
                // col 10/11에서 못 찾으면 전체 행에서 키워드 재탐색 (토스 등 비표준 열 구조)
                if (!bestCompany) {
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
        console.log(`[마스터검증] XLSX행수: ${masterOrderData.length - 1}, 데이터행: ${masterFileRowCount}, null행: ${nullRowCount}, masterRawTotalQty: ${masterRawTotalQty}, realTotal: ${realTotal}, fakeTotal: ${fakeTotal}, 합계: ${realTotal + fakeTotal}, skipped: ${skippedOrders.length}, unclaimed: ${unclaimedOrders.length}`);
        console.log(`[마스터검증] companyOrderCounts:`, companyOrderCounts);
        if (unclaimedOrders.length > 0) console.log(`[마스터검증] unclaimedOrders:`, unclaimedOrders);
        if (skippedOrders.length > 0) console.log(`[마스터검증] skippedOrders:`, skippedOrders);
        return { realOrders, fakeOrders, realTotal, fakeTotal, productToCompany, unclaimedOrders, allOrderDetails, companyOrderCounts, skippedOrders, masterRawTotalQty, masterFileRowCount };
    }, [masterOrderData, fakeOrderInput, pricingConfig, rowPlatformSources]);

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
        fakeOrderInput.split('\n').forEach(line => {
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
    }, [companySessions, allOrderRows, fakeOrderInput, batchMasterRows, batchPlatforms]);

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
                setMasterOrderFile(new File([normalizedBuffer], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }));

                console.log(`✅ [Platform] "${platformName}" 감지됨 (${Math.round(detectedPlatform.score * 100)}% 일치)${detectedPlatform.columnRemap ? ' [열 리맵]' : ''}, 헤더행=${detectedPlatform.actualHeaderRowIdx}, 데이터시작=${dataStart}: ${json.length - 1}건 정규화`);
            } else {
                setUploadedPlatforms([{ name: '쿠팡', count: json.length - 1 }]);
                setRowPlatformSources([]);
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
                // col 10/11에서 못 찾으면 전체 행에서 키워드 재탐색 (토스 등 비표준 열 구조)
                if (!bestCompany) {
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

    const clearMasterFile = () => { setMasterOrderFile(null); setMasterOrderData(null); setDetectedCompanies(new Set()); setUploadedPlatforms([]); setRowPlatformSources([]); };

    const handleBatchUpload = async (file: File) => {
        console.log('🚀 [배치 업로드] 시작:', file.name);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            let json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
            if (!json || json.length < 2) { alert('유효한 주문서가 아닙니다.'); return; }

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
                // col 10/11에서 못 찾으면 전체 행에서 키워드 재탐색 (토스 등 비표준 열 구조)
                if (!bestCompany) {
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
            if (companiesInFile.size === 0) { alert('주문서에서 매칭되는 업체를 찾지 못했습니다.'); return; }
            let maxRound = 0;
            (Object.values(companySessions) as SessionData[][]).forEach(sessions => {
                sessions.forEach(s => { if (s.round > maxRound) maxRound = s.round; });
            });
            const nextRound = maxRound + 1;
            const newBatchFiles: Record<string, File> = {};
            const newExpectedCounts: Record<string, number> = {};
            const newBatchMasterRows: Record<string, any[][]> = {};
            const newSessions: Record<string, SessionData[]> = { ...companySessions };
            const newSelectedIds = new Set(selectedSessionIds);
            for (const companyName of companiesInFile) {
                const newSessionId = `${companyName}-batch-${nextRound}-${Date.now()}`;
                const newSession: SessionData = { id: newSessionId, companyName, round: nextRound };
                newSessions[companyName] = [...(newSessions[companyName] || []), newSession];
                newSelectedIds.add(newSessionId);
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
            setCompanySessions(newSessions);
            setSelectedSessionIds(newSelectedIds);
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
            alert('파일 처리 중 오류가 발생했습니다.');
        }
    };

    // 범용 택배 양식 다운로드: 템플릿 매핑에 따라 주문 데이터 채워서 다운로드
    const handleCourierDownload = async (template: CourierTemplate) => {
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }

        try {
            // 1차 마스터 파일 읽기
            const masterData = await masterOrderFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            const fakeOrderNums = resolveFakeOrderNumbers(fakeOrderInput, { normalize: true });
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
            const tmplDisplayName = template.label ? `${template.name}_${template.label}` : template.name;
            XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_${businessPrefix}_${tmplDisplayName}.xlsx`);

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
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
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
            const masterData = await masterOrderFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            const fakeOrderNums = resolveFakeOrderNumbers(fakeOrderInput, { normalize: true });
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
        const tmplDisplayName = tmpl ? (tmpl.label ? `${tmpl.name}_${tmpl.label}` : tmpl.name) : '택배';
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '주문서');
        XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_${businessPrefix}_가구매_${tmplDisplayName}_운송장완료.xlsx`);
    };

    const handleAddManualOrder = (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualInput.companyName || !manualInput.recipientName || !manualInput.productName) {
            alert('업체, 수령자 이름, 품목명은 필수입니다.'); return;
        }
        const newOrder: ManualOrder = {
            id: `mo-${Date.now()}`, companyName: manualInput.companyName, recipientName: manualInput.recipientName,
            phone: manualInput.phone, address: manualInput.address, productName: manualInput.productName, qty: parseInt(manualInput.qty) || 1,
            memo: manualInput.memo
        };
        setManualOrders(prev => [...prev, newOrder]);
        setSelectedManualOrderIds(prev => new Set([...prev, newOrder.id]));
        setManualInput(prev => ({ ...prev, recipientName: '', phone: '', address: '', productName: '', qty: '1', memo: '' }));
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

    const handleAddSession = (companyName: string) => {
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
        if (newCount > 0 && prevCount === 0 && Date.now() > toastSuppressUntilRef.current) {
            const companyName = sessionId.replace(/-\d+$/, '');
            addToast(companyName, newCount, sessionId);
        }
        prevOrderRowsRef.current[sessionId] = newCount;

        setAllOrderRows(prev => ({ ...prev, [sessionId]: orderRows }));
        setAllInvoiceRows(prev => ({ ...prev, [sessionId]: invoiceRows }));
        setAllUploadInvoiceRows(prev => ({ ...prev, [sessionId]: uploadInvoiceRows }));
        if (header) setAllHeaders(prev => ({ ...prev, [sessionId]: header }));
        setAllSummaries(prev => ({ ...prev, [sessionId]: summaryExcel }));
        if (registeredProductNames) setAllRegisteredNames(prev => ({ ...prev, [sessionId]: registeredProductNames }));
        if (itemSummary) setAllItemSummaries(prev => ({ ...prev, [sessionId]: itemSummary }));
        if (orderItems) setAllOrderItems(prev => ({ ...prev, [sessionId]: orderItems }));
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
        const dateStr = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `${dateStr} ${businessPrefix ? businessPrefix + ' ' : ''}${companyName} 합산발주서.xlsx`);
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
        const dateStr = new Date().toISOString().slice(0, 10);
        const label = type === 'mgmt' ? '기록용' : '업로드용';
        XLSX.writeFile(wb, `${dateStr} ${businessPrefix ? businessPrefix + ' ' : ''}${companyName} 합산송장_${label}.xlsx`);
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
        const dateStr = new Date().toISOString().slice(0, 10);
        const companiesStr = selectedCompanyNames.length > 3 ? `${selectedCompanyNames.slice(0, 3).join(', ')} 외 ${selectedCompanyNames.length - 3}곳` : selectedCompanyNames.join(', ');
        XLSX.writeFile(wb, `${dateStr} [${businessPrefix ? businessPrefix + ' ' : ''}${companiesStr}] 업로드용_송장_병합.xlsx`);
    };

    const handleDownloadDepositList = () => {
        if (selectedSessionIds.size === 0) { alert('입금 목록을 생성할 업체를 선택해주세요.'); return; }
        const wb = XLSX.utils.book_new();
        const depositRows: any[][] = [];
        let total = 0;
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            let companyTotal = 0;
            sessions.forEach(s => {
                if (!selectedSessionIds.has(s.id)) return;
                companyTotal += totalsMap[s.id] || 0;
            });
            if (companyTotal > 0) { depositRows.push([config?.bankName || '은행미지정', config?.accountNumber || '계좌미지정', companyTotal, name]); total += companyTotal; }
        });
        manualTransfers.forEach(t => { depositRows.push([t.bankName, t.accountNumber, t.amount, t.label]); total += t.amount; });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * fakeCourierSettings.unitPrice;
            depositRows.push([fakeCourierSettings.bankName, fakeCourierSettings.accountNumber, deliveryFee, `${fakeCourierSettings.name}(${fakeOrderAnalysis.inputNumbers.size}건)`]);
            total += deliveryFee;
        }
        if (depositRows.length === 0) { alert('선택된 업체 중 입금할 내역이 없습니다.'); return; }
        depositRows.push([], ['', '합계', total]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(depositRows), "입금내역");
        XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_${businessPrefix}_입금목록.xlsx`);
    };

    const handleDownloadWorkLog = () => {
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));

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
        // K열 등록상품명은 원본 엑셀에서 그대로, 가격/마진은 단가관리에서 productKey로 직접 조회
        const marginSheetData: any[][] = [['등록상품명', '품목명', '수량', '판매가', '공급가', '마진(개당)', '총마진', '지출금액', '지출내역']];
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
        // 품목 연동 비용을 marginGroup key로 집계 (company::productKey → expenses)
        // 같은 품목에 여러 비용이 있으면 첫 번째 비용 금액/내역을 H/I에 입력 (추가 비용은 합산)
        type LinkedExpense = { amount: number; descriptions: string[] };
        const linkedExpenseMap = new Map<string, LinkedExpense>();
        allExpenses.forEach(exp => {
            if (exp.company && exp.productKey) {
                const key = `${exp.company}::${exp.productKey}`;
                const existing = linkedExpenseMap.get(key);
                if (existing) {
                    existing.amount += exp.amount;
                    existing.descriptions.push(exp.description);
                } else {
                    linkedExpenseMap.set(key, { amount: exp.amount, descriptions: [exp.description] });
                }
            }
        });

        // 마진시트 행 추가 + H/I 품목 연동 비용 채우기
        for (const g of marginGroups) {
            const d = g.data;
            // key 마지막 segment가 productKey
            const productKey = g.key.split('::')[2] ?? '';
            const linkedKey = `${g.company}::${productKey}`;
            const linked = linkedExpenseMap.get(linkedKey);
            marginSheetData.push([
                d.regName, d.productName, d.count,
                d.sellingPrice, d.supplyPrice, d.margin, d.margin * d.count,
                linked ? linked.amount : '',
                linked ? linked.descriptions.join(' / ') : '',
            ]);
        }

        // 총 마진
        const totalMargin = marginSheetData.length > 1
            ? marginSheetData.slice(1).reduce((sum: number, r: any[]) => sum + (r[6] || 0), 0)
            : 0;
        if (marginSheetData.length > 1) {
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 마진', totalMargin, '', '']);
        }

        // 비용 섹션 — 품목 미연동 비용만 (자동 물류비 + 업체/품목 미지정 비용)
        const generalExpenses = allExpenses.filter(exp => !(exp.company && exp.productKey));
        if (generalExpenses.length > 0) {
            marginSheetData.push([]);
            marginSheetData.push(['', '[비용]', '', '', '', '', '', '', '']);
            generalExpenses.forEach(exp => {
                marginSheetData.push(['', exp.category, '', '', '', '', '', exp.amount, exp.description]);
            });
            const totalExpense = allExpenses.reduce((sum, e) => sum + e.amount, 0);
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 비용', '', totalExpense, '']);
            marginSheetData.push(['', '', '', '', '', '순이익', '', totalMargin - totalExpense, '']);
        } else if (allExpenses.length > 0) {
            // 모든 비용이 품목 연동인 경우도 순이익 표시
            const totalExpense = allExpenses.reduce((sum, e) => sum + e.amount, 0);
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 비용', '', totalExpense, '']);
            marginSheetData.push(['', '', '', '', '', '순이익', '', totalMargin - totalExpense, '']);
        }

        if (marginSheetData.length > 1) {
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(marginSheetData), "마진시트");
        }

        // 반품시트 생성 (마진시트와 동일 양식, -금액)
        if (returns.length > 0) {
            const returnSheetData: any[][] = [['업체', '품목명', '수량', '개당마진', '반품마진']];
            returns.forEach(r => {
                returnSheetData.push([r.company, r.productName, r.count, r.marginPerUnit, r.totalMargin]);
            });
            returnSheetData.push([]);
            returnSheetData.push(['', '', '', '총 반품 마진', returns.reduce((s, r) => s + r.totalMargin, 0)]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(returnSheetData), "반품시트");
        }

        const todayDate = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `${todayDate}_${businessPrefix}_업무일지.xlsx`);
    };

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
        const dateStr = new Date().toISOString().slice(0, 10);
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

    const handleSaveToSalesHistory = async () => {
        // 마스터파일 이름에서 날짜 파싱 (예: "0309_주문목록.xlsx" → "2026-03-09")
        let recordDate = new Date().toISOString().slice(0, 10);
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
                    recordDate = `${new Date().getFullYear()}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                }
            }
        }
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));

        // 발주/송장 데이터 수집
        const orderSheetData: any[][] = [];
        const invoiceSheetData: any[][] = [];
        sortedCompanyNames.forEach(name => {
            (companySessions[name] || []).forEach(s => {
                if (allOrderRows[s.id]) orderSheetData.push(...allOrderRows[s.id]);
                if (allInvoiceRows[s.id]) invoiceSheetData.push(...allInvoiceRows[s.id]);
            });
        });

        // 입금 데이터 수집
        const depositRows: { bankName: string; accountNumber: string; amount: number }[] = [];
        let depTotal = 0;
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            sessions.forEach(s => {
                const amount = totalsMap[s.id] || 0;
                if (amount > 0) {
                    depositRows.push({ bankName: config?.bankName || '', accountNumber: config?.accountNumber || '', amount });
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

        // 마진 데이터 수집: orderItems를 (회사, 등록상품명, productKey) 기준으로 집계
        const marginMap = new Map<string, MarginRecord>();
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
                        });
                    }
                }
            });
        });
        const marginRecords = Array.from(marginMap.values());
        const marginTotal = marginRecords.reduce((sum, r) => sum + r.totalMargin, 0);

        // summaryLines는 매출 records 생성 등 다른 곳에서 사용
        const summaryLines: string[][] = [];
        sortedCompanyNames.forEach(name => {
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
                        const productEntry = Object.values(companyConfig.products).find((p: any) => p.displayName === productName);
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
        const totalAmount = records.reduce((sum, r) => sum + r.totalPrice, 0);

        // Firestore는 undefined를 저장할 수 없으므로 null로 치환
        const sanitizeRows = (rows: any[][]): any[][] =>
            rows.map(row => row.map(cell => cell === undefined ? null : cell));

        // 반품 데이터: 로컬 입력 + 기존 Firestore 저장분 병합
        let allReturns = [...returns];
        try {
            const { loadAllSalesHistory } = await import('../services/firestoreService');
            const allHistory = await loadAllSalesHistory(businessId);
            const existing = allHistory.find(d => d.date === recordDate);
            if (existing?.returnRecords) {
                allReturns = [...existing.returnRecords, ...returns];
            }
        } catch {}
        const returnTotal = allReturns.reduce((s, r) => s + r.totalMargin, 0);

        const dailySales: DailySales = {
            date: recordDate, records, totalAmount, savedAt: new Date().toISOString(),
            orderRows: orderSheetData.length > 0 ? sanitizeRows(orderSheetData) : undefined,
            invoiceRows: invoiceSheetData.length > 0 ? sanitizeRows(invoiceSheetData) : undefined,
            depositRecords: depositRows.length > 0 ? depositRows : undefined,
            depositTotal: depTotal > 0 ? depTotal : undefined,
            marginRecords: marginRecords.length > 0 ? marginRecords : undefined,
            marginTotal: marginTotal > 0 ? marginTotal : undefined,
            expenseRecords: allExpenses.length > 0 ? allExpenses : undefined,
            returnRecords: allReturns.length > 0 ? allReturns : undefined,
            returnTotal: returnTotal !== 0 ? returnTotal : undefined,
        };

        setSaveStatus('saving');
        try {
            await upsertDailySales(dailySales, businessId);
            setSaveStatus('success');
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
            <div>
                <section className="glass rounded-[1.8rem] p-6 shadow-xl">
                    <div className="flex flex-col gap-6">
                        {/* 썸네일 + 메모 노트 */}
                        <div className="bg-zinc-950/40 p-5 rounded-2xl border border-zinc-800/50">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-zinc-400 font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                                        <PlusCircleIcon className="w-4 h-4 text-cyan-500" />
                                        메모 / 썸네일
                                    </h3>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {thumbnailNotes.map(note => (
                                        <div key={note.id} className="relative bg-zinc-900/80 rounded-lg border border-zinc-800 p-2 flex flex-col gap-1 group animate-pop-in" style={{ width: 'calc(100% / 6 - 7px)', minWidth: '140px' }}>
                                            <button onClick={() => handleRemoveThumbnailNote(note.id)} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-zinc-800 hover:bg-rose-500 text-zinc-500 hover:text-white rounded-full text-[9px] font-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all border border-zinc-700 z-10">×</button>
                                            <input
                                                type="text"
                                                value={note.memos[0]}
                                                onChange={(e) => handleThumbnailMemo(note.id, 0, e.target.value)}
                                                placeholder="제목"
                                                className="w-full bg-transparent border-none px-0 py-0 text-[13px] font-black text-zinc-200 placeholder:text-zinc-700 focus:ring-0 outline-none truncate"
                                            />
                                            <label className="w-full aspect-square rounded-md border border-dashed border-zinc-700 hover:border-cyan-500/50 cursor-pointer flex items-center justify-center overflow-hidden transition-colors bg-zinc-950/50">
                                                {note.imageData ? (
                                                    <img src={note.imageData} alt="" className="w-full h-full object-cover rounded-md" />
                                                ) : (
                                                    <span className="text-zinc-700 text-[20px]">+</span>
                                                )}
                                                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleThumbnailImage(note.id, f); }} />
                                            </label>
                                            <div className="flex flex-col gap-0.5">
                                                {[1, 2].map(idx => (
                                                    <input
                                                        key={idx}
                                                        type="text"
                                                        value={note.memos[idx]}
                                                        onChange={(e) => handleThumbnailMemo(note.id, idx, e.target.value)}
                                                        placeholder={`메모 ${idx}`}
                                                        className="w-full bg-zinc-950/60 border border-zinc-800 rounded px-1.5 py-0.5 text-[12px] font-bold text-zinc-300 placeholder:text-zinc-700 focus:ring-1 focus:ring-cyan-500/30 outline-none leading-[20px]"
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                    <button onClick={handleAddThumbnailNote} className="flex items-center justify-center rounded-lg border border-dashed border-zinc-700 hover:border-cyan-500/50 hover:text-cyan-400 text-zinc-600 transition-all aspect-square" style={{ width: 'calc(100% / 6 - 7px)', minWidth: '140px' }}>
                                        <PlusCircleIcon className="w-5 h-5" />
                                    </button>
                                </div>
                        </div>
                    </div>
                </section>
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

            {/* 사이드바 포탈: 수동 발주 + 발주서 업로드 + 가구매 명단 */}
            {isCurrent && document.getElementById('manual-order-portal') && createPortal(
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
                            <select value={manualInput.companyName} onChange={e => setManualInput({...manualInput, companyName: e.target.value, productName: ''})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
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
                            <select value={manualInput.productName} onChange={e => setManualInput({...manualInput, productName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
                                <option value="">품목 선택</option>
                                {manualInput.companyName && pricingConfig[manualInput.companyName]?.products &&
                                    Object.entries(pricingConfig[manualInput.companyName].products).map(([key, p]: [string, any]) => (
                                        <option key={key} value={p.displayName || key}>{p.displayName || key} ({(Number(p.supplyPrice) || 0).toLocaleString()}원)</option>
                                    ))
                                }
                            </select>
                            <div className="flex gap-2">
                                <input type="number" placeholder="수량" value={manualInput.qty} onChange={e => setManualInput({...manualInput, qty: e.target.value})} className="w-14 bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                <button type="submit" className="flex-1 btn-accent rounded-xl text-xs">추가</button>
                            </div>
                        </div>
                        <input placeholder="메모 (배송메세지로 입력됨)" value={manualInput.memo} onChange={e => setManualInput({...manualInput, memo: e.target.value})} className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                    </form>
                    {manualOrders.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {manualOrders.map(o => {
                                const isSelected = selectedManualOrderIds.has(o.id);
                                return (
                                <div key={o.id} className={`px-2.5 py-1 rounded-lg border flex items-center gap-1.5 group animate-pop-in cursor-pointer transition-all ${isSelected ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-950 border-zinc-900 opacity-40'}`} onClick={() => handleToggleManualOrderSelection(o.id)}>
                                    <input type="checkbox" checked={isSelected} onChange={() => handleToggleManualOrderSelection(o.id)} onClick={e => e.stopPropagation()} className="w-3 h-3 accent-rose-500 cursor-pointer" />
                                    <span className="text-[10px] font-black text-rose-500">{o.companyName}</span>
                                    <span className="text-[10px] font-bold text-zinc-300">{o.recipientName}</span>
                                    <span className="text-[9px] text-zinc-600 truncate max-w-[60px]">{o.productName}</span>
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
                                <button onClick={clearMasterFile} className="text-zinc-700 hover:text-rose-500 p-1"><ArrowPathIcon className="w-3.5 h-3.5" /></button>
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
                                const isOk = diff === 0 && !hasUnclaimed;
                                return (
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
                                );
                            })()}
                        </div>
                    )}
                    {masterOrderFile && (
                        <div className="bg-zinc-950 p-2 rounded-2xl border border-dashed border-zinc-700 hover:border-rose-500/50 transition-all">
                            <input ref={batchFileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleBatchUpload(f); e.target.value = ''; } }} />
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
                                {fakeOrderAnalysis.inputLineCount > 0 && (
                                    <div className="flex gap-1 flex-wrap">
                                        <span className="bg-zinc-800 text-zinc-400 text-[11px] px-2 py-0.5 rounded-full animate-pop-in border border-zinc-700 font-black">
                                            총 {fakeOrderAnalysis.inputLineCount}명
                                        </span>
                                        <span className="bg-emerald-500 text-white text-[11px] px-2 py-0.5 rounded-full animate-pop-in font-black">
                                            매칭 {fakeOrderAnalysis.matched.length}
                                        </span>
                                        {fakeOrderAnalysis.missing.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[11px] px-2 py-0.5 rounded-full animate-pop-in font-black">
                                                미발견 {fakeOrderAnalysis.missing.length}
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
                        <textarea
                            value={fakeOrderInput} onChange={(e: any) => setFakeOrderInput(e.target.value)}
                            placeholder="예: 홍길동 20231010-00001"
                            className="w-full min-h-[80px] bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-[10px] font-mono text-zinc-300 focus:outline-none focus:border-rose-500/50 resize-none custom-scrollbar"
                        />
                        <div className="space-y-2">
                            {courierTemplates.length === 0 && (
                                <div className="text-center py-2 text-zinc-600 text-[9px] font-black border border-dashed border-zinc-800 rounded-xl cursor-pointer hover:border-pink-500/30 hover:text-pink-500 transition-colors" onClick={() => setShowTemplateManager(true)}>
                                    택배 양식을 먼저 추가해주세요
                                </div>
                            )}
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
                                    <div key={tmpl.id} className={`space-y-1.5 p-2 rounded-xl border ${cs.border} bg-zinc-950/40`}>
                                        <button
                                            onClick={() => handleCourierDownload(tmpl)}
                                            disabled={!masterOrderFile || fakeOrderAnalysis.inputNumbers.size === 0}
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
                                );
                            })}
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
                    <div className="flex items-center gap-2 mb-2">
                        <select
                            value={newExpense.company}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, company: e.target.value, productKey: '' }))}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-orange-500/50"
                        >
                            <option value="">업체 선택 (선택)</option>
                            {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <select
                            value={newExpense.productKey}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, productKey: e.target.value }))}
                            disabled={!newExpense.company}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-orange-500/50 disabled:opacity-40 flex-1"
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

                {/* 5) 반품 관리 */}
                <div className="glass-light p-4 rounded-2xl mb-3">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-violet-500/10 p-2 rounded-lg"><ArrowPathIcon className="w-4 h-4 text-violet-400" /></div>
                        <h3 className="text-zinc-200 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
                            반품 관리
                            {returns.length > 0 && (
                                <span className="bg-violet-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pop-in">
                                    {returns.length}건 · {returns.reduce((s, r) => s + r.totalMargin, 0).toLocaleString()}원
                                </span>
                            )}
                        </h3>
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                        <select
                            value={returnCompany}
                            onChange={(e) => { setReturnCompany(e.target.value); setReturnProductKey(''); }}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50"
                        >
                            <option value="">업체 선택</option>
                            {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <select
                            value={returnProductKey}
                            onChange={(e) => setReturnProductKey(e.target.value)}
                            disabled={!returnCompany}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-violet-500/50 disabled:opacity-40 flex-1"
                        >
                            <option value="">품목 선택</option>
                            {returnProducts.map(p => <option key={p.key} value={p.key}>{p.name} ({p.margin.toLocaleString()}원)</option>)}
                        </select>
                    </div>
                    <div className="flex items-center gap-2 mb-3">
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
                                        count: qty, marginPerUnit: p.margin, totalMargin: -(p.margin * qty), memo: returnMemo || undefined,
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
                                    company: returnCompany,
                                    productKey: returnProductKey,
                                    productName: p.name,
                                    count: qty,
                                    marginPerUnit: p.margin,
                                    totalMargin: -(p.margin * qty),
                                    memo: returnMemo || undefined,
                                }]);
                                setReturnProductKey('');
                                setReturnCount('1');
                                setReturnMemo('');
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
                    {returns.length > 0 && (
                        <div className="space-y-1.5">
                            {returns.map((ret, i) => (
                                <div key={i} className="flex items-center justify-between px-3 py-2 rounded-xl border bg-zinc-950/50 border-zinc-800/50">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400 border border-violet-500/30">
                                            {ret.company}
                                        </span>
                                        <span className="text-[10px] text-zinc-400">{ret.productName}</span>
                                        <span className="text-[10px] text-zinc-500">{ret.count}개</span>
                                        {ret.memo && <span className="text-[10px] text-zinc-600">{ret.memo}</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-mono font-bold text-violet-400">{ret.totalMargin.toLocaleString()}원</span>
                                        <button onClick={() => setReturns(prev => prev.filter((_, idx) => idx !== i))} className="text-zinc-700 hover:text-violet-400 transition-colors">
                                            <TrashIcon className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                            <div className="flex justify-end pt-2 pr-2">
                                <span className="text-[10px] font-black text-violet-400">
                                    총 반품: {returns.reduce((s, r) => s + r.totalMargin, 0).toLocaleString()}원
                                </span>
                            </div>
                        </div>
                    )}
                </div>
                </>,
                document.getElementById('manual-order-portal')!
            )}

            <div className="sticky top-0 z-30 rounded-2xl px-4 py-2.5 shadow-2xl backdrop-blur-2xl bg-zinc-950/70 border border-zinc-800/40">
                <div className="flex flex-wrap items-center gap-2">
                    <button onClick={handleDownloadMergedUploadInvoices} disabled={selectedSessionIds.size === 0} className="group flex items-center gap-2 bg-zinc-800/60 text-zinc-400 hover:text-white px-4 py-2 rounded-full text-[11px] font-bold tracking-wide transition-all duration-200 border border-zinc-700/30 hover:border-zinc-600 hover:bg-zinc-700/60 active:scale-95 disabled:opacity-25 disabled:cursor-not-allowed">
                        <BoltIcon className="w-3.5 h-3.5" /><span>송장 병합</span>{selectedSessionIds.size > 0 && <span className="bg-zinc-700/60 text-[10px] px-1.5 py-0.5 rounded-full">{selectedSessionIds.size}</span>}
                    </button>
                    <button onClick={handleDownloadDepositList} className="group flex items-center gap-2 bg-zinc-800/60 text-zinc-400 hover:text-white px-4 py-2 rounded-full text-[11px] font-bold tracking-wide transition-all duration-200 border border-zinc-700/30 hover:border-zinc-600 hover:bg-zinc-700/60 active:scale-95">
                        <ArrowDownTrayIcon className="w-3.5 h-3.5" /><span>입금목록</span>
                    </button>
                    <button onClick={handleDownloadWorkLog} className="group flex items-center gap-2 bg-zinc-800/60 text-zinc-400 hover:text-white px-4 py-2 rounded-full text-[11px] font-bold tracking-wide transition-all duration-200 border border-zinc-700/30 hover:border-zinc-600 hover:bg-zinc-700/60 active:scale-95">
                        <ClipboardDocumentCheckIcon className="w-3.5 h-3.5" /><span>업무일지</span>
                    </button>
                    <div className="flex flex-col items-end gap-1">
                        <button
                            onClick={handleSaveToSalesHistory}
                            disabled={saveStatus === 'saving'}
                            className={`group flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold tracking-wide transition-all duration-200 active:scale-95 border ${
                                saveStatus === 'success'
                                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                    : saveStatus === 'error'
                                    ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                    : saveStatus === 'saving'
                                    ? 'bg-zinc-800/60 text-zinc-500 border-zinc-700/30 cursor-wait'
                                    : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/30 hover:text-white hover:border-zinc-600 hover:bg-zinc-700/60'
                            }`}
                        >
                            <ChartBarIcon className="w-3.5 h-3.5" />
                            <span>{
                                saveStatus === 'saving' ? '저장 중...'
                                : saveStatus === 'success' ? '기록 완료!'
                                : saveStatus === 'error' ? '저장 실패'
                                : '기록하기'
                            }</span>
                        </button>
                        {saveStatus === 'error' && saveError && (
                            <span className="text-red-400 text-[10px] font-bold max-w-[200px] text-right">{saveError}</span>
                        )}
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
                        <div className="flex flex-wrap gap-2 mt-1">
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

            <section className="glass rounded-[1.8rem] overflow-hidden shadow-xl">
                <div className="p-6 border-b border-zinc-900 bg-zinc-900/40 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-800 p-2 rounded-xl border border-zinc-700"><BuildingStorefrontIcon className="w-5 h-5 text-rose-500" /></div>
                        <h2 className="text-xl font-black text-white tracking-tight uppercase">Workstation</h2>
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
                <div className="flex justify-end mb-2">
                    <button onClick={handleResetWorkstations} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black text-zinc-500 hover:text-rose-400 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-rose-500/30 rounded-lg transition-all" title="워크스테이션 초기화">
                        <ArrowPathIcon className="w-3.5 h-3.5" />
                        <span>워크스테이션 초기화</span>
                    </button>
                </div>
                {/* 업체별 발주 현황 요약 대시보드 */}
                {companySummaryData.length > 0 && (
                    <div className="mb-4 px-3">
                        <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/60 overflow-hidden">
                            {/* 헤더 */}
                            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60">
                                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">업체별 현황</span>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handleCopyOrderSummary(companySummaryData)}
                                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black text-zinc-400 hover:text-white bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700/30 hover:border-zinc-600 transition-all active:scale-95"
                                        title="엑셀용으로 복사"
                                    >
                                        <DocumentCheckIcon className="w-3 h-3" />
                                        <span>복사</span>
                                    </button>
                                    <button
                                        onClick={() => handleDownloadOrderSummary(companySummaryData)}
                                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black text-zinc-400 hover:text-white bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700/30 hover:border-zinc-600 transition-all active:scale-95"
                                        title="엑셀 다운로드"
                                    >
                                        <ArrowDownTrayIcon className="w-3 h-3" />
                                        <span>엑셀</span>
                                    </button>
                                </div>
                            </div>
                            {/* 컬럼 헤더 */}
                            <div className="grid items-center gap-2 px-3 py-1.5 border-b border-zinc-800/40" style={{ gridTemplateColumns: '20px 1fr 44px 110px 90px' }}>
                                <div />
                                <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">업체</span>
                                <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest text-right">건수</span>
                                <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest text-right">입금액</span>
                                <span className="text-[9px] font-black text-zinc-600 uppercase tracking-widest text-right">마진</span>
                            </div>
                            {/* 업체별 행 */}
                            <div className="divide-y divide-zinc-800/30">
                                {companySummaryData.map(r => {
                                    const isChecked = checkedCompanies.has(r.company);
                                    const firstSession = (companySessions[r.company] || []).find(s => (allOrderRows[s.id]?.length || 0) > 0);
                                    const isEditingDeposit = editingCell?.company === r.company && editingCell?.field === 'deposit';
                                    const isEditingMargin = editingCell?.company === r.company && editingCell?.field === 'margin';
                                    const hasDepositOverride = companyOverrides[r.company]?.deposit !== undefined;
                                    const hasMarginOverride = companyOverrides[r.company]?.margin !== undefined;
                                    return (
                                        <div key={r.company} className={`grid items-center gap-2 px-3 py-2 transition-all ${isChecked ? 'opacity-40' : 'hover:bg-zinc-800/20'}`} style={{ gridTemplateColumns: '20px 1fr 44px 110px 90px' }}>
                                            <input
                                                type="checkbox"
                                                checked={isChecked}
                                                onChange={() => setCheckedCompanies(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(r.company)) next.delete(r.company); else next.add(r.company);
                                                    return next;
                                                })}
                                                className="w-3.5 h-3.5 accent-rose-500 cursor-pointer"
                                            />
                                            <button
                                                onClick={() => firstSession && handleToastClick(firstSession.id)}
                                                className={`text-left text-[12px] font-black truncate transition-colors ${isChecked ? 'line-through text-zinc-600' : 'text-zinc-200 hover:text-white'}`}
                                                title="클릭하여 이동"
                                            >
                                                {r.company}
                                            </button>
                                            <span className={`text-right text-[10px] font-bold ${isChecked ? 'text-zinc-700' : 'text-zinc-500'}`}>{r.orderCount}</span>
                                            {/* 입금액 */}
                                            {isEditingDeposit ? (
                                                <input
                                                    type="number"
                                                    value={editingValue}
                                                    onChange={e => setEditingValue(e.target.value)}
                                                    onBlur={() => {
                                                        const val = parseInt(editingValue);
                                                        setCompanyOverrides(prev => ({ ...prev, [r.company]: { ...prev[r.company], deposit: isNaN(val) ? r.calculatedDeposit : val } }));
                                                        setEditingCell(null);
                                                    }}
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                                        if (e.key === 'Escape') setEditingCell(null);
                                                    }}
                                                    className="w-full text-right text-[11px] font-black text-white bg-zinc-800 border border-rose-500/50 rounded px-1 py-0.5 focus:outline-none"
                                                    autoFocus
                                                />
                                            ) : (
                                                <button
                                                    onClick={() => { setEditingCell({ company: r.company, field: 'deposit' }); setEditingValue(String(r.deposit)); }}
                                                    title="클릭하여 수정"
                                                    className={`text-right text-[11px] font-black w-full transition-colors hover:text-rose-400 ${isChecked ? 'text-zinc-700' : 'text-white'} ${hasDepositOverride ? 'underline decoration-dotted decoration-rose-400/60' : ''}`}
                                                >
                                                    {r.deposit.toLocaleString()}
                                                </button>
                                            )}
                                            {/* 마진 */}
                                            {isEditingMargin ? (
                                                <input
                                                    type="number"
                                                    value={editingValue}
                                                    onChange={e => setEditingValue(e.target.value)}
                                                    onBlur={() => {
                                                        const val = parseInt(editingValue);
                                                        setCompanyOverrides(prev => ({ ...prev, [r.company]: { ...prev[r.company], margin: isNaN(val) ? r.calculatedMargin : val } }));
                                                        setEditingCell(null);
                                                    }}
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                                        if (e.key === 'Escape') setEditingCell(null);
                                                    }}
                                                    className="w-full text-right text-[11px] font-black text-emerald-400 bg-zinc-800 border border-emerald-500/50 rounded px-1 py-0.5 focus:outline-none"
                                                    autoFocus
                                                />
                                            ) : (
                                                <button
                                                    onClick={() => { setEditingCell({ company: r.company, field: 'margin' }); setEditingValue(String(r.margin)); }}
                                                    title="클릭하여 수정"
                                                    className={`text-right text-[11px] font-black w-full transition-colors ${isChecked ? 'text-zinc-700' : r.margin > 0 ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-700 hover:text-zinc-500'} ${hasMarginOverride ? 'underline decoration-dotted decoration-emerald-400/60' : ''}`}
                                                >
                                                    {r.margin > 0 ? `+${r.margin.toLocaleString()}` : '—'}
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                                {/* 합계 행 */}
                                {companySummaryData.length > 1 && (() => {
                                    const totalOrders = companySummaryData.reduce((s, r) => s + r.orderCount, 0);
                                    const totalDeposit = companySummaryData.reduce((s, r) => s + r.deposit, 0);
                                    const totalMargin = companySummaryData.reduce((s, r) => s + r.margin, 0);
                                    return (
                                        <div className="grid items-center gap-2 px-3 py-2 bg-zinc-800/40 border-t border-zinc-700/40" style={{ gridTemplateColumns: '20px 1fr 44px 110px 90px' }}>
                                            <div />
                                            <span className="text-[11px] font-black text-zinc-300">합계</span>
                                            <span className="text-right text-[10px] font-bold text-zinc-400">{totalOrders}</span>
                                            <span className="text-right text-[11px] font-black text-white">{totalDeposit.toLocaleString()}</span>
                                            <span className="text-right text-[11px] font-black text-emerald-400">{totalMargin > 0 ? `+${totalMargin.toLocaleString()}` : '—'}</span>
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                )}
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
                                items={sortCompanies(Object.keys(pricingConfig))}
                                strategy={verticalListSortingStrategy}
                            >
                                {sortCompanies(Object.keys(pricingConfig)).map(company => (
                                    <SortableCompanyRow key={company} id={company}>
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
                                        return sessions.map((session, sIdx) => {
                                        const prevItems = sessions
                                            .slice(0, sIdx)
                                            .map(ps => ({ round: ps.round, summary: allItemSummaries[ps.id] || {} }))
                                            .filter(item => Object.keys(item.summary).length > 0);
                                        const sessionPlatform = session.round <= 1 ? masterPlatformName : (batchPlatforms[session.id] || '쿠팡');
                                        return workstationsReady ? (
                                            <CompanyWorkstationRow
                                                key={session.id} sessionId={session.id} companyName={company} roundNumber={session.round} isFirstSession={sIdx === 0} isLastSession={sIdx === (companySessions[company] || []).length - 1} pricingConfig={pricingConfig}
                                                vendorFiles={vendorFiles[company] || []} masterFile={masterOrderFile} batchFile={batchFiles[session.id] || null} isDetected={detectedCompanies.has(company)} fakeOrderNumbers={fakeOrderInput}
                                                manualOrders={sIdx === 0 ? manualOrders.filter(o => o.companyName === company) : []} isSelected={selectedSessionIds.has(session.id)} onSelectToggle={handleToggleSessionSelection}
                                                onVendorFileChange={(files) => handleVendorFileChange(company, files)} onResultUpdate={handleResultUpdate} onDataUpdate={handleDataUpdate}
                                                onAddSession={() => handleAddSession(company)} onRemoveSession={() => handleRemoveSession(company, session.id)} onAddAdjustment={handleAddCompanyAdjustment}
                                                onDownloadMergedOrder={(companySessions[company] || []).length > 1 ? () => handleDownloadMergedOrder(company) : undefined}
                                                onDownloadMergedInvoice={(companySessions[company] || []).length > 1 ? (type: 'mgmt' | 'upload') => handleDownloadMergedInvoice(company, type) : undefined}
                                                previousRoundItems={prevItems}
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
                                            />
                                        ) : null;
                                    });
                                    })()}
                                </SortableCompanyRow>
                            ))}
                            </SortableContext>
                        </table>
                    </DndContext>
                </div>
            </section>

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
