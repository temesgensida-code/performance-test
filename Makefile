.PHONY: help perf-up perf-down perf-test smoke-test load-test stress-test spike-test soak-test concurrency-test perf-logs perf-clean

help:
	@echo "Performance Testing Environment Commands:"
	@echo "  make perf-up          - Start backend API, Prometheus, Grafana, and metric exporters"
	@echo "  make smoke-test       - Run the k6 smoke test (2 VUs, ~30s sanity check)"
	@echo "  make load-test        - Run the k6 load test (up to 40 VUs, multi-scenario expected traffic)"
	@echo "  make stress-test      - Run the k6 stress test (step-up to 150+ VUs, saturation & recovery)"
	@echo "  make spike-test       - Run the k6 spike test (sudden 24x jump to 120 VUs & shock recovery)"
	@echo "  make soak-test        - Run the k6 soak test (sustained 25 VUs, 30m endurance & leak check)"
	@echo "  make concurrency-test - Run the k6 concurrency test (distributed locks, constraints, hotspot locks)"
	@echo "  make perf-test        - Alias for smoke-test"
	@echo "  make perf-down        - Stop and tear down performance test containers"
	@echo "  make perf-logs        - Tail logs from all performance stack services"
	@echo "  make perf-clean       - Stop services and remove performance data volumes"

perf-up:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --build api prometheus grafana postgres-exporter redis-cache-exporter redis-broker-exporter

perf-test: smoke-test

smoke-test:
	./scripts/run-test.sh --type=smoke

load-test:
	./scripts/run-test.sh --type=load

stress-test:
	./scripts/run-test.sh --type=stress

spike-test:
	./scripts/run-test.sh --type=spike

soak-test:
	./scripts/run-test.sh --type=soak

concurrency-test:
	./scripts/run-test.sh --type=concurrency

perf-down:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml down

perf-logs:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml logs -f

perf-clean:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml down -v
