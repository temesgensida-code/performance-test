#!/usr/bin/env python3
"""
seed_volume_data.py - High-Performance Bulk Data Seeder for Volume Testing

Populates PostgreSQL with:
- 20,000 users with precomputed bcrypt hash for 'password123'
- 200,000+ follow relationships
- 500,000 posts with realistic timestamps
- 50,000 user_matches pairs with scores and tags

Can be run directly or through Docker:
    python performance/scripts/seed_volume_data.py
    docker compose exec db python ... (or via docker exec psql)
"""

import os
import subprocess
import sys
import time

# Pre-hashed bcrypt for 'password123' (avoids CPU cost of 20,000 bcrypt runs)
BCRYPT_PASSWORD_HASH = "$2b$12$9r6TArFoHmXAEIrtydMOFulKk3uhAAmolxH2lqRsSLfdtQgOfbpQW"

SQL_SEED_SCRIPT = f"""
-- 1. Seed 20,000 Users
INSERT INTO users (username, email, hashed_password, display_name, bio, interests, is_active, created_at)
SELECT 
    'vol_user_' || i,
    'vol_user_' || i || '@example.com',
    '{BCRYPT_PASSWORD_HASH}',
    'Volume User ' || i,
    'Bio for volume user ' || i || ' testing high database scale.',
    ARRAY['tech', 'database', 'python', 'scaling', 'k6']::varchar[],
    true,
    NOW() - (i || ' minutes')::interval
FROM generate_series(1, 20000) AS i
ON CONFLICT (username) DO NOTHING;

-- 2. Seed ~230,000 Follow edges across user pool
INSERT INTO follows (follower_id, followee_id, created_at)
SELECT DISTINCT
    f.follower_id,
    f.followee_id,
    NOW() - (random() * interval '30 days')
FROM (
    SELECT 
        u1.id AS follower_id,
        u2.id AS followee_id
    FROM (
        SELECT id FROM users WHERE username LIKE 'vol_user_%' ORDER BY random() LIMIT 5000
    ) u1
    CROSS JOIN (
        SELECT id FROM users WHERE username LIKE 'vol_user_%' ORDER BY random() LIMIT 50
    ) u2
    WHERE u1.id <> u2.id
) f
ON CONFLICT DO NOTHING;

-- 3. Seed 500,000 Posts
INSERT INTO posts (author_id, content, created_at)
SELECT 
    u.id AS author_id,
    'Volume post #' || i || ': benchmarking index depth, table scans, and deep pagination latency across 500k rows in PostgreSQL.',
    NOW() - (random() * interval '60 days')
FROM generate_series(1, 500000) AS i
CROSS JOIN LATERAL (
    SELECT id FROM users WHERE username LIKE 'vol_user_%' ORDER BY random() LIMIT 1
) u;

-- 4. Seed 50,000 User Matches
INSERT INTO user_matches (user_id, matched_user_id, score, shared_interests, computed_at)
SELECT DISTINCT
    m.user_id,
    m.matched_user_id,
    round((0.5 + random() * 0.5)::numeric, 4),
    ARRAY['database', 'python']::varchar[],
    NOW()
FROM (
    SELECT 
        u1.id AS user_id,
        u2.id AS matched_user_id
    FROM (
        SELECT id FROM users WHERE username LIKE 'vol_user_%' ORDER BY random() LIMIT 2000
    ) u1
    CROSS JOIN (
        SELECT id FROM users WHERE username LIKE 'vol_user_%' ORDER BY random() LIMIT 30
    ) u2
    WHERE u1.id <> u2.id
) m
ON CONFLICT (user_id, matched_user_id) DO NOTHING;

-- 5. Update PostgreSQL Statistics for Query Planner
ANALYZE users;
ANALYZE follows;
ANALYZE posts;
ANALYZE user_matches;
"""

def execute_via_docker():
    print("[*] Executing seed SQL via docker exec on container 'social-backend-db-1'...")
    cmd = [
        "docker", "exec", "-i", "social-backend-db-1",
        "psql", "-U", "social", "-d", "social"
    ]
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stdout, stderr = process.communicate(input=SQL_SEED_SCRIPT)
    if process.returncode != 0:
        print(f"[!] Error executing SQL: {stderr}", file=sys.stderr)
        return False
    print(stdout)
    return True

def verify_counts():
    print("[*] Verifying database table counts...")
    check_sql = """
    SELECT 
        (SELECT count(*) FROM users) AS total_users,
        (SELECT count(*) FROM follows) AS total_follows,
        (SELECT count(*) FROM posts) AS total_posts,
        (SELECT count(*) FROM user_matches) AS total_matches;
    """
    cmd = [
        "docker", "exec", "-i", "social-backend-db-1",
        "psql", "-U", "social", "-d", "social", "-c", check_sql
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout)

def main():
    start_time = time.time()
    print("=========================================================")
    print("  Social Backend - High Performance Volume Data Seeder   ")
    print("  Target: ~20k Users | ~200k Follows | ~500k Posts       ")
    print("=========================================================")
    
    success = execute_via_docker()
    if not success:
        sys.exit(1)
        
    verify_counts()
    elapsed = time.time() - start_time
    print(f"[+] Bulk volume seeding completed successfully in {elapsed:.2f} seconds.")

if __name__ == "__main__":
    main()
