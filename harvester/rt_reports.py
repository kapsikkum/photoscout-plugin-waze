"""Read AddAlertAction (2708) from Waze RT Batch, using dumped AoM schemas.

Field provenance: Waze 5.25.0.1 Container.proto, AoMCommands.proto,
AoMCommon.proto and Types.proto. Unknown commands are ignored.
"""
from protobuf import _fields

TYPES = {2: 'POLICE', 3: 'ACCIDENT', 4: 'JAM', 6: 'HAZARD', 8: 'CONSTRUCTION', 11: 'CAMERA', 13: 'ROAD_CLOSED', 103: 'HAZARD'}
POLICE_SUBTYPES = {201: 'POLICE_VISIBLE', 202: 'POLICE_HIDING', 203: 'POLICE_WITH_MOBILE_CAMERA'}


def _message(data):
    return {field: value for field, _, value in _fields(data)}


def _text(data, field):
    value = data.get(field)
    return value.decode('utf8', errors='replace') if isinstance(value, bytes) else None


def parse_rt_reports(data):
    alerts, removed = [], []
    for field, wire, element in _fields(data):
        if field != 1001 or wire != 2:
            continue
        for command, command_wire, payload in _fields(element):
            if command_wire != 2:
                continue
            if command == 2794:
                uuid = _text(_message(payload), 1)
                if uuid:
                    removed.append(uuid)
            if command != 2708:
                continue
            action = _message(payload)
            if not isinstance(action.get(1), bytes):
                continue
            alert = _message(action[1])
            info = _message(alert.get(2, b''))
            kind = TYPES.get(info.get(1))
            if not kind:
                continue
            point = _message(info.get(3, b''))
            if not isinstance(point.get(101), int) or not isinstance(point.get(102), int):
                continue
            signed = lambda value: ((value + 2**31) % 2**32) - 2**31
            lng, lat = signed(point[101]) / 1e6, signed(point[102]) / 1e6
            if abs(lng) > 180 or abs(lat) > 90:
                continue
            reporting = _message(alert.get(3, b''))
            details = _message(info.get(9, b''))
            police = _message(details.get(2, b''))
            address = _message(reporting.get(8, b''))
            uuid = _text(alert, 6)
            report_time = reporting.get(4)
            # report_time is UNIX seconds in this protocol, not pubMillis.
            alerts.append({'id': uuid or str(alert.get(1, '')), 'uuid': uuid,
                           'type': kind, 'subType': (({1: 'POLICE_DEFAULT', 2: 'POLICE_HIDDEN', 3: 'POLICE_MOBILE_CAMERA'}.get(police.get(1)) or POLICE_SUBTYPES.get(info.get(2))) if kind == 'POLICE' else None),
                           'bearing': info.get(6),
                           'point': [lng, lat], 'description': _text(reporting, 3),
                           'street': _text(address, 2), 'city': _text(address, 3),
                           'reportTime': report_time * 1000 if isinstance(report_time, int) else None,
                           'thumbsUp': reporting.get(9)})
    return alerts, removed
