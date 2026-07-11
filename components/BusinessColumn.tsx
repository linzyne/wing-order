import React, { useState, useEffect, useRef, useCallback } from 'react';
import CompanySelector from './CompanySelector';
import PricingEditor from './PricingEditor';
import SalesTracker from './SalesTracker';
import TodoList from './TodoList';
import { usePricingConfig, usePlatformConfigs, loadPricingBackup } from '../hooks/useFirestore';
import { WrenchScrewdriverIcon, Cog6ToothIcon, ChartBarIcon, ArrowDownTrayIcon, ClipboardDocumentCheckIcon, PencilIcon } from './icons';
import { syncPricingFields } from '../services/migration';
import type { PricingConfig, CompanyConfig } from '../types';

const HARDCODED_IDS = ['안군농원', '조에'];

interface MasterUploadHandlers { uploadMaster: (file: File) => Promise<void>; uploadBatch: (file: File) => Promise<void>; getNextRound: () => number; deleteBatchRound: (round: number) => boolean; clearMaster: () => void; downloadAllCompanies?: () => void; getCompanyClosed?: (companyName: string) => boolean; getCompanyRecorded?: (companyName: string) => boolean; toggleCompanyClosed?: (companyName: string) => void; toggleCompanyRecord?: (companyName: string) => void; setWorkDate?: (date: string) => void; getWorkDate?: () => string; uploadVendorInvoice?: (files: File[]) => void; getInvoiceState?: () => { name: string; uploadCount: number }[]; downloadInvoice?: (companyName: string) => void; getLastSettlementSummaries?: () => { companyName: string; kakaoText: string; excelText: string }[]; }

interface DownloadActions { downloadDepositList: () => void; downloadWorkLog: () => void; downloadDepositListWithExtra: (extraRows: { bankName: string; accountNumber: string; amount: string; label: string }[]) => void; getDepositBaseRows: () => any[][]; downloadDepositListDirect: (baseRows: any[][], extraRows: { bankName: string; accountNumber: string; amount: string; label: string }[]) => void; }

const BANK_URLS: Record<string, string> = {
  woori: 'https://nbi.wooribank.com/nbi/woori?withyou=BITRS0029',
  hana: 'https://biz.kebhana.com/index.jsp?pc',
};

const BANK_LABELS: Record<string, { label: string; color: string }> = {
  woori: { label: '우리', color: '#1d4ed8' },
  hana: { label: '하나', color: '#0f766e' },
};

interface BusinessColumnProps {
  businessId: string;
  displayName: string;
  portalId: string;
  themeColor?: string;
  bank?: string;
  sharedSuppliers?: PricingConfig;
  onSendToLibrary?: (companyName: string, companyConfig: CompanyConfig) => void;
  initiallyMounted?: boolean;
  refreshKey?: number;
  globalFakeOrderInput?: string;
  onGlobalFakeMatch?: (matched: string[]) => void;
  globalUnsentOrderInput?: string;
  onStatusUpdate?: (status: { litCount: number; downloadAll: () => void }) => void;
  onRegisterMasterUpload?: (businessId: string, handlers: MasterUploadHandlers) => void;
  onRegisterReset?: (businessId: string, fn: () => void) => void;
  onRegisterDownloadActions?: (businessId: string, actions: DownloadActions) => void;
  onWorkstationReset?: () => void;
  onEdit?: () => void;
  onExposeOrderRows?: (header: any[] | null, dataRows: any[][]) => void;
  onHasWarnings?: (has: boolean) => void;
}

const BusinessColumnContent: React.FC<BusinessColumnProps> = ({ businessId, displayName, portalId, themeColor, bank, sharedSuppliers, onSendToLibrary, onStatusUpdate, onRegisterMasterUpload, onRegisterReset, onRegisterDownloadActions, onWorkstationReset, globalFakeOrderInput, onGlobalFakeMatch, globalUnsentOrderInput, onEdit, onExposeOrderRows, onHasWarnings }) => {
  const [activeTab, setActiveTab] = useState('converter');
  const { config, saveConfig, isLoading, configSource } = usePricingConfig(businessId);
  const { platformConfigs, savePlatformConfig } = usePlatformConfigs(businessId);
  const [salesRefreshTrigger, setSalesRefreshTrigger] = useState<{ date: string; n: number } | undefined>();
  const [workstationRefreshTrigger, setWorkstationRefreshTrigger] = useState<{ date: string; n: number } | undefined>();
  const [actions, setActions] = useState<Partial<DownloadActions>>({});

  // 매출현황에서 기록을 지우거나 바꿨을 때 워크스테이션의 recordedCompanies도 재조회
  const handleCompanyRecordChanged = useCallback((date: string) => {
    setWorkstationRefreshTrigger(prev => ({ date, n: (prev?.n ?? 0) + 1 }));
  }, []);

  // 인라인 함수로 넘기면 매 렌더마다 새 참조 → CompanySelector useEffect 무한루프 발생
  // useCallback으로 안정화
  const handleRegisterActions = useCallback((a: DownloadActions) => {
    setActions(a);
    onRegisterDownloadActions?.(businessId, a);
  }, [onRegisterDownloadActions, businessId]);

  const handleRegisterMasterUpload = useCallback((handlers: any) => {
    onRegisterMasterUpload?.(businessId, handlers);
  }, [onRegisterMasterUpload, businessId]);

  const handleRegisterReset = useCallback((fn: () => void) => {
    onRegisterReset?.(businessId, fn);
  }, [onRegisterReset, businessId]);

  useEffect(() => {
    if (HARDCODED_IDS.includes(businessId)) syncPricingFields(businessId);
  }, [businessId]);

  const tabBtn = (tab: string, label: string, Icon: React.FC<{ className?: string }>) => (
    <button
      onClick={() => setActiveTab(tab)}
      className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl whitespace-nowrap transition-all duration-200 ${
        activeTab === tab ? 'btn-accent' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );

  const btnClass = 'flex items-center gap-1.5 bg-zinc-700/60 text-zinc-400 hover:text-white px-3 py-1.5 rounded-full text-[11px] font-bold transition-all duration-200 border border-zinc-700/30 hover:border-zinc-600 hover:bg-zinc-700 active:scale-95';

  return (
    <div className="flex gap-3 py-4 animate-fade-in" style={{ minHeight: '100%' }}>
      <div className="flex-1 min-w-0 bg-zinc-800 rounded-2xl p-2 shadow-xl border border-zinc-700/40 flex flex-col">
        {/* 스티키 헤더 */}
        <header className="sticky top-2 z-20 bg-zinc-800/95 backdrop-blur rounded-xl px-3 py-2 mb-6 flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {themeColor && themeColor !== '#09090b' && (
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: themeColor }} />
            )}
            <h2 className="text-base font-black text-white tracking-tight whitespace-nowrap">{displayName}</h2>
            {onEdit && (
              <button
                onClick={onEdit}
                className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white text-[10px] font-bold transition-colors border border-zinc-600"
                title="사업자 편집"
              >
                <PencilIcon className="w-2.5 h-2.5" />
                <span>편집</span>
              </button>
            )}
            {!HARDCODED_IDS.includes(businessId) && configSource === 'default' && (
              <span className="px-2 py-0.5 bg-amber-900/30 border border-amber-500/30 rounded-lg text-amber-400 text-[10px] font-bold">
                연결 실패
              </span>
            )}
            {configSource === 'default' && (() => {
              const backup = loadPricingBackup(businessId);
              if (!backup || Object.keys(backup.data).length === 0) return null;
              return (
                <button
                  onClick={() => {
                    if (!window.confirm(`${backup.savedAt.slice(0, 10)} 백업으로 복원할까요? (${Object.keys(backup.data).length}개 업체)`)) return;
                    saveConfig(backup.data);
                  }}
                  className="px-2 py-0.5 bg-rose-900/40 border border-rose-500/40 rounded-lg text-rose-400 text-[10px] font-bold hover:bg-rose-900/60 transition-colors"
                >
                  백업 복원 ({backup.savedAt.slice(0, 10)})
                </button>
              );
            })()}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* 항상 떠있는 액션 버튼 */}
            {activeTab === 'converter' && (
              <>
                <button onClick={() => actions.downloadDepositList?.()} className={btnClass}>
                  <ArrowDownTrayIcon className="w-3 h-3" /><span>입금목록</span>
                </button>
                {bank && BANK_URLS[bank] && (
                  <button
                    onClick={() => window.open(BANK_URLS[bank], '_blank')}
                    className={btnClass}
                    style={{ color: BANK_LABELS[bank]?.color, borderColor: `${BANK_LABELS[bank]?.color}55` }}
                    title={`${BANK_LABELS[bank]?.label}은행 대량이체`}
                  >
                    <span className="text-[10px] font-black">{BANK_LABELS[bank]?.label}</span>
                    <span>은행</span>
                  </button>
                )}
                <button onClick={() => actions.downloadWorkLog?.()} className={btnClass}>
                  <ClipboardDocumentCheckIcon className="w-3 h-3" /><span>업무일지</span>
                </button>
              </>
            )}
            <nav className="flex p-1 glass rounded-2xl">
              {tabBtn('converter', '발주서/송장', WrenchScrewdriverIcon)}
              {tabBtn('pricing', '품목/업체', Cog6ToothIcon)}
              {tabBtn('sales', '매출현황', ChartBarIcon)}
            </nav>
          </div>
        </header>

        <main className="w-full flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              <span className="ml-3 text-zinc-500 text-sm font-bold">데이터 로딩 중...</span>
            </div>
          ) : null}
          <div style={{ display: !isLoading && activeTab === 'converter' ? undefined : 'none' }}>
            <CompanySelector
              pricingConfig={config}
              onConfigChange={saveConfig}
              businessId={businessId}
              businessDisplayName={displayName}
              platformConfigs={platformConfigs}
              isActive={activeTab === 'converter'}
              isCurrent={true}
              portalId={portalId}
              onSaved={(date) => setSalesRefreshTrigger(prev => ({ date, n: (prev?.n ?? 0) + 1 }))}
              onStatusUpdate={onStatusUpdate}
              onRegisterActions={handleRegisterActions}
              onRegisterMasterUpload={onRegisterMasterUpload ? handleRegisterMasterUpload : undefined}
              onRegisterReset={onRegisterReset ? handleRegisterReset : undefined}
              onWorkstationReset={onWorkstationReset}
              globalFakeOrderInput={globalFakeOrderInput}
              onGlobalFakeMatch={onGlobalFakeMatch}
              globalUnsentOrderInput={globalUnsentOrderInput}
              isPricingConfigLoaded={!isLoading}
              onExposeOrderRows={onExposeOrderRows}
              onHasWarnings={onHasWarnings}
              externalRecordRefresh={workstationRefreshTrigger}
            />
          </div>
          <div style={{ display: !isLoading && activeTab === 'pricing' ? undefined : 'none' }}>
            <PricingEditor
              config={config}
              onConfigChange={saveConfig}
              businessId={businessId}
              platformConfigs={platformConfigs}
              onPlatformConfigsChange={savePlatformConfig}
              sharedSuppliers={sharedSuppliers}
              onSendToLibrary={onSendToLibrary}
            />
          </div>
          <div style={{ display: !isLoading && activeTab === 'sales' ? undefined : 'none' }}>
            <SalesTracker
              key={businessId}
              isActive={activeTab === 'sales'}
              businessId={businessId}
              refreshTrigger={salesRefreshTrigger}
              onCompanyRecordChanged={handleCompanyRecordChanged}
            />
          </div>
        </main>

        <footer className="text-center mt-16 pb-8">
          <p className="text-zinc-700 font-bold text-[10px] tracking-widest uppercase">
            Wing Business &copy; {new Date().getFullYear()}
          </p>
        </footer>
      </div>

      <div className="w-[18rem] flex-shrink-0 sticky top-2 self-start max-h-[calc(100vh-1rem)] overflow-y-auto custom-scrollbar glass rounded-2xl p-2 shadow-xl">
        <div id={portalId} />
      </div>

      <div className="flex-1 min-w-[18rem] max-w-[22rem] flex-shrink-0 sticky top-2 self-start glass rounded-2xl p-2 shadow-xl">
        <TodoList businessId={businessId} />
      </div>
    </div>
  );
};

const BusinessColumn: React.FC<BusinessColumnProps> = ({ initiallyMounted = false, refreshKey = 0, onEdit, ...props }) => {
  const [mounted, setMounted] = useState(initiallyMounted);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mounted) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setMounted(true); },
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100vw', flexShrink: 0, scrollSnapAlign: 'start', backgroundColor: props.themeColor || '#09090b' }}
      className="px-2 overflow-y-auto h-full"
    >
      {mounted
        ? <BusinessColumnContent key={refreshKey} onEdit={onEdit} {...props} />
        : (
          <div className="flex items-center justify-center min-h-screen">
            <div className="w-8 h-8 border-[3px] border-rose-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )
      }
    </div>
  );
};

export default BusinessColumn;
