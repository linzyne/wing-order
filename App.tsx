
import React, { useState, useEffect } from 'react';
import CompanySelector from './components/CompanySelector';
import PricingEditor from './components/PricingEditor';
import SalesTracker from './components/SalesTracker';
import TodoList from './components/TodoList';
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
      <div className="flex gap-4 py-4 animate-fade-in">
        <div className="w-full max-w-5xl">
          <header className="flex flex-col md:flex-row items-center justify-between mb-8 px-2 gap-4">
          <div className="flex items-center gap-5">
            <div className="bg-zinc-900 p-3 rounded-[1.2rem] shadow-2xl border border-zinc-800">
              <ChartBarIcon className="w-8 h-8 text-rose-500" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight">
                윙 <span className="text-rose-500">발주매니저</span>
              </h1>
              <p className="text-zinc-500 font-bold text-[10px] mt-0.5 uppercase tracking-wider">Automated Order Management</p>
            </div>
            <div className="flex items-center ml-4 p-1 bg-zinc-900 rounded-xl border border-zinc-800">
              {/* 하드코딩 사업자 */}
              {HARDCODED_OPTIONS.map(b => (
                <button
                  key={b.id}
                  onClick={() => handleBusinessChange(b.id)}
                  className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all ${
                    currentBusiness === b.id
                      ? 'text-white shadow-lg'
                      : 'text-zinc-500 hover:text-white'
                  }`}
                  style={currentBusiness === b.id ? { backgroundColor: b.id === '조에' ? '#f472b6' : '#f43f5e' } : {}}
                >
                  {b.label}
                </button>
              ))}
              {/* 동적 사업자 */}
              {dynamicBusinesses.map(b => (
                <div key={b.id} className="relative group">
                  <button
                    onClick={() => handleBusinessChange(b.id)}
                    className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all ${
                      currentBusiness === b.id
                        ? 'text-white shadow-lg'
                        : 'text-zinc-500 hover:text-white'
                    }`}
                    style={currentBusiness === b.id ? { backgroundColor: b.buttonColor || '#8b5cf6' } : {}}
                  >
                    {b.displayName}
                  </button>
                  <button
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteBusiness(b.id); }}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full items-center justify-center text-white hidden group-hover:flex"
                    title="사업자 삭제"
                  >
                    <span className="text-[8px] font-black">X</span>
                  </button>
                </div>
              ))}
              {/* 사업자 추가 버튼 */}
              <button
                onClick={() => setShowAddModal(true)}
                className="px-2 py-1.5 text-zinc-600 hover:text-zinc-300 transition-colors"
                title="사업자 추가"
              >
                <PlusCircleIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          <nav className="flex p-1.5 bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl">
            <button
              onClick={() => setActiveTab('converter')}
              className={`flex items-center gap-2 px-6 py-2.5 text-sm font-black rounded-xl transition-all ${
                activeTab === 'converter'
                  ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/20'
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              <WrenchScrewdriverIcon className="w-4 h-4" />
              <span>발주서/송장 관리</span>
            </button>
            <button
              onClick={() => setActiveTab('pricing')}
              className={`flex items-center gap-2 px-6 py-2.5 text-sm font-black rounded-xl transition-all ${
                activeTab === 'pricing'
                  ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/20'
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              <Cog6ToothIcon className="w-4 h-4" />
              <span>품목/업체 설정</span>
            </button>
            <button
              onClick={() => setActiveTab('sales')}
              className={`flex items-center gap-2 px-6 py-2.5 text-sm font-black rounded-xl transition-all ${
                activeTab === 'sales'
                  ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/20'
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              <ChartBarIcon className="w-4 h-4" />
              <span>매출현황</span>
            </button>
          </nav>
        </header>

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

          <footer className="text-center mt-12 text-zinc-600 font-bold text-xs pb-8">
            <p className="flex items-center justify-center gap-1">
              Made with <span className="text-rose-500">❤️</span> for Wing Business &copy; {new Date().getFullYear()}
            </p>
          </footer>
        </div>

        <div className="w-80 flex-shrink-0">
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
