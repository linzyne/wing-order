
import React, { useState, useEffect } from 'react';
import CompanySelector from './components/CompanySelector';
import PricingEditor from './components/PricingEditor';
import SalesTracker from './components/SalesTracker';
import TodoList from './components/TodoList';
import DashboardOverview from './components/DashboardOverview';
import OrderStatusBanner from './components/OrderStatusBanner';
import { ChartBarIcon, WrenchScrewdriverIcon, Cog6ToothIcon } from './components/icons';
import { usePricingConfig, usePlatformConfigs, useAllBusinessWorkspaces } from './hooks/useFirestore';
import { migrateLocalStorageToFirestore, syncPricingFields } from './services/migration';
import type { BusinessId } from './types';

const BUSINESS_OPTIONS: { id: BusinessId; label: string }[] = [
  { id: '안군농원', label: '안군농원' },
  { id: '조에', label: '조에농원' },
];

// 대시보드 아이콘
const HomeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
  </svg>
);

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [currentBusiness, setCurrentBusiness] = useState<BusinessId>(() => {
    const saved = localStorage.getItem('selectedBusiness');
    return (saved === '안군농원' || saved === '조에') ? saved : '안군농원';
  });

  const handleBusinessChange = (newBusiness: BusinessId) => {
    if (newBusiness === currentBusiness) return;
    if (!window.confirm(`사업자를 "${BUSINESS_OPTIONS.find(b => b.id === newBusiness)?.label}"(으)로 전환하시겠습니까?`)) return;
    localStorage.setItem('selectedBusiness', newBusiness);
    setCurrentBusiness(newBusiness);
  };

  // 대시보드에서 사업자 클릭 시 confirm 없이 바로 전환
  const handleNavigateFromDashboard = (newBusiness: BusinessId) => {
    localStorage.setItem('selectedBusiness', newBusiness);
    setCurrentBusiness(newBusiness);
    setActiveTab('converter');
  };

  // 배너에서 사업자 클릭 시 confirm 없이 전환
  const handleSwitchFromBanner = (newBusiness: BusinessId) => {
    if (newBusiness === currentBusiness) return;
    localStorage.setItem('selectedBusiness', newBusiness);
    setCurrentBusiness(newBusiness);
  };

  const { config: pricingConfig, saveConfig, isLoading, configSource } = usePricingConfig(currentBusiness);
  const { platformConfigs, savePlatformConfig } = usePlatformConfigs(currentBusiness);
  const { workspaces, isReady: workspacesReady } = useAllBusinessWorkspaces();

  const handleConfigChange = (newConfig: typeof pricingConfig) => {
    saveConfig(newConfig);
  };

  useEffect(() => {
    migrateLocalStorageToFirestore().then((migrated) => {
      if (migrated) console.log('[App] localStorage → Firestore 마이그레이션 완료');
    });
    syncPricingFields(currentBusiness);
  }, [currentBusiness]);

  if (isLoading) {
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
    <div className="bg-zinc-950 min-h-screen p-2 font-sans text-zinc-100">
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
            {activeTab !== 'dashboard' && (
              <div className="flex ml-4 p-1 bg-zinc-900 rounded-xl border border-zinc-800">
                {BUSINESS_OPTIONS.map(b => (
                  <button
                    key={b.id}
                    onClick={() => handleBusinessChange(b.id)}
                    className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all ${
                      currentBusiness === b.id
                        ? 'bg-rose-500 text-white shadow-lg'
                        : 'text-zinc-500 hover:text-white'
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <nav className="flex p-1.5 bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-black rounded-xl transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/20'
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              <HomeIcon className="w-4 h-4" />
              <span>대시보드</span>
            </button>
            <button
              onClick={() => setActiveTab('converter')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-black rounded-xl transition-all ${
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
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-black rounded-xl transition-all ${
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
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-black rounded-xl transition-all ${
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

        {/* 발주 미완료 경고 배너 (대시보드가 아닌 탭에서 표시) */}
        {activeTab !== 'dashboard' && (
          <OrderStatusBanner
            workspaces={workspaces}
            isReady={workspacesReady}
            currentBusiness={currentBusiness}
            onSwitchBusiness={handleSwitchFromBanner}
          />
        )}

        {configSource === 'default' && (
          <div className="mb-4 px-4 py-3 bg-amber-900/30 border border-amber-500/30 rounded-xl text-amber-400 text-xs font-bold text-center">
            Firestore 연결 실패 - 기본 설정 사용 중 (브라우저 콘솔 확인)
          </div>
        )}

        {/* 대시보드 탭 */}
        <div style={{ display: activeTab === 'dashboard' ? undefined : 'none' }}>
          <DashboardOverview
            workspaces={workspaces}
            isReady={workspacesReady}
            onNavigate={handleNavigateFromDashboard}
          />
        </div>

        <main className="w-full" key={currentBusiness}>
          <div style={{ display: activeTab === 'converter' ? undefined : 'none' }}>
            <CompanySelector pricingConfig={pricingConfig} onConfigChange={handleConfigChange} businessId={currentBusiness} platformConfigs={platformConfigs} />
          </div>
          <div style={{ display: activeTab === 'pricing' ? undefined : 'none' }}>
            <PricingEditor config={pricingConfig} onConfigChange={handleConfigChange} businessId={currentBusiness} platformConfigs={platformConfigs} onPlatformConfigsChange={savePlatformConfig} />
          </div>
          <div style={{ display: activeTab === 'sales' ? undefined : 'none' }}>
            <SalesTracker isActive={activeTab === 'sales'} businessId={currentBusiness} />
          </div>
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
    </div>
  );
};

export default App;
