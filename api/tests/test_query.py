import io
import statistics
from datetime import UTC, datetime, timedelta

import pytest
from conftest import build_activity, fixture_bytes
from fastapi.testclient import TestClient

from app.main import app, get_storage
from app.parsing.fit_parser import parse_fit
from app.storage.backends import LocalStorage

# Saturdays at 08:00 New York time (EDT, UTC-4).
DAY0 = datetime(2026, 9, 5, 12, 0, tzinfo=UTC)


@pytest.fixture
def client(tmp_path):
    storage = LocalStorage(str(tmp_path))
    app.dependency_overrides[get_storage] = lambda: storage
    yield TestClient(app)
    app.dependency_overrides.clear()


def make_session(client, *activities) -> str:
    sid = client.post("/sessions").json()["session_id"]
    files = [("files", (f"a{i}.fit", io.BytesIO(data))) for i, data in enumerate(activities)]
    resp = client.post(f"/sessions/{sid}/uploads", files=files)
    assert resp.status_code == 200
    return sid


def run(km: float, speed: float = 4.0, day: int = 0, **kw) -> bytes:
    return build_activity(DAY0 + timedelta(days=day), [speed] * int(km * 1000 / speed + 1), **kw)


def query(client, sid, *panels, **request):
    resp = client.post(f"/sessions/{sid}/query", json={"panels": list(panels), **request})
    assert resp.status_code == 200, resp.text
    return {p["id"]: p for p in resp.json()["panels"]}


def points(panel, series=0):
    return [(p["x"], p["y"], p["error"], p["n"]) for p in panel["series"][series]["points"]]


DISTANCE_SERIES = [
    {"label": "5k", "filters": [{"field": "distance_m", "op": "near", "value": 5000}]},
    {"label": "10k", "filters": [{"field": "distance_m", "op": "near", "value": 10000}]},
]


def test_distance_bins_default_to_2_5_percent(client):
    # 4.88 and 5.12 km are inside 5k ± 2.5% (4.875-5.125); 5.2 km is not.
    sid = make_session(client, run(4.88), run(5.12, day=1), run(5.2, day=2), run(10.2, day=3))
    panel = {"id": "p", "y": {"field": "avg_speed_mps"}, "series": DISTANCE_SERIES}
    p = query(client, sid, panel)["p"]
    assert [s["n_activities"] for s in p["series"]] == [2, 1]


def test_distance_tolerance_is_adjustable(client):
    sid = make_session(client, run(4.88), run(5.2, day=1))
    panel = {"id": "p", "y": {"field": "avg_speed_mps"}, "series": DISTANCE_SERIES[:1]}
    assert query(client, sid, panel, distance_tolerance=0.05)["p"]["series"][0]["n_activities"] == 2
    per_filter = {"id": "p", "y": {"field": "avg_speed_mps"}, "series": [{"label": "5k", "filters": [
        {"field": "distance_m", "op": "near", "value": 5000, "tolerance": 0.0}]}]}
    assert query(client, sid, per_filter)["p"]["series"][0]["n_activities"] == 0


def test_lap_pace_mean_and_std_per_run(client):
    # Mile laps at different speeds, ending with a short partial lap.
    mile = 1609.344
    speeds = [4.0] * int(mile / 4 + 1) + [4.0] * int(mile / 4 + 1) + [5.0] * int(mile / 5 + 1)
    speeds += [2.0] * 100
    fit = build_activity(DAY0, speeds)
    sid = make_session(client, fit)
    panel = {"id": "p", "y": {"field": "avg_pace_s_per_km", "level": "lap"}, "error": "std"}
    [(x, y, err, n)] = points(query(client, sid, panel)["p"])

    parsed = parse_fit(fit, "a.fit")
    laps = [lap for lap in next(iter(parsed.laps.values()))
            if lap["kind"] == "device" and not lap["is_partial"]]
    paces = [1000 / lap["avg_speed_mps"] for lap in laps]
    assert n == len(paces) == 3  # the partial final lap is excluded by default
    assert y == pytest.approx(statistics.mean(paces))
    assert err == pytest.approx(statistics.stdev(paces))
    assert 20 < err < 35  # two ~250 s/km laps and one ~200 s/km lap
    assert x == "2026-09-05T08:00:00"  # 12:00 UTC shown in New York local time

    with_partial = query(client, sid, {**panel, "include_partial_laps": True})["p"]
    assert points(with_partial)[0][3] == 4


def test_computed_splits(client):
    sid = make_session(client, run(5.2))
    km = {"id": "km", "lap_kind": "split_km", "y": {"field": "distance_m", "level": "lap",
                                                     "agg": "count"}}
    mi = {**km, "id": "mi", "lap_kind": "split_mi"}
    res = query(client, sid, km, mi)
    assert points(res["km"])[0][1] == 5  # 5 full km; the 200 m remainder is partial
    assert points(res["mi"])[0][1] == 3


def test_record_speed_ignores_stops(client):
    speeds = [4.0] * 1000 + [0.0] * 500 + [4.0] * 250
    sid = make_session(client, build_activity(DAY0, speeds))
    panel = {"id": "p", "y": {"field": "speed", "level": "record"}, "error": "std"}
    [(_, y, err, n)] = points(query(client, sid, panel)["p"])
    assert y == pytest.approx(4.0)
    assert err == pytest.approx(0.0)
    assert n == 1250  # the 1000 + 250 samples above walking-still speed


def test_scatter_of_activity_fields(client):
    sid = make_session(client, run(5, speed=3.0), run(5, speed=4.0, day=1))
    panel = {"id": "p", "x": {"field": "avg_speed_mps"}, "y": {"field": "avg_pace_s_per_km"}}
    pts = points(query(client, sid, panel)["p"])
    assert [round(x, 2) for x, *_ in pts] == [3.0, 4.0]
    assert [round(y) for _, y, *_ in pts] == [333, 250]


def test_point_mode_one_point_per_lap(client):
    sid = make_session(client, run(5.0), run(5.0, day=1))
    panel = {"id": "p", "group_by": "point", "x": {"field": "lap_index", "level": "lap"},
             "y": {"field": "avg_pace_s_per_km", "level": "lap"}}
    assert len(points(query(client, sid, panel)["p"])) == 6  # 3 full mile laps per run

    mixed = {**panel, "y": {"field": "hr", "level": "record"}}
    assert "same level" in query(client, sid, mixed)["p"]["error"]


def test_weekly_buckets_use_local_time_and_monday_start(client):
    # Sunday 23:30 in New York is Monday 03:30 UTC: it belongs to the week starting Aug 31.
    sunday_night = datetime(2026, 9, 7, 3, 30, tzinfo=UTC)
    sid = make_session(client, run(5), build_activity(sunday_night, [4.0] * 1251),
                       run(5, day=3))
    panel = {"id": "p", "group_by": "week", "y": {"field": "distance_m", "agg": "sum"}}
    pts = points(query(client, sid, panel)["p"])
    assert [(x, round(y), n) for x, y, _, n in pts] == [("2026-08-31", 10000, 2),
                                                        ("2026-09-07", 5000, 1)]


def test_hidden_activities(client):
    sid = make_session(
        client,
        run(5),
        run(5, day=1, sub_sport="treadmill"),
        run(5, day=2, sport="training", sub_sport="strength_training"),
    )
    acts = client.get(f"/sessions/{sid}/activities").json()
    assert acts["total"] == 1
    panel = {"id": "p", "y": {"field": "distance_m"}}
    assert query(client, sid, panel)["p"]["series"][0]["n_activities"] == 1


def test_display_filters(client):
    sid = make_session(client, run(5), run(5, day=1, sport="cycling"), run(5, day=10))
    panel = {"id": "p", "y": {"field": "distance_m"}}
    runs = query(client, sid, panel, filters={"activity_types": ["run"]})["p"]
    assert runs["series"][0]["n_activities"] == 2
    recent = query(client, sid, panel, filters={"date_range": {"start": "2026-09-10"}})["p"]
    assert recent["series"][0]["n_activities"] == 1


def test_hand_picked_selection(client):
    sid = make_session(client, run(5), run(5, day=1), run(5, day=2))
    ids = [a["activity_id"] for a in client.get(f"/sessions/{sid}/activities").json()["items"]]
    panel = {"id": "p", "y": {"field": "distance_m"}}

    def n(**filters):
        return query(client, sid, panel, filters=filters)["p"]["series"][0]["n_activities"]

    assert n(activity_ids=ids[:2]) == 2
    assert n(exclude_activity_ids=ids[:1]) == 2
    assert n(activity_ids=[]) == 0
    assert n(activity_ids=ids[:2], exclude_activity_ids=ids[:1]) == 1


def test_activity_list_date_filters(client):
    sid = make_session(client, run(5), run(5, day=10))
    url = f"/sessions/{sid}/activities"
    assert client.get(url, params={"start": "2026-09-10"}).json()["total"] == 1
    assert client.get(url, params={"end": "2026-09-05"}).json()["total"] == 1
    # Both runs are over 30 days before today (and only get older), so the window is empty.
    assert client.get(url, params={"last_days": 30}).json()["total"] == 0


def test_bad_panel_does_not_break_others(client):
    sid = make_session(client, run(5))
    res = query(
        client, sid,
        {"id": "ok", "y": {"field": "distance_m"}},
        {"id": "unknown", "y": {"field": "nope"}},
        {"id": "category", "y": {"field": "distance_m"}, "x": {"field": "activity_type"}},
        {"id": "bad_filter", "y": {"field": "distance_m"},
         "filters": [{"field": "distance_m", "op": "between", "value": 5}]},
    )
    assert res["ok"]["error"] is None and len(points(res["ok"])) == 1
    assert "unknown activity field" in res["unknown"]["error"]
    assert "not plotted" in res["category"]["error"]
    assert "bad value" in res["bad_filter"]["error"]


def test_missing_data_warning_for_csv_only_activities(client):
    sid = make_session(client, run(5))
    client.post(f"/sessions/{sid}/uploads", data={"timezone": "America/Denver"},
                files=[("files", ("g.csv", fixture_bytes("garmin_activities_metric.csv")))])
    panel = {"id": "p", "y": {"field": "avg_pace_s_per_km", "level": "lap"},
             "filters": [{"field": "distance_m", "op": "gte", "value": 4000}]}
    p = query(client, sid, panel, filters={"activity_types": ["run"]})["p"]
    assert len(points(p)) == 1
    assert p["warnings"] == ["1 of 2 activities have no lap pace data"]


def test_field_catalog_coverage(client):
    sid = make_session(client, run(5), run(5, day=1, sport="cycling"))
    cat = client.get(f"/sessions/{sid}/fields", params={"activity_type": "run"}).json()
    assert cat["total_activities"] == 1
    record = {f["name"]: f["coverage"] for f in cat["levels"]["record"]}
    assert record["speed"] == 1 and record["power"] == 0
    lap = {f["name"]: f for f in cat["levels"]["lap"]}
    assert lap["avg_pace_s_per_km"]["unit"] == "s/km" and lap["avg_pace_s_per_km"]["coverage"] == 1


def test_missing_data_warning_names_both_axes(client):
    sid = make_session(client, run(5), run(5, day=1, sport="cycling"))  # rides have no cadence here
    panel = {"id": "p", "x": {"field": "avg_cadence"}, "y": {"field": "avg_speed_mps"}}
    p = query(client, sid, panel)["p"]
    assert p["warnings"] == ["2 of 2 activities have no average speed or average cadence data"]


def test_series_filter_by_activity_type(client):
    sid = make_session(client, run(5), run(5, day=1, sport="cycling"))
    panel = {"id": "p", "y": {"field": "distance_m"}, "series": [
        {"label": "Runs", "filters": [{"field": "activity_type", "op": "eq", "value": "run"}]},
        {"label": "Rides", "filters": [{"field": "activity_type", "op": "eq", "value": "ride"}]},
    ]}
    p = query(client, sid, panel)["p"]
    assert [s["n_activities"] for s in p["series"]] == [1, 1]


@pytest.mark.parametrize(("raw", "subtype"), [
    ("running", "standard"), ("running/trail", "trail"), ("Trail Running", "trail"),
    ("Trail Run", "trail"), ("running/track", "track"), ("running/street", "road"),
    ("cycling/gravel_cycling", "gravel"), ("Gravel/Unpaved Cycling", "gravel"),
    ("Road Cycling", "road"), ("Mountain Biking", "mountain"), ("Mountain Bike Ride", "mountain"),
    ("cycling/e_bike_mountain", "e_bike"), ("E-Bike Ride", "e_bike"), ("Cyclocross", "cyclocross"),
    # Strava: bulk-export names and API sport_type names.
    ("Run", "standard"), ("Gravel Ride", "gravel"), ("E-Mountain Bike Ride", "e_bike"),
    ("TrailRun", "trail"), ("GravelRide", "gravel"), ("MountainBikeRide", "mountain"),
    ("EMountainBikeRide", "e_bike"),
    ("Hiking", "standard"), (None, "standard"),
])
def test_subtypes_from_each_source_naming(raw, subtype):
    from app.parsing.schema import normalize_activity_subtype
    assert normalize_activity_subtype(raw) == subtype


def test_subtype_filters_counts_and_series(client):
    sid = make_session(
        client,
        run(5, day=0, sub_sport="trail"),
        run(5, day=1, sub_sport="trail"),
        run(5, day=2),
        run(10, speed=6.0, day=3, sport="cycling", sub_sport="gravel_cycling"),
    )
    fields = client.get(f"/sessions/{sid}/fields").json()
    assert fields["subtypes"] == {"run": {"trail": 2, "standard": 1}, "ride": {"gravel": 1}}
    acts = client.get(f"/sessions/{sid}/activities").json()["items"]
    assert sorted(a["activity_subtype"] for a in acts) == ["gravel", "standard", "trail", "trail"]

    panel = {"id": "n", "group_by": "month", "y": {"field": "distance_m", "agg": "count"}}
    # Trail runs only; rides aren't narrowed.
    out = query(client, sid, panel, filters={
        "activity_types": ["run", "ride"], "activity_subtypes": {"run": ["trail"]}})
    assert out["n"]["series"][0]["n_activities"] == 3

    # One series per subtype, as the web app's "split by subtype" builds them.
    split = {"id": "s", "y": {"field": "distance_m"}, "series": [
        {"label": s, "filters": [{"field": "activity_subtype", "op": "eq", "value": s}]}
        for s in ("trail", "standard")]}
    out = query(client, sid, split, filters={"activity_types": ["run"]})
    assert [s["n_activities"] for s in out["s"]["series"]] == [2, 1]
