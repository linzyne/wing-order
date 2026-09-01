import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// 렌더 도중 에러가 나도 화면이 통째로 사라지지 않도록(=새까만 화면) 잡아서 안내
class ErrorBoundary extends React.Component<{ children?: React.ReactNode }, { error: Error | null }> {
  declare props: { children?: React.ReactNode };
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#09090b', color: '#e4e4e7', fontFamily: 'Pretendard, sans-serif', padding: 24 }}>
        <div style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
          <h1 style={{ fontSize: 18, fontWeight: 900, color: '#f87171', marginBottom: 8 }}>화면을 그리는 중 오류가 났어요</h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#a1a1aa', marginBottom: 16 }}>
            새로고침하면 대부분 복구됩니다. 계속 반복되면 아래 내용을 개발자에게 보내주세요.
          </p>
          <pre style={{ fontSize: 11, textAlign: 'left', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 12, padding: 12, overflow: 'auto', maxHeight: 240, color: '#d4d4d8' }}>
            {String(error.stack || error.message || error)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 24px', background: '#3f3f46', color: '#fff', border: 'none', borderRadius: 12, fontWeight: 700, cursor: 'pointer' }}
          >
            새로고침
          </button>
        </div>
      </div>
    );
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
