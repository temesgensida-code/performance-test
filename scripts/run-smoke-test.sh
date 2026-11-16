#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

echo "=========================================================="
echo " Starting Performance Testing Stack (Backend + Prometheus + Grafana)"
echo "=========================================================="
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --build api prometheus grafana postgres-exporter redis-cache-exporter redis-broker-exporter

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
echo " Executing k6 Smoke Test"
echo "=========================================================="
docker compose -f docker-compose.yml -f docker-compose.perf.yml run --rm k6

echo ""
echo "=========================================================="
echo " Performance Run Complete!"
echo " Grafana Dashboard:  http://localhost:3001/d/social-backend-perf"
echo " Prometheus UI:      http://localhost:9091"
echo " API Docs & Health:  http://localhost:8000/docs"
echo "=========================================================="
