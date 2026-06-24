
import React from 'react';
import { ArrowDownTrayIcon } from './icons';

interface BusinessStatus {
    id: string;
    displayName: string;
    litCount: number;
}

interface QuickDownloadBarProps {
    businesses: BusinessStatus[];
    currentBusiness: string;
    onSwitch: (id: string) => void;
    onDownload: (id: string) => void;
}

const QuickDownloadBar: React.FC<QuickDownloadBarProps> = ({ businesses, currentBusiness, onSwitch, onDownload }) => {
    if (businesses.length <= 1) return null;

    return (
        <div className="flex items-center gap-2 px-2 pb-4 overflow-x-auto">
            {businesses.map(b => {
                const isCurrent = b.id === currentBusiness;
                const hasOrders = b.litCount > 0;
                return (
                    <div
                        key={b.id}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-black flex-shrink-0 transition-all ${
                            isCurrent
                                ? 'bg-zinc-700 border-zinc-500 text-white'
                                : 'bg-zinc-800/50 border-zinc-700/40 text-zinc-500'
                        }`}
                    >
                        <button
                            onClick={() => onSwitch(b.id)}
                            className={`transition-colors ${isCurrent ? 'text-white' : 'hover:text-zinc-200'}`}
                        >
                            {b.displayName}
                        </button>
                        {hasOrders && (
                            <>
                                <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse flex-shrink-0" />
                                <span className="text-orange-400">{b.litCount}</span>
                                <button
                                    onClick={() => onDownload(b.id)}
                                    className="text-orange-400 hover:text-orange-300 transition-colors"
                                    title={`${b.displayName} 발주서 다운로드`}
                                >
                                    <ArrowDownTrayIcon className="w-3 h-3" />
                                </button>
                            </>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default QuickDownloadBar;
