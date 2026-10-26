"""Minimal FIT file encoder for building test fixtures.

Covers just the messages the parser reads (file_id, record, session, activity). Field numbers,
base types, and scales follow the FIT profile; the official SDK decoding these files (with CRC
checks on) is what keeps this honest.
"""

import struct
from datetime import UTC, datetime

FIT_EPOCH = datetime(1989, 12, 31, tzinfo=UTC)

# Base types: (type byte, struct format, invalid value)
ENUM = (0x00, "B", 0xFF)
UINT8 = (0x02, "B", 0xFF)
UINT16 = (0x84, "H", 0xFFFF)
SINT32 = (0x85, "i", 0x7FFFFFFF)
UINT32 = (0x86, "I", 0xFFFFFFFF)
UINT32Z = (0x8C, "I", 0)

# Global message numbers and fields: name -> (field number, base type, scale, offset)
MESSAGES = {
    "file_id": (0, {
        "type": (0, ENUM, 1, 0),
        "manufacturer": (1, UINT16, 1, 0),
        "product": (2, UINT16, 1, 0),
        "serial_number": (3, UINT32Z, 1, 0),
        "time_created": (4, UINT32, 1, 0),
    }),
    "session": (18, {
        "timestamp": (253, UINT32, 1, 0),
        "start_time": (2, UINT32, 1, 0),
        "sport": (5, ENUM, 1, 0),
        "sub_sport": (6, ENUM, 1, 0),
        "total_elapsed_time": (7, UINT32, 1000, 0),
        "total_timer_time": (8, UINT32, 1000, 0),
        "total_distance": (9, UINT32, 100, 0),
        "total_calories": (11, UINT16, 1, 0),
        "avg_speed": (14, UINT16, 1000, 0),
        "avg_heart_rate": (16, UINT8, 1, 0),
        "max_heart_rate": (17, UINT8, 1, 0),
        "avg_power": (20, UINT16, 1, 0),
        "total_ascent": (22, UINT16, 1, 0),
        "normalized_power": (34, UINT16, 1, 0),
    }),
    "record": (20, {
        "timestamp": (253, UINT32, 1, 0),
        "position_lat": (0, SINT32, 1, 0),
        "position_long": (1, SINT32, 1, 0),
        "altitude": (2, UINT16, 5, 500),
        "heart_rate": (3, UINT8, 1, 0),
        "cadence": (4, UINT8, 1, 0),
        "distance": (5, UINT32, 100, 0),
        "speed": (6, UINT16, 1000, 0),
        "power": (7, UINT16, 1, 0),
    }),
    "lap": (19, {
        "timestamp": (253, UINT32, 1, 0),
        "start_time": (2, UINT32, 1, 0),
        "total_elapsed_time": (7, UINT32, 1000, 0),
        "total_timer_time": (8, UINT32, 1000, 0),
        "total_distance": (9, UINT32, 100, 0),
        "total_ascent": (21, UINT16, 1, 0),
        "lap_trigger": (24, ENUM, 1, 0),
    }),
    "activity": (34, {
        "timestamp": (253, UINT32, 1, 0),
        "total_timer_time": (0, UINT32, 1000, 0),
        "num_sessions": (1, UINT16, 1, 0),
        "type": (2, ENUM, 1, 0),
        "local_timestamp": (5, UINT32, 1, 0),
    }),
}

SPORTS = {"generic": 0, "running": 1, "cycling": 2, "swimming": 5, "training": 10}
SUB_SPORTS = {"generic": 0, "treadmill": 1, "trail": 3, "indoor_cycling": 6,
              "strength_training": 20}
LAP_TRIGGERS = {"manual": 0, "distance": 2, "session_end": 7}


def fit_time(dt: datetime) -> int:
    return int((dt - FIT_EPOCH).total_seconds())


def degrees_to_semicircles(deg: float) -> int:
    return int(deg * (2**31 / 180))


def _crc(data: bytes, crc: int = 0) -> int:
    table = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]
    for byte in data:
        tmp = table[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ table[byte & 0xF]
        tmp = table[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ table[(byte >> 4) & 0xF]
    return crc


class FitBuilder:
    def __init__(self) -> None:
        self._body = bytearray()
        self._defined: dict[int, tuple[str, tuple[str, ...]]] = {}

    def add(self, mesg: str, **values) -> "FitBuilder":
        """Append one data message. Datetime values are converted; None writes the invalid value."""
        global_num, fields = MESSAGES[mesg]
        names = tuple(n for n in fields if n in values)
        local = list(MESSAGES).index(mesg)
        if self._defined.get(local) != (mesg, names):
            self._body += struct.pack("<BBBHB", 0x40 | local, 0, 0, global_num, len(names))
            for n in names:
                num, (base, fmt, _), _, _ = fields[n]
                self._body += struct.pack("<BBB", num, struct.calcsize(fmt), base)
            self._defined[local] = (mesg, names)
        self._body += struct.pack("<B", local)
        for n in names:
            _, (_, fmt, invalid), scale, offset = fields[n]
            v = values[n]
            if v is None:
                raw = invalid
            elif isinstance(v, datetime):
                raw = fit_time(v)
            elif n == "sport":
                raw = SPORTS[v]
            elif n == "sub_sport":
                raw = SUB_SPORTS[v]
            elif n == "lap_trigger":
                raw = LAP_TRIGGERS[v]
            else:
                raw = round((v + offset) * scale)
            self._body += struct.pack("<" + fmt, raw)
        return self

    def build(self) -> bytes:
        header = struct.pack("<BBHI4s", 14, 0x20, 2132, len(self._body), b".FIT")
        header += struct.pack("<H", _crc(header))
        data = header + bytes(self._body)
        return data + struct.pack("<H", _crc(data))
