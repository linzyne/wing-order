import React, { useState } from 'react';
import type { PricingConfig } from '../types';

const THEME_PRESETS = [
  { label: '다크 퍼플', themeColor: '#0f0a1a', buttonColor: '#8b5cf6' },
  { label: '다크 블루', themeColor: '#0a0f1a', buttonColor: '#3b82f6' },
  { label: '다크 그린', themeColor: '#0a1a0f', buttonColor: '#22c55e' },
  { label: '다크 오렌지', themeColor: '#1a130a', buttonColor: '#f97316' },
  { label: '다크 핑크', themeColor: '#1a0a13', buttonColor: '#ec4899' },
  { label: '다크 틸', themeColor: '#0a1a1a', buttonColor: '#14b8a6' },
];

interface AddBusinessModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (business: {
    id: string;
    displayName: string;
    shortName: string;
    senderName: string;
    phone: string;
    address: string;
    themeColor: string;
    buttonColor: string;
  }, initialConfig?: PricingConfig) => Promise<void>;
  existingIds: string[];
}

const AddBusinessModal: React.FC<AddBusinessModalProps> = ({ isOpen, onClose, onAdd, existingIds }) => {
  const [displayName, setDisplayName] = useState('');
  const [shortName, setShortName] = useState('');
  const [senderName, setSenderName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [selectedTheme, setSelectedTheme] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // 초기 업체 설정
  const [firstCompanyName, setFirstCompanyName] = useState('');
  const [firstProductName, setFirstProductName] = useState('');
  const [firstSupplyPrice, setFirstSupplyPrice] = useState('');

  if (!isOpen) return null;

  const resetForm = () => {
    setDisplayName('');
    setShortName('');
    setSenderName('');
    setPhone('');
    setAddress('');
    setSelectedTheme(0);
    setFirstCompanyName('');
    setFirstProductName('');
    setFirstSupplyPrice('');
    setError('');
  };

  const handleSubmit = async () => {
    if (!displayName.trim()) { setError('사업자명을 입력하세요.'); return; }
    if (!shortName.trim()) { setError('약칭을 입력하세요.'); return; }
    if (!senderName.trim()) { setError('보내는사람명을 입력하세요.'); return; }
    if (!phone.trim()) { setError('전화번호를 입력하세요.'); return; }

    const id = displayName.trim();
    if (existingIds.includes(id)) {
      setError('이미 존재하는 사업자명입니다.');
      return;
    }
    if (/[\/\\.#$\[\]]/.test(id) || id === '.' || id === '..') {
      setError('사업자명에 특수문자(/ \\ . # $ [ ])는 사용할 수 없습니다.');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const theme = THEME_PRESETS[selectedTheme];
      let initialConfig: PricingConfig | undefined;

      if (firstCompanyName.trim() && firstProductName.trim()) {
        initialConfig = {
          [firstCompanyName.trim()]: {
            products: {
              [firstProductName.trim()]: {
                supplyPrice: Number(firstSupplyPrice) || 0,
                displayName: firstProductName.trim(),
              }
            }
          }
        };
      }

      await onAdd({
        id,
        displayName: displayName.trim(),
        shortName: shortName.trim(),
        senderName: senderName.trim(),
        phone: phone.trim(),
        address: address.trim(),
        themeColor: theme.themeColor,
        buttonColor: theme.buttonColor,
      }, initialConfig);

      resetForm();
      onClose();
    } catch (e) {
      setError('추가 중 오류가 발생했습니다.');
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { resetForm(); onClose(); }}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-zinc-800">
          <h2 className="text-lg font-black text-white">사업자 추가</h2>
          <p className="text-xs text-zinc-500 mt-1">새로운 사업자 정보를 입력하세요.</p>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* 기본 정보 */}
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-bold text-zinc-400">사업자명 (표시용) *</span>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="예: 새농원"
                className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-bold text-zinc-400">약칭 (파일 접두사) *</span>
                <input
                  type="text"
                  value={shortName}
                  onChange={e => setShortName(e.target.value)}
                  placeholder="예: 새"
                  className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-zinc-400">보내는사람명 *</span>
                <input
                  type="text"
                  value={senderName}
                  onChange={e => setSenderName(e.target.value)}
                  placeholder="예: 새농원"
                  className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-bold text-zinc-400">전화번호 *</span>
                <input
                  type="text"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="예: 01012345678"
                  className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-zinc-400">주소</span>
                <input
                  type="text"
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  placeholder="예: 제주도"
                  className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </label>
            </div>
          </div>

          {/* 테마 색상 */}
          <div>
            <span className="text-xs font-bold text-zinc-400">테마 색상</span>
            <div className="flex gap-2 mt-2">
              {THEME_PRESETS.map((preset, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedTheme(i)}
                  className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border transition-all ${
                    selectedTheme === i ? 'border-white bg-zinc-800' : 'border-zinc-800 hover:border-zinc-600'
                  }`}
                >
                  <div className="flex gap-1">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: preset.themeColor, border: '1px solid #444' }} />
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: preset.buttonColor }} />
                  </div>
                  <span className="text-[9px] text-zinc-500">{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 초기 업체 설정 */}
          <div className="border-t border-zinc-800 pt-4">
            <span className="text-xs font-bold text-zinc-400">초기 업체(공급사) 설정 <span className="text-zinc-600">(선택사항)</span></span>
            <p className="text-[10px] text-zinc-600 mt-1 mb-3">나중에 "품목/업체 설정" 탭에서 추가할 수도 있습니다.</p>
            <div className="space-y-2">
              <input
                type="text"
                value={firstCompanyName}
                onChange={e => setFirstCompanyName(e.target.value)}
                placeholder="업체(공급사)명 - 예: 연두"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={firstProductName}
                  onChange={e => setFirstProductName(e.target.value)}
                  placeholder="품목명 - 예: 포기김치 3kg"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                />
                <input
                  type="text"
                  value={firstSupplyPrice}
                  onChange={e => setFirstSupplyPrice(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="공급가 - 예: 16300"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="text-red-400 text-xs font-bold bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-zinc-800 flex gap-3 justify-end">
          <button
            onClick={() => { resetForm(); onClose(); }}
            className="px-4 py-2 text-sm font-bold text-zinc-400 hover:text-white transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-5 py-2 text-sm font-black text-white rounded-lg transition-all disabled:opacity-50"
            style={{ backgroundColor: THEME_PRESETS[selectedTheme].buttonColor }}
          >
            {isSubmitting ? '추가 중...' : '사업자 추가'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddBusinessModal;
