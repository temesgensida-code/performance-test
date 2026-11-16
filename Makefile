.PHONY: help perf-up perf-down perf-test perf-logs perf-clean

help:
	@echo "Performance Testing Environment Commands:"
	@echo "  make perf-up     - Start backend API, Prometheus, Grafana, and metric exporters"
	@echo "  make perf-test   - Run the on-demand k6 smoke test and stream metrics to Prometheus"
	@echo "  make perf-down   - Stop and tear down performance test containers"
	@echo "  make perf-logs   - Tail logs from all performance stack services"
	@echo "  make perf-clean  - Stop services and remove performance data volumes"

perf-up:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --build api prometheus grafana postgres-exporter redis-cache-exporter redis-broker-exporter

perf-test:
	./scripts/run-smoke-test.sh

perf-down:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml down

perf-logs:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml logs -f

perf-clean:
	docker compose -f docker-compose.yml -f docker-compose.perf.yml down -v
