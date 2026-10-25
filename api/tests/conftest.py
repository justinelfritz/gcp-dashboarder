from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fit_builder import FitBuilder, degrees_to_semicircles

FIXTURES = Path(__file__).parent / "fixtures"

# The Garmin CSV "Morning Run" fixture: 07:15:22 in Denver (MDT, UTC-6) on 2024-03-10.
RUN_START = datetime(2024, 3, 10, 13, 15, 22, tzinfo=UTC)


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def add_session(b: FitBuilder, start: datetime, seconds: int, sport: str, sub_sport="generic",
                **fields) -> None:
    b.add(
        "session",
        timestamp=start + timedelta(seconds=seconds),
        start_time=start,
        sport=sport,
        sub_sport=sub_sport,
        total_elapsed_time=float(seconds),
        total_timer_time=float(seconds),
        **fields,
    )


def add_records(b: FitBuilder, start: datetime, seconds: int, speed=3.0, hr=150, power=None):
    for i in range(seconds):
        b.add(
            "record",
            timestamp=start + timedelta(seconds=i),
            position_lat=degrees_to_semicircles(39.74 + i * 1e-5),
            position_long=degrees_to_semicircles(-104.99),
            altitude=1600.0,
            heart_rate=hr,
            cadence=85,
            distance=i * speed,
            speed=speed,
            power=power,
        )


def build_run(start: datetime = RUN_START, seconds: int = 60, with_records: bool = True,
              utc_offset_h: int = -6) -> bytes:
    b = FitBuilder().add("file_id", type=4, manufacturer=1, product=1, serial_number=1,
                         time_created=start)
    if with_records:
        add_records(b, start, seconds)
    add_session(b, start, seconds, "running", total_distance=seconds * 3.0, total_calories=50,
                avg_speed=3.0, avg_heart_rate=150, max_heart_rate=160, total_ascent=12)
    end = start + timedelta(seconds=seconds)
    b.add("activity", timestamp=end, total_timer_time=float(seconds), num_sessions=1, type=0,
          local_timestamp=end + timedelta(hours=utc_offset_h))
    return b.build()


@pytest.fixture
def run_fit() -> bytes:
    return build_run()
