.PHONY: help perf-up perf-down perf-test smoke-test load-test perf-logs perf-clean

help:
	@echo "Performance Testing Environment Commands:"
	@echo "  make perf-up     - Start backend API, Prometheus, Grafana, and metric exporters"
	@echo "  make smoke-test  - Run the k6 smoke test (2 VUs, ~30s sanity check)"
	@echo "  make load-test   - Run the k6 load test (up to 40 VUs, multi-scenario expected traffic)"
	@echo "  make perf-test   - Alias for smoke-test"
	@echo "  make perf-down   - Stop and tear down performance test containers"
	@echo "  make perf-logs   - Tail logs from all performance stack services"
	@echo "  make perf-clean  - Stop services and remove performance data volumes"

perf-up:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --build api prometheus grafana postgres-exporter redis-cache-exporter redis-broker-exporter

perf-test: smoke-test

smoke-test:
	./scripts/run-test.sh --type=smoke

load-test:
	./scripts/run-test.sh --type=load

perf-down:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml down

perf-logs:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml logs -f

perf-clean:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml down -v
