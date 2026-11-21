PYTHON ?= python3
PORT ?= 8000
API_PORT ?= 8001

.PHONY: check dev-api serve-fixture

check:
	$(PYTHON) scripts/check_fixture.py fixtures/venue/manifest.json
	$(PYTHON) -B tools/smoke_scan_mock.py
	$(PYTHON) -B tools/test_recorder_server.py

dev-api:
	$(PYTHON) -B tools/scan_mock.py --port $(API_PORT)

serve-fixture:
	$(PYTHON) -m http.server $(PORT) --bind 127.0.0.1 --directory fixtures/venue
