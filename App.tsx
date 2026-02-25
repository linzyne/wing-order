
import React, { useState, useEffect } from 'react';
import CompanySelector from './components/CompanySelector';
import PricingEditor from './components/PricingEditor';
import SalesTracker from './components/SalesTracker';
import { ChartBarIcon, WrenchScrewdriverIcon, Cog6ToothIcon } from './components/icons';
import { usePricingConfig } from './hooks/useFirestore';
import { migrateLocalStorageToFirestore } from './services/migration';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('converter');
  const { config: pricingConfig, saveConfig, isLoading } = usePricingConfig();

  const handleConfigChange = (newConfig: typeof pricingConfig) => {
    saveConfig(newConfig);
  };

  useEffect(() => {
    migrateLocalStorageToFirestore().then((migrated) => {
      if (migrated) console.log('[App] localStorage → Firestore 마이그레이션 완료');
    });
  }, []);

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
    <div className="bg-zinc-950 min-h-screen flex flex-col items-center p-2 font-sans text-zinc-100">
      <div className="w-full max-w-5xl mx-auto py-4 animate-fade-in">
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

        <main className="w-full">
          {activeTab === 'converter' && <CompanySelector pricingConfig={pricingConfig} />}
          {activeTab === 'pricing' && <PricingEditor config={pricingConfig} onConfigChange={handleConfigChange} />}
          {activeTab === 'sales' && <SalesTracker />}
        </main>
        
        <footer className="text-center mt-12 text-zinc-600 font-bold text-xs pb-8">
          <p className="flex items-center justify-center gap-1">
            Made with <span className="text-rose-500">❤️</span> for Wing Business &copy; {new Date().getFullYear()}
          </p>
        </footer>
      </div>
    </div>
  );
};

export default App;
