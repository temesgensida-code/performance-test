#!/usr/bin/env bash
set -euo pipefail

TEST_TYPE="smoke"
CUSTOM_DURATION="${SOAK_DURATION:-30m}"
CUSTOM_VUS="${SOAK_VUS:-25}"

# Parse command line flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        --type=*)
            TEST_TYPE="${1#*=}"
            shift
            ;;
        -t|--type)
            TEST_TYPE="$2"
            shift 2
            ;;
        --duration=*)
            CUSTOM_DURATION="${1#*=}"
            shift
            ;;
        -d|--duration)
            CUSTOM_DURATION="$2"
            shift 2
            ;;
        --vus=*)
            CUSTOM_VUS="${1#*=}"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--type=smoke|load|stress|spike|soak|concurrency|volume|scalability] [--duration=30m] [--vus=25]"
            echo ""
            echo "Options:"
            echo "  --type=smoke         Run quick baseline sanity test (2 VUs for ~30s)"
            echo "  --type=load          Run expected-traffic load test (up to 40 VUs, multi-scenario)"
            echo "  --type=stress        Run step-up saturation stress test (up to 150+ VUs with recovery)"
            echo "  --type=spike         Run aggressive traffic spike test (instant 24x jump to 120 VUs & recovery)"
            echo "  --type=soak          Run long-running endurance soak test (sustained load over time)"
            echo "  --type=concurrency   Run concurrency & race condition test (distributed locks, constraints, hotspot locks)"
            echo "  --type=volume        Run volume & deep pagination test against 500k-row database (30 VUs, 5m)"
            echo "  --type=scalability   Run scalability test across web/celery workers & DB pool (40 VUs, 3m)"
            echo "  --duration=X         Duration for soak test (default: 30m, e.g. 1h, 2h)"
            echo "  --vus=N              Concurrency for soak test (default: 25 VUs)"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: $0 [--type=smoke|load|stress|spike|soak|concurrency|volume|scalability]"
            exit 1
            ;;
    esac
done

if [[ "${TEST_TYPE}" != "smoke" && "${TEST_TYPE}" != "load" && "${TEST_TYPE}" != "stress" && "${TEST_TYPE}" != "spike" && "${TEST_TYPE}" != "soak" && "${TEST_TYPE}" != "concurrency" && "${TEST_TYPE}" != "volume" && "${TEST_TYPE}" != "scalability" ]]; then
    echo "Error: Invalid test type '${TEST_TYPE}'. Must be 'smoke', 'load', 'stress', 'spike', 'soak', 'concurrency', 'volume', or 'scalability'."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

echo "=========================================================="
echo " Starting Performance Testing Stack (Backend + Prometheus + Grafana)"
echo "=========================================================="
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d api prometheus grafana postgres-exporter redis-cache-exporter redis-broker-exporter

echo ""
echo "Waiting for API (http://localhost:8000/health) and Prometheus (http://localhost:9091)..."
until curl -s http://localhost:8000/health >/dev/null 2>&1; do
    echo "Waiting for API service to be healthy..."
    sleep 2
done

until curl -s http://localhost:9091/-/ready >/dev/null 2>&1; do
    echo "Waiting for Prometheus to be ready..."
    sleep 2
done

echo ""
echo "=========================================================="
if [[ "${TEST_TYPE}" == "scalability" ]]; then
    echo " Executing k6 SCALABILITY Test (Resource sizing across web workers, Celery, and DB)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6-scalability
    DASHBOARD_URL="http://localhost:3001/d/social-backend-scalability-test"
    DASHBOARD_NAME="Social Backend - Scalability & Resource Sizing"
elif [[ "${TEST_TYPE}" == "volume" ]]; then
    echo " Executing k6 VOLUME Test (Deep pagination & index traversal on 500k-row database)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6-volume
    DASHBOARD_URL="http://localhost:3001/d/social-backend-volume-test"
    DASHBOARD_NAME="Social Backend - Volume Testing (500k Rows)"
elif [[ "${TEST_TYPE}" == "concurrency" ]]; then
    echo " Executing k6 CONCURRENCY Test (Distributed locks, unique constraints, hotspot row-locking)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6-concurrency
    DASHBOARD_URL="http://localhost:3001/d/social-backend-concurrency-test"
    DASHBOARD_NAME="Social Backend - Concurrency & Contention Analysis"
elif [[ "${TEST_TYPE}" == "soak" ]]; then
    echo " Executing k6 SOAK Test (Long-running endurance: ${CUSTOM_VUS} VUs for ${CUSTOM_DURATION})"
    echo "=========================================================="
    SOAK_DURATION="${CUSTOM_DURATION}" SOAK_VUS="${CUSTOM_VUS}" \
      docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm \
      -e SOAK_DURATION="${CUSTOM_DURATION}" \
      -e SOAK_VUS="${CUSTOM_VUS}" \
      k6-soak
    DASHBOARD_URL="http://localhost:3001/d/social-backend-soak-test"
    DASHBOARD_NAME="Social Backend - Soak Testing & Long-Term Stability"
elif [[ "${TEST_TYPE}" == "spike" ]]; then
    echo " Executing k6 SPIKE Test (Sudden 24x traffic surge to 120 VUs & recovery)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6-spike
    DASHBOARD_URL="http://localhost:3001/d/social-backend-spike-test"
    DASHBOARD_NAME="Social Backend - Spike Testing & Shock Recovery"
elif [[ "${TEST_TYPE}" == "stress" ]]; then
    echo " Executing k6 STRESS Test (Step-up saturation to 150+ VUs with recovery)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6-stress
    DASHBOARD_URL="http://localhost:3001/d/social-backend-stress-test"
    DASHBOARD_NAME="Social Backend - Stress Testing & Saturation"
elif [[ "${TEST_TYPE}" == "load" ]]; then
    echo " Executing k6 LOAD Test (Multi-scenario 80/15/5 distribution, ~40 VUs)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6-load
    DASHBOARD_URL="http://localhost:3001/d/social-backend-load-test"
    DASHBOARD_NAME="Social Backend - Load Testing & Capacity"
else
    echo " Executing k6 SMOKE Test (Minimal load sanity test, 2 VUs)"
    echo "=========================================================="
    docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6
    DASHBOARD_URL="http://localhost:3001/d/social-backend-perf"
    DASHBOARD_NAME="Social Backend Performance Overview"
fi

echo ""
echo "=========================================================="
echo " Performance Run Complete!"
echo " Dedicated Dashboard:  ${DASHBOARD_URL}"
echo " Dashboard Name:       ${DASHBOARD_NAME}"
echo " Prometheus UI:        http://localhost:9091"
echo " API Docs & Health:    http://localhost:8000/docs"
echo "=========================================================="
