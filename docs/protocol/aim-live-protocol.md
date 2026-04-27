# AiM EVO5 — WiFi Protocol (Live Data)

Reverse-engineered from `docs/protocol/captures/live1.pcapng` and
`live2.pcapng` (Race Studio 3 ↔ AiM EVO5, capture date 2026-04-23). All
findings here come from observed traffic; the byte-level layout has been
validated against ≥194 server live frames in Live 1 and ≥860 in Live 2.

> **Status:** spec validated by deep-dive analysis. The trailer u16 formula
> is decoded (`sum(payload) & 0xFFFF`, **2,318 / 2,318 captured outer frames
> match**). The 547-byte live frame's channel-offset → name map is extracted
> via the 13,608-byte channel-definitions frame (103 channels). The "iSLV /
> iHW / iUSR / iPTH / iLCK / iSST / iLTS / iPRL" inner-command set is
> structurally decoded. See companion documents for the byte-level work:
> - [aim-live-protocol-deep-dive.md](aim-live-protocol-deep-dive.md) —
>   per-question empirical decoding (CRC verification, STNC structure,
>   3-pass enumeration diff, kkk heartbeat, full channel map)
> - [aim-protocol-research.md](aim-protocol-research.md) — pointers into
>   `libxrk` and the wider AiM ecosystem confirming our findings against
>   independent sources

---

## 1. Network layout

| | |
|--|--|
| Device IP | `10.0.0.1` (AiM acts as a WiFi AP, "AiM-EVO5-00740-UConn-EV") |
| Device discovery | UDP broadcast, port `36002` |
| Live data channel | TCP, device port `2000` |
| Client-side TCP port | ephemeral (observed `60025`) |
| Frame cadence | client polls every ~250 ms; device replies in batches of 4 server frames per poll |

The client owns the cadence — the device only emits a 547-byte live snapshot
in response to a client request. No request, no data. Heartbeat is mandatory:
once connected, the client must keep sending the poll to avoid the device
considering it disconnected. **There is no separate "start streaming" command
and no separate "stop streaming" command** — Race Studio's pause/resume button
just stops drawing; the wire traffic continues identically. This was
verified by comparing Live 2 around the user-reported pause point (idx 600+,
t≈40s): the cycle is byte-identical before and after.

---

## 2. UDP discovery (port 36002)

### 2.1 Probe (client → broadcast / device)

Client sends a 6-byte UDP datagram from `10.0.0.10:36002` to `10.0.0.1:36002`
(or to the WiFi broadcast address for first-time discovery).

```
ASCII  : aim-ka
Hex    : 61 69 6d 2d 6b 61
Length : 6 bytes
```

(`ka` likely abbreviates "keep-alive"; this same probe is used during
discovery and as a periodic ping.)

The probe is repeated roughly once per second. In Live 1, the laptop sent
the probe ~90 times over the capture.

### 2.2 Reply (device → client)

Device replies with **244 bytes** containing identity strings:

```
offset  bytes  meaning
0       0xec 00 00 00              prefix (length-of-payload field, LE u32 = 236)
4       0x02 00 00 00              ?type marker
8       0x0a 00 00 01              client IP echo (10.0.0.10)
12      0x00 00 02 00              ?subnet/mask
16      0x1e 21 00 00              ?fixed
20..51  ASCII vehicle name         "UConn-EV" + zero pad to 32 bytes
52..67  zeros                      reserved
68..70  ASCII "idn"                start of inner identity block
71..74  0x01 38 00 11              fixed
75..78  0x03 b8 01 00              ?firmware/build
79..82  0x00 c4 d4 4d              ?model code
83..86  0x00 01 19 0d              ?
87..98  0x00 01 20 28 ...          flags + reserved
99..123 zeros                       reserved
124..159 ASCII model+serial+name   "AiM-EVO5-00740-UConn-EV" + zero pad
                                    format: "AiM-<MODEL>-<SERIAL>-<VEHICLE>"
160..243 zeros                      reserved
```

The model is parseable with the regex `^AiM-([A-Z0-9]+)-(\d+)-(.+?)\0`. The
serial number was `00740` in our capture. The vehicle name is also written to
offsets 20..51, but the version inside the `idn` block is canonical (it can
include hyphens; the leading copy gets truncated at the first NUL).

The reply is exactly **244 bytes** for our EVO5; longer for devices with more
auxiliary identity fields (haven't observed any).

---

## 3. TCP framing

After discovery, the client opens TCP to `10.0.0.1:2000`. All TCP traffic uses
the same outer envelope:

```
+----+------+------------+------+----+      +----+------+--------+----+
| <h | CMD4 |  LEN (u32) | FLAG |  > | data | <  | CMD4 | TR(u16)|  > |
+----+------+------------+------+----+      +----+------+--------+----+
  2     4         4         1     1  LEN       1     4      2       1
```

| field | bytes | meaning |
|--|--|--|
| header magic | 2 | ASCII `<h` |
| `CMD4` | 4 | 4-byte ASCII command code (e.g. `STCP`, `STNC`) |
| `LEN` | 4 | little-endian unsigned, length of `data` only (excludes header/trailer) |
| `FLAG` | 1 | observed 0x00 throughout; reserved |
| `>` | 1 | header end |
| `data` | `LEN` | payload (often contains an inner `<h<CMD>...><CMD>...>` sub-frame) |
| `<` | 1 | trailer start |
| `CMD4` | 4 | same command code as header (must match) |
| `TR` | 2 | little-endian u16; **`sum(payload_bytes) & 0xFFFF`**. Decoded by the deep-dive against 2,318 / 2,318 captured outer frames + 27 / 27 inner sub-frames with no exceptions; cross-confirmed against `libxrk`'s parser source. Senders MUST compute it correctly — empty-checksum or wrong-checksum frames are silently dropped by the device. |
| `>` | 1 | trailer end |

Total frame size = `LEN + 20`.

### 3.1 Outer command codes

Only two outer codes have been observed:

| `CMD4` | direction | role |
|--|--|--|
| `STCP` | both | "Studio TCP" — generic data envelope (carries acks, device responses, live data, inner sub-frames) |
| `STNC` | client→device only | "Studio Network Command" — client request/poll. Always 64-byte payload. |

### 3.2 Inner command codes (server → client only)

These appear inside `STCP` payloads as nested `<h<CMD4>...><CMD4>...>` blocks:

| `CMD4` | semantic |
|--|--|
| `iMST` | Master device info (3462-byte first frame contains identity + capabilities) |
| `iSLV` | Slave/sub-device info |
| `iHW ` (note trailing space) | Hardware info |
| `iUSR` | User/driver/vehicle info — `device=…|pilota=…|veicolo=…|campionato=…|venue_type=…|` (Italian field names) |
| `iPTH` | Filesystem path map (see §3.3) |
| `iLCK` | Lock/permission state |
| `iSST` | Session state |
| `iLTS` | Logged sessions index |
| `iPRL` | Profiles list |

Each inner command is observed exactly 3 times in our captures — they are
returned during the 3-pass enumeration handshake (§4.2). After that the
device only emits live `STCP` frames.

### 3.3 Filesystem map (`iPTH`)

The first `iPTH` payload exposes the device's logical filesystem:

```
media=0:,0:.NEW|
settings=0:/setup,0:/setup.NEW|
splash=0:/lgo,0:/lgo.NEW|
channels=0:/ch,0:/ch.NEW|
overlay=0:/ov,0:/ov.NEW|
ecustream=0:/ecu,0:/ecu.NEW|
can1stream=0:/can1,0:/can1.NEW|
can2stream=0:/can2,0:/can2.NEW|
can1stcrip=0:/can1,0:/can1.NEW|
can2stcrip=0:/can2,0:/can2.NEW|
mathchannels=0:/mth,0:/mth.NEW|
smarty=0:/smc,0:/smc.NEW|
shiftlights=0:/shf,0:/shf.NEW|
leds=0:/led,0:/led.NEW|
outputs=0:/out,0:/out.NEW|
messages=0:/msg,0:/msg.NEW|
popups=0:/pop,0:/pop.NEW|
dsplmeas=0:/dsm,0:/dsm.NEW|
tracks=0:/gps,0:/gps.NEW|
```

Each entry is `name=<live-path>,<staging-path>`. The `.NEW` paths are
write-staging slots used when Race Studio pushes config to the device. **For
read-only live data we never need these; they are documented for future
write-side features (e.g. pushing channels/track configurations).**

This also confirms that GPS/track data is stored at `0:/gps` on the device's
internal filesystem.

---

## 4. Connection lifecycle

### 4.1 Connect

1. Client sends UDP `aim-ka` probe on port 36002.
2. Device replies with 244-byte identity packet (§2.2).
3. Client opens TCP to `10.0.0.1:2000`.
4. Client sends an 8-byte STCP payload `00 00 00 00 06 08 00 00`.
   - First u32 = `0x00000000` (zero header).
   - Second u32 = `0x00000806` — empirically a "hello" sub-command. The
     trailing `0x08` matches the STCP `LEN` field and may double as an
     echo-of-length safety check.
5. Device replies with an 8-byte STCP payload `00 00 00 00 06 19 00 00`.
   - Second u32 = `0x00001906`. Treat this as "hello-ack". The exact
     semantics of byte 5 (`0x19` vs the client's `0x08`) are not understood
     yet; both values are constant across all our captures.

### 4.2 Enumeration (3-pass)

The client now drives a 3-pass sequence to read device identity, hardware,
filesystem, lock state, sessions, and profiles. Each pass is a fixed cycle:

```
  C → S   STNC  64 bytes      pass-N enumeration request
  S → C   STCP  64 bytes      ack ('A' → 'I')
  C → S   STCP  68 bytes      pass-N follow-up (date stamp + record count)
  S → C   STCP   4 bytes      micro-ack
  S → C   STCP  64 bytes      ack ('Q')
  C → S   STCP   4 bytes      micro-ack
  S → C   STCP  3462 bytes    payload (contains iMST + iSLV + iHW  + iUSR + iPTH + iLCK + iSST + iLTS + iPRL)
```

Three passes are observed; each carries the same inner data. We assume the
3× repetition is the device's way of asserting freshness (Race Studio
displays a "loading…" UI during this and we suspect it discards the first 2
copies and renders the 3rd).

For our client: do all three passes, take the third, ignore the first two.
The total bytes transferred during enumeration is ~31 KB.

The 68-byte STCP "follow-up" payload contains a date stamp:

```
offset  bytes                   meaning
0..11   00 00 00 00 00 00 00 00  zeros (envelope inner header)
        00 00 00 00
12..15  ea 07 00 00              year (LE u16) → 0x07ea = 2026
16..19  04 00 00 00              month (LE u32) → 4
20..23  18 00 00 00              day (LE u32) → 24
24..27  03 00 00 00              hour
28..31  2b 00 00 00              minute
32..35  00 00 00 00              second
36..67  duplicate of 0..31 with hour=23, minute=43 (timezone offset?)
```

We do not fully understand why two timestamps appear — likely "wall clock UTC"
and "device local". For our client, sending the host's current time in both
slots is sufficient.

### 4.3 Live data poll (steady state)

After enumeration, every cycle is exactly:

```
  S → C   STCP   547 bytes     LIVE DATA SNAPSHOT  ← the value
  C → S   STNC    64 bytes     poll request
  S → C   STCP    64 bytes     ack ('I')
  S → C   STCP    64 bytes     ack ('Q')
  C → S   STCP     4 bytes     micro-ack
  S → C   STCP    12 bytes     "kkk" heartbeat
```

Cadence: ~250 ms per cycle (≈4 Hz). Cycle observed unchanged for 71 s in
Live 1 and 134 s in Live 2 (including the user-reported "pause stream"
event — the pause is a Race Studio UI affordance; the wire traffic is
identical).

### 4.4 Disconnect

Race Studio simply closes the TCP socket on shutdown. No special goodbye
message is observed. Device emits a 12-byte `kkk` heartbeat as the final
frame in both captures.

---

## 5. The 547-byte live-data frame

This is the frame to parse for live values. Total length 547; observed 194
times in Live 1 and 860+ times in Live 2.

### 5.1 Layout (verified across 200+ frames)

```
offset    bytes  contents
[ 0..  3]    4   00 00 00 00                    constant header
[ 4.. 14]   11   subsystem tag + monotonic ts   varies frame-to-frame
                 [ 4..  7]   ASCII tag, e.g. "Syst", "Fuel", "kkk\x01"
                             (4 chars, name of the report subsystem)
                 [ 8.. 11]   monotonic counter (LE u32, ~ms)
                 [12.. 14]   subsystem flags
[15.. 35]   21   00 d7 00 00 00 ... 1a 00 00 00  constant
[36..  36]   1   varies (4 distinct: 0x50/'P', 0x51/'Q', etc)  subsystem code
[37..  37]   1   constant 0x4e ('N')
[38..  38]   1   varies (5 distinct values)     channel-count? subsystem version?
[39..  47]   9   72 00 00 00 00 00 00 00 00     constant ('r' + zero pad)
[48.. 50]    3   varies (timestamp echo of bytes 8..10)
[51..  51]   1   constant 0x00
[52.. 54]    3   varies (timestamp echo)
[55..  55]   1   constant 0x00
[56.. 58]    3   varies (timestamp echo)
[59..127]   69   constant block: 7× 8-byte slots of ff ff ff 7f 00 00 00 00
                 (signed-int max marker) + 5 bytes of trailer constants
[128..130]   3   CHANNEL VALUE 1 (LE int24-style or 3 bytes of a 4-byte LE u32 with byte 131 always 0)
[131..139]   9   constant 00 b5 b0 01 00 4c 20 2f 01
[140..142]   3   CHANNEL VALUE 2
[143..151]   9   constant 00 4d 18 00 00 19 08 01 00
[152..154]   3   CHANNEL VALUE 3
[155..163]   9   constant 00 39 3a 00 00 ba 51 02 00
[164..166]   3   CHANNEL VALUE 4
[167..175]   9   constant 00 72 35 00 00 fb 81 02 00
[176..178]   3   CHANNEL VALUE 5
[179..179]   1   constant 0x00
[180..182]   3   CHANNEL VALUE 6
[183..183]   1   constant 0x00
[184..186]   3   CHANNEL VALUE 7
[187..195]   9   constant 1a 00 00 00 00 6f 09 03 0c
[196..198]   3   CHANNEL VALUE 8 / event flags
[199..199]   1   constant 0x08
[200..201]   2   value-pair A (likely u16)
[202..203]   2   constant f6 e4
[204..205]   2   value-pair B (likely u16)
[206..207]   2   constant 35 19
[208..208]   1   constant 0x40
[209..211]   3   constant 00 00 00
[212..224]  13   "main float block" — looks like 4× IEEE 754 float32 LE
                 (RPM, speed, voltage, temperature?). Channel mapping is
                 device-specific — see §7.
[225..227]   3   constant 00 00 00
[228..228]   1   varies (14 distinct)
[229..230]   2   constant 00 00
[231..231]   1   varies (5 distinct)
[232..239]   8   constant 00 10 00 00 00 00 00 00
[240..255]  16   "main float block 2" — heavy variation across all 16 bytes,
                 4× float32 LE; primary live channels (channel offsets vary
                 by device configuration)
[256..260]   5   constant 00 00 80 ff 59
[261..262]   2   varies — likely a CRC of bytes [0..260]
[263..455] 193   constant — channel template / inactive-slot block
                 (filled with 0x80 0xff signed-int markers + the IEEE 754
                 floats 0x803f = 1.0f and 0xf042 = 60.0f)
[456..462]   7   varies (small distinct counts, 2 each — slow-changing)
[463..478]  16   constant 44 12 0f 18 44 81 00 00 00 ... 00
[479..480]   2   varies (3 distinct, 2 distinct)
[481..537]  57   constant — tail-end channel template
[538..538]   1   varies
[539..540]   2   constant c4 46  (= float 0.0244 maybe — half marker?)
[541..542]   2   varies
[543..546]   4   constant 7b 45 01 00
```

### 5.2 What we know for sure

- The frame size is **always 547 bytes** in our captures.
- Bytes [4..14] identify the **subsystem** generating this snapshot. Three
  values seen: `System` (system info), `Fuel Use` (fuel-channel sample), and
  `kkk\x01\x00\x00\x00\x00` (generic channel state — the most common).
- Bytes [8..11] are a monotonic counter (units appear to be ms; the device
  uptime in our capture aligns with this scale).
- The constant blocks at [263..455] and [481..537] are channel-config
  templates: each 12-byte slot contains either `0x80 0xff 0xff 0xff` × N
  (inactive marker) or an active channel float with its name and unit.
- Bytes [212..224] and [240..255] are the **primary value blocks** —
  little-endian IEEE 754 float32, four values each. Approximate channel
  mapping (to be confirmed by cross-referencing with the `MCLK Master Clk`
  channel-config table from the 13608-byte enumeration frame): RPM, speed,
  steering, throttle, brake, lateral-G, longitudinal-G, voltage.

### 5.3 What needs verification before shipping

- **CRC.** Bytes [261..262] vary in a way consistent with a small CRC over
  earlier bytes. Until decoded, our client should accept all incoming frames
  regardless and validate at the application level (sanity-check value ranges).
  When *sending* (we don't yet — we're read-only), we'll need to compute it.
- **Channel offset → channel name mapping.** The 13608-byte
  channel-definitions frame (idx 47 in Live 1) is parsed but not yet
  decoded. The implementation plan in §6 includes that step.

---

## 6. Implementation plan (read-only client)

```
backend/services/aim_live.py   (new)
  AimLiveClient
    .discover()           UDP probe + parse identity
    .connect(host)        TCP open + hello + enumeration
    .poll()               one cycle; returns LiveSnapshot (subsystem, ts, channels)
    .stream()             async generator yielding LiveSnapshot every ~250ms
    .close()
```

The client owns its own asyncio loop. The existing `aim_connector.py`
(already implements UDP discovery + TCP session-list download for downloaded
sessions) is for **downloaded session retrieval**, a different mode that
shares only the discovery step. Don't shoehorn live into it; add a sibling.

WebSocket bridge: `backend/routes/live.py` exposes `GET /api/live/ws` that
upgrades to WebSocket, wraps `AimLiveClient.stream()`, and forwards each
`LiveSnapshot` as JSON `{ts, subsystem, channels: {name: value}}`.

Frontend: a new `LiveView.tsx` subscribes to the WebSocket, maintains a
ring buffer of the last 60 s of data, and renders it on the existing
`TelemetryChart` (we re-use the same chart engine; just feed it a synthetic
session whose samples grow as new frames arrive).

---

## 7. Resolved questions and remaining gaps

The original "Open questions" section in this doc has been answered as
follows. Full evidence and per-question scripts live in
[`aim-live-protocol-deep-dive.md`](aim-live-protocol-deep-dive.md).

**Resolved:**

1. **Trailer u16** — DECODED as `sum(payload) & 0xFFFF`, 2,318/2,318 match.
   See §3.
2. **3-pass enumeration** — DECODED. The three copies are byte-identical
   except for one byte in `iLTS` (the seconds digit of the device's wall
   clock). It's plain redundancy, not delta/snapshot/end. A client can
   safely take the first pass and ignore the other two.
3. **Channel offset → name mapping** — HIGH confidence. The 13,608-byte
   channel-definitions frame is **103 records of 132 bytes each**, parsed
   directly via `libxrk`'s `parse_xrk_bytes`. The mapping rule is
   `live_offset = channel_def_logical_offset + 12`. 103 channels mapped;
   sanity-checked against known stationary-EV values: SOC=85.5%,
   Pack_Voltage=405.5V, Pack_Temp=20.0°C, BMS_Disch_Lim=120A.
4. **Subsystem tag set at [4..14]** — three values observed in our
   captures: `System` (system info update), `Fuel Use` (fuel sample), and
   `kkk\x01\x00\x00\x00\x00` (generic state — most common). What
   determines which fires when is still uncertain (only one each of
   `System`/`Fuel Use` was captured).
5. **The IMU block** — RECLASSIFIED. The original spec called bytes
   [212..224] the "main float block" (4× float32). It's actually 6× s16
   covering InlA, LatA, VerA, RollRate, PitchRate, YawRate.
6. **STNC payload structure** — DECODED. 64-byte payload: bytes 8..10 are
   a u24 selector, byte 24 is opcode `'A'` (REQUEST), the rest is zero.
   Two steady-state selectors: `0x00020003` triggers a 547-byte live
   snapshot, `0x00020053` triggers a 12-byte heartbeat.
7. **Server STCP-64 ack format** — bytes 16..19 of the `Q` ack carry
   `(next-frame-payload-length) - 4` — a load-bearing length hint that
   clients can use for buffer pre-allocation.

**Remaining gaps (low priority — none block read-only live streaming):**

- **GPS sub-struct field meanings** — need a moving capture with GPS
  lock; our test vehicle was stationary.
- **Exact unit / scale calibration for raw-count channels** (LogT,
  external VBat, several IMU channels). The `u32_at_84..u32_at_92` fields
  in the channel-def record are likely scale + unit codes but the
  encoding isn't fully decoded.
- **The `idn 0x01 0x38 0x00 0x11` magic** in the UDP reply and 3462-byte
  iMST. Constant across our captures; appears to be a shared identifier
  marker.
- **The `kkk` heartbeat byte 7** (`0x01` in all captures). Could be a
  version field or a status nibble; can't tell from our data.

---

## 8. References

- `docs/protocol/captures/live1.pcapng` — connect → enumerate → 70 s of live
- `docs/protocol/captures/live2.pcapng` — connect → 134 s of live including
  a Race Studio "pause stream" UI event at t≈40 s (no wire effect)
- `docs/protocol/captures/parse_aim_stream.py` — frame parser used to
  generate the per-command analysis
- `docs/protocol/captures/parse_chronological.py` — chronological merger
  used to identify cycle structure
- `docs/protocol/captures/extract_547.py` — column-by-column variability
  analysis used to reverse-engineer §5.1
- `backend/services/aim_connector.py` — existing UDP-discovery code (we will
  reuse §2.1 and §2.2 from it)
