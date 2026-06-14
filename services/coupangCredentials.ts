export interface WingCredentials {
  id: string;
  password: string;
}

export type DownloadMethod = 'api' | 'browser';

const PREFIX = 'wing_creds_';
const METHOD_PREFIX = 'wing_method_';

export function saveDownloadMethod(businessId: string, method: DownloadMethod): void {
  localStorage.setItem(METHOD_PREFIX + businessId, method);
}

export function loadDownloadMethod(businessId: string): DownloadMethod {
  return (localStorage.getItem(METHOD_PREFIX + businessId) as DownloadMethod) ?? 'browser';
}

export function saveWingCredentials(businessId: string, creds: WingCredentials): void {
  localStorage.setItem(PREFIX + businessId, JSON.stringify(creds));
}

export function loadWingCredentials(businessId: string): WingCredentials | null {
  const raw = localStorage.getItem(PREFIX + businessId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function deleteWingCredentials(businessId: string): void {
  localStorage.removeItem(PREFIX + businessId);
}
