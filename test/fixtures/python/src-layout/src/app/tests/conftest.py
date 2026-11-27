import pytest


@pytest.fixture
def service():
    from app.service import Service
    from app.fixture_only import fixture_value
    return Service(), fixture_value
