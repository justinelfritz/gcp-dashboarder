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


def build_activity(start: datetime, speeds: list[float], sport: str = "running",
                   sub_sport: str = "generic", hr: int = 150, cadence: int = 85,
                   lap_every_m: float | None = 1609.344, utc_offset_h: int = -4) -> bytes:
    """A FIT activity with one record per second at the given speeds, and distance auto-laps."""
    b = FitBuilder().add("file_id", type=4, manufacturer=1, product=1, serial_number=1,
                         time_created=start)
    distance, lap_start, lap_start_dist, laps = 0.0, start, 0.0, []
    for i, speed in enumerate(speeds):
        ts = start + timedelta(seconds=i)
        distance += speed if i else 0
        b.add("record", timestamp=ts, position_lat=degrees_to_semicircles(40.0),
              position_long=degrees_to_semicircles(-74.0), altitude=100.0, heart_rate=hr,
              cadence=cadence, distance=distance, speed=speed, power=None)
        if lap_every_m and distance - lap_start_dist >= lap_every_m:
            laps.append((lap_start, ts, distance - lap_start_dist, "distance"))
            lap_start, lap_start_dist = ts + timedelta(seconds=1), distance
    end = start + timedelta(seconds=len(speeds) - 1)
    if lap_start <= end:
        laps.append((lap_start, end, distance - lap_start_dist, "session_end"))
    for lap_start_t, lap_end, dist, trigger in laps:
        secs = (lap_end - lap_start_t).total_seconds()
        b.add("lap", timestamp=lap_end, start_time=lap_start_t, total_elapsed_time=secs,
              total_timer_time=secs, total_distance=dist, total_ascent=0, lap_trigger=trigger)
    seconds = len(speeds) - 1
    add_session(b, start, seconds, sport, sub_sport=sub_sport, total_distance=distance,
                avg_speed=distance / seconds, avg_heart_rate=hr, max_heart_rate=hr,
                total_ascent=0)
    b.add("activity", timestamp=end, total_timer_time=float(seconds), num_sessions=1, type=0,
          local_timestamp=end + timedelta(hours=utc_offset_h))
    return b.build()
