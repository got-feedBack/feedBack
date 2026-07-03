import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'plugins' / 'tuner'))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
# Drop a sibling 'routes' cached by another plugin's tests (bare-name collision).
sys.modules.pop('routes', None)
import routes as tuner_routes


@pytest.fixture
def config_dir(tmp_path):
    return tmp_path


@pytest.fixture
def client(config_dir):
    app = FastAPI()
    tuner_routes.setup(app, {
        "config_dir": str(config_dir),
        "register_tuning_provider": lambda pid, fn: None,
        "unregister_tuning_provider": lambda pid: None,
    })
    return TestClient(app)


@pytest.fixture(autouse=True)
def _bind_tuner_routes():
    """Keep sys.modules['routes'] pointing at THIS plugin's routes for these
    tests, so a runtime `import routes` in a test body resolves correctly
    regardless of which other plugin's bare-named routes ran first."""
    prev = sys.modules.get('routes')
    sys.modules['routes'] = tuner_routes
    try:
        yield
    finally:
        if prev is not None:
            sys.modules['routes'] = prev
        else:
            sys.modules.pop('routes', None)
