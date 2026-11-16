#!/usr/bin/env bash
set -euo pipefail

TEST_TYPE="smoke"

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
        -h|--help)
            echo "Usage: $0 [--type=smoke|load|stress]"
            echo ""
            echo "Options:"
            echo "  --type=smoke    Run quick baseline sanity test (2 VUs for ~30s)"
            echo "  --type=load     Run expected-traffic load test (up to 40 VUs, multi-scenario)"
            echo "  --type=stress   Run step-up saturation stress test (up to 150+ VUs with recovery)"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: $0 [--type=smoke|load|stress]"
            exit 1
            ;;
    esac
done

if [[ "${TEST_TYPE}" != "smoke" && "${TEST_TYPE}" != "load" && "${TEST_TYPE}" != "stress" ]]; then
    echo "Error: Invalid test type '${TEST_TYPE}'. Must be 'smoke', 'load', or 'stress'."
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
if [[ "${TEST_TYPE}" == "stress" ]]; then
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
