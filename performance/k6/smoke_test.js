import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';

export const options = {
  vus: 2,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'], // Less than 1% errors
    http_req_duration: ['p(95)<300'], // 95% of requests within 300ms
  },
};

export function setup() {
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const username = `smoke_${uniqueId}`.slice(0, 28);
  const email = `${username}@example.com`;
  const password = 'SmokePassword123!';
  const displayName = `Smoke User ${uniqueId}`;

  // 1. Register a test user
  const registerPayload = JSON.stringify({
    username: username,
    email: email,
    password: password,
    display_name: displayName,
  });

  const registerRes = http.post(`${BASE_URL}/api/v1/auth/register`, registerPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(registerRes, {
    'setup register succeeded': (r) => r.status === 201,
  });

  // 2. Login to get JWT
  const loginBody = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, loginBody, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  check(loginRes, {
    'setup login succeeded': (r) => r.status === 200,
  });

  const tokenData = loginRes.json();
  const token = tokenData ? tokenData.access_token : null;

  if (!token) {
    throw new Error('Failed to obtain JWT bearer token in setup()');
  }

  return { token: token, username: username };
}

export default function (data) {
  const authHeaders = {
    headers: {
      Authorization: `Bearer ${data.token}`,
      'Content-Type': 'application/json',
    },
  };

  // 1. Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health check 200': (r) => r.status === 200,
    'health check reports ok': (r) => {
      try {
        return r.json().status === 'ok';
      } catch (e) {
        return false;
      }
    },
  });

  // 2. Read own profile
  const meRes = http.get(`${BASE_URL}/api/v1/users/me`, authHeaders);
  check(meRes, {
    'get /users/me 200': (r) => r.status === 200,
  });

  // 3. Create a post
  const postPayload = JSON.stringify({
    content: `Smoke test post from VU ${__VU} at ${new Date().toISOString()}`,
  });
  const createPostRes = http.post(`${BASE_URL}/api/v1/posts`, postPayload, authHeaders);
  check(createPostRes, {
    'create post 201': (r) => r.status === 201,
  });

  // 4. Retrieve feed
  const feedRes = http.get(`${BASE_URL}/api/v1/feed?page=1&page_size=10`, authHeaders);
  check(feedRes, {
    'get /feed 200': (r) => r.status === 200,
  });

  // 5. Query matches
  const matchesRes = http.get(`${BASE_URL}/api/v1/matches`, authHeaders);
  check(matchesRes, {
    'get /matches 200': (r) => r.status === 200,
  });

  sleep(1);
}
