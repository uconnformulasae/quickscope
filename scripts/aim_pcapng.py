"""Stdlib-only pcapng reader for AiM port-2000 TCP captures.

Lets tests and analysis scripts replay Race Studio / QuickScope Wireshark
captures without tshark. Supports Ethernet + IPv4 + TCP, which is all the
AiM captures contain.

Usage::

    python scripts/aim_pcapng.py C:/Users/me/Downloads/RS3_PULL_242.pcapng
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

AIM_TCP_PORT = 2000
_BLOCK_IDB = 0x00000001
_BLOCK_EPB = 0x00000006
_ETHERTYPE_IPV4 = 0x0800
_IPPROTO_TCP = 6
_TCP_FLAG_SYN = 0x02


class PcapngError(ValueError):
    """Raised when a file is not a readable little-endian pcapng capture."""


@dataclass
class TcpSegment:
    ts: float
    is_client_to_server: bool
    seq: int
    flags: int
    payload: bytes


@dataclass
class TcpStream:
    """One TCP connection to the device, keyed by the client's (ip, port)."""

    client_ip: str
    client_port: int
    segments: list[TcpSegment] = field(default_factory=list)

    def payload_bytes(self, *, client_to_server: bool) -> int:
        return sum(
            len(s.payload) for s in self.segments if s.is_client_to_server == client_to_server
        )

    def reassemble(self, *, client_to_server: bool) -> bytes:
        """In-order byte stream for one direction; retransmits are de-duplicated."""
        segs = [s for s in self.segments if s.is_client_to_server == client_to_server]
        syn = next((s for s in segs if s.flags & _TCP_FLAG_SYN), None)
        data_segs = [s for s in segs if s.payload]
        if not data_segs:
            return b""
        base = (syn.seq + 1) if syn is not None else min(s.seq for s in data_segs)
        buf = bytearray()
        for seg in sorted(data_segs, key=lambda s: (s.seq - base) & 0xFFFFFFFF):
            offset = (seg.seq - base) & 0xFFFFFFFF
            end = offset + len(seg.payload)
            if end > len(buf):
                buf.extend(b"\x00" * (end - len(buf)))
            buf[offset:end] = seg.payload
        return bytes(buf)


def read_packets(path: str | Path) -> list[tuple[float, bytes]]:
    """Return ``(timestamp_s, link_layer_frame)`` for every Enhanced Packet Block."""
    data = Path(path).read_bytes()
    if data[:4] != b"\x0a\x0d\x0d\x0a":
        raise PcapngError(f"{path}: not a pcapng file")
    ts_resolution: dict[int, float] = {}
    packets: list[tuple[float, bytes]] = []
    offset = 0
    while offset + 12 <= len(data):
        block_type, block_len = struct.unpack_from("<II", data, offset)
        if block_len < 12 or offset + block_len > len(data):
            raise PcapngError(f"{path}: truncated block at offset {offset}")
        body = data[offset + 8 : offset + block_len - 4]
        if block_type == _BLOCK_IDB:
            ts_resolution[len(ts_resolution)] = _idb_ts_resolution(body)
        elif block_type == _BLOCK_EPB:
            iface, ts_high, ts_low, captured_len, _orig_len = struct.unpack_from("<IIIII", body, 0)
            resolution = ts_resolution.get(iface, 1e-6)
            packets.append((((ts_high << 32) | ts_low) * resolution, body[20 : 20 + captured_len]))
        offset += block_len
    return packets


def _idb_ts_resolution(body: bytes) -> float:
    option_offset = 8
    while option_offset + 4 <= len(body):
        code, length = struct.unpack_from("<HH", body, option_offset)
        if code == 0:
            break
        if code == 9 and length >= 1:  # if_tsresol
            value = body[option_offset + 4]
            exponent = value & 0x7F
            return 2.0**-exponent if value & 0x80 else 10.0**-exponent
        option_offset += 4 + ((length + 3) & ~3)
    return 1e-6


def tcp_streams(path: str | Path, port: int = AIM_TCP_PORT) -> list[TcpStream]:
    """All TCP connections to ``port`` in capture order."""
    streams: dict[tuple[str, int], TcpStream] = {}
    for ts, frame in read_packets(path):
        parsed = _parse_ipv4_tcp(frame)
        if parsed is None:
            continue
        src, dst, sport, dport, seq, flags, payload = parsed
        if port not in (sport, dport):
            continue
        is_c2s = dport == port
        key = (src, sport) if is_c2s else (dst, dport)
        stream = streams.setdefault(key, TcpStream(client_ip=key[0], client_port=key[1]))
        stream.segments.append(TcpSegment(ts, is_c2s, seq, flags, payload))
    return list(streams.values())


def _parse_ipv4_tcp(frame: bytes):
    if len(frame) < 34 or struct.unpack_from(">H", frame, 12)[0] != _ETHERTYPE_IPV4:
        return None
    ip = frame[14:]
    if ip[0] >> 4 != 4 or ip[9] != _IPPROTO_TCP:
        return None
    ihl = (ip[0] & 0x0F) * 4
    total_len = struct.unpack_from(">H", ip, 2)[0]
    tcp = ip[ihl:total_len]
    if len(tcp) < 20:
        return None
    sport, dport, seq = struct.unpack_from(">HHI", tcp, 0)
    data_offset = (tcp[12] >> 4) * 4
    src = ".".join(str(b) for b in ip[12:16])
    dst = ".".join(str(b) for b in ip[16:20])
    return src, dst, sport, dport, seq, tcp[13], bytes(tcp[data_offset:])


def largest_stream(path: str | Path, port: int = AIM_TCP_PORT) -> TcpStream:
    """The connection with the most device-to-client bytes (the log download)."""
    streams = tcp_streams(path, port)
    if not streams:
        raise PcapngError(f"{path}: no TCP traffic on port {port}")
    return max(streams, key=lambda s: s.payload_bytes(client_to_server=False))


def main(argv: list[str]) -> int:
    for path in argv:
        print(path)
        for stream in tcp_streams(path):
            segs = stream.segments
            print(
                f"  {stream.client_ip}:{stream.client_port}"
                f"  c2s={stream.payload_bytes(client_to_server=True)}"
                f"  s2c={stream.payload_bytes(client_to_server=False)}"
                f"  dur={segs[-1].ts - segs[0].ts:.2f}s"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
