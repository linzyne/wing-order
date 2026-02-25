
import React, { useState, useEffect, useRef } from 'react';
import type { PricingConfig, CompanyConfig, ProductPricing } from '../types';
import {
    TrashIcon, PlusCircleIcon, DocumentArrowUpIcon, BuildingStorefrontIcon,
    PhoneIcon, ArrowsPointingOutIcon, ArrowsPointingInIcon, ArrowDownTrayIcon, ArrowUpTrayIcon,
    ChevronDownIcon, ChevronUpIcon
} from './icons';

declare var XLSX: any;

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
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 w-full max-w-lg shadow-2xl">
                {/* Fix: TypeScript error where message was missing on productEditor type variant */}
                <p className="text-xl font-black text-white mb-8 text-center">{dialog.message}</p>

                {dialog.type === 'prompt' && (
                    <input
                        autoFocus
                        type="text"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-4 text-white mb-8 focus:ring-2 focus:ring-rose-500/20 outline-none text-base"
                        placeholder={dialog.placeholder}
                        value={promptValue}
                        onChange={(e) => setPromptValue(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
                    />
                )}

                {dialog.type === 'productEditor' && (
                    <div className="space-y-6 mb-8 text-left">
                        <div>
                            <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">품목 명칭</label>
                            <input
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-4 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-base"
                                value={dialog.product.displayName}
                                onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, displayName: e.target.value } })}
                            />
                        </div>

                        <div className="grid grid-cols-3 gap-4">
                            <div>
                                <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">공급가</label>
                                <input
                                    type="number"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-base text-right"
                                    value={dialog.product.supplyPrice}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, supplyPrice: Number(e.target.value) } })}
                                />
                            </div>
                            <div>
                                <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">판매가</label>
                                <input
                                    type="number"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-base text-right"
                                    value={dialog.product.sellingPrice || 0}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, sellingPrice: Number(e.target.value) } })}
                                />
                            </div>
                            <div>
                                <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">마진</label>
                                <input
                                    type="number"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-base text-right"
                                    value={dialog.product.margin || 0}
                                    onChange={(e) => setDialog({ ...dialog, product: { ...dialog.product, margin: Number(e.target.value) } })}
                                />
                            </div>
                        </div>
                        <div>
                            <label className="text-[12px] font-black text-zinc-500 uppercase mb-2 block">매칭 키워드 (별칭)</label>
                            <textarea
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-4 text-white focus:ring-2 focus:ring-rose-500/20 outline-none text-sm resize-none"
                                rows={3}
                                placeholder="쉼표로 구분하여 입력 (예: 부사사과 2kg, 부사 사과 2kg내외)"
                                value={(dialog.product.aliases || []).join(', ')}
                                onChange={(e) => {
                                    const aliases = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                                    setDialog({ ...dialog, product: { ...dialog.product, aliases: aliases.length > 0 ? aliases : undefined } });
                                }}
                            />
                            <p className="text-[10px] text-zinc-600 mt-1.5">주문서 상품명에 이 키워드가 포함되면 해당 품목으로 자동 매칭됩니다</p>
                        </div>
                    </div>
                )}

                <div className="flex gap-4">
                    {(dialog.type === 'confirm' || dialog.type === 'prompt' || dialog.type === 'productEditor') && (
                        <button
                            onClick={() => dialog.onCancel()}
                            className="flex-1 px-6 py-4 bg-zinc-800 text-zinc-400 font-black rounded-xl hover:bg-zinc-700 transition-all text-base"
                        >
                            취소
                        </button>
                    )}
                    <button
                        onClick={handleConfirm}
                        className="flex-1 px-6 py-4 bg-rose-500 text-white font-black rounded-xl hover:bg-rose-600 shadow-lg shadow-rose-900/20 transition-all text-base"
                    >
                        확인
                    </button>
                </div>
            </div>
        </div >
    );
};

interface PricingEditorProps {
    config: PricingConfig;
    onConfigChange: (newConfig: PricingConfig) => void;
}

const PricingEditor: React.FC<PricingEditorProps> = ({ config, onConfigChange }) => {
    const [dialog, setDialog] = useState<DialogType>(null);
    const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>(() => {
        return Object.keys(config).reduce((acc, key) => ({ ...acc, [key]: true }), {});
    });
    const [isInfoExpanded, setIsInfoExpanded] = useState(false);

    const handleUpdate = (newConfig: PricingConfig) => onConfigChange(newConfig);

    const handleAddCompany = () => {
        setDialog({
            type: 'prompt',
            message: '새로운 그룹 이름을 지어주세요 🌸',
            placeholder: '예: 고랭지김치',
            onConfirm: (companyName) => {
                if (!companyName) return;
                const newConfig = { ...config };
                if (newConfig[companyName]) {
                    setDialog({ type: 'alert', message: '이미 있는 이름이에요! ✨', onConfirm: () => setDialog(null) });
                    return;
                }
                newConfig[companyName] = { phone: '', bankName: '', accountNumber: '', products: { '기본 품목': { displayName: '기본 품목', supplyPrice: 0 } } };
                handleUpdate(newConfig);
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
                const newConfig = { ...config };
                delete newConfig[companyName];
                handleUpdate(newConfig);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    const handleUpdateCompanyName = (oldName: string, newName: string) => {
        if (oldName === newName) return;
        if (config[newName]) {
            setDialog({ type: 'alert', message: '이미 있는 이름이에요! 🥺', onConfirm: () => setDialog(null) });
            handleUpdate({ ...config });
            return;
        }
        const newConfig = { ...config };
        newConfig[newName] = newConfig[oldName];
        delete newConfig[oldName];
        handleUpdate(newConfig);
    };

    const handleUpdatePhone = (companyName: string, phone: string) => {
        const newConfig = { ...config };
        newConfig[companyName].phone = phone;
        handleUpdate(newConfig);
    };

    const handleUpdateBank = (companyName: string, bank: string) => {
        const newConfig = { ...config };
        newConfig[companyName].bankName = bank;
        handleUpdate(newConfig);
    };

    const handleUpdateAccount = (companyName: string, account: string) => {
        const newConfig = { ...config };
        newConfig[companyName].accountNumber = account;
        handleUpdate(newConfig);
    };

    const handleAddProduct = (companyName: string) => {
        setDialog({
            type: 'prompt',
            message: `'${companyName}'에 추가할 품목 이름을 지어주세요! ✨`,
            placeholder: '예: 배추김치 5kg',
            onConfirm: (displayName) => {
                if (!displayName) return;
                const newConfig = { ...config };
                const productKey = displayName;
                if (newConfig[companyName].products[productKey]) {
                    setDialog({ type: 'alert', message: '이미 같은 품목이 있어요! ✨', onConfirm: () => setDialog(null) });
                    return;
                }
                newConfig[companyName].products[productKey] = { displayName, supplyPrice: 0 };
                handleUpdate(newConfig);
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
                const newConfig = { ...config };
                delete newConfig[companyName].products[productKey];
                handleUpdate(newConfig);
                setDialog(null);
            },
            onCancel: () => setDialog(null),
        });
    };

    const handleUpdateProduct = (companyName: string, productKey: string, newProduct: ProductPricing) => {
        const newConfig = JSON.parse(JSON.stringify(config));
        const newProductKey = newProduct.displayName;
        if (productKey === newProductKey) {
            newConfig[companyName].products[productKey] = newProduct;
        } else {
            if (newConfig[companyName].products[newProductKey]) {
                setDialog({ type: 'alert', message: '이미 존재하는 품목명입니다. 🥺', onConfirm: () => setDialog(null) });
                return;
            }
            delete newConfig[companyName].products[productKey];
            newConfig[companyName].products[newProductKey] = newProduct;
        }
        handleUpdate(newConfig);
    };

    const toggleCompany = (companyName: string) => setExpandedCompanies(prev => ({ ...prev, [companyName]: !prev[companyName] }));
    const expandAll = () => setExpandedCompanies(Object.keys(config).reduce((acc, key) => ({ ...acc, [key]: true }), {}));
    const collapseAll = () => setExpandedCompanies(Object.keys(config).reduce((acc, key) => ({ ...acc, [key]: false }), {}));

    const handleExport = () => {
        const dataStr = JSON.stringify(config, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        const exportFileDefaultName = `윙발주_백업_${new Date().toISOString().slice(0, 10)}.json`;
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
    };

    const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target?.result;
                if (typeof text === 'string') {
                    const importedConfig = JSON.parse(text);
                    if (typeof importedConfig === 'object' && importedConfig !== null) handleUpdate(importedConfig);
                    else throw new Error("파일 형식이 이상해요! 🥺");
                }
            } catch (err) {
                setDialog({ type: 'alert', message: `불러오기 실패: ${err instanceof Error ? err.message : '알 수 없는 오류'}`, onConfirm: () => setDialog(null) });
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    };

    return (
        <div className="space-y-8 pb-16">
            <div className="bg-zinc-900 rounded-[2.5rem] shadow-2xl border border-zinc-800 overflow-hidden">
                <div
                    className="flex justify-between items-center p-6 cursor-pointer bg-zinc-800/30"
                    onClick={() => setIsInfoExpanded(!isInfoExpanded)}
                >
                    <h3 className="font-black text-xl text-rose-500 flex items-center gap-4">
                        <span className="bg-zinc-950 p-3 rounded-full shadow-inner border border-zinc-800 text-base">💡</span>
                        업체 추가 안내
                    </h3>
                    {isInfoExpanded ? <ChevronUpIcon className="w-6 h-6 text-zinc-600" /> : <ChevronDownIcon className="w-6 h-6 text-zinc-600" />}
                </div>
                {isInfoExpanded && (
                    <div className="p-8 text-base font-medium space-y-8 animate-fade-in text-zinc-400 bg-zinc-950">
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="bg-zinc-900 p-8 rounded-[2rem] border border-zinc-800 shadow-inner">
                                <h4 className="font-black text-rose-400 mb-6 flex items-center gap-3 text-base">🌸 매핑 정보</h4>
                                <ul className="space-y-4 text-sm">
                                    <li className="flex justify-between border-b border-zinc-800 pb-2"><span>받는분</span> <span className="font-black text-rose-500">B열</span></li>
                                    <li className="flex justify-between border-b border-zinc-800 pb-2"><span>연락처</span> <span className="font-black text-rose-500">D열</span></li>
                                    <li className="flex justify-between border-b border-zinc-800 pb-2"><span>주소</span> <span className="font-black text-rose-500">C열</span></li>
                                    <li className="flex justify-between border-b border-zinc-800 pb-2"><span>품목</span> <span className="font-black text-rose-500">J열</span></li>
                                    <li className="flex justify-between border-b border-zinc-800 pb-2"><span>수량</span> <span className="font-black text-rose-500">K열</span></li>
                                </ul>
                            </div>
                            <div className="bg-zinc-900 p-8 rounded-[2rem] border border-zinc-800 shadow-inner">
                                <h4 className="font-black text-indigo-400 mb-6 flex items-center gap-3 text-base">🎀 고정 발송 정보</h4>
                                <ul className="space-y-5 text-sm">
                                    <li className="flex flex-col border-b border-zinc-800 pb-2">
                                        <span className="text-[12px] text-indigo-500 font-bold mb-1">연락처 (C열)</span>
                                        <span className="font-black text-zinc-100 text-base">070-5222-6543</span>
                                    </li>
                                    <li className="flex flex-col border-b border-zinc-800 pb-2">
                                        <span className="text-[12px] text-indigo-500 font-bold mb-1">주소 (F열)</span>
                                        <span className="font-black text-zinc-100 text-sm">강원 평창군 방림면 평창대로84-15</span>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="bg-zinc-900/50 p-5 rounded-full flex flex-wrap items-center justify-between gap-6 border border-zinc-800 shadow-2xl backdrop-blur-sm">
                <div className="flex gap-3">
                    <button onClick={expandAll} className="p-4 bg-zinc-800 hover:bg-zinc-700 rounded-full text-rose-400 transition-all shadow-lg border border-zinc-700"><ArrowsPointingOutIcon className="w-5 h-5" /></button>
                    <button onClick={collapseAll} className="p-4 bg-zinc-800 hover:bg-zinc-700 rounded-full text-rose-400 transition-all shadow-lg border border-zinc-700"><ArrowsPointingInIcon className="w-5 h-5" /></button>
                </div>
                <div className="flex gap-4">
                    <button onClick={handleExport} className="flex items-center gap-3 bg-zinc-800 text-zinc-300 font-black py-3.5 px-8 rounded-xl hover:bg-zinc-700 transition-all border border-zinc-700 shadow-lg text-sm">
                        <ArrowDownTrayIcon className="w-5 h-5" /><span>백업</span>
                    </button>
                    <label className="flex items-center gap-3 bg-zinc-800 text-indigo-400 font-black py-3.5 px-8 rounded-xl hover:bg-zinc-700 transition-all border border-zinc-700 shadow-lg text-sm cursor-pointer">
                        <ArrowUpTrayIcon className="w-5 h-5" />
                        <span>복원</span>
                        <input type="file" className="hidden" accept=".json" onChange={handleImport} />
                    </label>
                    <button onClick={handleAddCompany} className="flex items-center gap-3 bg-rose-500 text-white font-black py-3.5 px-10 rounded-xl hover:bg-rose-600 transition-all shadow-xl shadow-rose-900/30 text-sm">
                        <PlusCircleIcon className="w-6 h-6" /><span>새 그룹</span>
                    </button>
                </div>
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
                    {Object.entries(config).map(([companyName, companyConfig]) => (
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
                            onAddProduct={() => handleAddProduct(companyName)}
                            onDeleteProduct={(productKey) => handleDeleteProduct(companyName, productKey)}
                            onOpenProductEditor={(productKey, product) => setDialog({
                                type: 'productEditor',
                                /* Fix: provide message which was missing in original logic for this type variant */
                                message: '품목 정보 수정 ✍️',
                                companyName,
                                productKey,
                                product,
                                onConfirm: (originalProductKey, newProduct) => {
                                    handleUpdateProduct(companyName, originalProductKey, newProduct);
                                    setDialog(null);
                                },
                                onCancel: () => setDialog(null)
                            })}
                        />
                    ))}
                </div>
            )}

            {dialog && <Dialog dialog={dialog} setDialog={setDialog} />}
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
    onAddProduct: () => void;
    onDeleteProduct: (productKey: string) => void;
    onOpenProductEditor: (productKey: string, product: ProductPricing) => void;
}> = React.memo(({ companyName, companyConfig, isExpanded, onToggle, ...props }) => {
    return (
        <div className="bg-zinc-900 rounded-[2.5rem] shadow-2xl border border-zinc-800 overflow-hidden group">
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
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="flex items-center gap-4 bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                            <PhoneIcon className="w-5 h-5 text-zinc-600" />
                            <EditableField
                                value={companyConfig.phone || ''}
                                onSave={props.onUpdatePhone}
                                placeholder="연락처"
                                className="text-sm font-bold text-zinc-400 focus:outline-none"
                            />
                        </div>
                        <div className="flex items-center gap-4 bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                            <span className="text-lg">🏦</span>
                            <EditableField
                                value={companyConfig.bankName || ''}
                                onSave={props.onUpdateBank}
                                placeholder="은행명"
                                className="text-sm font-bold text-zinc-400 focus:outline-none"
                            />
                        </div>
                        <div className="flex items-center gap-4 bg-zinc-950 px-5 py-4 rounded-xl border border-zinc-800 shadow-inner">
                            <span className="text-lg">💳</span>
                            <EditableField
                                value={companyConfig.accountNumber || ''}
                                onSave={props.onUpdateAccount}
                                placeholder="계좌번호"
                                className="text-sm font-bold text-zinc-400 focus:outline-none"
                            />
                        </div>
                    </div>
                    <ProductTable products={companyConfig.products} onAddProduct={props.onAddProduct} onDeleteProduct={props.onDeleteProduct} onOpenProductEditor={props.onOpenProductEditor} />
                </div>
            )}
        </div>
    );
});

const ProductTable: React.FC<{
    products: { [key: string]: ProductPricing };
    onAddProduct: () => void;
    onDeleteProduct: (productKey: string) => void;
    onOpenProductEditor: (productKey: string, product: ProductPricing) => void;
}> = React.memo(({ products, onAddProduct, onDeleteProduct, onOpenProductEditor }) => (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <table className="w-full text-sm text-left">
            <thead className="bg-zinc-900/50 text-zinc-600 font-black uppercase tracking-widest text-[12px]">
                <tr>
                    <th className="px-4 py-2 w-[40%]">품목 명칭</th>
                    <th className="px-4 py-2 text-right w-[15%]">공급가</th>
                    <th className="px-4 py-2 text-right w-[15%]">판매가</th>
                    <th className="px-4 py-2 text-right w-[10%]">마진</th>
                    <th className="px-4 py-2 text-center w-[20%]">관리</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
                {Object.keys(products).map((productKey) => {
                    const product = products[productKey];
                    return (
                        <tr key={productKey} className="hover:bg-zinc-900/40 transition-colors">
                            <td className="px-4 py-2">
                                <div className="font-bold text-zinc-200 text-sm">{product.displayName}</div>
                                {product.aliases && product.aliases.length > 0 && (
                                    <div className="text-[10px] text-zinc-600 truncate max-w-xs">{product.aliases.join(', ')}</div>
                                )}
                            </td>
                            <td className="px-4 py-2 text-right font-black text-rose-500 text-sm">
                                {product.supplyPrice.toLocaleString()}원
                            </td>
                            <td className="px-4 py-2 text-right font-bold text-zinc-300 text-sm">
                                {(product.sellingPrice || 0).toLocaleString()}원
                            </td>
                            <td className="px-4 py-2 text-right font-bold text-emerald-400 text-sm">
                                {(product.margin || 0).toLocaleString()}원
                            </td>
                            <td className="px-4 py-2 text-center">
                                <div className="flex items-center justify-center gap-4">
                                    <button onClick={() => onOpenProductEditor(productKey, product)} className="text-indigo-400 hover:text-indigo-300 font-black text-[11px] underline underline-offset-2">상세</button>
                                    <button onClick={() => onDeleteProduct(productKey)} className="text-zinc-700 hover:text-red-500 transition-colors"><TrashIcon className="w-4 h-4" /></button>
                                </div>
                            </td>
                        </tr>
                    )
                })}
                <tr>
                    <td colSpan={5} className="p-0">
                        <button onClick={onAddProduct} className="w-full flex items-center justify-center gap-3 text-rose-400 bg-zinc-900/30 hover:bg-zinc-900/60 transition-all font-black py-6 text-base border-t border-zinc-900">
                            <PlusCircleIcon className="w-6 h-6" />
                            <span>새 품목 추가</span>
                        </button>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
));

export default PricingEditor;
