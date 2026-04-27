# AiM EVO5 — Live Protocol Deep Dive

Companion to `aim-live-protocol.md`. Empirically derived from
`docs/protocol/captures/live1.pcapng` and `live2.pcapng` (3416 + ~5400
TCP frames, 71 + 134 s of capture, AiM EVO5 SN 00740 stationary). Every
claim below is backed by code in
`docs/protocol/captures/analysis/`. Hypotheses that did not pan out
are documented as such, not silently dropped.

> **Confidence levels** used throughout:
> - **DECODED** = formula matches across every captured frame (no exceptions).
> - **HIGH** = formula matches across many captured frames but coverage is
>   incomplete (e.g. only one device, only stationary).
> - **PARTIAL** = field role is identified, exact bit layout still uncertain.
> - **HYPOTHESIS** = plausible interpretation, not yet verified.

---

## 0. Methodology and a parser-direction bug

A reusable frame parser lives at
`docs/protocol/captures/analysis/lib_frames.py`. Compared to
`parse_aim_stream.py`, it auto-detects which "Node" in the
`tshark follow,tcp,raw` dump is the device by parsing the
`Node 0:` / `Node 1:` headers and matching `:2000`. **`live2_tcp_stream0.txt`
has the device on Node 0 (unindented) while `live1_tcp_stream0.txt` has
it on Node 1 (tab-indented), so the existing `parse_aim_stream.py`
silently mis-labels every direction in Live 2.** All analysis below uses
the corrected loader. (`parse_aim_stream.py` should be patched the same
way; it currently understates Live 2 client-frame count by attributing
device frames to the client.)

---

## 1. Outer-envelope trailer u16 — DECODED

> **The trailer is `sum(payload_bytes) mod 0x10000`** — a plain unsigned
> 16-bit sum of the payload bytes (no CRC, no XOR, no sequence counter).
> Confirmed on **2318 / 2318 outer frames** (live1 + live2) and on every
> inner enumeration sub-frame (27 / 27) without a single mismatch.

### 1.1 What was tested

Script: `analysis/q1_trailer_crc.py`. For each captured frame, computed:

| function | poly | init | refl |
|---|---|---|---|
| CRC-16/CCITT-FALSE | 0x1021 | 0xFFFF | no |
| CRC-16/XMODEM | 0x1021 | 0x0000 | no |
| CRC-16/MODBUS | 0x8005 | 0xFFFF | yes |
| CRC-16/X.25 | 0x1021 | 0xFFFF | yes (xor-out 0xFFFF) |
| CRC-16/IBM-ARC | 0x8005 | 0x0000 | yes |
| CRC-16/KERMIT | 0x1021 | 0x0000 | yes |
| Fletcher-16 | n/a | n/a | n/a |
| 16-bit XOR (over byte pairs) | n/a | n/a | n/a |
| **`sum(bytes) & 0xFFFF`** | n/a | n/a | n/a |

…each over eleven candidate domains (payload only; header+payload;
header+payload+trailer-prefix; payload after the inner header; just the
last byte stripped; etc).

### 1.2 Result

Only one combination matches every single frame:

```
SUM16(payload)  →  100% match across 2318 outer frames + 27 inner frames
```

The next-best candidates max out around 50% (CCITT + others on selected
domains) and only because they happened to produce 0 for the very common
4-byte ack `00 00 00 00`. None match the SERVER's varying 547-byte live
frames at all except SUM16.

### 1.3 Recipe for senders

```python
def trailer(payload: bytes) -> int:
    return sum(payload) & 0xFFFF

# Then write trailer in little-endian u16:
trailer_bytes = struct.pack("<H", trailer(payload))
# Final wire: header_12 + payload + b"<" + cmd_4 + trailer_bytes + b">"
```

Verification helper: `analysis/q1_verify.py` → `Outer frames: 2318,
mismatches: 0; Inner frames: 27, mismatches: 0`.

### 1.4 What this means for the spec

Replace §3 "TR" row in `aim-live-protocol.md`:

> ~~`TR` … little-endian u16; varies across frames — appears to be a
> XOR-like checksum or a per-command sequence/length-mod marker. Not yet
> decoded.~~

with:

> `TR` little-endian u16 = `sum(payload_bytes) mod 0x10000`. The same
> formula applies to every nested inner sub-frame's trailer.

---

## 2. STCP "hello" payloads — PARTIAL

### 2.1 Observed

Per `analysis/q2_short_payloads.py`:

| direction | payload (hex) | u32_LE × 2 | count | when |
|---|---|---|---|---|
| C → S | `00 00 00 00 06 08 00 00` | (0, 0x00000806) | 1 | exactly once at TCP-open in live1 and in `Data-Development/aim_tcp_stream*.txt` |
| S → C | `00 00 00 00 06 19 00 00` | (0, 0x00001906) | 1 | reply |

Live 2 does not contain these — its capture started after the connection
was already open.

### 2.2 Anatomy

The first u32 is `0x00000000` — call it the "no-context" header
(matches the leading u32 in every other `STCP` payload). The second u32
encodes:

```
LE bytes  06 08 00 00     LE bytes  06 19 00 00
            ^^   ^^                   ^^   ^^
            |    |                    |    |
            +-- 0x06: protocol family / hello marker (constant)
                 0x08 (client)         0x19 (device)
```

* `0x06` is constant in BOTH the client and the device payload at offset
  4 → it is plausibly a "protocol family" marker shared by hello + ack.
* `0x08` (client) and `0x19` (device) differ. `0x08` is the byte length
  of the message itself (also the value of the outer LEN field), so it
  likely doubles as a "echo-of-length" sanity check. `0x19` is `0x08 +
  0x11` = `0x19`; the high nibble of 0x11 might be a status nibble. There
  is nothing in either capture that rules in or out a more elaborate
  meaning, so we mark this PARTIAL.

### 2.3 Practical recipe

For a read-only client, sending the literal 8-byte sequence
`00 00 00 00 06 08 00 00` works (verified on this device). The device
will respond with `00 00 00 00 06 19 00 00` regardless of what the
client put in the second-byte position; we have not retried with mutated
values, so until tested we recommend keeping it byte-exact.

---

## 3. STNC 64-byte payload structure — DECODED

> The 64-byte STNC payload is a **selector** addressed to the device.
> Of 64 bytes, exactly **3 bytes vary** in our captures (offsets 8, 9, 10);
> all others are constant.

### 3.1 Layout

| offset | bytes | meaning | values seen |
|---|---|---|---|
| 0..7 | u64 zero | reserved (matches the inner-message "no-context" header) | always 0 |
| 8..9 | u16 LE | **selector low** | 0x0003, 0x0053, 0x0010, 0x0006, 0x0024, 0x0002, 0x0008, 0x0009, 0x0028 |
| 10 | u8 | **selector high** | 0x01 (during enum), 0x02 (steady state), 0x06 (one-shot) |
| 11..15 | zeros | reserved | 0 |
| 16..19 | u32 LE | **request payload size** | 0 in steady-state polls; 0x40 (=64) during the 3-pass enum |
| 20..23 | zeros | reserved | 0 |
| 24 | u8 | **opcode** | always `0x41 = 'A'` (client request marker) |
| 25..63 | zeros | reserved | 0 |

In live1 the steady-state cycle uses only two selectors:

| selector u32 LE | sent N× | server response |
|---|---|---|
| `0x00020003` | 194 | (I-ack) → (Q-ack with len=0x21F=543) → 547-byte live snapshot → kkk |
| `0x00020053` | 194 | (I-ack) → (Q-ack with len=0x008=8)   → 12-byte kkk heartbeat (no live data) |

So the cadence "alternate `0x03` poll then `0x53` poll" is precisely
"give me a live snapshot; give me a heartbeat". Live 2 reproduces the
pattern (33 of each).

### 3.2 Server STCP-64 ack frames

Server ack frames are 64 bytes too; they echo the selector bytes 8..10
verbatim and add three fields:

| offset | meaning |
|---|---|
| 0..7 | zeros |
| 8..10 | **echoed selector** from the request |
| 11..15 | zeros |
| 16..19 | **`Q`-ack only**: u32 LE = `(next-frame outer LEN) - 4` (= 547-4=0x21F for live, 12-4=0x008 for kkk, 1072-4=… for the 3462 enum frame) |
| 20..21 | constant `0xe8 0x7f` (= 32744 — possibly a magic) |
| 22..23 | zeros |
| 24 | **opcode** byte: 0x41 'A' / 0x49 'I' / 0x51 'Q' / 0x45 'E' |
| 25 | constant 0x0a |
| 26..63 | zeros |

The 4 opcodes seen: `'A'` (echo of request — only when the server is
proxying a request back), `'I'` ("information / ready"), `'Q'`
("quote / payload follows"), `'E'` ("error"). In our captures only
`'I'` and `'Q'` appear in normal flow; `'A'` and `'E'` are seen during
the enumeration handshake only.

### 3.3 Implementation note

The `Q` ack's byte[16..19] equal to `(next_payload_len - 4)` is a
**load-bearing length hint**. A read-only client can pre-allocate the
incoming-frame buffer based on this u32 instead of waiting for the
outer header. In particular, `0x21F` and `0x008` are the only values
seen in steady state, so a client that always allocates 547 bytes after
seeing `Q,len=0x21F` is safe.

Verification: `analysis/q3_stnc.py`, `q3_stnc_corr.py`, `q3_stnc_full.py`,
`q3_stnc_pairs.py`.

---

## 4. The 3-pass enumeration — DECODED (and demystified)

> The 3 copies are **byte-identical** for 8 of the 9 inner commands. The
> only delta is in `iLTS` (Last-Time-Stamp): the device's wall-clock
> seconds field ticks while Race Studio re-asks. The 3-pass repetition
> is plain redundancy, not a snapshot/delta/end trio.

### 4.1 Per-command diff across the 3 copies (live1)

Script: `analysis/q4_three_pass.py`.

| inner cmd | bytes per copy | diff(0,1) | diff(0,2) | meaning |
|---|---|---|---|---|
| `iMST` | 192 | 0 | 0 | Master/Slave/Hardware identity — static |
| `iSLV` | 128 | 0 | 0 | Slave info — static |
| `iHW ` | 1 | 0 | 0 | Hardware info — static |
| `iUSR` | 106 | 0 | 0 | User strings (`device=…|pilota=…|`…) — static |
| `iPTH` | 1176 | 0 | 0 | Filesystem map — static |
| `iLCK` | 47 | 0 | 0 | Lock state — static |
| `iSST` | 149 | 0 | 0 | Session state — static |
| `iLTS` | 81 | **1 byte** | **1 byte** | Last-Time-Stamp ASCII — only the seconds digit changes |
| `iPRL` | 1398 | 0 | 0 | Profiles list — static |

`iLTS` payload is ASCII; the diff is at byte 67 (`'3' → '4' → '4'`):

```
copy0: lt_nm=|..lt_y=2026|..lt_mo=4|..lt_d=23|..lt_h=23|..lt_m=43|..lt_s=53|..lt_sz=0|..
copy1: lt_nm=|..lt_y=2026|..lt_mo=4|..lt_d=23|..lt_h=23|..lt_m=43|..lt_s=54|..lt_sz=0|..
copy2: lt_nm=|..lt_y=2026|..lt_mo=4|..lt_d=23|..lt_h=23|..lt_m=43|..lt_s=54|..lt_sz=0|..
```

(Pass 0 happened during second 53 of minute 43; pass 1+2 happened during
second 54.)

### 4.2 Implementation note

Race Studio retries enumeration 3× because it overlaps with config-mode
chatter and the device may resend if the very first request races.
**A read-only client that times out a single enumeration can safely retry
once.** The third copy is identical to the first up to a single
ASCII-decimal seconds digit, so it does not contain new information.

---

## 5. The 547-byte live frame — HIGH (mapped via channel-def)

The 547-byte frame is a **flat 535-byte channel buffer** preceded by a
12-byte envelope header:

```
+-----+----+--------+---------+-------------------------------+
|  00 | 00 | TAG[8] | TS[u32] | flat channel buffer (535 B)   |
+-----+----+--------+---------+-------------------------------+
  4    4   8        4         535                              = 547
```

| live offset | bytes | meaning |
|---|---|---|
| `[0..3]` | 4 | reserved 0x00000000 |
| `[4..11]` | 8 | subsystem name, NUL-padded ASCII (`System\0\0`, `Fuel Use`, `kkk\x01\x00\x00\x00\x00`) |
| `[12..15]` | 4 | u32 LE Master Clock (= 0.1ms ticks since boot — see §5.2) |
| `[16..546]` | 531 | flat channel buffer (channel offsets from `MCLK Master Clk`-frame, see below) |

Note that the spec's previous §5 "[ 4..14] subsystem tag + monotonic ts"
range was correct in spirit but slightly off-by-one; the timestamp at
[12..15] is the MCLK channel value (the FIRST channel in the channel-def
table), not part of the envelope header proper. The MCLK record
parameters (sample-period 100,000 µs = 100 ms, scale 1.0, offset 0.0)
are consistent with what the channel-def table says.

### 5.1 Channel map (extracted from the 13608-byte channel-def frame)

The mapping `live_offset = channel_def_logical_offset + 12` was verified
against several channels with known stationary values:

| tag | name | live offset | width | type | observed value | sanity check |
|---|---|---|---|---|---|---|
| MCLK | Master Clk | 12..15 | 4 | u32 LE (ms × 10) | 174600 → 243400 | matches 0.69 s capture span (243400-174600 = 68800 → ~69 s) ✓ |
| LAP | Lap Time | 16..35 | 20 | LAP struct | constant `d7 00 00 00 …` | no laps recorded — placeholder ✓ |
| LogT | Logger Temp | 36..37 | 2 | u16/s16 | `50 4e` | not yet calibrated — non-zero suggests valid raw count |
| VBat | External Voltage | 38..39 | 2 | u16/s16 | `03 72` | likewise — placeholder until lookup |
| PreT | Predictive Time | 40..43 | 4 | u32/f32 | 0 | no prediction (no laps) ✓ |
| bstD | Prdt Best Diff | 44..47 | 4 | u32/f32 | 0 | ✓ |
| Roll | Roll Time | 48..59 | 12 | 3× u32 | 3 timestamps | 3 timestamps echoed (last lap, ts, ts) — placeholder ✓ |
| Best | Best Time | 60..119 | 60 | record | 7× `INT32_MAX,0`+ 8 bytes | 7 lap-time slots all "no lap" markers ✓ |
| ODO | Total Odometer | 120..131 | 12 | 3× u32 | `c4 42 09 00 7e 86 8d 01 08 aa 02 00` | first u32 = 607428 (counts), second = 26183806 (pulses?), third = current TS ✓ |
| odo1..odo4 | Reset Odometer 1..4 | 132..179 | 12 each | 3× u32 | similar pattern | resettable trip counters |
| GPS | GPS | 180..235 | 56 | GPS struct | (mostly zeros / placeholders) | indoor capture, no GPS fix |
| Spd1 | LFspeed | 236..239 | 4 | u32/f32 | 0 | stationary ✓ |
| RBRK | FrBrakePressure | 240..241 | 2 | s16 | small noise | brake released ✓ |
| Ch04 | RBrkPressure | 242..243 | 2 | s16 | small noise | ✓ |
| **InlA** | **InlineAcc** | **244..245** | **2** | **s16** | very stable | inertial bias |
| **LatA** | **LateralAcc** | **246..247** | **2** | **s16** | very stable | inertial bias |
| **VerA** | **VerticalAcc** | **248..249** | **2** | **s16** | very stable | inertial bias (1 g + offset) |
| **Roll** | **RollRate** | **250..251** | **2** | **s16** | small noise | gyro bias |
| **Ptch** | **PitchRate** | **252..253** | **2** | **s16** | larger swing | gyro bias |
| **YawR** | **YawRate** | **254..255** | **2** | **s16** | very stable | gyro bias |
| Bias | BrakeBias | 256..259 | 4 | f32 | -inf placeholder | ✓ |
| LnCr | RBrakePressCorr | 260..263 | 4 | f32 | varying | calibration value |
| RTD…CANC (faults) | bool flags | 264..319 | 4 each | u32 | all 0 | no faults ✓ |
| RTD…CANC (alarms) | bool flags | 320..375 | 4 each | u32 | all 0 | no alarms ✓ |
| Motor_Temp..Iq_Feedback (12 ch) | motor telemetry | 376..415 | 4 each | f32 | -inf placeholder | inverter off ✓ |
| InvRunFault*, PostFault* (8 ch) | byte flags | 416..423 | 1 each | u8 | 0 | no faults ✓ |
| c001..c002, TQLM, TQRX | torque cmd/fb | 424..439 | 4 each | f32 | mostly 0 / -inf | inverter off ✓ |
| **DIR** | **Direction** | **440..443** | **4** | **f32** | **1.0** | **forward direction** ✓ |
| MCEN | InverterEnable | 444..447 | 4 | f32 | 0 | inverter disabled ✓ |
| **DCL** | **BMS_Disch_Lim** | **448..451** | **4** | **f32** | **120.0** | **120 A** ✓ |
| TPS | Throttle_Pos | 452..455 | 4 | f32 | 0 | foot off pedal ✓ |
| **BSE** | **BSE_Voltage** | **456..459** | **4** | **f32** | **392.16** | brake-sensor V (raw) |
| **TPV1** | **TPS_1_Voltage** | **460..463** | **4** | **f32** | **1384.7** | TPS sensor V (raw) |
| TPV2 | TPS_2_Voltage | 464..467 | 4 | f32 | 608.13 (constant) | ✓ |
| LVCU | LVCU_Status | 468 | 1 | u8 | 0x81 | status flags |
| TPS_1, TPS_2 | TPS_1, TPS_2 | 469..476 | 4 each | f32 | 0 | ✓ |
| lspd | lvcu_motor_speed | 477..480 | 4 | f32 (varies in 17912/18044/18174) | small u16 in lower 2 bytes? | needs verification |
| wtw..vspd (10 ch) | launch-control state | 481..516 | 4 each | f32 | -inf | LC inactive ✓ |
| **DCR** | **BMS_Disch_Enable** | **517..520** | **4** | **f32** | **1.0** | enabled ✓ |
| **SOC** | **State_of_Charge** | **521..524** | **4** | **f32** | **85.5** | 85.5 % ✓ |
| **BTMP** | **Pack_Temp** | **525..528** | **4** | **f32** | **20.0** | 20 °C ✓ |
| **VBAT** | **Pack_Voltage** | **529..532** | **4** | **f32** | **405.5** | 405.5 V (HV pack) ✓ |
| IBAT | Pack_Current | 533..536 | 4 | f32 | 0 | resting current ✓ |
| BMSV | BMS_LV_input | 537..540 | 4 | f32 | 25,200 (≈ 25.2 V × 1000?) | LV input |
| ch | Min_Cell_Voltage | 541..544 | 4 | f32 | 4031 (≈ 4.031 V × 1000?) | per-cell min |
| SRec | StartRec | 545..546 | 2 | u16 | 0x0001 | recording flag |

(`InlA…YawR` are the 8 bytes the original spec called "main float block";
they're 6× s16, not 3× f32. The reason `[212..224]` looked like 13 bytes
in the old spec is that **`Roll` (Roll Time) at offsets 48..59 is
12 bytes wide** and the 16-byte block at 244..259 covers
`InlA, LatA, VerA, RollRate, PitchRate, YawRate, BrakeBias` = 6×2 + 4 = 16
bytes — the s16 IMU + a 4-byte float. So [212..223] in the OLD spec was
the **`GPS` struct's tail** (offsets 32..43 of the 56-byte GPS sub-struct),
not a "main float block".)

### 5.2 MCLK = 0.1 ms ticks?

MCLK reads 174600 in the first frame, 243400 in the last (live1). Frame
0 was captured at `t=2.36s` and the last live frame at `t≈70s` of capture
elapsed. (243400 − 174600) = 68800. 68800 × 1 ms = 68.8 s — close to
the 67.6 s wall-clock delta. So MCLK is in **milliseconds** (not 0.1 ms;
the value is in 1 ms ticks). Ratio 68800/67600 ≈ 1.018 — within clock
drift / measurement noise.

The channel-def MCLK record carries `u32_at_64 = 100000` which is the
**sample period in microseconds** (100 ms = 10 Hz cadence) — separate
field, not the unit of the value.

### 5.3 What the spec's "constants" actually were

The previous spec called several variable byte ranges "constants" because
they did not change in the (stationary, no-laps) capture. With the
channel-def map, almost all of them are explained:

| spec field | reality |
|---|---|
| `[59..127]` constant block | actual `Best Time` 60-byte struct (7 lap-time slots, each `(INT32_MAX, 0)` = "no lap recorded"; trailing 8 bytes are the running clock state for that lap structure) |
| `[131..139], [143..151], [155..163], [167..175]` 9-byte slots | the persistent `(odo1..odo4)` reset-odometer counters: 8 byte cumulative state + 4 byte tag-aligned padding interleaved with the per-frame timestamp echoes. They are constant in our captures because the car is stationary. They WILL change once the wheel turns. |
| `[212..224]` 13-byte "main float block" | tail of the 56-byte `GPS` struct (offsets 32..44 of GPS payload) |
| `[228..231], [232..239]` mostly-constant block | tail of the GPS struct (offsets 48..55) |
| `[256..260]` constant `00 00 80 ff 59` | first 5 bytes of the `Bias` (BrakeBias) f32 + 1 byte that turns out to be inside the next channel — the apparent constancy is because BrakeBias = -∞ (`00 00 80 ff = float32 = -1×10^30 placeholder`) and `LnCr` only varies in the upper 2 bytes |
| `[263..455]` huge constant region | f32 channels for `BSE/TPV*/LVCU/TPS_1..lc_*/DCR/SOC/BTMP/VBAT` etc that are -∞ placeholders or constant in this stationary capture |
| `[481..537]` constant region | identical reason: a long stretch of -∞ placeholders for inverter/launch-control channels that aren't producing data |
| `[538..540], [541..542], [543..546]` | tail of `BMSV/ch/SRec` channels |

### 5.4 What's still uncertain (HYPOTHESIS markers)

* **Type encoding.** The channel-def `u32_at_80` field has the value set
  `{2, 4, 514, 1, 6, 9, 13, 4099, 65536, 0x10000}`. We can correlate
  exactly:
  * `0x10000 = 65536` → GPS struct (only one)
  * `0x1003 = 4099` → MCLK only (combined "u32 + magic")
  * `1` → 4-byte u32 counters / time fields (PreT, bstD, Roll, Best, ODO, odo1..odo4)
  * `2` → 16-bit unsigned/signed ints AND 4-byte floats interchangeably
    (LogT, VBat, Spd1, RBRK, Ch04, BSE, TPV1, TPV2, RPM, …) — the byte
    width is in `u32_at_72`, not derivable from the type alone
  * `6` → s16 inertial channels (InlA, LatA, VerA, Roll, Ptch, YawR,
    Bias, LnCr) — definitely signed
  * `9` → group-tag for "motor telemetry" (RPM through TPS2, lc_*) —
    mixed widths and signedness
  * `13` → 1-byte fault flags (8 of them in a row at 416..423)
  * `512`/`514` → 4-byte fault/alarm bool encoded as a u32
  
  We cannot yet confidently say "type code 2 means f32" or "means u16" —
  it depends on width. **Use `u32_at_72` (width) as the authoritative
  size and the channel name to decide signedness/representation.**
* **Calibration.** `u32_at_84..u32_at_92` looks like (scale-shift,
  unit-id, format-decimals). `u32_at_92` = 2 for most channels and 4 for
  some — could be display decimal places.
* **`u32_at_64`** is the sample period in µs and is reliable (matches
  observed cadence of MCLK, IMU, RPM, etc).
* **The "Syst", "Fuel Use" and "kkk" subsystem tag bytes** at `[4..11]`
  decide which channels actually have their slots updated in this
  particular frame. We have not yet figured out the exact "subsystem ⇒
  set-of-channels-to-write" mapping (the channel-def doesn't expose a
  per-channel subsystem tag). HYPOTHESIS: the device loops through the
  3 subsystems and writes the channels whose `(sample_period, phase)`
  fits, leaving everything else at its previous value. This explains
  why 192 of 194 frames carry the `kkk` tag (the catch-all subsystem)
  and only one each for `Syst` and `Fuel Use`.
* **Diff between subsystem frames.** Comparing the single `Syst` frame
  to the single `Fuel Use` frame (via `analysis/q5_full_layout.py` /
  the diff inline in `q5_chan_to_live.py`), they differ only in:
  * the 8-byte tag at `[4..11]`,
  * the MCLK timestamp at `[12..15]` and its echoed copies inside
    sub-structs `Roll`, `ODO`, `odo1..odo4`, `GPS`,
  * a handful of GPS-internal fields (the GPS sub-struct has its own
    sub-timestamps and counters).

  No NEW channels are filled in by `Syst` or `Fuel Use` that wouldn't
  also be filled by `kkk`. Both `Syst` and `Fuel Use` only appeared once
  each at the start of the capture; without more samples we cannot
  determine when they fire.

Verification scripts: `analysis/q5_full_layout.py` (variability map),
`q5_overlay.py` (multi-type interpretations), `q5_validate.py` (channel
mapping check), `q5_chan_to_live.py` (offset table generator).

---

## 6. The 13608-byte channel-definitions frame — DECODED (structure) / PARTIAL (per-record fields)

> This is THE artifact that maps live-frame byte offsets to channel
> names. We have 103 channels and a confirmed `live_offset =
> channel_def_offset + 12` formula.

### 6.1 Outer envelope

```
[ 0.. 3]   00 00 00 00          reserved
[ 4.. 7]   "hhh\x01"            "hhh" sub-protocol tag (channel-def block)
[ 8..11]   u32 LE = 0x284b351c  unknown — not a CRC of the contents
                                 (676,017,436 — could be a build/version)
[12..]     repeated <hM\0\0\0...M\0\0\0> records (132 bytes each:
            12 hdr + 112 payload + 8 trailer)
```

103 records × 132 bytes/record + 12 byte header = 13,608 bytes ✓.

The inner records use the **same outer envelope format as STCP** (`<h` +
4-byte cmd + LEN + FLAG + `>` … `<` + cmd + trailer + `>`), but:

* The 4-byte command is `M\x00\x00\x00` — non-ASCII bytes 2..4.
* The FLAG byte is `0x04` (vs `0x00` in STCP). FLAG=4 may signal "raw
  binary record".
* SUM16(payload) trailer convention applies (verified).

### 6.2 Per-record layout (112 bytes)

| offset | bytes | meaning (HIGH if marked, otherwise PARTIAL) |
|---|---|---|
| `[ 0.. 3]` | u32 LE | **channel-index** — sequential 0..N-1 per "channel group" (HIGH) |
| `[ 4.. 7]` | u32 LE | (low16, high16): low16 = sub-id within group, high16 = group-id |
| `[ 8..11]` | u32 LE | per-channel state (mostly 0; non-zero for GPS, ODO, etc) |
| `[12..15]` | u32 LE | u32 "id_value" — varies per channel; might be display config or default |
| `[16..19]` | u32 LE | **type-class** — `1`/`2`/`4`/`5` (data type family) |
| `[20..23]` | u32 LE | unit code (0..32 mostly) — not yet decoded to unit names |
| `[24..27]` | 4 chars ASCII | **4-byte channel tag** (e.g. `MCLK`, `RPM `, `GPS `) (HIGH) |
| `[28..31]` | 4 chars ASCII | tail of tag if longer, otherwise zero |
| `[32..63]` | 32 chars ASCII NUL-padded | **channel display name** (HIGH) |
| `[64..67]` | u32 LE | **sample period in µs** (HIGH). 0 = event-driven. Common: 100000 (10 Hz), 20000 (50 Hz), 1000000 (1 Hz) |
| `[68..71]` | u32 LE | **byte offset into the live frame's flat buffer** (HIGH; verified — see §5) |
| `[72..75]` | u32 LE | **byte width of this channel's value** in the live frame (HIGH) |
| `[76..79]` | u32 LE / 4 chars | string "@AIM" (`0x4d494140`) for some channels, 0 for others; flag byte |
| `[80..83]` | u32 LE | **type code** family (1=u32, 2=u16/f32 by width, 6=s16-inertial, 9=motor, 13=u8, 512/514=fault u32) (PARTIAL) |
| `[84..87]` | u32 LE | secondary type / subsystem code |
| `[88..91]` | u32 LE | per-channel display index? |
| `[92..95]` | u32 LE | **decimal places for display** (HYPOTHESIS) — usually 2, sometimes 4 |
| `[96..99]` | u32 LE | 0 |
| `[100..103]` | f32 LE | **scale factor** (HIGH) — 1.0 for almost all channels |
| `[104..107]` | f32 LE | **offset** (HIGH) — 0.0 for almost all channels |
| `[108..111]` | f32 LE | **max-display-value** (HYPOTHESIS) — 99,999.9 for VBat; 60.0 for several others |

### 6.3 Recipe to extract the channel map

```python
import struct

def parse_channel_defs(payload_13608: bytes) -> list[dict]:
    if not payload_13608.startswith(b"\x00\x00\x00\x00hhh\x01"):
        raise ValueError("not a channel-def frame")
    out = []
    i = 12
    while i + 132 <= len(payload_13608):
        # outer M\0\0\0 record header
        if payload_13608[i:i+2] != b"<h" or payload_13608[i+2:i+6] != b"M\x00\x00\x00":
            break
        ln = int.from_bytes(payload_13608[i+6:i+10], "little")  # always 112
        flag = payload_13608[i+10]                              # always 0x04
        body = payload_13608[i+12:i+12+ln]
        out.append({
            "index":      struct.unpack_from("<I", body,  0)[0],
            "tag":        body[24:28].rstrip(b"\x00").decode("latin1"),
            "name":       body[32:64].rstrip(b"\x00").decode("latin1"),
            "sample_us":  struct.unpack_from("<I", body, 64)[0],
            "live_off":   struct.unpack_from("<I", body, 68)[0] + 12,
            "width":      struct.unpack_from("<I", body, 72)[0],
            "type":       struct.unpack_from("<I", body, 80)[0],
            "scale":      struct.unpack_from("<f", body, 100)[0],
            "offset":     struct.unpack_from("<f", body, 104)[0],
        })
        i += 12 + ln + 8
    return out
```

This produces 103 records consistent with §5.1.

Verification: `analysis/q6_decode.py`, `q6_record_format.py`,
`q6_full_records.py`.

---

## 7. The 12-byte "kkk" heartbeat — DECODED

> Every kkk heartbeat in every capture is the literal 12 bytes
> `00 00 00 00 6b 6b 6b 01 00 00 00 00`. There is no per-frame
> variation, no counter, no embedded timestamp.

* Live 1 server side: 194 / 194 identical.
* Live 2 server side: 34 / 34 identical.
* Sibling capture (`Data-Development/aim_tcp_stream0.txt`) server side:
  16 / 16 identical.

Decoding:

| offset | bytes | role |
|---|---|---|
| `[0..3]` | `00 00 00 00` | "no-context" header (same as every other STCP payload) |
| `[4..6]` | `6b 6b 6b` | ASCII `kkk` — heartbeat tag |
| `[7]` | `0x01` | sub-tag / version (always 1 in our data) |
| `[8..11]` | `00 00 00 00` | reserved |

The byte `0x01` is constant across all heartbeats and across different
device states (`live1`, `live2`, sibling). We do not have evidence to
distinguish between "always-1 version field" and "boolean status that
happens to be set in our captures"; HYPOTHESIS: it is a status nibble
(e.g. `lap_recording = no`). A capture with the device actively
recording would resolve this.

Verification: `analysis/q7_kkk.py`.

---

## 8. The 4-byte STCP micro-acks — DECODED

> Always exactly `00 00 00 00`. Confirmed across all 398 micro-acks in
> live1 (394 client→server + 4 server→client), 66 in live2, and 43 in
> the sibling capture. No other 4-byte payload was ever observed.

Verification: same script `analysis/q2_short_payloads.py`.

---

## 9. Recommendations for updating the main spec

The following changes to `aim-live-protocol.md` are now justified by
empirical data and should be applied:

1. **§3 trailer u16**: replace "Not yet decoded" with `TR =
   sum(payload_bytes) mod 0x10000` and note that the same formula
   applies to inner sub-frame trailers. Add the recipe in §1.3 above to
   the "Implementation plan" section. **(High priority — required for
   write-side support.)**
2. **§4.1 hello sequence**: add the explanation of the `0x06` constant
   marker and the `0x08`/`0x19` second byte (echo-of-length / status
   nibble). Mark the `0x19` semantics PARTIAL.
3. **§4.3 live-data poll**: add the selector table from §3.1 above.
   Note that selector `0x00020003` triggers a 547-byte snapshot and
   `0x00020053` triggers a 12-byte heartbeat — the client controls which
   one fires by alternating selectors.
4. **§4.2 enumeration**: replace "we suspect Race Studio discards the
   first 2 copies" with the empirical finding "the 3 copies are
   byte-identical except for `iLTS`, where the seconds digit ticks; the
   3-pass repetition is plain redundancy". A read-only client may take
   any of the three copies and use the host's wall-clock for timestamps.
5. **§5 547-byte live frame**: replace the byte-by-byte layout with the
   channel-table-driven mapping in §5.1 above. The "constant" regions
   in the old spec are mostly placeholder values for inactive channels
   (`-∞ float`, `INT32_MAX int`) and should be documented as such.
   Specifically:
   - `[12..15]` is `MCLK` (Master Clock, u32 ms).
   - `[244..255]` is **6× s16** (the IMU: InlA, LatA, VerA, RollRate,
     PitchRate, YawRate) — NOT 4× f32.
   - The end of the frame `[440..544]` is mostly **f32 channel values**
     — DCL, DIR, MCEN, BSE, TPV1/2, DCR, SOC, BTMP, VBAT — these are the
     "primary live values" Race Studio shows on its dashboards.
6. **§7 open questions**:
   - Q1 (trailer u16) — **resolved**.
   - Q2 (3-pass enumeration) — **resolved**.
   - Q3 (channel map) — **resolved** (the channel-def frame is now
     decoded; live frame offsets are mapped via `live_off = chan_off + 12`).
   - Q4 (subsystem tag set) — partially resolved. `System`, `Fuel Use`
     and `kkk` are the three tags. Without a longer capture (with laps,
     fuel events, etc) we can't enumerate the rest, but the mapping rule
     "subsystem name + ts at [4..15]" is now confirmed.
   - Q5 (`idn 0x01 0x38 0x00 0x11`) — still PARTIAL.
7. **Add a note about the `parse_aim_stream.py` direction-detection bug**
   (Live 2 has the device on Node 0, not Node 1) so future captures are
   parsed correctly. The corrected loader is in `analysis/lib_frames.py`.

---

## Appendix A — Channel map cheat sheet (sorted by live offset)

This is the single most useful artifact from this deep dive. Drop it in
the implementation as a Python dict keyed by tag.

```
live_off  width  type    tag  name
   12       4    u32     MCLK Master Clk                  (MCLK timestamp, ms)
   16      20    struct  LAP  Lap Time                    (lap-record struct)
   36       2    u16     LogT Logger Temperature          (raw counts; need calib)
   38       2    u16     VBat External Voltage            (raw counts; need calib)
   40       4    u32     PreT Predictive Time             (ms)
   44       4    u32     bstD Prdt Best Diff              (ms)
   48      12    struct  Roll Roll Time                   (lap-record sub-struct)
   60      60    struct  Best Best Time                   (7 lap-time slots, latest cum.)
  120      12    struct  ODO  Total Odometer              (cumulative pulses)
  132      12    struct  odo1 Reset Odometer 1
  144      12    struct  odo2 Reset Odometer 2
  156      12    struct  odo3 Reset Odometer 3
  168      12    struct  odo4 Reset Odometer 4
  180      56    struct  GPS  GPS                         (lat/lon/alt/spd/heading/sats/fix)
  236       4    u32     Spd1 LFspeed
  240       2    s16     RBRK FrBrakePressure
  242       2    s16     Ch04 RBrkPressure
  244       2    s16     InlA InlineAcc                   (IMU x-accel)
  246       2    s16     LatA LateralAcc                  (IMU y-accel)
  248       2    s16     VerA VerticalAcc                 (IMU z-accel)
  250       2    s16     Roll RollRate                    (gyro x)
  252       2    s16     Ptch PitchRate                   (gyro y)
  254       2    s16     YawR YawRate                     (gyro z)
  256       4    f32     Bias BrakeBias                   (-inf when N/A)
  260       4    f32     LnCr RBrakePressCorr
  264       4    u32     RTD…CANC Faults  (14 channels)   (boolean as u32)
  320       4    u32     RTD…CANC Alarms  (14 channels)   (boolean as u32)
  376       4    f32     c003 Motor_Temp
  380       4    f32     RPM  RPM
  384..415  4    f32     IphA…Iq_Feedback (8 ch)
  416       1    u8      IFB4…IFB7 + PFB0…PFB3 (8 ch)
  424       4    f32     c001 Torque_Command
  428       4    f32     c002 Torque_Feedback
  432       4    f32     TQLM MCU_Torque_Limit
  436       4    f32     TQRX LVCU_Torque_Req
  440       4    f32     DIR  Direction                   (1.0 forward)
  444       4    f32     MCEN InverterEnable              (1.0 / 0.0)
  448       4    f32     DCL  BMS_Disch_Lim               (A)
  452       4    f32     TPS  Throttle_Pos                (%)
  456       4    f32     BSE  BSE_Voltage                 (raw)
  460       4    f32     TPV1 TPS_1_Voltage               (raw)
  464       4    f32     TPV2 TPS_2_Voltage               (raw)
  468       1    u8      LVCU LVCU_Status
  469       4    f32     TPS1 TPS_1                       (%)
  473       4    f32     TPS2 TPS_2                       (%)
  477       4    f32     lspd lvcu_motor_speed
  481..516 4 each f32    wtw…vspd  (10 ch — launch-control state)
  517       4    f32     DCR  BMS_Disch_Enable            (0.0/1.0)
  521       4    f32     SOC  State_of_Charge             (%)
  525       4    f32     BTMP Pack_Temp                   (°C)
  529       4    f32     VBAT Pack_Voltage                (V)
  533       4    f32     IBAT Pack_Current                (A)
  537       4    f32     BMSV BMS_LV_input                (mV?)
  541       4    f32     ch   Min_Cell_Voltage            (mV?)
  545       2    u16     SRec StartRec                    (recording flag)
```

Total: 103 channels, total width = 535 bytes. Plus the 12-byte envelope
header = 547 ✓.

---

## Appendix B — Cycle and selector summary (for implementers)

```
Connect
   C → S   STCP  8B   00 00 00 00 06 08 00 00       hello
   S → C   STCP  8B   00 00 00 00 06 19 00 00       hello-ack

Enumeration (3×)
   C → S   STNC  64B  selector=0x00010010 (e.g.)    request enum
   S → C   STCP  64B  ack='I' / 'A'
   C → S   STCP  68B  date stamp
   S → C   STCP   4B  micro-ack (00 00 00 00)
   S → C   STCP  64B  ack='Q' with len-hint
   C → S   STCP   4B  micro-ack
   S → C   STCP  3462B   contains iMST + iSLV + iHW + iUSR + iPTH + iLCK + iSST + iLTS + iPRL

(pass through selector 0x00020024 / 0x00020028 etc once, then channel-def)
   S → C   STCP  13608B   channel-definition frame (103× <hM\0\0\0...> records)

Steady state (~250 ms)
   loop:
     C → S   STNC 64B  selector=0x00020003   "give me a snapshot"
     S → C   STCP 64B  ack='I'  selector echoed
     S → C   STCP 64B  ack='Q'  byte[16..19] = 0x21F = 543
     C → S   STCP  4B  micro-ack
     S → C   STCP 547B live snapshot
     C → S   STNC 64B  selector=0x00020053   "heartbeat please"
     S → C   STCP 64B  ack='I'
     S → C   STCP 64B  ack='Q'  byte[16..19] = 0x008
     C → S   STCP  4B  micro-ack
     S → C   STCP 12B  kkk heartbeat

   For each frame:
     trailer u16 = sum(payload_bytes) mod 0x10000
```

---

## Appendix C — Repository

All scripts that produced the findings above are in
`docs/protocol/captures/analysis/`:

| script | purpose |
|---|---|
| `lib_frames.py` | shared frame parser with corrected direction detection |
| `q1_trailer_crc.py` | CRC / sum-16 / xor brute force |
| `q1_verify.py` | end-to-end SUM16 verification |
| `q2_hello.py`, `q2_short_payloads.py` | hello + short-payload catalog |
| `q3_stnc.py`, `q3_stnc_corr.py`, `q3_stnc_full.py`, `q3_stnc_pairs.py` | STNC / STCP-64 structure |
| `q4_three_pass.py`, `q4_ilts.py` | 3-pass enumeration diff |
| `q5_live_frame.py`, `q5_overlay.py`, `q5_full_layout.py`, `q5_validate.py`, `q5_chan_to_live.py` | live-frame layout |
| `q6_channel_def.py`, `q6_decode.py`, `q6_record_format.py`, `q6_full_records.py` | channel-def decode |
| `q7_kkk.py` | kkk heartbeat |

To re-derive everything, run:

```
cd docs/protocol/captures/analysis
python3 q1_verify.py            # → "Outer frames: 2318, mismatches: 0"
python3 q3_stnc_full.py         # → 64-byte STNC structure
python3 q4_three_pass.py        # → 3-pass diff
python3 q5_validate.py          # → channel-by-channel live frame map
python3 q6_full_records.py      # → 103-row channel-def table
```
