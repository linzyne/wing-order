
import React, { useState, useEffect } from 'react';
import CompanySelector from './components/CompanySelector';
import PricingEditor from './components/PricingEditor';
import SalesTracker from './components/SalesTracker';
import TodoList from './components/TodoList';
import QuestTimeline from './components/QuestTimeline';
import OrderStatusBanner from './components/OrderStatusBanner';
import DynamicBusinessPanel from './components/DynamicBusinessPanel';
import AddBusinessModal from './components/AddBusinessModal';
import { ChartBarIcon, WrenchScrewdriverIcon, Cog6ToothIcon, PlusCircleIcon } from './components/icons';
import { usePricingConfig, usePlatformConfigs, useAllBusinessWorkspaces } from './hooks/useFirestore';
import { useBusinessList } from './hooks/useBusinessList';
import { migrateLocalStorageToFirestore, syncPricingFields } from './services/migration';
import type { BusinessId, HardcodedBusinessId } from './types';

const HARDCODED_OPTIONS: { id: HardcodedBusinessId; label: string }[] = [
  { id: '안군농원', label: '안군농원' },
  { id: '조에', label: '조에농원' },
];

const HARDCODED_IDS: string[] = HARDCODED_OPTIONS.map(b => b.id);

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('converter');
  const [currentBusiness, setCurrentBusiness] = useState<BusinessId>(() => {
    const saved = localStorage.getItem('selectedBusiness');
    // 하드코딩 + 동적 사업자 모두 허용 (동적 사업자 존재 여부는 useEffect에서 검증)
    return saved || '안군농원';
  });
  const [showAddModal, setShowAddModal] = useState(false);

  const { businesses: allBusinesses, dynamicBusinesses, isLoading: businessListLoading, addBusiness, removeBusiness } = useBusinessList();

  // 동적 사업자인지 판별
  const isDynamicBusiness = !HARDCODED_IDS.includes(currentBusiness);

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

  // 양쪽 하드코딩 사업자 설정을 동시에 로드 (사업자 전환 시 컴포넌트 파괴 방지)
  const pricing안군 = usePricingConfig('안군농원');
  const pricing조에 = usePricingConfig('조에');
  const platform안군 = usePlatformConfigs('안군농원');
  const platform조에 = usePlatformConfigs('조에');
  const dynamicIds = dynamicBusinesses.map((b: { id: string }) => b.id);
  const { workspaces, isReady: workspacesReady } = useAllBusinessWorkspaces(dynamicIds);

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
  useEffect(() => {
    if (!businessListLoading && isDynamicBusiness) {
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
        <div className="flex-1 min-w-0">
          <header className="flex flex-col md:flex-row items-center justify-between mb-8 px-2 gap-4">
          <div className="flex items-center gap-4">
            <div className="relative p-3 rounded-2xl bg-gradient-to-br from-rose-500/20 to-rose-600/5 border border-rose-500/20">
              <ChartBarIcon className="w-7 h-7 text-rose-400" />
              <div className="absolute inset-0 rounded-2xl bg-rose-500/5 blur-xl" />
            </div>
            <div>
              <h1 className="text-xl font-black text-white tracking-tight">
                윙 <span className="bg-gradient-to-r from-rose-400 to-pink-500 bg-clip-text text-transparent">발주매니저</span>
              </h1>
              <p className="text-zinc-600 font-bold text-[9px] mt-0.5 uppercase tracking-[0.2em]">Order Management</p>
            </div>
            <div className="flex items-center ml-3 p-0.5 glass rounded-xl gap-0.5">
              {HARDCODED_OPTIONS.map(b => {
                const isActive = currentBusiness === b.id;
                const color = b.id === '조에' ? '#f472b6' : '#f43f5e';
                return (
                <button
                  key={b.id}
                  onClick={() => handleBusinessChange(b.id)}
                  className={`px-3 py-1.5 text-[11px] font-black rounded-[10px] transition-all duration-200 ${
                    isActive
                      ? 'text-white shadow-lg'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                  }`}
                  style={isActive ? { background: `linear-gradient(135deg, ${color}, ${color}dd)`, boxShadow: `0 4px 16px ${color}33` } : {}}
                >
                  {b.label}
                </button>
                );
              })}
              {dynamicBusinesses.map(b => {
                const isActive = currentBusiness === b.id;
                const color = b.buttonColor || '#8b5cf6';
                return (
                <div key={b.id} className="relative group">
                  <button
                    onClick={() => handleBusinessChange(b.id)}
                    className={`px-3 py-1.5 text-[11px] font-black rounded-[10px] transition-all duration-200 ${
                      isActive
                        ? 'text-white shadow-lg'
                        : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                    }`}
                    style={isActive ? { background: `linear-gradient(135deg, ${color}, ${color}dd)`, boxShadow: `0 4px 16px ${color}33` } : {}}
                  >
                    {b.displayName}
                  </button>
                  <button
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteBusiness(b.id); }}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-zinc-700 hover:bg-red-500 rounded-full items-center justify-center text-white hidden group-hover:flex transition-colors"
                    title="사업자 삭제"
                  >
                    <span className="text-[7px] font-black">×</span>
                  </button>
                </div>
                );
              })}
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
              onClick={() => setActiveTab('converter')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl transition-all duration-200 ${
                activeTab === 'converter'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <WrenchScrewdriverIcon className="w-3.5 h-3.5" />
              <span>발주서/송장</span>
            </button>
            <button
              onClick={() => setActiveTab('pricing')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl transition-all duration-200 ${
                activeTab === 'pricing'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <Cog6ToothIcon className="w-3.5 h-3.5" />
              <span>품목/업체</span>
            </button>
            <button
              onClick={() => setActiveTab('sales')}
              className={`flex items-center gap-2 px-5 py-2 text-[12px] font-black rounded-xl transition-all duration-200 ${
                activeTab === 'sales'
                  ? 'btn-accent'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40'
              }`}
            >
              <ChartBarIcon className="w-3.5 h-3.5" />
              <span>매출현황</span>
            </button>
          </nav>
        </header>

        {/* 게임형 퀘스트 타임라인 */}
        <QuestTimeline />

        {/* 발주 미완료 경고 배너 */}
        <OrderStatusBanner
          workspaces={workspaces}
          isReady={workspacesReady}
          currentBusiness={currentBusiness}
          onSwitchBusiness={handleSwitchFromBanner}
          allBusinesses={allBusinesses}
        />

        {!isDynamicBusiness && configSource === 'default' && (
          <div className="mb-4 px-4 py-3 bg-amber-900/30 border border-amber-500/30 rounded-xl text-amber-400 text-xs font-bold text-center">
            Firestore 연결 실패 - 기본 설정 사용 중 (브라우저 콘솔 확인)
          </div>
        )}

        <main className="w-full">
          {/* 하드코딩 사업자: CompanySelector 인스턴스 유지 (전환 시 파괴되지 않음) */}
          {HARDCODED_OPTIONS.map(b => (
            <div key={b.id} style={{ display: (activeTab === 'converter' && currentBusiness === b.id) ? undefined : 'none' }}>
              <CompanySelector
                pricingConfig={configMap[b.id].pricing.config}
                onConfigChange={(newConfig) => configMap[b.id].pricing.saveConfig(newConfig)}
                businessId={b.id}
                platformConfigs={configMap[b.id].platform.platformConfigs}
                isActive={activeTab === 'converter' && currentBusiness === b.id}
              />
            </div>
          ))}
          {/* 하드코딩 사업자용 PricingEditor / SalesTracker */}
          {!isDynamicBusiness && pricingConfig && savePlatformConfig && (
            <>
              <div style={{ display: activeTab === 'pricing' ? undefined : 'none' }}>
                <PricingEditor config={pricingConfig} onConfigChange={handleConfigChange} businessId={currentBusiness} platformConfigs={platformConfigs!} onPlatformConfigsChange={savePlatformConfig} />
              </div>
              <div style={{ display: activeTab === 'sales' ? undefined : 'none' }}>
                <SalesTracker isActive={activeTab === 'sales'} businessId={currentBusiness} />
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
            />
          ))}
        </main>

          <footer className="text-center mt-16 pb-8">
            <p className="text-zinc-700 font-bold text-[10px] tracking-widest uppercase">
              Wing Business &copy; {new Date().getFullYear()}
            </p>
          </footer>
        </div>

        <div className="w-64 flex-shrink-0 sticky top-2 self-start max-h-screen overflow-y-auto custom-scrollbar">
          <div id="manual-order-portal" />
        </div>

        <div className="w-72 flex-shrink-0 sticky top-2 self-start">
          <TodoList businessId={currentBusiness} />
        </div>
      </div>

      {/* 사업자 추가 모달 */}
      <AddBusinessModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={addBusiness}
        existingIds={allBusinesses.map(b => b.id)}
      />
    </div>
  );
};

export default App;
