import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';
const SOAK_DURATION = __ENV.SOAK_DURATION || '30m';
const TARGET_VUS = parseInt(__ENV.SOAK_VUS || '25', 10);

function buildSoakStages() {
  // If a short duration (e.g., 1m or 2m) is passed for local sanity verification:
  if (SOAK_DURATION.endsWith('m') && parseInt(SOAK_DURATION, 10) <= 3) {
    const totalSec = parseInt(SOAK_DURATION, 10) * 60;
    return [
      { duration: '15s', target: TARGET_VUS },
      { duration: `${Math.max(15, totalSec - 30)}s`, target: TARGET_VUS },
      { duration: '15s', target: 0 },
    ];
  }

  // Standard longevity profile (gentle ramp, sustained soak, gentle ramp-down)
  return [
    { duration: '2m', target: TARGET_VUS },   // 2m gentle ramp
    { duration: SOAK_DURATION, target: TARGET_VUS }, // Sustained endurance window (default 30m)
    { duration: '2m', target: 0 },            // 2m gentle ramp-down
  ];
}

export const options = {
  scenarios: {
    soak_endurance: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: buildSoakStages(),
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Strict endurance thresholds: System must maintain low error rate and steady latency over hours
    http_req_failed: ['rate<0.005'],    // Less than 0.5% error rate across entire test
    http_req_duration: ['p(95)<400', 'p(99)<800'], // Assert zero upward latency drift
  },
};

export function setup() {
  const numUsers = 25;
  const users = [];
  const baseTimestamp = Date.now().toString().slice(-6);

  // 1. Provision persistent test user pool
  for (let i = 0; i < numUsers; i++) {
    const username = `sok_${baseTimestamp}_${i}`.slice(0, 28);
    const email = `${username}@example.com`;
    const password = 'SoakPassword123!';
    const displayName = `Soak User ${i}`;

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

  // 2. Establish cross-following network and seed initial posts
  for (let i = 0; i < users.length; i++) {
    const currentUser = users[i];
    const authHeaders = {
      headers: {
        Authorization: `Bearer ${currentUser.token}`,
        'Content-Type': 'application/json',
      },
    };

    const target1 = (i + 1) % users.length;
    const target2 = (i + 2) % users.length;

    http.post(`${BASE_URL}/api/v1/users/${users[target1].id}/follow`, null, authHeaders);
    http.post(`${BASE_URL}/api/v1/users/${users[target2].id}/follow`, null, authHeaders);

    http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({ content: `Initial soak test seed content from ${currentUser.username}` }),
      authHeaders
    );
  }

  return { users: users };
}

export default function (data) {
  if (!data.users || data.users.length === 0) return;

  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const otherUser = data.users[Math.floor(Math.random() * data.users.length)];

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  const actionRoll = Math.random();

  // 1. Reads (75% of traffic): Feed polling & profile lookups (monitoring cache hit stability & DB reads)
  if (actionRoll < 0.75) {
    if (Math.random() < 0.60) {
      // Timeline feed reads with variable pagination
      const page = Math.floor(Math.random() * 3) + 1;
      const feedRes = http.get(`${BASE_URL}/api/v1/feed?page=${page}&page_size=20`, authHeaders);
      check(feedRes, {
        'soak: get feed 200': (r) => r.status === 200,
      });
    } else if (Math.random() < 0.85) {
      // User profile retrieval (tests Redis user_key TTL and DB fallback)
      const profileRes = http.get(`${BASE_URL}/api/v1/users/${otherUser.id}`, authHeaders);
      check(profileRes, {
        'soak: get profile 200': (r) => r.status === 200,
      });
    } else {
      // Cached match retrieval
      const matchesRes = http.get(`${BASE_URL}/api/v1/matches`, authHeaders);
      check(matchesRes, {
        'soak: get matches 200': (r) => r.status === 200,
      });
    }
  }
  // 2. Writes (15% of traffic): Content generation & follow churn (inducing steady cache invalidations)
  else if (actionRoll < 0.90) {
    if (Math.random() < 0.65) {
      // Publish new post (bumps author feed version and enqueues follower fanout)
      const postRes = http.post(
        `${BASE_URL}/api/v1/posts`,
        JSON.stringify({
          content: `Endurance post from VU ${__VU} at ${new Date().toISOString()}`,
        }),
        authHeaders
      );
      check(postRes, {
        'soak: create post 201': (r) => r.status === 201,
      });
    } else if (user.id !== otherUser.id) {
      // Toggle follow/unfollow
      const isFollow = Math.random() < 0.5;
      if (isFollow) {
        const followRes = http.post(`${BASE_URL}/api/v1/users/${otherUser.id}/follow`, null, authHeaders);
        check(followRes, {
          'soak: follow': (r) => r.status === 204 || r.status === 400,
        });
      } else {
        const unfollowRes = http.del(`${BASE_URL}/api/v1/users/${otherUser.id}/follow`, null, authHeaders);
        check(unfollowRes, {
          'soak: unfollow': (r) => r.status === 204,
        });
      }
    }
  }
  // 3. Background Compute & Auth (10% of traffic): Login verifications & Celery matching tasks
  else {
    const subRoll = Math.random();
    if (subRoll < 0.50) {
      // Re-authenticate (tests bcrypt CPU and token generation over time)
      const loginRes = http.post(
        `${BASE_URL}/api/v1/auth/login`,
        `username=${encodeURIComponent(user.username)}&password=${encodeURIComponent(user.password)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      check(loginRes, {
        'soak: login 200': (r) => r.status === 200,
      });
    } else if (subRoll < 0.80) {
      // Update interests (enqueues Celery background Jaccard matching calculation)
      const interestSets = [
        ['endurance', 'stability', 'memory-leaks'],
        ['redis', 'postgres', 'fastapi', 'celery'],
        ['reliability', 'monitoring', 'grafana', 'k6'],
      ];
      const interests = interestSets[Math.floor(Math.random() * interestSets.length)];
      const patchRes = http.patch(
        `${BASE_URL}/api/v1/users/me`,
        JSON.stringify({ interests: interests }),
        authHeaders
      );
      check(patchRes, {
        'soak: patch interests 200': (r) => r.status === 200,
      });
    } else {
      // Trigger match refresh (tests 60s Redis lock and rate-limit shedding)
      const refreshRes = http.post(`${BASE_URL}/api/v1/matches/refresh`, null, authHeaders);
      check(refreshRes, {
        'soak: match refresh': (r) => r.status === 202 || r.status === 429,
      });
    }
  }

  // Realistic user pacing between 0.4s and 0.9s to maintain steady, continuous traffic
  sleep(Math.random() * 0.5 + 0.4);
}
