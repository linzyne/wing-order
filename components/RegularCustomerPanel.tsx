import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ManualOrder, PricingConfig } from '../types';
import { subscribeRegularCustomers, saveRegularCustomers, loadPricingConfig, loadDynamicBusinesses, appendRedirectedManualOrders, type RegularCustomer, type RegularRedirect } from '../services/firestoreService';
import { getBusinessInfo } from '../types';
import { TrashIcon, PencilIcon, UserGroupIcon } from './icons';

export type ServiceOrderDraft = Omit<ManualOrder, 'id'>;

interface Props {
    businessId?: string;
    businessName?: string;
    /** 오늘 업로드된 주문서 데이터 행 (쿠팡 원본 열 배치: [2]=주문번호, [10]=등록상품명, [11]=옵션, [22]=수량, [26]=수취인, [27]=전화, [29]=주소) */
    orderRows: any[][];
    pricingConfig: PricingConfig;
    manualOrders: ManualOrder[];
    onAddOrders: (orders: ServiceOrderDraft[]) => void;
    /** 대신 보내기로 이 사업자 발주서에서 뺄 주문 ("이름 주문번호" 줄들) */
    onRedirectedOrdersChange?: (text: string) => void;
}

interface RegularMatch {
    key: string;
    customer: RegularCustomer;
    orderNumber: string;
    recipientName: string;
    phone: string;
    address: string;
    deliveryMessage: string;
    products: { name: string; qty: number }[];
}

/** 이 사업자에서 들어온 단골 주문 중, 다른 사업자로 대신 보낼 것 */
interface RedirectPlan {
    match: RegularMatch;
    redirect: RegularRedirect;
    qty: number;
    redirectKey: string;
}

const keywordHit = (keyword: string | undefined, text: string) => {
    const k = String(keyword || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
    if (!k) return true;
    return String(text || '').normalize('NFC').replace(/\s+/g, '').toLowerCase().includes(k);
};

interface ServiceTarget {
    customerId: string;
    recipientName: string;
    phone: string;
    address: string;
}

const normName = (v: any) => String(v ?? '').normalize('NFC').replace(/[^가-힣a-zA-Z]/g, '').toLowerCase();
const normAddr = (v: any) => String(v ?? '').normalize('NFC').replace(/\([^)]*\)/g, '').replace(/[^가-힣a-zA-Z0-9]/g, '').toLowerCase();
const digits = (v: any) => String(v ?? '').replace(/\D/g, '');

// 시/도 표기는 주문서마다 제각각(서울 / 서울특별시, 경북 / 경상북도)이라 비교에서 뺀다
const PROVINCE_RE = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|충청북|충청남|전라북|전라남|경상북|경상남)(특별시|광역시|특별자치시|특별자치도|도)?$/;

/** 단골 주소의 각 토큰(시/도 제외)이 주문 주소에 들어있는지로 판정 — 띄어쓰기·괄호·시도 표기 차이 흡수 */
const addressMatches = (customerAddr: string, orderAddr: string): boolean => {
    const target = normAddr(orderAddr);
    if (!target) return false;
    const tokens = String(customerAddr || '').normalize('NFC').replace(/\([^)]*\)/g, ' ').split(/[\s,]+/)
        .map(normAddr).filter(t => t && !PROVINCE_RE.test(t));
    if (tokens.length === 0) return false;
    const hit = tokens.filter(t => target.includes(t)).length;
    // 토큰이 많으면(상세주소까지 적은 경우) 동·호수 표기 차이 정도는 봐준다
    return tokens.length >= 4 ? hit / tokens.length >= 0.8 : hit === tokens.length;
};

// 쿠팡 안심번호(050x)는 주문마다 바뀌어 단골 식별에 쓸 수 없다
const isSafeNumber = (d: string) => d.startsWith('050');

export const findRegularMatches = (customers: RegularCustomer[], rows: any[][]): RegularMatch[] => {
    if (customers.length === 0 || rows.length === 0) return [];
    const byName = new Map<string, RegularCustomer[]>();
    customers.forEach(c => {
        const n = normName(c.name);
        if (!n) return;
        byName.set(n, [...(byName.get(n) || []), c]);
    });
    const result = new Map<string, RegularMatch>();
    for (const row of rows) {
        if (!row) continue;
        const recipientName = String(row[26] ?? '').trim();
        const candidates = byName.get(normName(recipientName));
        if (!candidates) continue;
        const address = String(row[29] ?? '').trim();
        const phone = String(row[27] ?? '').trim();
        const phoneDigits = digits(phone);
        const customer = candidates.find(c => {
            const cPhone = digits(c.phone);
            if (cPhone && phoneDigits && !isSafeNumber(phoneDigits) && cPhone === phoneDigits) return true;
            return addressMatches(c.address, address);
        });
        if (!customer) continue;
        const orderNumber = String(row[2] ?? '').trim();
        const key = `${customer.id}|${orderNumber || normAddr(address)}`;
        const productName = String(row[10] ?? '').trim() || String(row[11] ?? '').trim();
        const option = String(row[10] ?? '').trim() ? String(row[11] ?? '').trim() : '';
        const qty = parseInt(String(row[22] ?? '1'), 10) || 1;
        const deliveryMessage = String(row[30] ?? '').trim();
        const existing = result.get(key) || { key, customer, orderNumber, recipientName, phone, address, deliveryMessage, products: [] };
        existing.products.push({ name: option ? `${productName} / ${option}` : productName, qty });
        result.set(key, existing);
    }
    return [...result.values()];
};

const todayStr = () => new Date().toLocaleDateString('en-CA');
const alertedStorageKey = (businessId?: string) => `wing:regularAlerted:${businessId || '안군농원'}`;

const loadAlerted = (businessId?: string): Set<string> => {
    try {
        const raw = localStorage.getItem(alertedStorageKey(businessId));
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return parsed?.date === todayStr() ? new Set(parsed.keys || []) : new Set();
    } catch { return new Set(); }
};

const saveAlerted = (businessId: string | undefined, keys: Set<string>) => {
    try { localStorage.setItem(alertedStorageKey(businessId), JSON.stringify({ date: todayStr(), keys: [...keys] })); } catch { /* 저장 불가 환경 무시 */ }
};

const inputCls = 'bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-amber-500/30 outline-none';

const RegularCustomerPanel: React.FC<Props> = ({ businessId, businessName, orderRows, pricingConfig, manualOrders, onAddOrders, onRedirectedOrdersChange }) => {
    const fromBizId = businessId || '안군농원';
    const bizName = (id: string) => getBusinessInfo(id)?.displayName || id;
    const [businesses, setBusinesses] = useState<{ id: string; displayName: string }[]>([]);
    const [customers, setCustomers] = useState<RegularCustomer[]>([]);
    const [form, setForm] = useState({ name: '', address: '', phone: '', memo: '' });
    const [editingId, setEditingId] = useState<string | null>(null);
    const [showAlert, setShowAlert] = useState(false);
    const [newKeys, setNewKeys] = useState<Set<string>>(new Set());
    const [serviceTarget, setServiceTarget] = useState<ServiceTarget | null>(null);
    const [serviceSel, setServiceSel] = useState<Record<string, string>>({}); // `${company}\u0000${productKey}` → 수량
    const [serviceSearch, setServiceSearch] = useState('');
    const [openCompanies, setOpenCompanies] = useState<Set<string>>(new Set());
    const [serviceMemo, setServiceMemo] = useState('');
    const alertedRef = useRef<Set<string>>(loadAlerted(businessId));

    useEffect(() => subscribeRegularCustomers(setCustomers), []);

    const persist = (next: RegularCustomer[]) => {
        setCustomers(next);
        saveRegularCustomers(next).catch(e => { console.error('[Firestore] 단골 저장 실패:', e); alert('단골 리스트 저장에 실패했습니다.'); });
    };

    const matches = useMemo(() => findRegularMatches(customers, orderRows), [customers, orderRows]);

    // ===== 대신 보내기 =====
    const redirectPlans = useMemo<RedirectPlan[]>(() => matches.flatMap(m => {
        const r = m.customer.redirect;
        if (!r || r.businessId === fromBizId || !m.orderNumber) return [];
        const hit = m.products.filter(p => keywordHit(r.keyword, p.name));
        if (hit.length === 0) return [];
        const orderQty = hit.reduce((sum, p) => sum + p.qty, 0);
        return [{ match: m, redirect: r, qty: orderQty * (r.qty || 1), redirectKey: `${fromBizId}|${m.orderNumber}` }];
    }), [matches, fromBizId]);
    const redirectByKey = useMemo(() => new Map(redirectPlans.map(p => [p.match.key, p])), [redirectPlans]);

    // 이 사업자 발주서에서 뺄 주문 (미발송 명단과 같은 방식)
    const redirectedText = useMemo(() => redirectPlans.map(p => `${p.match.recipientName} ${p.match.orderNumber}`).join('\n'), [redirectPlans]);
    useEffect(() => { onRedirectedOrdersChange?.(redirectedText); }, [redirectedText, onRedirectedOrdersChange]);

    // 대신 보낼 사업자의 수동발주에 넣기 (한 번 넣은 주문은 다시 안 넣음)
    const [redirectStatus, setRedirectStatus] = useState<Record<string, 'done' | 'error'>>({});
    const triedRedirectRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const todo = redirectPlans.filter(p => !triedRedirectRef.current.has(p.redirectKey));
        if (todo.length === 0) return;
        todo.forEach(p => triedRedirectRef.current.add(p.redirectKey));
        const byTarget = new Map<string, RedirectPlan[]>();
        todo.forEach(p => byTarget.set(p.redirect.businessId, [...(byTarget.get(p.redirect.businessId) || []), p]));
        byTarget.forEach((plans, target) => {
            const orders = plans.map(p => ({
                id: `mo-rd-${fromBizId}-${p.match.orderNumber}`,
                redirectKey: p.redirectKey,
                redirectFrom: businessName || fromBizId,
                companyName: p.redirect.companyName,
                recipientName: p.match.recipientName,
                phone: p.match.phone,
                address: p.match.address,
                productName: p.redirect.productName,
                productKey: p.redirect.productKey,
                qty: p.qty,
                memo: p.match.deliveryMessage,
            }));
            appendRedirectedManualOrders(target, orders)
                .then(() => setRedirectStatus(prev => { const n = { ...prev }; plans.forEach(p => { n[p.redirectKey] = 'done'; }); return n; }))
                .catch(e => {
                    console.error('[단골 대신 보내기] 실패:', e);
                    plans.forEach(p => triedRedirectRef.current.delete(p.redirectKey));
                    setRedirectStatus(prev => { const n = { ...prev }; plans.forEach(p => { n[p.redirectKey] = 'error'; }); return n; });
                    alert(`단골 대신 보내기 실패 — ${bizName(target)} 수동발주에 넣지 못했습니다. 새로고침 후 다시 확인해 주세요.`);
                });
        });
    }, [redirectPlans, fromBizId, businessName]);

    // 대신 보내기 설정창
    const [redirectEdit, setRedirectEdit] = useState<RegularCustomer | null>(null);
    const [rdBiz, setRdBiz] = useState('');
    const [rdConfig, setRdConfig] = useState<PricingConfig | null>(null);
    const [rdSel, setRdSel] = useState<{ company: string; key: string } | null>(null);
    const [rdQty, setRdQty] = useState('1');
    const [rdKeyword, setRdKeyword] = useState('');
    const [rdSearch, setRdSearch] = useState('');

    const openRedirect = (c: RegularCustomer) => {
        setRedirectEdit(c);
        setRdBiz(c.redirect?.businessId || '');
        setRdSel(c.redirect ? { company: c.redirect.companyName, key: c.redirect.productKey } : null);
        setRdQty(String(c.redirect?.qty || 1));
        setRdKeyword(c.redirect?.keyword || '');
        setRdSearch('');
        loadDynamicBusinesses().then(list => {
            const ids = [...new Set(['안군농원', '조에', ...list.map(b => b.id)])];
            setBusinesses(ids.map(id => ({ id, displayName: bizName(id) })));
        }).catch(() => setBusinesses([{ id: '안군농원', displayName: '안군농원' }, { id: '조에', displayName: '조에농원' }]));
    };
    useEffect(() => {
        if (!rdBiz) { setRdConfig(null); return; }
        let cancelled = false;
        setRdConfig(null);
        loadPricingConfig(rdBiz).then(({ config }) => { if (!cancelled) setRdConfig(config || {}); });
        return () => { cancelled = true; };
    }, [rdBiz]);
    const rdProducts = useMemo(() => {
        if (!rdConfig) return [] as { company: string; key: string; label: string }[];
        const q = rdSearch.trim().normalize('NFC').toLowerCase().replace(/\s+/g, '');
        return Object.keys(rdConfig).sort().flatMap(company =>
            Object.entries(rdConfig[company]?.products || {}).map(([key, p]: [string, any]) => ({ company, key, label: p?.orderFormName || p?.displayName || key })))
            .filter(x => !q || `${x.company}${x.label}${x.key}`.normalize('NFC').toLowerCase().replace(/\s+/g, '').includes(q));
    }, [rdConfig, rdSearch]);
    const saveRedirect = () => {
        if (!redirectEdit || !rdBiz || !rdSel || !rdConfig) return;
        const p = rdConfig[rdSel.company]?.products?.[rdSel.key] as any;
        const redirect: RegularRedirect = {
            businessId: rdBiz, companyName: rdSel.company, productKey: rdSel.key,
            productName: p?.orderFormName || p?.displayName || rdSel.key,
            qty: Math.max(1, parseInt(rdQty, 10) || 1),
            ...(rdKeyword.trim() ? { keyword: rdKeyword.trim() } : {}),
        };
        persist(customers.map(c => c.id === redirectEdit.id ? { ...c, redirect } : c));
        setRedirectEdit(null);
    };
    const clearRedirect = () => {
        if (!redirectEdit) return;
        persist(customers.map(c => {
            if (c.id !== redirectEdit.id) return c;
            const { redirect: _drop, ...rest } = c;
            return rest;
        }));
        setRedirectEdit(null);
    };

    // 새로 발견된 단골 주문이 있으면 알림
    useEffect(() => {
        const fresh = matches.filter(m => !alertedRef.current.has(m.key));
        if (fresh.length === 0) return;
        setNewKeys(new Set(fresh.map(m => m.key)));
        setShowAlert(true);
    }, [matches]);

    const closeAlert = () => {
        matches.forEach(m => alertedRef.current.add(m.key));
        saveAlerted(businessId, alertedRef.current);
        setNewKeys(new Set());
        setShowAlert(false);
    };

    const serviceCountFor = (customerId: string) => manualOrders.filter(o => o.regularCustomerId === customerId).length;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const name = form.name.trim();
        const address = form.address.trim();
        if (!name || !address) { alert('이름과 주소는 필수입니다.'); return; }
        const data = { name, address, phone: form.phone.trim(), memo: form.memo.trim() };
        if (editingId) {
            persist(customers.map(c => c.id === editingId ? { ...c, ...data } : c));
            setEditingId(null);
        } else {
            persist([...customers, { id: `rc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data }]);
        }
        setForm({ name: '', address: '', phone: '', memo: '' });
    };

    const startEdit = (c: RegularCustomer) => {
        setEditingId(c.id);
        setForm({ name: c.name, address: c.address, phone: c.phone || '', memo: c.memo || '' });
    };

    const remove = (c: RegularCustomer) => {
        if (!confirm(`단골 '${c.name}'을(를) 삭제할까요?`)) return;
        persist(customers.filter(x => x.id !== c.id));
        if (editingId === c.id) { setEditingId(null); setForm({ name: '', address: '', phone: '', memo: '' }); }
    };

    const openService = (target: ServiceTarget) => {
        setServiceTarget(target);
        setServiceSel({});
        setServiceSearch('');
        setServiceMemo('');
        setOpenCompanies(new Set());
    };

    const companies = useMemo(() => Object.keys(pricingConfig).sort(), [pricingConfig]);
    const productLabel = (p: any, key: string) => p?.orderFormName || p?.displayName || key;

    const filteredCompanies = useMemo(() => {
        const q = serviceSearch.trim().normalize('NFC').toLowerCase().replace(/\s+/g, '');
        return companies.map(company => {
            const products = Object.entries(pricingConfig[company]?.products || {});
            if (!q) return { company, products };
            const companyHit = company.toLowerCase().replace(/\s+/g, '').includes(q);
            const hits = products.filter(([key, p]: [string, any]) =>
                companyHit || [key, p?.displayName, p?.orderFormName].some(v => String(v || '').normalize('NFC').toLowerCase().replace(/\s+/g, '').includes(q)));
            return { company, products: hits };
        }).filter(c => c.products.length > 0);
    }, [companies, pricingConfig, serviceSearch]);

    const selKey = (company: string, key: string) => `${company}\u0000${key}`;
    const selectedEntries = (Object.entries(serviceSel) as [string, string][]).map(([k, qty]) => {
        const [company, key] = k.split('\u0000');
        return { company, key, qty };
    });

    const toggleProduct = (company: string, key: string) => {
        const k = selKey(company, key);
        setServiceSel(prev => {
            const next = { ...prev };
            if (k in next) delete next[k]; else next[k] = '1';
            return next;
        });
    };

    const handleAddService = () => {
        if (!serviceTarget || selectedEntries.length === 0) return;
        const drafts: ServiceOrderDraft[] = selectedEntries.map(({ company, key, qty }) => {
            const p = pricingConfig[company]?.products?.[key] as any;
            return {
                companyName: company,
                recipientName: serviceTarget.recipientName,
                phone: serviceTarget.phone,
                address: serviceTarget.address,
                productName: productLabel(p, key),
                productKey: key,
                qty: parseInt(qty, 10) || 1,
                memo: serviceMemo.trim(),
                regularCustomerId: serviceTarget.customerId,
            };
        });
        onAddOrders(drafts);
        alert(`${serviceTarget.recipientName}님 서비스 ${drafts.length}건을 수동 발주에 추가했습니다.\n(${[...new Set(drafts.map(d => d.companyName))].join(', ')})`);
        setServiceTarget(null);
    };

    const matchedCustomerIds = new Set(matches.map(m => m.customer.id));

    return (
        <>
            <details className="glass-light rounded-2xl mb-3 group/regular">
                <summary className="flex items-center justify-between gap-2 p-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/20 rounded-2xl transition-colors duration-200">
                    <h3 className="text-zinc-400 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
                        <div className="bg-amber-500/10 p-1 rounded-lg"><UserGroupIcon className="w-3.5 h-3.5 text-amber-400" /></div>
                        단골 관리
                        {customers.length > 0 && <span className="bg-zinc-700 text-zinc-200 text-[9px] px-1.5 py-0.5 rounded-full font-black">{customers.length}</span>}
                        {matches.length > 0 && <span className="bg-amber-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-black">오늘 {matches.length}건</span>}
                    </h3>
                    <span className="text-zinc-600 text-[10px] transition-transform group-open/regular:rotate-180">▼</span>
                </summary>
                <div className="px-4 pb-4">
                    {matches.length > 0 && (
                        <button type="button" onClick={() => setShowAlert(true)} className="w-full mb-3 px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] font-black hover:bg-amber-500/25 transition-all">
                            오늘 단골 주문 {matches.length}건 보기 · 서비스 추가
                        </button>
                    )}
                    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
                        <div className="grid grid-cols-2 gap-2">
                            <input placeholder="이름 *" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} />
                            <input placeholder="전화번호 (선택)" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className={inputCls} />
                        </div>
                        <input placeholder="주소 * (예: 경북 구미시 산동읍 신당로 12)" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className={inputCls} />
                        <div className="flex gap-2">
                            <input placeholder="메모 (선택)" value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })} className={`${inputCls} flex-1`} />
                            <button type="submit" className={`px-3 rounded-xl text-xs font-black text-white transition-all ${editingId ? 'bg-amber-500 hover:bg-amber-400' : 'bg-amber-600 hover:bg-amber-500'}`}>{editingId ? '수정' : '등록'}</button>
                            {editingId && <button type="button" onClick={() => { setEditingId(null); setForm({ name: '', address: '', phone: '', memo: '' }); }} className="px-2 text-[10px] font-black text-zinc-500 hover:text-zinc-300">취소</button>}
                        </div>
                        <p className="text-[9px] text-zinc-600">이름 + 주소(또는 전화번호)가 모두 맞아야 단골로 알림 · 모든 사업자 공통 리스트</p>
                    </form>
                    {customers.length > 0 && (
                        <div className="mt-3 flex flex-col gap-1 max-h-60 overflow-y-auto">
                            {customers.map(c => {
                                const today = matchedCustomerIds.has(c.id);
                                const svc = serviceCountFor(c.id);
                                return (
                                    <div key={c.id} className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 ${editingId === c.id ? 'bg-amber-900/30 border-amber-600/50' : today ? 'bg-amber-500/10 border-amber-500/40' : 'bg-zinc-900 border-zinc-800'}`}>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[11px] font-black text-zinc-200">{c.name}</span>
                                                {today && <span className="text-[8px] font-black text-white bg-amber-500 px-1 rounded">오늘 주문</span>}
                                                {svc > 0 && <span className="text-[8px] font-black text-emerald-300 bg-emerald-500/15 px-1 rounded">서비스 {svc}건</span>}
                                                {c.memo && <span className="text-[9px] text-zinc-500 truncate">{c.memo}</span>}
                                            </div>
                                            {c.redirect && (
                                                <div className="text-[9px] font-bold text-sky-300 truncate">↪ {bizName(c.redirect.businessId)} · {c.redirect.companyName} {c.redirect.productName} x{c.redirect.qty}{c.redirect.keyword ? ` ('${c.redirect.keyword}' 주문만)` : ''}</div>
                                            )}
                                            <div className="text-[9px] text-zinc-500 truncate" title={c.address}>{c.address}{c.phone ? ` · ${c.phone}` : ''}</div>
                                        </div>
                                        <button type="button" title="서비스 추가" onClick={() => openService({ customerId: c.id, recipientName: c.name, phone: c.phone || '', address: c.address })} className="px-1.5 py-0.5 rounded-md text-[9px] font-black text-amber-300 border border-amber-500/40 hover:bg-amber-500 hover:text-white transition-all whitespace-nowrap">서비스</button>
                                        <button type="button" title="다른 사업자에서 주문하면 이 사업자·품목으로 대신 보내기" onClick={() => openRedirect(c)} className={`px-1.5 py-0.5 rounded-md text-[9px] font-black border transition-all whitespace-nowrap ${c.redirect ? 'text-white bg-sky-600 border-sky-500' : 'text-sky-300 border-sky-500/40 hover:bg-sky-600 hover:text-white'}`}>대신</button>
                                        <button type="button" onClick={() => startEdit(c)} className="text-amber-500 hover:text-amber-300 transition-colors"><PencilIcon className="w-3 h-3" /></button>
                                        <button type="button" onClick={() => remove(c)} className="text-zinc-700 hover:text-rose-500 transition-colors"><TrashIcon className="w-3 h-3" /></button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </details>

            {showAlert && matches.length > 0 && createPortal(
                <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={closeAlert}>
                    <div className="w-full max-w-lg bg-zinc-950 border border-amber-500/50 rounded-2xl p-5 shadow-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="text-amber-300 font-black text-base mb-1">⭐ 단골 주문 발견{businessName ? ` — ${businessName}` : ''}</div>
                        <div className="text-zinc-500 text-[11px] mb-4">오늘 발주에 단골 고객 주문 {matches.length}건이 있습니다. 서비스를 보내려면 [서비스 추가]를 누르세요.</div>
                        <div className="flex flex-col gap-2 overflow-y-auto">
                            {matches.map(m => {
                                const svc = serviceCountFor(m.customer.id);
                                return (
                                    <div key={m.key} className={`rounded-xl border p-3 ${newKeys.has(m.key) ? 'border-amber-500/60 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900'}`}>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-black text-white">{m.recipientName}</span>
                                            {newKeys.has(m.key) && <span className="text-[9px] font-black text-white bg-amber-500 px-1.5 rounded">NEW</span>}
                                            {svc > 0 && <span className="text-[9px] font-black text-emerald-300 bg-emerald-500/15 px-1.5 rounded">서비스 {svc}건 추가됨</span>}
                                            <span className="flex-1" />
                                            <button type="button" onClick={() => openService({ customerId: m.customer.id, recipientName: m.recipientName, phone: m.phone, address: m.address })} className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-white text-[11px] font-black transition-all">서비스 추가</button>
                                        </div>
                                        {m.customer.memo && <div className="text-[10px] text-amber-200/70 mt-1">메모: {m.customer.memo}</div>}
                                        {(() => {
                                            const plan = redirectByKey.get(m.key);
                                            if (!plan) return null;
                                            const st = redirectStatus[plan.redirectKey];
                                            return (
                                                <div className="mt-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-200">
                                                    ↪ 이 사업자 발주서에서 빼고 <b>{bizName(plan.redirect.businessId)}</b> {plan.redirect.companyName} {plan.redirect.productName} x{plan.qty}로 대신 보냄
                                                    <span className={`ml-1 ${st === 'error' ? 'text-rose-400' : 'text-sky-400'}`}>{st === 'error' ? '(넘기기 실패)' : st === 'done' ? '(수동발주에 넣음)' : '(넣는 중…)'}</span>
                                                </div>
                                            );
                                        })()}
                                        <div className="text-[10px] text-zinc-500 mt-1">{m.address}{m.orderNumber ? ` · 주문번호 ${m.orderNumber}` : ''}</div>
                                        <div className="mt-1.5 flex flex-col gap-0.5">
                                            {m.products.map((p, i) => <div key={i} className="text-[11px] text-zinc-300">· {p.name} <span className="text-zinc-500">x{p.qty}</span></div>)}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <button type="button" onClick={closeAlert} className="mt-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-black transition-all">확인</button>
                    </div>
                </div>,
                document.body
            )}

            {serviceTarget && createPortal(
                <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }} onClick={() => setServiceTarget(null)}>
                    <div className="w-full max-w-xl bg-zinc-950 border border-zinc-700 rounded-2xl p-5 shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="text-white font-black text-base">서비스 추가 — {serviceTarget.recipientName}</div>
                        <div className="text-zinc-500 text-[11px] mb-3 truncate">{serviceTarget.address}{serviceTarget.phone ? ` · ${serviceTarget.phone}` : ''}</div>
                        <input autoFocus placeholder="업체/품목 검색" value={serviceSearch} onChange={e => setServiceSearch(e.target.value)} className={`${inputCls} mb-2`} />
                        <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 min-h-[200px]">
                            {filteredCompanies.length === 0 && <div className="text-zinc-600 text-xs p-3">검색 결과가 없습니다.</div>}
                            {filteredCompanies.map(({ company, products }) => {
                                const isOpen = openCompanies.has(company) || !!serviceSearch.trim();
                                const selCount = selectedEntries.filter(s => s.company === company).length;
                                return (
                                    <div key={company} className="rounded-xl border border-zinc-800 bg-zinc-900">
                                        <button type="button" onClick={() => setOpenCompanies(prev => { const n = new Set(prev); if (n.has(company)) n.delete(company); else n.add(company); return n; })} className="w-full flex items-center gap-2 px-3 py-2 text-left">
                                            <span className="text-xs font-black text-zinc-200">{company}</span>
                                            <span className="text-[10px] text-zinc-600">{products.length}개 품목</span>
                                            {selCount > 0 && <span className="text-[9px] font-black text-white bg-amber-500 px-1.5 rounded-full">{selCount}</span>}
                                            <span className="flex-1" />
                                            <span className={`text-zinc-600 text-[10px] transition-transform ${isOpen ? 'rotate-180' : ''}`}>▼</span>
                                        </button>
                                        {isOpen && (
                                            <div className="px-3 pb-2 flex flex-col gap-1">
                                                {products.map(([key, p]: [string, any]) => {
                                                    const k = selKey(company, key);
                                                    const checked = k in serviceSel;
                                                    return (
                                                        <label key={key} className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer ${checked ? 'bg-amber-500/15' : 'hover:bg-zinc-800'}`}>
                                                            <input type="checkbox" checked={checked} onChange={() => toggleProduct(company, key)} className="w-3.5 h-3.5 accent-amber-500" />
                                                            <span className="flex-1 text-[11px] font-bold text-zinc-300 truncate">{p?.displayName || key}{p?.orderFormName && p.orderFormName !== p.displayName ? ` → ${p.orderFormName}` : ''}</span>
                                                            <span className="text-[10px] text-zinc-500">{(Number(p?.supplyPrice) || 0).toLocaleString()}원</span>
                                                            {checked && (
                                                                <input type="number" min={1} value={serviceSel[k]} onChange={e => { const qty = e.target.value; setServiceSel(prev => ({ ...prev, [k]: qty })); }} className="w-12 bg-zinc-950 border border-zinc-700 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white outline-none" />
                                                            )}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <input placeholder="메모 (배송메세지로 입력됨, 선택)" value={serviceMemo} onChange={e => setServiceMemo(e.target.value)} className={`${inputCls} mt-3`} />
                        <div className="flex gap-2 mt-3">
                            <button type="button" disabled={selectedEntries.length === 0} onClick={handleAddService} className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-black transition-all">
                                서비스 추가{selectedEntries.length > 0 ? ` (${selectedEntries.length}건)` : ''}
                            </button>
                            <button type="button" onClick={() => setServiceTarget(null)} className="px-4 text-zinc-400 hover:text-zinc-200 text-xs font-black">취소</button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {redirectEdit && createPortal(
                <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }} onClick={() => setRedirectEdit(null)}>
                    <div className="w-full max-w-md bg-zinc-950 border border-sky-700/60 rounded-2xl p-5 shadow-2xl max-h-[90vh] flex flex-col gap-2" onClick={e => e.stopPropagation()}>
                        <div className="text-white font-black text-base">대신 보내기 — {redirectEdit.name}</div>
                        <div className="text-zinc-500 text-[11px]">이 단골이 <b>다른 사업자</b>에서 주문하면, 그 발주서에서 빼고 아래 사업자의 수동발주에 넣습니다.</div>
                        <select value={rdBiz} onChange={e => { setRdBiz(e.target.value); setRdSel(null); }} className={inputCls}>
                            <option value="">보낼 사업자 선택</option>
                            {businesses.map(b => <option key={b.id} value={b.id}>{b.displayName}</option>)}
                        </select>
                        {rdBiz && (
                            <>
                                <input placeholder="업체/품목 검색 (예: 나리찬)" value={rdSearch} onChange={e => setRdSearch(e.target.value)} className={inputCls} />
                                <div className="flex-1 overflow-y-auto min-h-[160px] max-h-[40vh] flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1.5">
                                    {!rdConfig && <div className="text-zinc-600 text-xs p-2">불러오는 중…</div>}
                                    {rdConfig && rdProducts.length === 0 && <div className="text-zinc-600 text-xs p-2">품목이 없습니다.</div>}
                                    {rdProducts.map(x => {
                                        const on = rdSel?.company === x.company && rdSel?.key === x.key;
                                        return (
                                            <button type="button" key={`${x.company}\u0000${x.key}`} onClick={() => setRdSel({ company: x.company, key: x.key })} className={`text-left px-2 py-1 rounded-lg text-[11px] font-bold ${on ? 'bg-sky-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}>
                                                <span className={on ? 'text-sky-100' : 'text-sky-400'}>{x.company}</span> · {x.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        <div className="flex gap-2">
                            <input type="number" min={1} value={rdQty} onChange={e => setRdQty(e.target.value)} title="주문 1개당 보낼 수량" className={`${inputCls} w-20`} />
                            <input placeholder="이 말이 든 주문만 (예: 김치, 비우면 전부)" value={rdKeyword} onChange={e => setRdKeyword(e.target.value)} className={`${inputCls} flex-1`} />
                        </div>
                        <div className="flex gap-2 mt-1">
                            <button type="button" disabled={!rdBiz || !rdSel || !rdConfig} onClick={saveRedirect} className="flex-1 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-black transition-all">저장</button>
                            {redirectEdit.redirect && <button type="button" onClick={clearRedirect} className="px-3 text-rose-400 hover:text-rose-300 text-xs font-black">해제</button>}
                            <button type="button" onClick={() => setRedirectEdit(null)} className="px-3 text-zinc-400 hover:text-zinc-200 text-xs font-black">취소</button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
};

export default RegularCustomerPanel;
