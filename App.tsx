
import React, { useState, useEffect } from 'react';
import CompanySelector from './components/CompanySelector';
import PricingEditor from './components/PricingEditor';
import SalesTracker from './components/SalesTracker';
import TodoList from './components/TodoList';
import DynamicBusinessPanel from './components/DynamicBusinessPanel';
import AddBusinessModal from './components/AddBusinessModal';
import CoupangDownloader from './components/CoupangDownloader';
import { ChartBarIcon, WrenchScrewdriverIcon, Cog6ToothIcon, PlusCircleIcon, PencilIcon } from './components/icons';
import { usePricingConfig, usePlatformConfigs, useSharedSuppliers } from './hooks/useFirestore';
import { useBusinessList } from './hooks/useBusinessList';
import { migrateLocalStorageToFirestore, syncPricingFields } from './services/migration';
import type { BusinessId, HardcodedBusinessId } from './types';

const HARDCODED_OPTIONS: { id: HardcodedBusinessId; label: string }[] = [
  { id: '안군농원', label: '안군농원' },
  { id: '조에', label: '조에농원' },
];

const HARDCODED_IDS: string[] = HARDCODED_OPTIONS.map(b => b.id);

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState(() => {
    return localStorage.getItem('activeTab') || 'converter';
  });
  const [currentBusiness, setCurrentBusiness] = useState<BusinessId>(() => {
    const saved = localStorage.getItem('selectedBusiness');
    // 하드코딩 + 동적 사업자 모두 허용 (동적 사업자 존재 여부는 useEffect에서 검증)
    return saved || '안군농원';
  });
  const [showAddModal, setShowAddModal] = useState(false);
  const [salesRefreshTrigger, setSalesRefreshTrigger] = useState<{ date: string; n: number } | undefined>();
  const [quotaExceeded, setQuotaExceeded] = useState(false);

  useEffect(() => {
    const handler = () => setQuotaExceeded(true);
    window.addEventListener('firestore-quota-exceeded', handler);
    return () => window.removeEventListener('firestore-quota-exceeded', handler);
  }, []);

  const { businesses: allBusinesses, dynamicBusinesses, isLoading: businessListLoading, addBusiness, removeBusiness, updateBusiness } = useBusinessList();
  const [editingBusiness, setEditingBusiness] = useState<typeof allBusinesses[0] | null>(null);

  // 동적 사업자인지 판별
  const isDynamicBusiness = !HARDCODED_IDS.includes(currentBusiness);

  const handleTabChange = (tab: string) => {
    localStorage.setItem('activeTab', tab);
    setActiveTab(tab);
  };

  const handleBusinessChange = (newBusiness: BusinessId) => {
    if (newBusiness === currentBusiness) return;
    const label = allBusinesses.find(b => b.id === newBusiness)?.displayName || newBusiness;
    if (!window.confirm(`사업자를 "${label}"(으)로 전환하시겠습니까?`)) return;
    localStorage.setItem('selectedBusiness', newBusiness);
    setCurrentBusiness(newBusiness);
  };

  // 배너에서 사업자 클릭 시 confirm 없이 전환
  const handleSwitchFromBanner = (newBusiness: BusinessId) => {
    if (newBusiness === currentBusiness) return;
    localStorage.setItem('selectedBusiness', newBusiness);
    setCurrentBusiness(newBusiness);
  };

  const handleDeleteBusiness = async (businessId: string) => {
    if (!window.confirm(`"${allBusinesses.find(b => b.id === businessId)?.displayName}" 사업자를 삭제하시겠습니까?\n(Firestore 데이터는 보존됩니다)`)) return;
    await removeBusiness(businessId);
    // 삭제된 사업자가 현재 선택 중이면 안군농원으로 전환
    if (currentBusiness === businessId) {
      localStorage.setItem('selectedBusiness', '안군농원');
      setCurrentBusiness('안군농원');
    }
  };

  const sharedSuppliers = useSharedSuppliers();

  // 양쪽 하드코딩 사업자 설정을 동시에 로드 (사업자 전환 시 컴포넌트 파괴 방지)
  const pricing안군 = usePricingConfig('안군농원');
  const pricing조에 = usePricingConfig('조에');
  const platform안군 = usePlatformConfigs('안군농원');
  const platform조에 = usePlatformConfigs('조에');
  const dynamicIds = dynamicBusinesses.map((b: { id: string }) => b.id);

  const configMap: Record<HardcodedBusinessId, { pricing: typeof pricing안군; platform: typeof platform안군 }> = {
    '안군농원': { pricing: pricing안군, platform: platform안군 },
    '조에': { pricing: pricing조에, platform: platform조에 },
  };

  // 하드코딩 사업자가 선택된 경우에만 configMap 사용
  const activePricing = !isDynamicBusiness ? configMap[currentBusiness as HardcodedBusinessId].pricing : null;
  const activePlatform = !isDynamicBusiness ? configMap[currentBusiness as HardcodedBusinessId].platform : null;
  const pricingConfig = activePricing?.config;
  const saveConfig = activePricing?.saveConfig;
  const isLoading = activePricing?.isLoading ?? false;
  const configSource = activePricing?.configSource;
  const platformConfigs = activePlatform?.platformConfigs;
  const savePlatformConfig = activePlatform?.savePlatformConfig;

  const handleConfigChange = (newConfig: typeof pricingConfig) => {
    if (saveConfig && newConfig) saveConfig(newConfig);
  };

  useEffect(() => {
    migrateLocalStorageToFirestore().then((migrated) => {
      if (migrated) console.log('[App] localStorage → Firestore 마이그레이션 완료');
    });
    // 하드코딩 사업자만 syncPricingFields 실행
    if (!isDynamicBusiness) {
      syncPricingFields(currentBusiness);
    }
  }, [currentBusiness, isDynamicBusiness]);

  // 저장된 사업자가 삭제되었으면 안군농원으로 복귀
  // 단, 동적 사업자 목록이 비어있으면 아직 서버 데이터 미도착일 수 있으므로 건너뜀
  useEffect(() => {
    if (!businessListLoading && isDynamicBusiness && dynamicBusinesses.length > 0) {
      const exists = dynamicBusinesses.some(b => b.id === currentBusiness);
      if (!exists) {
        localStorage.setItem('selectedBusiness', '안군농원');
        setCurrentBusiness('안군농원');
      }
    }
  }, [businessListLoading, isDynamicBusiness, dynamicBusinesses, currentBusiness]);

  // 현재 사업자의 테마 색상
  const currentBusinessEntry = allBusinesses.find((b: { id: string }) => b.id === currentBusiness);
  const bgColor = currentBusinessEntry?.themeColor || '#09090b';

  // 하드코딩 사업자 로딩 중이거나, 동적 사업자 목록이 아직 로드되지 않은 상태에서 동적 사업자가 선택된 경우
  if ((isLoading && !isDynamicBusiness) || (isDynamicBusiness && businessListLoading)) {
    return (
      <div className="bg-zinc-950 min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-3 border-rose-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-500 font-bold text-sm">데이터 로딩 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-2 font-sans text-zinc-100 transition-colors duration-300" style={{ backgroundColor: bgColor }}>
      <div className="flex gap-3 py-4 animate-fade-in">
        <div className="flex-1 min-w-0 max-w-[calc(100%-42rem)] bg-zinc-800 rounded-2xl p-2 shadow-xl border border-zinc-700/40">
          <header className="flex flex-col md:flex-row items-center justify-between mb-8 px-2 gap-4">
          <div className="flex items-center gap-4">
            <div className="relative p-3 rounded-2xl bg-zinc-800/60 border border-zinc-700/40">
              <ChartBarIcon className="w-7 h-7 text-zinc-400" />
            </div>
            <h1 className="text-xl font-black text-white tracking-tight">
              윙
            </h1>
            <div className="flex items-center ml-3 gap-1.5">
              <select
                value={currentBusiness}
                onChange={(e) => handleBusinessChange(e.target.value as BusinessId)}
                className="bg-zinc-700 text-white text-[11px] font-black rounded-[10px] px-3 py-1.5 border-none outline-none cursor-pointer appearance-none pr-7"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2371717a' stroke-width='2.5'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='m19 9-7 7-7-7'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center', backgroundSize: '12px' }}
              >
                {HARDCODED_OPTIONS.map(b => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
                {dynamicBusinesses.map(b => (
                  <option key={b.id} value={b.id}>{b.displayName}</option>
                ))}
              </select>
              {isDynamicBusiness && (
                <>
                  <button
                    onClick={() => {
                      const entry = allBusinesses.find(b => b.id === currentBusiness);
                      if (entry) setEditingBusiness(entry);
                    }}
                    className="w-5 h-5 flex items-center justify-center bg-zinc-700 hover:bg-zinc-500 rounded-full text-zinc-400 hover:text-white transition-colors"
                    title="사업자 편집"
                  >
                    <PencilIcon className="w-2.5 h-2.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteBusiness(currentBusiness)}
                    className="w-5 h-5 flex items-center justify-center bg-zinc-700 hover:bg-red-500 rounded-full text-zinc-400 hover:text-white transition-colors text-[10px] font-black"
                    title="사업자 삭제"
                  >
                    ×
                  </button>
                </>
              )}
              <button
                onClick={() => setShowAddModal(true)}
                className="px-1.5 py-1.5 text-zinc-600 hover:text-zinc-400 transition-colors"
                title="사업자 추가"
              >
                <PlusCircleIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <nav className="flex p-1 glass rounded-2xl">
            <button
              onClick={() => handleTabChange('converter')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl whitespace-nowrap transition-all duration-200 ${
                activeTab === 'converter'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <WrenchScrewdriverIcon className="w-3.5 h-3.5" />
              <span>발주서/송장</span>
            </button>
            <button
              onClick={() => handleTabChange('pricing')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl whitespace-nowrap transition-all duration-200 ${
                activeTab === 'pricing'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <Cog6ToothIcon className="w-3.5 h-3.5" />
              <span>품목/업체</span>
            </button>
            <button
              onClick={() => handleTabChange('sales')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl whitespace-nowrap transition-all duration-200 ${
                activeTab === 'sales'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <ChartBarIcon className="w-3.5 h-3.5" />
              <span>매출현황</span>
            </button>
            <button
              onClick={() => handleTabChange('suppliers')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl whitespace-nowrap transition-all duration-200 ${
                activeTab === 'suppliers'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <Cog6ToothIcon className="w-3.5 h-3.5" />
              <span>업체</span>
            </button>
          </nav>
        </header>

        {!isDynamicBusiness && configSource === 'default' && (
          <div className="mb-4 px-4 py-3 bg-amber-900/30 border border-amber-500/30 rounded-xl text-amber-400 text-xs font-bold text-center">
            Firestore 연결 실패 - 기본 설정 사용 중 (브라우저 콘솔 확인)
          </div>
        )}

        <main className="w-full">
          {/* 쿠팡 주문서 다운로드 — converter 탭에서만 노출 */}
          {activeTab === 'converter' && (
            <CoupangDownloader businesses={allBusinesses.map(b => ({ id: b.id, displayName: b.displayName }))} />
          )}

          {/* 하드코딩 사업자: CompanySelector 인스턴스 유지 (전환 시 파괴되지 않음) */}
          {HARDCODED_OPTIONS.map(b => (
            <div key={b.id} style={{ display: (activeTab === 'converter' && currentBusiness === b.id) ? undefined : 'none' }}>
              <CompanySelector
                pricingConfig={configMap[b.id].pricing.config}
                onConfigChange={(newConfig) => configMap[b.id].pricing.saveConfig(newConfig)}
                businessId={b.id}
                platformConfigs={configMap[b.id].platform.platformConfigs}
                isActive={activeTab === 'converter' && currentBusiness === b.id}
                isCurrent={currentBusiness === b.id}
                onSaved={(date) => setSalesRefreshTrigger(prev => ({ date, n: (prev?.n ?? 0) + 1 }))}
              />
            </div>
          ))}
          {/* 공급업체 라이브러리 탭 (사업자 무관) */}
          <div style={{ display: activeTab === 'suppliers' ? undefined : 'none' }}>
            <PricingEditor
              config={sharedSuppliers.config}
              onConfigChange={sharedSuppliers.saveConfig}
              isLibraryMode
            />
          </div>

          {/* 하드코딩 사업자용 PricingEditor / SalesTracker */}
          {!isDynamicBusiness && pricingConfig && savePlatformConfig && (
            <>
              <div style={{ display: activeTab === 'pricing' ? undefined : 'none' }}>
                <PricingEditor
                  config={pricingConfig}
                  onConfigChange={handleConfigChange}
                  businessId={currentBusiness}
                  platformConfigs={platformConfigs!}
                  onPlatformConfigsChange={savePlatformConfig}
                  sharedSuppliers={sharedSuppliers.config}
                />
              </div>
              <div style={{ display: activeTab === 'sales' ? undefined : 'none' }}>
                <SalesTracker key={currentBusiness} isActive={activeTab === 'sales'} businessId={currentBusiness} refreshTrigger={salesRefreshTrigger} />
              </div>
            </>
          )}
          {/* 동적 사업자: DynamicBusinessPanel이 자체 hooks 관리 */}
          {dynamicBusinesses.map(b => (
            <DynamicBusinessPanel
              key={b.id}
              businessId={b.id}
              activeTab={activeTab}
              isCurrentBusiness={currentBusiness === b.id}
              sharedSuppliers={sharedSuppliers.config}
            />
          ))}
        </main>

          <footer className="text-center mt-16 pb-8">
            <p className="text-zinc-700 font-bold text-[10px] tracking-widest uppercase">
              Wing Business &copy; {new Date().getFullYear()}
            </p>
          </footer>
        </div>

        <div className="w-[18rem] flex-shrink-0 sticky top-2 self-start max-h-screen overflow-y-auto custom-scrollbar glass rounded-2xl p-2 shadow-xl">
          <div id="manual-order-portal" />
        </div>

        <div className="flex-1 min-w-[18rem] max-w-[22rem] flex-shrink-0 sticky top-2 self-start glass rounded-2xl p-2 shadow-xl">
          <TodoList businessId={currentBusiness} />
        </div>
      </div>

      {/* 사업자 추가 모달 */}
      <AddBusinessModal
        isOpen={showAddModal || !!editingBusiness}
        onClose={() => { setShowAddModal(false); setEditingBusiness(null); }}
        onAdd={addBusiness}
        onEdit={async (id, updates) => { await updateBusiness(id, updates); setEditingBusiness(null); }}
        existingIds={allBusinesses.map(b => b.id)}
        editingBusiness={editingBusiness ?? undefined}
      />

      {/* Firestore 한도 초과 팝업 */}
      {quotaExceeded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-zinc-900 border border-red-500/60 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl text-center">
            <div className="text-4xl mb-4">🚫</div>
            <h2 className="text-red-400 font-black text-lg mb-2">Firestore 일일 한도 초과</h2>
            <p className="text-zinc-300 text-sm leading-relaxed mb-1">
              오늘 사용 가능한 Firestore 읽기/쓰기 횟수를 모두 소진했어요.
            </p>
            <p className="text-zinc-500 text-xs leading-relaxed mb-6">
              자정(00:00)이 지나면 자동으로 초기화됩니다.
            </p>
            <button
              onClick={() => setQuotaExceeded(false)}
              className="px-6 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-xl text-zinc-200 text-sm font-bold transition-colors"
            >
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
