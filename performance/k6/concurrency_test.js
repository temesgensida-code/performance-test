import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL || 'http://api:8000';

export const options = {
  scenarios: {
    // 1. Distributed Lock Mutex Contention (POST /matches/refresh)
    lock_contention: {
      executor: 'constant-vus',
      vus: 8,
      duration: '30s',
      exec: 'testLockContention',
    },
    // 2. Unique Constraint Collision Race (POST /auth/register with identical credentials)
    registration_collision: {
      executor: 'constant-vus',
      vus: 6,
      duration: '30s',
      exec: 'testRegistrationRace',
    },
    // 3. Hotspot Row-Locking & Relationship Churn (POST/DELETE /users/{hotspot}/follow)
    hotspot_follow_contention: {
      executor: 'constant-vus',
      vus: 12,
      duration: '30s',
      exec: 'testHotspotFollow',
    },
    // 4. Cache Stampede & Feed Version Synchronization (POST /posts + GET /feed)
    cache_sync_feed: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      exec: 'testCacheSyncFeed',
    },
  },
  thresholds: {
    // Zero unexpected system failures under concurrency (429 and 409 are expected business logic)
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<400'], // Assert no serialization or lock wait stalls
  },
};

export function setup() {
  const numUsers = 12;
  const users = [];
  const baseTimestamp = Date.now().toString().slice(-6);

  // 1. Provision user pool
  for (let i = 0; i < numUsers; i++) {
    const username = `cnc_${baseTimestamp}_${i}`.slice(0, 28);
    const email = `${username}@example.com`;
    const password = 'ConcurrencyPassword123!';
    const displayName = `Concurrency User ${i}`;

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

  // Hotspot Celebrity Account
  const hotspotUser = users[0];
  // Target user for Distributed Lock Contention testing
  const lockTargetUser = users[1];

  // Seed initial posts
  for (let i = 0; i < users.length; i++) {
    http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({ content: `Initial concurrency seed post by ${users[i].username}` }),
      {
        headers: {
          Authorization: `Bearer ${users[i].token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  return {
    users: users,
    hotspotId: hotspotUser ? hotspotUser.id : 1,
    lockUserToken: lockTargetUser ? lockTargetUser.token : users[0].token,
    lockUserId: lockTargetUser ? lockTargetUser.id : users[0].id,
  };
}

// 1. Distributed Lock Mutex Contention
// Multiple parallel requests using the EXACT same user token hitting POST /matches/refresh
// Expected: Exactly one 202 Accepted per minute, all other concurrent attempts rejected with 429
export function testLockContention(data) {
  const authHeaders = {
    headers: {
      Authorization: `Bearer ${data.lockUserToken}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/matches/refresh`, null, authHeaders);

  // Both 202 (lock winner) and 429 (rate-limit shedder) are correct atomic outcomes
  check(res, {
    'lock: atomic 202 or 429 received': (r) => r.status === 202 || r.status === 429,
    'lock: no server error or 500': (r) => r.status !== 500,
  });

  sleep(0.1);
}

// 2. Unique Constraint Collision Race
// Concurrent registration attempts using identical credentials in the same time window
// Expected: Exactly one 201 Created commits, while concurrent duplicates safely rollback with 409 Conflict
export function testRegistrationRace() {
  // Each 5-second window shares an identical target username/email across all VUs
  const windowId = Math.floor(Date.now() / 5000);
  const targetUsername = `race_${windowId}`.slice(0, 28);
  const targetEmail = `${targetUsername}@example.com`;

  const payload = JSON.stringify({
    username: targetUsername,
    email: targetEmail,
    password: 'RacePassword123!',
    display_name: `Race User ${windowId}`,
  });

  const res = http.post(`${BASE_URL}/api/v1/auth/register`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'registration: atomic 201 or 409 received': (r) => r.status === 201 || r.status === 409,
    'registration: no unhandled 500 or deadlock': (r) => r.status !== 500,
  });

  sleep(0.2);
}

// 3. Hotspot Row-Locking & Relationship Churn
// Multiple concurrent VUs simultaneously toggling follow/unfollow on the same celebrity account
// Expected: Clean row-level locking on PostgreSQL Follow table without deadlocks (zero 500s)
export function testHotspotFollow(data) {
  if (!data.users || data.users.length === 0) return;
  const user = data.users[Math.floor(Math.random() * data.users.length)];

  if (user.id === data.hotspotId) {
    sleep(0.1);
    return;
  }

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  const isFollow = Math.random() < 0.5;
  if (isFollow) {
    const followRes = http.post(`${BASE_URL}/api/v1/users/${data.hotspotId}/follow`, null, authHeaders);
    check(followRes, {
      'hotspot follow: 204 or 400 clean response': (r) => r.status === 204 || r.status === 400,
      'hotspot follow: no deadlock 500': (r) => r.status !== 500,
    });
  } else {
    const unfollowRes = http.del(`${BASE_URL}/api/v1/users/${data.hotspotId}/follow`, null, authHeaders);
    check(unfollowRes, {
      'hotspot unfollow: 204 clean response': (r) => r.status === 204,
      'hotspot unfollow: no deadlock 500': (r) => r.status !== 500,
    });
  }

  sleep(0.1);
}

// 4. Cache Stampede & Feed Version Synchronization
// Concurrent writers publishing posts while readers continuously fetch feed pages
// Expected: Atomic feed version bumping in Redis, consistent pagination, zero corrupted cache entries
export function testCacheSyncFeed(data) {
  if (!data.users || data.users.length === 0) return;
  const user = data.users[Math.floor(Math.random() * data.users.length)];

  const authHeaders = {
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
  };

  if (Math.random() < 0.35) {
    // Writer: Post creation (triggers Redis INCR feedver + Celery fanout)
    const postRes = http.post(
      `${BASE_URL}/api/v1/posts`,
      JSON.stringify({
        content: `Concurrent sync post from VU ${__VU} at ${Date.now()}`,
      }),
      authHeaders
    );
    check(postRes, {
      'cache sync: post created 201': (r) => r.status === 201,
    });
  } else {
    // Reader: Timeline retrieval under active cache invalidations
    const feedRes = http.get(`${BASE_URL}/api/v1/feed?page=1&page_size=20`, authHeaders);
    check(feedRes, {
      'cache sync: feed read 200': (r) => r.status === 200,
      'cache sync: feed returns items': (r) => {
        try {
          return Array.isArray(r.json('items'));
        } catch (e) {
          return false;
        }
      },
    });
  }

  sleep(0.1);
}
