import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';

export const options = {
  scenarios: {
    spike_shock: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        // 1. Baseline Reference (Normal steady state)
        { duration: '15s', target: 5 },
        { duration: '30s', target: 5 },
        // 2. Sudden Shock Surge (Instant 24x explosion within 10s)
        { duration: '10s', target: 120 },
        // 3. Peak Shock (Sustained extreme pressure beyond capacity)
        { duration: '45s', target: 120 },
        // 4. Instant Cliff Drop
        { duration: '10s', target: 5 },
        // 5. Cooldown & Recovery Phase (Measuring Time-to-Recovery and self-healing)
        { duration: '1m15s', target: 5 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // Generous thresholds during extreme 120 VU shock, testing that system survives and recovers
    http_req_failed: ['rate<0.20'],    // Max 20% error allowance during the sudden shock
    http_req_duration: ['p(95)<3000'], // Peak p95 latency allowance during shock
  },
};

export function setup() {
  const numUsers = 20;
  const users = [];
  const baseTimestamp = Date.now().toString().slice(-6);

  // 1. Provision user pool
  for (let i = 0; i < numUsers; i++) {
    const username = `spk_${baseTimestamp}_${i}`.slice(0, 28);
    const email = `${username}@example.com`;
    const password = 'SpikePassword123!';
    const displayName = `Spike User ${i}`;

    http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({
        username: username,
        email: email,
        password: password,
        display_name: displayName,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );

    const loginRes = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (loginRes.status === 200) {
      const token = loginRes.json('access_token');
      const meRes = http.get(`${BASE_URL}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const userId = meRes.status === 200 ? meRes.json('id') : null;

      if (userId && token) {
        users.push({
          id: userId,
          username: username,
          password: password,
          token: token,
        });
      }
    }
  }

  // 2. Select users[0] as the "Viral Celebrity" / Hotspot target
  const hotspotUser = users[0];

  // 3. Seed initial followers and posts
  for (let i = 0; i < users.length; i++) {
    const currentUser = users[i];
    const authHeaders = {
      headers: {
        Authorization: `Bearer ${currentUser.token}`,
        'Content-Type': 'application/json',
      },
    };

    const target1 = (i + 1) % users.length;
    http.post(`${BASE_URL}/api/v1/users/${users[target1].id}/follow`, null, authHeaders);

    http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({ content: `Initial spike test seed post from ${currentUser.username}` }),
      authHeaders
    );
  }

  return { users: users, hotspotId: hotspotUser ? hotspotUser.id : 1 };
}

export default function (data) {
  if (!data.users || data.users.length === 0) return;

  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  const roll = Math.random();

  // Vector 1: CPU & Event Loop Shock (25% of requests)
  // Sudden burst of heavy bcrypt password hash verification
  if (roll < 0.25) {
    const loginRes = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      `username=${encodeURIComponent(user.username)}&password=${encodeURIComponent(user.password)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    check(loginRes, {
      'spike: login processed': (r) => r.status === 200,
    });
  }
  // Vector 2: Cache Stampede / Thundering Herd (35% of requests)
  // Sudden wave of timeline reads while feeds are being invalidated
  else if (roll < 0.60) {
    const feedRes = http.get(`${BASE_URL}/api/v1/feed?page=1&page_size=20`, authHeaders);
    check(feedRes, {
      'spike: feed read': (r) => r.status === 200,
    });
  }
  // Vector 3: Hotspot Row-Locking Contention (15% of requests)
  // Hundreds of concurrent requests trying to follow the exact same viral account
  else if (roll < 0.75) {
    if (user.id !== data.hotspotId) {
      const followRes = http.post(`${BASE_URL}/api/v1/users/${data.hotspotId}/follow`, null, authHeaders);
      check(followRes, {
        'spike: hotspot follow': (r) => r.status === 204 || r.status === 400,
      });
    } else {
      const meRes = http.get(`${BASE_URL}/api/v1/users/me`, authHeaders);
      check(meRes, { 'spike: me': (r) => r.status === 200 });
    }
  }
  // Vector 4: Celery Broker Queue Flood (15% of requests)
  // Sudden burst of post publishing triggering async fan-out invalidations
  else if (roll < 0.90) {
    const postRes = http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({
        content: `Spike shock post from VU ${__VU} iter ${__ITER} at ${Date.now()}`,
      }),
      authHeaders
    );
    check(postRes, {
      'spike: create post': (r) => r.status === 201,
    });
  }
  // Vector 5: Distributed Lock Burst & Rate-Limit Defense (10% of requests)
  // Burst of match refresh requests competing for Redis locks
  else {
    const refreshRes = http.post(`${BASE_URL}/api/v1/matches/refresh`, null, authHeaders);
    check(refreshRes, {
      'spike: match refresh (202 or 429)': (r) => r.status === 202 || r.status === 429,
    });
  }

  // Very tight pacing during the spike to maintain aggressive sudden pressure
  sleep(Math.random() * 0.1 + 0.05);
}
