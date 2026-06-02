// Hermes Gateway 地址常量
// 必须与 scripts/hermes-backend.mjs 的 HERMES_GATEWAY_HOST / HERMES_GATEWAY_PORT 保持一致
export const GATEWAY_HOST = '127.0.0.1';
export const GATEWAY_PORT = 8642;
export const GATEWAY_WS_URL = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}/api/ws/extension`;
export const GATEWAY_HEALTH_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}/health`;
