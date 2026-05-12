import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '30s', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
export default function () {
  const r = http.get(`${BASE}/`);
  check(r, { 'status 2xx': (res) => res.status >= 200 && res.status < 300 });
  sleep(1);
}
