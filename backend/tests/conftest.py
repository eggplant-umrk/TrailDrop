import pathlib
import sys

import pytest

# main.py/models.py/route_analysis.py use absolute imports (no package prefix),
# so backend/ must be on sys.path for `import main` etc. to work from tests/.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


# Every TestClient in this test suite connects as the same "testclient" IP,
# so without a reset the module-level staff-auth rate limiter (shared
# in-memory state, same design as the route-analysis rate limiter) would
# accumulate failed attempts across every test file that exercises a
# staff-token endpoint with a bad/missing token
# (verify_qr, get_staff_reservation, search_staff_reservations,
# expire_stale_reservations) and start returning 429 partway through the
# suite. This mirrors test_route_analysis.py's reset_route_analysis_state
# fixture for the same reason.
@pytest.fixture(autouse=True)
def reset_staff_auth_rate_limit_state():
    main._staff_auth_failure_log.clear()
    main._staff_auth_rate_limit_last_cleanup = 0.0
    yield
    main._staff_auth_failure_log.clear()
    main._staff_auth_rate_limit_last_cleanup = 0.0


# Same reason as above for the reservation-create rate limiter: every
# TestClient request comes from the same "testclient" IP, so the shared
# in-memory log would otherwise leak across tests and start returning 429.
@pytest.fixture(autouse=True)
def reset_reservation_create_rate_limit_state():
    main._reservation_create_request_log.clear()
    main._reservation_create_rate_limit_last_cleanup = 0.0
    yield
    main._reservation_create_request_log.clear()
    main._reservation_create_rate_limit_last_cleanup = 0.0
