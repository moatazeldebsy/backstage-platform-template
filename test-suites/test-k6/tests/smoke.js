import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1, duration: '30s',
  thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
export default function () {
  const r = http.get(`${BASE}/healthz`);
  check(r, { 'status 200': (res) => res.status === 200 });
  sleep(1);
}
