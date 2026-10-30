// Runtime configuration read from the Vite .env files (see .env.example).
const e = import.meta.env;

export const env = {
  appEnv: e.VITE_APP_ENV || e.MODE,
  useMock: String(e.VITE_USE_MOCK ?? 'true') !== 'false',
  // false = never touch localStorage / sessionStorage (single-file demo build)
  persist: String(e.VITE_PERSIST ?? 'true') !== 'false',
  apiBaseUrl: e.VITE_API_BASE_URL || '',
  wsUrl: e.VITE_WS_URL || '',
  opcEndpoint: e.VITE_OPC_ENDPOINT || 'opc.tcp://ptct-opc01:4840',
  ldapDomain: e.VITE_LDAP_DOMAIN || 'PTCT',
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
  plant: 'PT Citra Tubindo Tbk · Batam',
};
