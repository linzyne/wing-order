import React from 'react';
import CompanySelector from './CompanySelector';
import PricingEditor from './PricingEditor';
import SalesTracker from './SalesTracker';
import { usePricingConfig, usePlatformConfigs } from '../hooks/useFirestore';

interface DynamicBusinessPanelProps {
  businessId: string;
  activeTab: string;
  isCurrentBusiness: boolean;
}

const DynamicBusinessPanel: React.FC<DynamicBusinessPanelProps> = ({ businessId, activeTab, isCurrentBusiness }) => {
  const { config, saveConfig, isLoading, configSource } = usePricingConfig(businessId);
  const { platformConfigs, savePlatformConfig } = usePlatformConfigs(businessId);

  if (isLoading) {
    return (
      <div style={{ display: isCurrentBusiness ? undefined : 'none' }}>
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          <span className="ml-3 text-zinc-500 text-sm font-bold">데이터 로딩 중...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: (activeTab === 'converter' && isCurrentBusiness) ? undefined : 'none' }}>
        <CompanySelector
          pricingConfig={config}
          onConfigChange={saveConfig}
          businessId={businessId}
          platformConfigs={platformConfigs}
          isActive={activeTab === 'converter' && isCurrentBusiness}
        />
      </div>
      <div style={{ display: (activeTab === 'pricing' && isCurrentBusiness) ? undefined : 'none' }}>
        <PricingEditor
          config={config}
          onConfigChange={saveConfig}
          businessId={businessId}
          platformConfigs={platformConfigs}
          onPlatformConfigsChange={savePlatformConfig}
        />
      </div>
      <div style={{ display: (activeTab === 'sales' && isCurrentBusiness) ? undefined : 'none' }}>
        <SalesTracker isActive={activeTab === 'sales' && isCurrentBusiness} businessId={businessId} />
      </div>
    </>
  );
};

export default DynamicBusinessPanel;
