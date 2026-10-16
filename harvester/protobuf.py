"""Bounded protobuf field decoding for the observed Waze RT messages."""
def _varint(data, pos):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise ValueError('Truncated protobuf varint')
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, pos
    raise ValueError('Oversized protobuf varint')


def _fields(data):
    pos = 0
    while pos < len(data):
        tag, pos = _varint(data, pos)
        field, wire = tag >> 3, tag & 7
        if not field:
            raise ValueError('Invalid protobuf field')
        if wire == 0:
            value, pos = _varint(data, pos)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            value, pos = data[pos:pos + size], pos + size
            if len(value) != size:
                raise ValueError('Truncated protobuf fixed field')
        elif wire == 2:
            size, pos = _varint(data, pos)
            value, pos = data[pos:pos + size], pos + size
            if len(value) != size:
                raise ValueError('Truncated protobuf bytes')
        else:
            raise ValueError('Unsupported protobuf wire type')
        yield field, wire, value
