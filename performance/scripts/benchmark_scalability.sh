#!/usr/bin/env bash
set -euo pipefail

DURATION="${1:-30s}"
VUS="${2:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

echo "================================================================================"
echo "    Social Backend - Automated Scalability & Worker Scaling Benchmark           "
echo "    Duration per tier: ${DURATION} | VUs: ${VUS}                                "
echo "================================================================================"

declare -A RPS_RESULTS
declare -A P95_RESULTS
declare -A LOGIN_RPS_RESULTS
declare -A TASKS_RESULTS

TIERS=(1 2 4)

for T in "${TIERS[@]}"; do
    echo ""
    echo ">>> [Tier ${T}] Configuring API with ${T} Web Workers & ${T} Celery Workers..."
    
    export WEB_CONCURRENCY="${T}"
    export CELERY_CONCURRENCY="${T}"
    
    docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d api worker >/dev/null 2>&1
    
    # Wait for API to respond
    echo -n "    Waiting for API health..."
    for i in {1..30}; do
        if docker exec social-backend-api-1 curl -s http://localhost:8000/health >/dev/null 2>&1 || curl -s http://localhost:8000/health >/dev/null 2>&1; then
            break
        fi
        echo -n "."
        sleep 1
    done
    echo " Ready."
    
    # Allow workers to stabilize
    sleep 3

    echo "    Running k6 scalability workload (${DURATION} @ ${VUS} VUs)..."
    OUTPUT_FILE=$(mktemp)
    
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm \
        -e TARGET_URL="http://api:8000" \
        -e SCALABILITY_DURATION="${DURATION}" \
        -e SCALABILITY_VUS="${VUS}" \
        k6-scalability run --vus "${VUS}" --duration "${DURATION}" -o experimental-prometheus-rw /scripts/scalability_test.js > "${OUTPUT_FILE}" 2>&1 || true

    # Extract metrics from output
    # http_reqs......................: 1234     45.67/s
    TOTAL_RPS=$(grep -E 'http_reqs\.*:' "${OUTPUT_FILE}" | awk '{print $(NF)}' | tr -d '/s' || echo "0")
    if [[ -z "${TOTAL_RPS}" ]]; then TOTAL_RPS="0"; fi

    # http_req_duration..............: ... p(95)=123.45ms
    P95_DUR=$(grep -E 'http_req_duration\.*:' "${OUTPUT_FILE}" | grep -o 'p(95)=[0-9.]*' | cut -d'=' -f2 || echo "0")
    if [[ -z "${P95_DUR}" ]]; then P95_DUR="0"; fi

    # auth_login_latency: p(95)=...
    LOGIN_P95=$(grep -E 'auth_login_latency\.*:' "${OUTPUT_FILE}" | grep -o 'p(95)=[0-9.]*' | cut -d'=' -f2 || echo "0")
    if [[ -z "${LOGIN_P95}" ]]; then LOGIN_P95="0"; fi

    # tasks_dispatched_total
    TASKS=$(grep -E 'tasks_dispatched_total\.*:' "${OUTPUT_FILE}" | awk '{print $2}' || echo "0")
    if [[ -z "${TASKS}" ]]; then TASKS="0"; fi

    RPS_RESULTS["${T}"]="${TOTAL_RPS}"
    P95_RESULTS["${T}"]="${P95_DUR}"
    LOGIN_RPS_RESULTS["${T}"]="${LOGIN_P95}"
    TASKS_RESULTS["${T}"]="${TASKS}"

    echo "    [Tier ${T} Results] Total RPS: ${TOTAL_RPS}/s | p95 Latency: ${P95_DUR}ms | Login p95: ${LOGIN_P95}ms | Tasks: ${TASKS}"
    rm -f "${OUTPUT_FILE}"
done

# Reset to default
echo ""
echo ">>> Resetting environment to standard configuration (WEB_CONCURRENCY=1, CELERY_CONCURRENCY=4)..."
export WEB_CONCURRENCY="1"
export CELERY_CONCURRENCY="4"
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d api worker >/dev/null 2>&1

echo ""
echo "=========================================================================================="
echo "                           SCALABILITY BENCHMARK REPORT                                   "
echo "=========================================================================================="
printf "%-10s | %-12s | %-14s | %-14s | %-10s | %-12s\n" "Workers" "Throughput" "p95 Latency" "Login p95" "Speedup" "Efficiency"
printf "%-10s-+-%-12s-+-%-14s-+-%-14s-+-%-10s-+-%-12s\n" "----------" "------------" "--------------" "--------------" "----------" "------------"

BASE_RPS="${RPS_RESULTS["1"]:-1}"
if (( $(echo "${BASE_RPS} <= 0" | bc -l) )); then BASE_RPS="1.0"; fi

for T in "${TIERS[@]}"; do
    RPS="${RPS_RESULTS["${T}"]:-0}"
    P95="${P95_RESULTS["${T}"]:-0}ms"
    LOGIN_P95="${LOGIN_RPS_RESULTS["${T}"]:-0}ms"
    
    SPEEDUP=$(echo "scale=2; ${RPS} / ${BASE_RPS}" | bc -l 2>/dev/null || echo "1.00")
    EFFICIENCY=$(echo "scale=1; (${SPEEDUP} / ${T}) * 100" | bc -l 2>/dev/null || echo "100.0")

    printf "%-10s | %-9s/s | %-14s | %-14s | %-8sx | %-10s%%\n" "${T} Workers" "${RPS}" "${P95}" "${LOGIN_P95}" "${SPEEDUP}" "${EFFICIENCY}"
done

echo "=========================================================================================="
echo " Dedicated Scalability Dashboard: http://localhost:3001/d/social-backend-scalability-test"
echo " Prometheus UI:                   http://localhost:9091"
echo "=========================================================================================="
