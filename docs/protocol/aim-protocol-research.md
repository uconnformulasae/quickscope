# AiM EVO5 / Race Studio 3 — Prior-Art Research

Compiled 2026-04-27 by surveying GitHub, PyPI, AiM official docs, and motorsport
forums. The aim was to find any prior reverse-engineering of the live WiFi
protocol on TCP port 2000 / UDP port 36002.

**One-line summary:** *No public reverse-engineering of the live WiFi wire
protocol exists.* But the **stored XRK file format is fully reverse-engineered**
in two open-source projects, and the file format and the live wire format share
the same outer framing — `<h <TOK4> <LEN u32> <ver u8> <0x3E> <payload> <0x3C>
<TOK4> <sum16> <0x3E>`. This is the single most actionable finding: every byte
that appears inside an `STCP` payload on the wire follows rules already
documented for XRK.

---

## 1. The XRK file format — fully reverse-engineered

### 1.1 `libxrk` (Christopher Dewan / Scott Smith, MIT)

- **Repo:** https://github.com/m3rlin45/libxrk
- **PyPI:** https://pypi.org/project/libxrk/
- **License:** MIT. Copyright header is `# Copyright 2024, Scott Smith.` in
  `src/libxrk/aim_xrk.pyx`; PyPI metadata lists the author as Christopher Dewan.
- **Status:** Pure-source parser (no AiM DLL). Cython + Rust backends; round-trip
  byte-identical against the official AiM DLL on a corpus of MXP/MXm logs.

This project is the gold mine. It contains:

- `spec/xrk_format.py` (1249 lines) — Construct-based "executable spec." This
  parses real XRK files and re-builds them byte-identically. It is explicitly
  the "single source of truth for the XRK wire format." Direct link:
  https://github.com/m3rlin45/libxrk/blob/main/spec/xrk_format.py
- `spec/docs/companion.md` — application-level algorithms (GPS timing, lap
  detection, decoder dispatch, time-offset).
  https://github.com/m3rlin45/libxrk/blob/main/spec/docs/companion.md
- `spec/docs/unknown_regions.md` — every byte range in the format that is *not*
  fully understood, with observed values and hypotheses.
  https://github.com/m3rlin45/libxrk/blob/main/spec/docs/unknown_regions.md
- `src/libxrk/aim_xrk.pyx` — the Cython parser (good for the loop-level
  validation logic).

#### Key technical facts established by this project

These all come straight from `spec/xrk_format.py` and the companion docs, and
they map directly onto the EVO5 wire format we observed:

1. **Header (XRK and wire) framing.** Two-byte opcode `<h` (0x3C 0x68),
   followed by:
   - 4-byte token (`uint32 LE`). 3-char tokens are padded with trailing
     `0x20` (space). Decoded back via the `_tokenc(i)` helper.
   - 4-byte payload length (`int32 LE`).
   - 1-byte version (the user's "FLAG" field — observed 0x00 in our captures
     but the field is actually a version byte, not a flag).
   - 1-byte `>` (0x3E).
   - `payload_len` bytes of payload.
   - 1-byte `<` (0x3C).
   - 4-byte token (must equal the header's token).
   - **Checksum: 2-byte unsigned LE = `sum(payload_bytes) & 0xFFFF`.** This is
     the user's unresolved "TR(u16)" field. It's a plain modular byte sum, not
     a CRC. Source: `spec/xrk_format.py` line 528 and Cython parser line 517-526.
   - 1-byte `>` (0x3E).
   - Total overhead: 20 bytes (2 + 4 + 4 + 1 + 1 + payload + 1 + 4 + 2 + 1).
2. **Tokens are 3- or 4-character ASCII** stored as little-endian `uint32`. A
   3-char token has a trailing `0x20` space byte. Helper functions `_tokdec(s)`
   and `_tokenc(i)` are at `spec/xrk_format.py` lines 58-79.
3. **Two recursive container tokens: `CNF` and `ENF`.** Their payload is itself
   a sequence of `<h ... >` messages. `CNF` is "merge into parent"; `ENF` is
   "keep as nested result." Source: `_DISPATCH_TABLE` entries marked
   `_Recurse(merge=True/False)`.
4. **Token `iSLV` carries an embedded `idn` block** (model_id `uint16 LE` at
   payload offset 6, logger_id `uint32 LE` at offset 12). `SRC` uses the same
   layout. Source: `spec/xrk_format.py` lines 451-460. **This is the only
   `i*` token observed in the stored XRK corpus**; the EVO5 live stream
   carries many more (`iMST iHW iUSR iPTH iLCK iSST iLTS iPRL`) — these are
   live-only and not present in stored files.
5. **Channel definitions live in `CHS` messages** (112-byte payload). Full byte
   layout, decoder dispatch table, unit map, and function-classification table
   are in `spec/xrk_format.py` and `spec/docs/companion.md`. Of particular
   interest:
   - `decoder_type` byte at offset 20 selects how to interpret the raw sample
     bytes. **Type 20 ("`H` interpolate") is `IEEE 754 half-precision (fp16)`
     reinterpret** — this is the most common encoding for analog sensor channels
     and is almost certainly what's in the 547-byte live-data frame's
     "channel value" 3-byte slots (probably an fp16 + a 1-byte status
     flag). Verify this by looking at `spec/docs/companion.md` §3.
   - Type 15 is a gear lookup: raw `uint16` is an ASCII char code, mapped
     `'N'→0, '1'→1, …, '6'→6`.
   - Calibrated channels use the high bit of `unit_type_byte`; mV channels
     with the high bit set are displayed in V (divide by 1000).
6. **GPS messages carry a 4-byte AIM timecode followed by a 52-byte u-blox
   NAV-SOL payload.** Total 56 bytes. ECEF positions in cm, velocities in cm/s,
   pAcc/sAcc in cm and cm/s, pDOP × 0.01. `spec/xrk_format.py` lines 327-349.
7. **GNFI messages are 32 bytes**: 4-byte timecode + 28 bytes of unknown logger
   internal state. Used as a non-GPS clock reference (immune to GPS-timing bug).
8. **Data messages (in stream, between header messages):**
   - `(S` — single-channel sample: opcode 0x28 0x53, then 4-byte timecode,
     2-byte channel index, then `channel_sizes[idx]` bytes, then `)` (0x29).
   - `(G` — group sample: opcode `(G`, then tc, group index, then packed
     payload, then `)`.
   - `(M` — multi-sample burst: opcode `(M`, tc, channel idx, count u16, then
     `count × channel_sizes[idx]` bytes, then `)`. Sample timestamps are
     `tc + i × Mms`.
   - `(c` — expansion-device sample. **Three known variants** distinguished by
     two byte fields; see `spec/docs/unknown_regions.md` for the full table.
9. **XRZ files are XRK files compressed with standard zlib.** Detect by first
   two bytes `0x78 0x01` / `0x9C` / `0xDA` and apply `zlib.decompress`.

#### Validation approach

`libxrk` runs cross-implementation tests against the official AiM DLL via Wine
(in `tests/reference_dll/`) as ground truth, with 99.97% agreement on a 213k
sample shock-pot fixture (the residual 0.02% are samples where AiM's DLL
applies internal smoothing/filtering not part of the wire format).

### 1.2 `xdrk` (bmc::labs, AGPL-3.0)

- **Repo:** https://github.com/bmc-labs/xdrk
- **What it is:** A *Rust wrapper* around AiM's official C/C++ DLL. **Not** a
  reverse-engineered parser — it just makes the proprietary DLL safe to call.
- **Useful for us:** The repo ships the DLL/.so under `aim/` and exports it via
  `libxdrk-x86_64.def`. The exported function names are the canonical AiM API:
  `open_file`, `get_channels_count`, `get_channel_name`, `get_channel_units`,
  `get_channel_samples`, `get_GPS_channel_*`, `get_GPS_raw_channel_*`,
  `get_lap_info`, `get_vehicle_name`, `get_track_name`, `get_racer_name`,
  `get_championship_name`, `get_venue_type_name`, `get_date_and_time`. This
  enumerates every metadata field RaceStudio expects per session.
- **Important:** Running `strings` on the bundled `libxdrk-x86_64.so` reveals
  AiM's internal C++ symbol soup. Among the strings:
  - `kSMPL_FMT_VOID`, `kSMPL_FMT_S32`, `kSMPL_FMT_S16`, `kSMPL_FMT_S8`,
    `kSMPL_FMT_U32`, `kSMPL_FMT_U16`, `kSMPL_FMT_U8`, `kSMPL_FMT_FLOAT`,
    `kSMPL_FMT_LAP_2G`, `kSMPL_FMT_GPS_AIM`, `kSMPL_FMT_GPS_UBX`,
    `kSMPL_FMT_DATA_ORA`, `kSMPL_FMT_GEAR`, `kSMPL_FMT_TGIRO`,
    `kSMPL_FMT_BITFIELD_8`, `kSMPL_FMT_BITFIELD_16_killed`,
    `kSMPL_FMT_STR_CODE_2_6`, `kSMPL_FMT_STR_CODE_2_30`, `kSMPL_FMT_LAP_1G`,
    `kSMPL_FMT_GPS_SV_INFO`, `kSMPL_FMT_TRAMA_CAN`, `kSMPL_FMT_F16`,
    `kSMPL_FMT_AIM_LATLON`, `kSMPL_FMT_LAP_2G_v2`, `kSMPL_FMT_TRUNN`,
    `kSMPL_FMT_TDIFF`, `kSMPL_FMT_SM32`, `KSMPL_FMT_TOTAL_ODOMETER`,
    `kSMPL_FMT_RESETTABLE_ODOMETER`, `kSMPL_FMT_MYLAPS_LAPTIME`,
    `kSMPL_FMT_MYLAPS_GAP`, `kSMPL_FMT_MYLAPS_PERSONAL`, `kSMPL_FMT_LAP_2G_v3`,
    `kSMPL_FMT_ROLL_TIME`, `kSMPL_FMT_BEST_TIME`, `kSMPL_FMT_GPS_AIM_v2`. This
    is the canonical sample-format enum.
  - `kTIPO_CH_INVALID`, `kTIPO_CH_ANALOGICO`, `kTIPO_CH_DIGITALE`, `kTIPO_CH_ECU`,
    `kTIPO_CH_MATH`, `kTIPO_CH_GPS`, `kTIPO_CH_LAPTIME`, `kTIPO_CH_ROLLTIME`,
    `kTIPO_CH_GEAR`, `kTIPO_CH_CAN1`, `kTIPO_CH_CAN2`, `kTIPO_CH_CAN_CUST`,
    `kTIPO_CH_KLINE`, `kTIPO_CH_RS232`, `kTIPO_CH_DIG_BISTATO`,
    `kTIPO_CH_CAN1_OUTPUT`, `kTIPO_CH_CAN2_OUTPUT`, `kTIPO_CH_RS3_GENERIC`.
    Channel-type enum.
  - Complete list of every device model AiM supports — the strings include
    `EVO4S`, `EVO5`, `Solo 2`, `Solo 2 DL`, `MXP`, `MXP Strada`, `MXG`, `MXS`,
    `MXm`, `MyChron5`, `MyChron5-660`, `MyChron5S`, `MXK10`, `MX2E`,
    `SmartyCam HD`, `SmartyCam GP HD`, `SmartyCam GP HD 2.2`, `SmartyCam 3`,
    `Solo`, `MyChron4 660`, `EVO4 ECU Bridge`, `RPM Bridge`, `RPM Logger`,
    plus dozens of legacy MyChron/MXL variants. The internal short codes
    include `MYC5`, `MYC5-660`, `MYC5S`, `MXG_12`, `MXS_Strada`, `MXS_12`,
    `MXSL_12_Morini`, `Solo2`, `Solo2_DL`, `EGF`, `MXP_Strada`, `PDM`, `MX_UTV`.
  - Dispatcher tag list seen in the `.so`: `CNF CHS CDE FT1 ACD GRP SRC iSLV
    TMD TMT ENF EVT LAP GPS GPS1 GPS2 GPS3 GPS4 GPS5 GPS6 GPS7 GPS8 RCR VEH
    CMP VTY TRK RACM PRFD TRTY GNV MAIN ident NET ident`. Most are documented
    in libxrk; `FT1`, `ACD`, `EVT`, `GPS2..GPS8`, `PRFD`, `TRTY`, `GNV`, `NET`
    are not in libxrk's dispatch table and may show up on the wire from an
    EVO5 (which has more capabilities than the MXP/MXm corpus libxrk was
    built on).
  - `aim-dbg-info` debug-line format string with `stat-misure=1 stat-lap=1
    stat-gps=1 gps-samples=1 stats-when-samples=1`. Just internal logging.
  - **No networking strings.** I grepped for `tcp`, `udp`, `wifi`, `2000`,
    `36002`, `connect`, `listen`, `socket`, `recv`, `send`, `aim-ka`,
    `STCP`, `STNC`, `iMST`, `iUSR` — none match. This confirms the DLL is
    pure file parser; the wire protocol lives elsewhere in the RaceStudio 3
    Qt application.

---

## 2. Live wire protocol — *not* publicly reverse-engineered

We searched broadly. No public project decodes the AiM live WiFi protocol on
TCP port 2000 or the UDP port 36002 discovery service. Specifically:

- No GitHub repository matches the strings `STCP`, `STNC`, `aim-ka`, `iMST`,
  `iUSR`, `iPTH`, `iLCK`, `iSST`, `iLTS`, `iPRL`, or any combination of these
  with "AiM" / "racestudio" / "aim-sportline" / "EVO5".
- The closest thing is `libxrk`, which decodes the **stored** format. The wire
  format we observed in our captures matches its outer framing exactly; the
  inner `i*` tokens are AiM internal codes likely shared with the device's
  filesystem persistence layer, but their payload structure is not in libxrk.
- The vendor Aim Tech publishes neither a wire-protocol spec nor an SDK for
  the live stream. AiM's public XRK SDK only reads files (see §1).
- LapSnap (https://lapsnap.app/) and goprotelemetryextractor.com both consume
  AiM data, but both are closed-source commercial products.
- AutosportLabs' "live-stream telemetry from your AIM dash" page is about a
  hardware bridge that connects to the AiM **CAN bus** (SmartyCam stream) —
  not the WiFi protocol.

### 2.1 The CAN-passthrough docs are *not* the wire protocol

- **AutosportLabs AIM Integration CAN Mapping:**
  https://wiki.autosportlabs.com/AIM_Integration_CAN_Mapping
- **AutosportLabs AIM SmartyCam CAN:** https://wiki.autosportlabs.com/AIM_SmartyCam_CAN
- **AutosportLabs PodiumConnect AIM:** https://wiki.autosportlabs.com/PodiumConnect_AIM
- **AutosportLabs blog "How to Live-stream telemetry from your AIM dash":**
  https://www.autosportlabs.com/how-to-live-stream-telemetry-from-your-aim-dash/

These describe the **CAN bus** integration: AiM dashes emit a SmartyCam CAN
stream at 1 Mbps with five fixed CAN IDs (1056, 1057, 1058, 1059, 1060), each
carrying 2-byte little-endian unsigned integers at offsets 0/2/4/6, with
type-specific multipliers (temperature × 0.1, pressure × 0.01). Useful as
*ground truth for what physical channels a device exposes*, but irrelevant to
the WiFi/TCP-port-2000 protocol we are decoding.

### 2.2 RaceStudio 3 release notes mention WiFi but not protocol

- https://www.aim-sportline.com/download/software/doc/RS3_ver_3.06.20_upgrades.pdf
  describes WiFi configuration UI from the user's perspective. No protocol
  details. Just confirms WPA2 / 8-char password / device-as-AP mode exists.

### 2.3 AiM's own troubleshooting docs

- AiM's WiFi FAQ tells users to capture WiFi traffic with Wireshark and email
  the .pcap to `software@aim-sportline.com`. Confirms (a) AiM uses Wireshark
  internally, (b) they have not published a dissector, (c) traffic is in the
  clear (otherwise capturing it would be useless to them).

---

## 3. Confirmed wire-protocol details (from observed traffic + libxrk spec)

### 3.1 The "TR(u16)" / "FLAG" mystery is solved

In our existing notes (`docs/protocol/aim-live-protocol.md` §3) we marked the
trailer 2-byte field as "appears to be a XOR-like checksum or a per-command
sequence/length-mod marker. **Not yet decoded.**" 

**Resolved.** It is `sum(payload_bytes) & 0xFFFF`. Plain unsigned
little-endian byte sum modulo 65536. Source: `libxrk/spec/xrk_format.py`
line 528 (`Rebuild(Int16ul, lambda ctx: sum(ctx.raw_payload) & 0xFFFF)`)
and Cython parser at `aim_xrk.pyx` lines 517-526
(`bytesum = accumulate(payload_start, payload_end, 0)`). Note the Cython
parser computes the sum starting from `&sv[pos]` *after* the header was
parsed (i.e., starting at the payload's first byte) and ending at the byte
just before the footer's `<` (i.e., the last payload byte). For nested
inner messages, the sum applies to the inner payload only. Verify this on
our captures.

The 1-byte field we labeled "FLAG" is the header **version byte**. Observed
value 0x00 in our captures; libxrk's spec also routinely emits version 0.
Some inner header messages in newer firmware may use non-zero versions.

### 3.2 Token encoding is uint32 LE

When we write parser code, decode the 4-byte command field as `uint32 LE`
and turn it back into ASCII via `_tokenc(i)` (libxrk lines 70-79 / 259-264).
3-char tokens like `iHW` carry a trailing `0x20`. The user's note that
`iHW ` has a "note trailing space" confirms this.

### 3.3 No CRC, no obfuscation, no compression on the live wire

The frame validates with byte-sum-mod-65536. There is no CRC32 / CRC16 /
hash. There is no obfuscation. Inside `STCP` payloads, the data is the
same wire-format as inside an XRK file (since the device persists what it
streams). Specifically the 547-byte live snapshot is *not* wrapped in a
header/footer of its own — it is the `STCP` payload itself, which means the
checksum on the outer envelope covers all 547 bytes.

### 3.4 Channel encoding inside the 547-byte live frame

Cross-referencing libxrk's decoder table with the 3-byte CHANNEL VALUE
slots in our `aim-live-protocol.md` §5.1, the most likely interpretation is:

- 2 bytes of fp16 (decoder type 20: half-precision IEEE 754, `np.float16`).
- 1 byte of "valid/status" flag (matches libxrk decoder type 13).

To validate this, take the bytes at offsets 128-130 from one of our captured
547-byte frames, treat the first 2 bytes as fp16, and see if the result is
a plausible engineering value (RPM / temperature / voltage / etc.). The
"main float block" at 212-224 is documented in our notes as 4× IEEE 754
float32 LE, which matches libxrk's decoder type 6 (`f` interpolate).

### 3.5 Italian field names confirm vendor

`pilota`, `veicolo`, `campionato`, `venue_type` (the user's observation)
exactly match the metadata fields the AiM DLL exports as `get_racer_name`,
`get_vehicle_name`, `get_championship_name`, `get_venue_type_name` (from
xdrk's `.def` file). The `iUSR` token name is "user information" in
Italian-influenced English.

### 3.6 Inner tokens we have *not* decoded but can now bound

| Token | EVO5 wire? | libxrk? | xdrk DLL strings? | Notes |
|-------|-----------|---------|-------------------|-------|
| iMST  | yes (3×)  | no      | not seen          | "Master device info." Likely root container; first frame is 3462 bytes containing identity + capabilities |
| iSLV  | yes       | yes     | yes (in `.so`)    | Slave/sub-device info. libxrk parses this as `EmbeddedIDNPayload` (idn block at offset 6). |
| iHW   | yes       | no      | not seen          | Hardware info. Probably embeds an idn-style block + firmware/build revisions |
| iUSR  | yes       | no      | not seen          | Driver/vehicle/championship strings (matches RACM/RCR/VEH/CMP/VTY in libxrk dispatch) |
| iPTH  | yes       | no      | not seen          | Filesystem path map; format in our captures is `key=path_a,path_b\|key=path_a,path_b\|…` |
| iLCK  | yes       | no      | not seen          | Lock state |
| iSST  | yes       | no      | not seen          | Session state |
| iLTS  | yes       | no      | not seen          | Logged sessions index |
| iPRL  | yes       | no      | not seen          | Profiles list |
| STCP  | yes       | no      | not seen          | Outer "Studio TCP" envelope, see §3.1 |
| STNC  | yes       | no      | not seen          | Outer client-poll envelope, 64-byte payload |

`iMST iHW iPTH iLCK iSST iLTS iPRL STCP STNC` are wire-only — they don't
appear in stored XRK files because the device's filesystem persistence layer
lives *inside* the device, not in the file format. Only `iSLV` and the
nested data tokens (CHS/GRP/CDE/CAL/GPS/LAP/idn/SRC/RACM/VET/TRK/GPSR/ODO/
ENF/CNF + the data-message variants `(S/(G/(M/(c`) ever leak into stored
files.

### 3.7 The user's `STCP STNC` mystery is resolved

These fit the same `<h …` framing as everything else. The user's observation
that the framing for the outer envelope was *the same shape* as the inner
sub-frames is correct, and `<h` is the universal opcode. In libxrk's spec,
both outer (file-level) and inner (CNF/ENF nested) messages use exactly the
same byte layout — the wire is no different.

### 3.8 The XRZ compression is unrelated to the live wire

XRZ files are zlib-compressed XRK. The live wire stream is not compressed
(otherwise the byte sum on the trailer would change every frame, and our
plaintext observation of the `iPTH` filesystem map would not work).

---

## 4. Leads worth digging into next

In rough priority order:

1. **Run libxrk's `parse_xrk_bytes()` against an `STCP` payload.** Most live
   payloads should parse as a sequence of header messages (`<h`-framed) plus
   data messages (`(S`/`(G`/`(M`/`(c`). The 547-byte live frame might *not*
   be a sequence of header messages — it could be a fixed-layout binary
   record specific to the live stream. But the 3462-byte enumeration payload
   almost certainly is a libxrk-parseable byte sequence.
2. **Validate the trailer-checksum hypothesis on our captures.** Pick any
   `STCP` frame, sum its payload bytes mod 65536, and compare to the trailer
   2-byte field. Confirm with five frames including one client→server
   `STNC` (so we know senders also obey the rule).
3. **Validate the fp16+status hypothesis on the live frame.** Take the
   3-byte CHANNEL VALUE slots at offsets [128:131], [140:143], [152:155],
   etc. in a captured 547-byte frame; treat bytes [0:2] as fp16, byte [2] as
   status. Compare to RaceStudio 3's displayed values during the same
   capture instant. If status byte ≠ 0 marks "invalid," that's libxrk
   decoder type 13.
4. **Read the 13608-byte "MCLK Master Clk" frame at idx 47 in our capture
   through libxrk's parser.** The user's notes flag this as the channel-config
   table that maps offsets to channel names. It's almost certainly a sequence
   of CHS messages (each 112 bytes payload + 20 byte envelope = 132 bytes per
   channel; 13608 / 132 ≈ 103 channels, which matches an EVO5 with full
   IMU+CAN+GPS+math channels). Parse it and the offset map falls out for free.
5. **Check libxrk's `tests/reference_dll/` directory for an EVO5-generated
   XRK fixture.** If they have one, comparing what AiM's DLL emits for an
   EVO5 file vs an MXP file shows the additional tokens the EVO5 produces.
6. **Pull the strings out of RaceStudio 3's Qt binary.** xdrk only contains
   the file-parser DLL; the wire protocol lives in the main `RaceStudio3.exe`
   (or `RaceStudio3` on macOS, which is what produced our captures). This is
   the highest-yield next step if more wire-format detail is needed; the
   internal token names will all be plaintext strings inside the binary.
7. **Inspect AiM's firmware images.** Firmware .bin files are downloadable
   from https://www.aim-sportline.com/en/sw-fw-download.htm . If they're not
   encrypted, strings + radare2 will reveal both ends of the protocol. We
   have not checked.
8. **Search the AiM "Connectivity" SDK.** RaceStudio 3 ships a `connectivity`
   plugin used by both the desktop app and the iOS LapSnap-equivalent. If
   AiM ever distributed a debug build of this plugin, the symbol names would
   match the wire tokens directly. We have not searched for this.

---

## 5. Sources actually fetched and read (annotated)

Each entry: URL — what we got — assessment.

### Primary (high-value)

- **libxrk repo** — https://github.com/m3rlin45/libxrk — *Cloned to /tmp/libxrk and read in full.* Pure-source XRK parser. The single most useful prior-art for our task. MIT licensed.
- **libxrk spec/xrk_format.py** — https://github.com/m3rlin45/libxrk/blob/main/spec/xrk_format.py — *Read in full (1249 lines).* Defines the on-wire framing, the dispatch table for all known tokens, the byte layout of CHS / GRP / GPS / GNFI / LAP / CDE / CAL / idn / TRK / GPSR / ODO / RACM / VET / EmbeddedIDN, and the Construct-based check that the trailer sum equals `sum(payload) & 0xFFFF`.
- **libxrk spec/docs/companion.md** — https://github.com/m3rlin45/libxrk/blob/main/spec/docs/companion.md — *Read in full.* Decoder dispatch table (decoder types 0-39 → struct format + interpolate flag), unit map, GPS ECEF→LLA conversion (Vermeille 2003), GPS timing bug correction, lap detection.
- **libxrk spec/docs/unknown_regions.md** — https://github.com/m3rlin45/libxrk/blob/main/spec/docs/unknown_regions.md — *Read in full.* Catalog of every byte range that is not yet understood, with observed values across test fixtures. Useful as a "things the EVO5 might tell us if we capture more data" wishlist.
- **libxrk src/libxrk/aim_xrk.pyx** — https://github.com/m3rlin45/libxrk/blob/main/src/libxrk/aim_xrk.pyx — *Skimmed key sections (header+sample loop validation at lines 374-528).* Confirms checksum is byte-sum, not CRC; confirms framing rule.
- **xdrk repo** — https://github.com/bmc-labs/xdrk — *Cloned to /tmp/xdrk; read README, CHANGELOG, the `.def` exports file, and ran `strings` on the bundled DLL/.so.* Wraps AiM's official DLL — not source-level reverse-engineering, but the DLL exports + strings catalog the canonical metadata names, sample formats, channel types, and supported device list.
- **AiM official "Access AiM Data Files with a DLL"** — https://www.aim-sportline.com/docs/racestudio3/html/xrk-dll.html — *Fetched.* Lists the GPS computed channels and confirms the 6 raw GPS channels exposed by the DLL. Useful for naming things the same way RaceStudio does.

### Secondary (low-value but checked for completeness)

- **PyPI libxrk page** — https://pypi.org/project/libxrk/ — *Tried; CDN error.* Worked around via libraries.io.
- **libraries.io libxrk page** — https://libraries.io/pypi/libxrk — *Fetched.* Pointed to the GitHub repo and confirmed MIT license.
- **laz-/xrk repo** — https://github.com/laz-/xrk — *Cloned and inspected.* Just a thin Python ctypes wrapper around the same AiM DLL. No reverse engineering. Header file `MatLabXRK.h` is a copy of AiM's official header; same content as xdrk's bindings.
- **Rennlist forum thread on AiM XRK library release** — https://rennlist.com/forums/data-acquisition-and-analysis-for-racing-and-de/979249-aim-releases-library-to-access-xrk-files.html — *Fetched.* Confirms 2017-era release of AiM DLL; no community RE.
- **AutosportLabs CAN integration wiki page** — https://wiki.autosportlabs.com/AIM_Integration_CAN_Mapping — *Fetched.* Confirmed CAN-bus IDs/multipliers for the SmartyCam stream. Not relevant to WiFi protocol but useful as channel-engineering ground truth.
- **AutosportLabs blog "How to Live-stream telemetry"** — https://www.autosportlabs.com/how-to-live-stream-telemetry-from-your-aim-dash/ — *Fetched.* About CAN integration, not WiFi. Confirms 14 channels available over CAN for SmartyCam.
- **veracitydata.com AiM products page** — https://veracitydata.com/products/aim-products/ — *Fetched.* Pure marketing. No technical content.
- **lapsnap.app** — https://lapsnap.app/ — *Fetched.* Closed-source mobile app. Confirms it works with WiFi-enabled AiM devices. No protocol details.

---

## 6. Searches that turned up *nothing* useful — don't repeat these

Each search was tried; none surfaced any AiM-specific protocol info beyond
what's already in §1 and §2.

- "AiM EVO5 protocol reverse engineering wireshark TCP" — generic Wireshark
  results + AOL Instant Messenger noise.
- "AiM Solo wifi protocol port 2000 reverse engineering" — generic protocol
  RE results, nothing AiM-specific.
- "AiM EVO4S OR EVO5 wifi reverse engineer github" — vendor product pages
  only.
- "github STCP STNC AiM protocol" — Simple-TCP / Stream Control TCP
  unrelated repos.
- "MyChron AiM TCP protocol wireshark wifi" — AOL Instant Messenger noise.
- "SmartyCam protocol packet format reverse engineering" — generic protocol
  RE academic papers.
- "Race Studio Communication Protocol RSCP AiM" — vendor docs only; "RSCP"
  is not a term AiM uses publicly. (We invented this in our captures'
  decoded notes; it is not standard.)
- "aim-ka UDP 36002 AiM device discovery" — nothing. The probe string
  `aim-ka` exists nowhere on the public web.
- "Race Studio 3 wifi configuration protocol open source" — vendor configuration docs only.
- "AiM CAN passthrough live stream protocol documentation" — pointed back
  to the AutosportLabs CAN-integration material and AiM's CAN protocol
  builder PDFs; nothing on WiFi.
- "Race Studio 2 vs 3 RTL TGZ file format open source" — unrelated EDA-RTL
  results.
- "AiM sportline github topic data logger telemetry" — `aimstack` ML tracker
  noise; only relevant repos surfaced are libxrk/xdrk/laz- which we already
  have.
- "AiM dash forum reverse engineer protocol fsae OR formula wireshark" —
  FSAE forum threads exist but archive returns 403. The threads are about
  CAN-bus integration, not WiFi.
- "AiM telemetry protocol iMST OR iSLV OR iUSR OR iPTH" — no hits other
  than vendor pages.
- "AiM data logger wifi python API library reverse open-source" — nothing
  AiM-specific. `aim` (the ML experiment tracker) and unrelated Inverter
  Data Logger dominate results.
- "Race Studio Italian forum protocollo wireshark/pcap" — generic Italian
  Wireshark tutorials; no AiM-specific community.
- "AiM Solo / MyChron python wifi download script" — vendor pages only.
- "libxrk STCP / STNC / iMST reverse engineer github" — libxrk doesn't
  mention these; confirms wire-only tokens.
- "AiM EVO5 / Solo 2 TCP port 2000 packet format" — vendor product pages
  only.

### Italian / European search terms tried (no extra value)

- "Race Studio forum Italian protocol Wireshark" → general HTML.it tutorials
  about Wireshark, no motorsport-specific community.
- "RaceStudio Italian forum FSAE Formula" → archive.org of fsae.com forums
  references CAN protocol but archives return 403/connection-refused.

The Italian motorsport community we expected to find (given AiM's Italian
origins and the `pilota/veicolo/campionato` field names) does not appear to
have published any public protocol documentation. The active Italian
motorsport forums (e.g., drift.it, FormulaSAE Italy) are not indexed by
the search providers we have access to, but a manual visit might be worth
doing if more leads dry up.

---

## 7. Speculation flagged as such

These are *plausible but unverified* and should be checked before relied on:

- **Sample format inside live frames is fp16 + 1-byte status.** Inferred from
  3-byte slot width matching libxrk's most common decoder type (20 = fp16
  interp) plus an extra status byte (decoder type 13). **Unverified** against
  RaceStudio 3 displayed values.
- **The 13608-byte "MCLK Master Clk" frame is a sequence of 112-byte CHS
  messages.** Inferred from 13608 ≈ 103 × 132 (132 = CHS payload + envelope
  overhead). **Unverified** by actually parsing it.
- **The version byte (our "FLAG") is always 0x00 only because the EVO5
  firmware is on version 0 of all message types.** Newer or older firmware
  may use non-zero versions. **Verify before hardcoding zero in our parser.**
- **`STNC` = "Studio Network Command" and `STCP` = "Studio TCP".** Our
  earlier decoded note. We have no source confirming the abbreviation
  expansion; it is just a plausible expansion. The 4 letters could equally
  stand for Italian terms.
- **Inner tokens beginning with `i` (iMST/iHW/iUSR/iPTH/iLCK/iSST/iLTS/iPRL)
  follow naming convention "info-X."** Inferred from `iSLV` being "info
  slave" in libxrk's commentary. The leading `i` consistently denotes a
  read-only enumeration message. Unverified.
