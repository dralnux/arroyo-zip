// IMSAI-8080 worker: an IMSAI (z80pack imsaisim model) running a Z80 CPU core
// (DrGoldfire/Z80.js) off the UI thread. The MPU-B monitor/boot ROM auto-boots
// CP/M from an IMSAI-format disk via the FIF floppy controller, so IMSAI disk
// images boot unmodified.
//
// Machine:
//   MPU-B ROM (2K) at 0xD800, shadowed at 0x0000-0x07FF at reset; reset -> PC=0xD800.
//   Banked ROM/RAM control on port 0xF3 (groupsel): bit6 low RAM, bit7 high RAM.
//   Console: IMSAI SIO-2 ch.A - port 2 data, port 3 status (b0 TX rdy, b1 RX rdy).
//   Disk: FIF board on port 0xFD - memory-mapped DMA via a 7-byte disk descriptor
//     [unit/cmd, result, track-hi/fmt, track, sector, dma-lo, dma-hi]; result=1 ok.
//     Units are one-hot: 1=A 2=B 4=C 8=D (8" SSSD 26x77x128); 15=4MB hard disk.

'use strict';

// worker query string carries the fingerprinted CPU-core, ROM and modem URLs
var Q = (function () { try { return new URLSearchParams(self.location.search); } catch (e) { return null; } })();
var CPU_URL = (Q && Q.get('cpu')) || '/sim/z80.js';
var CPU8080_URL = (Q && Q.get('cpu8080')) || '/sim/i8080.js';
var CPU_MODE = (Q && Q.get('cpumode')) || 'z80';   // which core to start in
var ROM_URL = (Q && Q.get('rom')) || '/sim/mpu-b-rom.bin';
var MODEM_URL = (Q && Q.get('modem')) || '/sim/sim-modem.js';
importScripts(CPU_URL);     // DrGoldfire/Z80.js -> global Z80(core)
// The 8080 core is optional (an older bundle may not ship it); if it fails to
// load the sim just stays Z80-only rather than refusing to boot. Grabbed off the
// global immediately because our adapter below reuses the name CPU8080.
var MALY = null;
try { importScripts(CPU8080_URL); MALY = self.CPU8080; }
catch (e) { try { console.warn('[sim] 8080 core failed to load (' + CPU8080_URL + '): ' + e.message); } catch (e2) {} }
// The AT modem is optional: a missing/failed modem module must never brick the
// sim (importScripts throws would otherwise abort the worker before it boots).
try { importScripts(MODEM_URL); }
catch (e) { try { console.warn('[sim] modem module failed to load (' + MODEM_URL + '): ' + e.message); } catch (e2) {} }
if (typeof Modem === 'undefined') {
  self.Modem = {
    config: function () {}, setWake: function () {}, tx: function () {},
    rxAvail: function () { return false; }, rx: function () { return 0; },
    reset: function () {}, dialNow: function () {}, hangupNow: function () {}
  };
}

// Adapter: presents one maly-style CPU8080 surface backed by either core.
//   z80   - DrGoldfire Z80. A strict 8080 superset, so the monitor ROM and CP/M
//           run unchanged while Z80 software (NZ-COM / Z-System) executes
//           correctly instead of misreading ED/CB/DD/FD opcodes. Default.
//   8080  - Martin Maly's flag-accurate 8080. Needed by pure-8080 software:
//           the Z80 redefines the parity flag as overflow (P/V) after
//           arithmetic, so 8080 code that branches on JPE/JPO (XYBASIC, the
//           IMSAI BASIC ROMs) takes the wrong branch and hangs.
var CPU8080 = (function () {
  var mode = 'z80';
  var z = null, m1 = false, fetchCb = null, wiring = null;
  // the first read of each instruction is the M1 opcode fetch: tell the machine
  // so the front panel can light the M1 status bit
  function read(a) { if (m1) { m1 = false; if (fetchCb) fetchCb(); } return wiring.ba(a); }
  function build() {
    if (mode === '8080') {                       // ports arrive pre-masked to 8 bits
      MALY.init(wiring.bt, read, function () {}, wiring.po, wiring.pi);
      return;
    }
    // the Z80 puts A/B on the high port byte (OUT (n),A etc.); the IMSAI is
    // 8-bit-decoded, so mask to the low 8 bits before dispatching
    z = new Z80({
      mem_read: read, mem_write: wiring.bt,
      io_read: function (p) { return wiring.pi(p & 0xff); },
      io_write: function (p, v) { wiring.po(p & 0xff, v); }
    });
  }
  return {
    has8080: function () { return !!MALY; },
    mode: function () { return mode; },
    // caller cold-boots after this: the two cores keep separate register state
    setMode: function (m) {
      var want = (m === '8080' && MALY) ? '8080' : 'z80';
      if (want === mode) return mode;
      mode = want;
      if (wiring) build();
      return mode;
    },
    init: function (byteTo, byteAt, onFetch, portOut, portIn) {
      wiring = { bt: byteTo, ba: byteAt, of: onFetch, po: portOut, pi: portIn };
      fetchCb = onFetch;
      build();
    },
    reset: function () { if (mode === '8080') MALY.reset(); else z.reset(); },
    set: function (reg, v) {
      if (mode === '8080') { MALY.set(reg, v & 0xffff); return; }
      var s = z.getState(); s[reg.toLowerCase()] = v & 0xffff; z.setState(s);
    },
    steps: function (Ts) {
      if (mode === '8080') {                     // T() is a cumulative cycle count
        var start = MALY.T(), t = 0;
        while (t < Ts) { m1 = true; MALY.steps(1); t = MALY.T() - start; }
        return;
      }
      var n = 0; while (n < Ts) { m1 = true; n += z.run_instruction(); }
    },
    step1: function () {
      m1 = true;
      if (mode === '8080') { var s = MALY.T(); MALY.steps(1); return MALY.T() - s; }
      return z.run_instruction();
    },
    status: function () {
      if (mode === '8080') {
        var q = MALY.status();
        return { pc: q.pc, sp: q.sp, a: q.a, b: q.b, c: q.c, d: q.d, e: q.e, h: q.h, l: q.l,
                 iff1: !!q.inte, halted: !!q.halted };
      }
      var s = z.getState();
      return { pc: s.pc, sp: s.sp, a: s.a, b: s.b, c: s.c, d: s.d, e: s.e, h: s.h, l: s.l, iff1: s.iff1, halted: s.halted };
    }
  };
})();

var SECTOR = 128;
var CYCLES_PER_TICK = 8000;       // ~2 MHz at a 4 ms cadence
var NDRIVES = 9;                  // drive indices 0-3 = floppies A:-D:, 8 = 4 MB hard disk (I:)
var FLOPPY_SIZE = 256256;         // 26 * 77 * 128
var HD_SIZE = 4177920;            // 128 * 255 * 128

var ROM_BASE = 0xD800, ROM_SIZE = 2048;
var GROUP0 = 0x40, GROUP1 = 0x80;   // groupsel bits: set = RAM banked in

var mem = new Uint8Array(65536);
var rom = null;                     // MPU-B ROM, filled by fetch below
var mpubram = new Uint8Array(256);  // MPU-B onboard scratch RAM at 0xD000
var groupsel = 0x00;                // power-on default: ROM shadowed low + high

// CP/M 3 banked memory (MMU register on port 0x40). selbnk 0 = base memory[]
// (with the MPU-B ROM banking); 1-7 select plain-RAM 48K banks for addresses
// below SEGSIZ. Addresses >= SEGSIZ are common (always base memory).
var SEGSIZ = 49152, NBANKS = 8;
var banks = [null];                 // banks[0] is base memory[], handled inline
for (var _b = 1; _b < NBANKS; _b++) banks.push(new Uint8Array(SEGSIZ));
var selbnk = 0;

var disks = new Array(NDRIVES).fill(null);
var dirty = new Array(NDRIVES).fill(false);

// FIF controller state
var fdstate = 0, descno = 0;
var fdaddr = new Array(16).fill(0);

var input = [];
var running = false, booted = false, pendingBoot = false, timer = null;
var batchOut = 0, batchDisk = 0, batchPoll = 0;
var persistTimer = null;

// ── AM9511A "APU" arithmetic processor (data 0xA2 / status 0xA3) ──
// Ported from z80pack's iodevices/apu (am9511.c, MIT). 16-byte circular stack;
// 16/32-bit fixed point plus 32-bit AM9511 floating point. Operations complete
// synchronously here, so BUSY is never observed set -- a real chip holds it high
// for the duration of the operation. XYBASIC's 9511 build (XYCPM95) polls that
// bit and spins forever if no APU answers.
//
// AM9511 float on the stack, little-endian: bytes 0-2 are a 24-bit mantissa
// with an EXPLICIT leading 1 (m/2^24 lies in [0.5,1); bit 23 clear means zero);
// byte 3 is the sign in bit 7 plus a 7-bit two's-complement exponent.
//   value = (sign) * (m / 2^24) * 2^exp
var APU = (function () {
  var BUSY = 0x80, SIGN = 0x40, ZERO = 0x20,
      E_DIV0 = 0x10, E_NEG = 0x08, E_ARG = 0x18, E_UND = 0x04, E_OVF = 0x02;
  var st = new Uint8Array(16), sp = 0, status = 0, latch = 0;

  function at(o) { return (sp + o) & 0x0f; }
  function rd(o) { return st[at(o)]; }
  function wr(o, v) { st[at(o)] = v & 0xff; }
  function dec(n) { sp = (sp - n) & 0x0f; }
  function push(v) { st[sp] = v & 0xff; sp = (sp + 1) & 0x0f; }
  function pop() { sp = (sp - 1) & 0x0f; return st[sp]; }
  function isSingle() { return (latch & 0x60) === 0x60; }
  function isFixed() { return (latch & 0x20) !== 0; }

  function get16(o) { var v = rd(o) | (rd(o + 1) << 8); return (v & 0x8000) ? v - 0x10000 : v; }
  function put16(o, v) { wr(o, v); wr(o + 1, v >> 8); }
  function get32(o) { return (rd(o) | (rd(o + 1) << 8) | (rd(o + 2) << 16) | (rd(o + 3) << 24)) | 0; }
  function put32(o, v) { wr(o, v); wr(o + 1, v >> 8); wr(o + 2, v >> 16); wr(o + 3, v >> 24); }

  function getF(o) {
    var m = rd(o) | (rd(o + 1) << 8) | (rd(o + 2) << 16), eb = rd(o + 3);
    if (!(m & 0x800000)) return 0;                  // mantissa bit 23 clear -> zero
    var e = eb & 0x7f; if (e & 0x40) e -= 128;      // 7-bit two's complement
    return ((eb & 0x80) ? -1 : 1) * (m / 16777216) * Math.pow(2, e);
  }
  function encF(v) {
    if (!v || !isFinite(v)) return [0, 0, 0, 0];
    var neg = v < 0; v = Math.abs(v);
    var e = Math.floor(Math.log(v) / Math.LN2) + 1, m = v / Math.pow(2, e);
    while (m >= 1) { m /= 2; e++; }                 // normalise to [0.5,1)
    while (m < 0.5) { m *= 2; e--; }
    var mant = Math.round(m * 16777216);
    if (mant > 0xffffff) { mant = mant >> 1; e++; }
    if (e > 63) { status |= E_OVF; e -= 128; }      // chip biases by 128 and flags
    else if (e < -64) { status |= E_UND; e += 128; }
    return [mant & 0xff, (mant >> 8) & 0xff, (mant >> 16) & 0xff, (e & 0x7f) | (neg ? 0x80 : 0)];
  }
  function putF(o, v) { var b = encF(v); wr(o, b[0]); wr(o + 1, b[1]); wr(o + 2, b[2]); wr(o + 3, b[3]); }
  function pushF(v) { var b = encF(v); push(b[0]); push(b[1]); push(b[2]); push(b[3]); }

  function sz() {
    if (isSingle()) { if ((rd(-1) | rd(-2)) === 0) status |= ZERO; }
    else if (isFixed()) { if ((rd(-1) | rd(-2) | rd(-3) | rd(-4)) === 0) status |= ZERO; }
    else if ((rd(-2) & 0x80) === 0) status |= ZERO;
    if (rd(-1) & 0x80) status |= SIGN;
  }

  function command(op) {
    latch = op; status = BUSY;
    var o = op & 0x1f, a, b, r, n, i, t, u;
    switch (o) {
      case 0x00: status = 0; return;                                   // NOP
      case 0x1a: push(0xda); push(0x0f); push(0xc9); push(0x02); sz(); break;  // PUPI
      case 0x14:                                                       // CHS (fixed)
        if (isSingle()) put16(-2, -get16(-2)); else put32(-4, -get32(-4));
        sz(); break;
      case 0x15: wr(-1, rd(-1) ^ 0x80); sz(); break;                   // CHSF
      case 0x18: dec(isSingle() ? 2 : 4); sz(); break;                 // POP
      case 0x17:                                                       // PTO (duplicate TOS)
        if (isSingle()) { t = rd(-2); u = rd(-1); push(t); push(u); }
        else { var d = [rd(-4), rd(-3), rd(-2), rd(-1)]; for (i = 0; i < 4; i++) push(d[i]); }
        sz(); break;
      case 0x19:                                                       // XCH
        n = isSingle() ? 2 : 4;
        for (i = 1; i <= n; i++) { t = rd(-i); u = rd(-n - i); wr(-i, u); wr(-n - i, t); }
        sz(); break;
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: case 0x16: {         // ADD SUB MUL DIV MUU
        var lim = isSingle() ? 0x10000 : 0x100000000;
        var tos = isSingle() ? get16(-2) : get32(-4);
        var nos = isSingle() ? get16(-4) : get32(-8);
        if (o === 0x0c) r = nos + tos;
        else if (o === 0x0d) r = nos - tos;
        else if (o === 0x0f) { if (tos === 0) { status |= E_DIV0; r = nos; } else r = (nos / tos) | 0; }
        else { r = nos * tos; if (o === 0x16) r = Math.floor(r / lim); }   // MUU = upper half
        if (o === 0x0c || o === 0x0d) { if (r >= lim / 2 || r < -lim / 2) status |= E_OVF; }
        if (isSingle()) { put16(-4, r); dec(2); } else { put32(-8, r); dec(4); }
        sz(); break;
      }
      case 0x10: case 0x11: case 0x12: case 0x13:                      // FADD FSUB FMUL FDIV
        a = getF(-4); b = getF(-8);
        if (o === 0x10) r = a + b;
        else if (o === 0x11) r = b - a;
        else if (o === 0x12) r = a * b;
        else if (a === 0) { r = b; status |= E_DIV0; } else r = b / a;
        putF(-8, r); dec(4); latch = 0x00; sz(); break;
      case 0x01: case 0x02: case 0x03: case 0x04: case 0x05:           // SQRT SIN COS TAN ASIN
      case 0x06: case 0x07: case 0x08: case 0x09: case 0x0a:           // ACOS ATAN LOG LN EXP
        a = getF(-4); r = 0;
        if (o === 0x01) { if (a < 0) status |= E_NEG; else r = Math.sqrt(a); }
        else if (o === 0x02) r = Math.sin(a);
        else if (o === 0x03) r = Math.cos(a);
        else if (o === 0x04) r = Math.tan(a);
        else if (o === 0x05) { if (Math.abs(a) > 1) status |= E_ARG; else r = Math.asin(a); }
        else if (o === 0x06) { if (Math.abs(a) > 1) status |= E_ARG; else r = Math.acos(a); }
        else if (o === 0x07) r = Math.atan(a);
        else if (o === 0x08) { if (a <= 0) status |= E_NEG; else r = Math.log(a) / Math.LN10; }
        else if (o === 0x09) { if (a <= 0) status |= E_NEG; else r = Math.log(a); }
        else r = Math.exp(a);
        putF(-4, r); latch = 0x00; sz(); break;
      case 0x0b:                                                       // PWR: nos^tos
        a = getF(-4); b = getF(-8); putF(-8, Math.pow(b, a)); dec(4); latch = 0x00; sz(); break;
      case 0x1d:                                                       // FLTS: 16-bit -> float
        n = (pop() << 8) | pop(); if (n & 0x8000) n -= 0x10000;
        pushF(n); latch = 0x00; sz(); break;
      case 0x1c:                                                       // FLTD: 32-bit -> float
        n = ((pop() << 24) | (pop() << 16) | (pop() << 8) | pop()) | 0;
        pushF(n); latch = 0x00; sz(); break;
      case 0x1f:                                                       // FIXS: float -> 16-bit
        a = getF(-4);
        if (a < -32768 || a > 32767) { status |= E_OVF; sz(); break; }
        dec(4); n = a < 0 ? Math.ceil(a) : Math.floor(a);
        push(n & 0xff); push((n >> 8) & 0xff); latch = 0x60; sz(); break;
      case 0x1e:                                                       // FIXD: float -> 32-bit
        a = getF(-4);
        if (a < -2147483648 || a > 2147483647) { status |= E_OVF; sz(); break; }
        dec(4); n = (a < 0 ? Math.ceil(a) : Math.floor(a)) | 0;
        push(n & 0xff); push((n >> 8) & 0xff); push((n >> 16) & 0xff); push((n >> 24) & 0xff);
        latch = 0x20; sz(); break;
      default: break;
    }
    status &= ~BUSY;
  }

  return {
    reset: function () { st.fill(0); sp = 0; status = 0; latch = 0; },
    push: push, pop: pop, command: command,
    status: function () { return status; }
  };
})();

// ── CP-A front panel: the last bus cycle + 8080 status byte, sampled for the LEDs ──
var CPU_MEMR = 128, CPU_INP = 64, CPU_M1 = 32, CPU_OUT = 16,
    CPU_HLTA = 8, CPU_STACK = 4, CPU_WO = 2, CPU_INTA = 1;
var fpAddr = 0, fpData = 0, fpStatus = 0, fpOutput = 0x00;   // 0xFF latch drives the programmed-output LEDs
var fpM1 = false;          // set by the adapter's opcode-fetch hook, consumed by the next byteAt

// Lamp strobe. Millions of bus cycles happen between panel frames, so the panel
// shows ONE of them — but which one has to be chosen at random. Taking whichever
// cycle the emulator happened to stop on locks the display to the guest's loop:
// the sample point advances by (slice mod loop) each frame, so when those two
// lengths are commensurate the panel freezes on a single instruction (at the CP/M
// prompt that happened at 2 and 8 MHz, and gave a two-state flicker at 4 and max).
// Picking a random cycle has no such phase to lock to, and over successive frames
// each lamp is lit for exactly its true share of the bus — a real panel viewed at
// 30 fps. Cost on this very hot path is one increment and one compare.
var fpCycles = 0, fpPick = 0, fpPicked = false, fpLastCycles = 0;
var fpPA = 0, fpPD = 0, fpPS = 0;
function fpBus(a, d, s) {
  fpAddr = a; fpData = d; fpStatus = s;
  if (fpCycles++ === fpPick) { fpPA = a; fpPD = d; fpPS = s; fpPicked = true; }
}
function fpResetFrame() {
  if (fpCycles) fpLastCycles = fpCycles;
  fpCycles = 0; fpPicked = false;
  // aim inside the previous frame's length; if this one comes up short we fall
  // back to its last cycle, which at a steady workload is a rare few percent
  fpPick = fpLastCycles ? Math.floor(Math.random() * fpLastCycles) : 0;
}
var fpHold = 0;            // pulses high while the FIF is doing DMA (bus request)
var lastFpPost = 0;
var senseHi = 0;           // high byte of the 16 data switches = the programmed-input / sense port (IN 0FFH)
function onFetch() { fpM1 = true; }

// ── banked memory: ROM overlays the low 2K and 0xD800 region until banked out ──
function byteAt(a) {
  a &= 0xffff;
  var v;
  if (selbnk >= 1 && selbnk < NBANKS && a < SEGSIZ) v = banks[selbnk][a];   // alternate bank
  else if (!(groupsel & GROUP0) && a < 0x0800 && rom) v = rom[a];
  else if (!(groupsel & GROUP1) && a >= 0xD800 && a <= 0xDFFF && rom) v = rom[a - ROM_BASE];
  else if (!(groupsel & GROUP1) && a >= 0xD000 && a <= 0xD0FF) v = mpubram[a - 0xD000];
  else v = mem[a];
  fpBus(a, v, CPU_MEMR | CPU_WO | (fpM1 ? CPU_M1 : 0)); fpM1 = false;
  return v;
}
function byteTo(a, v) {
  a &= 0xffff; v &= 0xff;
  fpBus(a, v, 0);   // memory write: WO active-low is 0, all status bits low
  if (selbnk >= 1 && selbnk < NBANKS && a < SEGSIZ) { banks[selbnk][a] = v; return; }   // alternate bank
  if (!(groupsel & GROUP1)) {
    if (a >= 0xD800 && a <= 0xDFFF) return;                 // ROM is write-protected
    if (a >= 0xD000 && a <= 0xD0FF) { mpubram[a - 0xD000] = v; return; }
  }
  mem[a] = v;   // low-page writes always hit RAM, even while ROM is shadowed for reads
}

// ── FIF floppy/hard-disk controller ──
function diskGeom(unit) {
  switch (unit) {
    case 1:  return { spt: 26, maxtrk: 77, no: 0, size: FLOPPY_SIZE };
    case 2:  return { spt: 26, maxtrk: 77, no: 1, size: FLOPPY_SIZE };
    case 4:  return { spt: 26, maxtrk: 77, no: 2, size: FLOPPY_SIZE };
    case 8:  return { spt: 26, maxtrk: 77, no: 3, size: FLOPPY_SIZE };
    case 15: return { spt: 128, maxtrk: 255, no: 8, size: HD_SIZE };
    default: return null;
  }
}
function fifExec(addr) {
  batchDisk++;
  fpHold = 1;                          // FIF DMA drives the bus-request (HOLD) light
  var b0 = byteAt(addr), unit = b0 & 0x0f, cmd = b0 >> 4;
  if (byteAt(addr + 1) !== 0) { byteTo(addr + 1, 0xc1); return; }   // result not pre-zeroed
  if (byteAt(addr + 2) !== 0) { byteTo(addr + 1, 0xc8); return; }   // track-hi / odd format
  var g = diskGeom(unit);
  if (!g) { byteTo(addr + 1, 0xc2); return; }                       // no/invalid drive select
  var d = disks[g.no];
  if (!d || d.length !== g.size) { byteTo(addr + 1, 0xa1); return; } // no disk / wrong size
  var track = byteAt(addr + 3), sector = byteAt(addr + 4);
  var dma = byteAt(addr + 5) | (byteAt(addr + 6) << 8);

  if (cmd === 4) { byteTo(addr + 1, 1); return; }                   // VERIFY: disks are reliable
  if (cmd === 3) {                                                  // FORMAT track -> 0xE5
    if (track >= g.maxtrk) { byteTo(addr + 1, 0xc5); return; }
    var pf = track * g.spt * SECTOR;
    for (var f = 0; f < g.spt * SECTOR; f++) d[pf + f] = 0xe5;
    dirty[g.no] = true; schedulePersist(); byteTo(addr + 1, 1); return;
  }
  if (cmd !== 1 && cmd !== 2) { byteTo(addr + 1, 0xc1); return; }
  if (track >= g.maxtrk) { byteTo(addr + 1, 0xc5); return; }
  if (sector < 1 || sector > g.spt) { byteTo(addr + 1, 0xc6); return; }
  var pos = (track * g.spt + (sector - 1)) * SECTOR;
  if (cmd === 2) {                                                  // READ sector -> DMA
    for (var i = 0; i < SECTOR; i++) byteTo((dma + i) & 0xffff, d[pos + i]);
  } else {                                                          // WRITE DMA -> sector
    for (var j = 0; j < SECTOR; j++) d[pos + j] = byteAt((dma + j) & 0xffff);
    dirty[g.no] = true; schedulePersist();
  }
  byteTo(addr + 1, 1);
}
function fifOut(v) {
  v &= 0xff;
  if (fdstate === 0) {
    switch (v & 0xf0) {
      case 0x00: descno = v & 0xf; fifExec(fdaddr[descno]); break;  // execute descriptor
      case 0x10: descno = v & 0xf; fdstate = 1; break;              // set descriptor address
      default: break;                                               // reset/wp/etc: no-op
    }
  } else if (fdstate === 1) {
    fdaddr[descno] = v; fdstate = 2;
  } else {
    fdaddr[descno] += v << 8; fdstate = 0;
  }
}

function schedulePersist() { if (!persistTimer) persistTimer = setTimeout(flushPersist, 800); }
function flushPersist() {
  persistTimer = null;
  for (var d = 0; d < NDRIVES; d++) {
    if (dirty[d] && disks[d]) {
      dirty[d] = false;
      var copy = disks[d].slice();
      postMessage({ type: 'persist', drive: d, buffer: copy.buffer }, [copy.buffer]);
    }
  }
}

function portIn(p) {
  var v;
  switch (p) {
    case 2: v = input.length ? input.shift() : 0x00; break;             // SIO-2 #1 ch A console data
    case 3: if (input.length) { v = 0x03; } else { batchPoll++; v = 0x01; } break;  // TX rdy [+ RX rdy]
    case 4: v = 0x00; break;                                            // SIO-2 #1 ch B (VIO keyboard): absent
    case 5: v = 0x01; break;                                            // ...TX ready, never any RX
    // The MPU-A and MPU-B monitors both know three console devices: the SIO-2
    // above, an 8251 serial channel at 12/13 (the ROM programs its baud rate with
    // OUT 13) and a parallel keyboard at 14/15. With no boot disk the ROM runs its
    // "HIT SPACE BAR" autodetect, polling all three, so these have to answer:
    // a floating 0xFF reads as a device endlessly delivering 0xFF characters.
    case 0x12: v = 0x00; break;                                         // serial data: nothing connected
    case 0x13: v = 0x01; break;                                         // 8251 status: TX ready, never RX
    case 0x14: v = 0x00; break;                                         // parallel data (z80pack io_pport_in)
    case 0x15: v = 0x00; break;                                         // parallel status: never a character
    // On a real IMSAI the AT modem is SIO-2 #2 channel B only; channel A is a
    // separate byte pipe with no AT interpreter (a socket on z80pack, nothing here).
    case 0x22: v = 0x00; break;                                         // ch A data: nothing attached
    case 0x23: v = 0x01; break;                                         // ch A status: TX ready, never RX
    case 0x24: v = Modem.rx(); break;                                   // ch B data -> modem
    case 0x25: v = 0x01 | (Modem.rxAvail() ? 0x02 : 0x00); break;       // TXRDY [+ RXRDY]
    case 0x40: v = selbnk; break;                                       // MMU bank register (CP/M 3)
    case 0xF3: groupsel = GROUP0 | GROUP1; v = 0xff; break;             // read control port banks all RAM in
    case 0xFD: v = 0x00; break;                                         // FIF
    case 0xFF: v = senseHi; break;                                      // front-panel sense switches (A15-A8)
    case 0xA0: v = 0xff; break;                                         // virtual hw control (lock)
    case 0xA2: v = APU.pop(); break;                                    // AM9511 APU data
    case 0xA3: v = APU.status(); break;                                 // AM9511 APU status
    // An S-100 card decodes its whole 16-port block, driving the bus even on the
    // addresses it doesn't use, so the two SIO-2 boards answer 0x00 across
    // 0x00-0x0F and 0x20-0x2F (z80pack's imsai_sio_nofun_in). Anywhere else no
    // card responds and the bus floats high -> 0xFF.
    default:
      v = ((p >= 0x00 && p <= 0x0f) || (p >= 0x20 && p <= 0x2f)) ? 0x00 : 0xff;
      break;
  }
  fpBus((fpAddr & 0xff00) | (p & 0xff), v & 0xff, CPU_INP | CPU_WO);
  return v;
}
function portOut(p, v) {
  v &= 0xff;
  switch (p) {
    case 2: batchOut++; postMessage({ type: 'out', data: v & 0x7f }); break;  // console out (strip parity)
    case 0x22: break;                                                         // SIO-2 #2 ch A: discarded (no device)
    case 0x24: Modem.tx(v); break;                                            // ch B data out -> modem (AT / online)
    case 0x23: case 0x25: break;                                              // SIO-2 #2 status/control: no-op
    case 0x40: selbnk = v; break;                                             // MMU bank register (CP/M 3)
    case 0xF3: groupsel = v; break;                                           // banked ROM/RAM select
    case 0xFD: fifOut(v); break;
    case 0xA2: APU.push(v); break;                                            // AM9511 APU data
    case 0xA3: APU.command(v); break;                                         // AM9511 APU command
    case 0xFF: fpOutput = v; break;                                           // programmed-output LEDs latch
    // 3/8 SIO status+control, 0xA0 hwctl: no-op
  }
  fpBus((fpAddr & 0xff00) | (p & 0xff), v, CPU_OUT);
}

CPU8080.setMode(CPU_MODE);   // select the core before wiring it up
CPU8080.init(byteTo, byteAt, onFetch, portOut, portIn);

// push the front-panel LED state to the UI; when stopped the bus shows PC / mem[PC]
// Stopped -> the exact bus state, as the real panel shows under EXAMINE.
// Running -> the one bus cycle this frame's strobe landed on. The lamps stay hard
// on/off; the movement comes from successive frames catching different cycles.
function fpSnapshot(stopped) {
  var st = CPU8080.status();
  var hlta = st.halted ? CPU_HLTA : 0;
  var m = {
    type: 'fp',
    output: fpOutput & 0xff,
    run: (running && !stopped) ? 1 : 0, wait: (running && !stopped) ? 0 : 1,
    inten: st.iff1 ? 1 : 0, hold: fpHold
  };
  if (stopped) {
    m.addr = st.pc & 0xffff; m.data = byteAt(st.pc) & 0xff;
    m.status = (CPU_MEMR | CPU_M1 | CPU_WO | hlta) & 0xff;
  } else if (fpPicked) {
    m.addr = fpPA & 0xffff; m.data = fpPD & 0xff; m.status = (fpPS | hlta) & 0xff;
  } else {                     // frame ran short, or halted with no bus activity
    m.addr = fpAddr & 0xffff; m.data = fpData & 0xff; m.status = (fpStatus | hlta) & 0xff;
  }
  postMessage(m);
  fpHold = 0;
  fpResetFrame();
}

function coldBoot() {
  if (!rom) { pendingBoot = true; return; }   // wait for the ROM fetch
  pendingBoot = false;
  flushPersist();
  mem.fill(0);
  mpubram.fill(0);
  for (var b = 1; b < NBANKS; b++) banks[b].fill(0);
  groupsel = 0x00;
  selbnk = 0;
  input.length = 0;
  Modem.reset();
  APU.reset();
  fpAddr = 0; fpData = 0; fpStatus = 0; fpOutput = 0x00; fpM1 = false; fpHold = 0; fpResetFrame();
  CPU8080.reset();
  CPU8080.set('PC', ROM_BASE);   // start in the monitor ROM (MPU-A/B both live at 0xD800); it auto-boots or drops to its monitor
  booted = true;
  postMessage({ type: 'cpu', mode: CPU8080.mode(), has8080: CPU8080.has8080() });
  if (!running) { running = true; loop(); }
}

function loop() {
  timer = null;
  if (!running) return;
  batchOut = 0; batchDisk = 0; batchPoll = 0;
  try {
    CPU8080.steps(CYCLES_PER_TICK);
  } catch (e) {
    running = false;
    postMessage({ type: 'error', msg: 'CPU fault: ' + e.message });
    return;
  }
  var now = Date.now();
  if (now - lastFpPost >= 30) { lastFpPost = now; fpSnapshot(false); }   // ~30 Hz LED refresh
  // A guest that is only polling the console gets a longer nap, which costs it
  // nothing real and saves a lot of host CPU. 33 ms rather than something longer
  // because the panel is sampled once per pass: nap through several frame periods
  // and the lamps update in slow, choppy jumps instead of a 30 Hz shimmer.
  var idle = input.length === 0 && batchOut === 0 && batchDisk === 0 && batchPoll > 200;
  timer = setTimeout(loop, idle ? 33 : 4);
}

// wake the CPU loop out of its idle delay (keystrokes, or modem data arriving)
function wakeLoop() { if (running && timer) { clearTimeout(timer); timer = null; loop(); } }
Modem.setWake(wakeLoop);

fetch(ROM_URL).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
  rom = new Uint8Array(buf);
  if (pendingBoot) coldBoot();
}).catch(function (e) {
  postMessage({ type: 'error', msg: 'ROM load failed: ' + e.message });
});

onmessage = function (e) {
  var m = e.data;
  switch (m.type) {
    case 'insert': disks[m.drive] = new Uint8Array(m.buffer); break;
    case 'eject':  disks[m.drive] = null; break;
    case 'boot':
    case 'reset':  coldBoot(); break;
    // Diagnostic: single-step a burst and histogram the PC, to find where a
    // wedged program is spinning. Stop the machine first (fp-stop).
    case 'mem-probe': {                       // diagnostic: read raw memory
      var out = [], ma = m.addr & 0xffff, ml = m.len || 64;
      for (var mi = 0; mi < ml; mi++) out.push(byteAt((ma + mi) & 0xffff));
      postMessage({ type: 'mem-probe', addr: ma, bytes: out });
      break;
    }
    case 'cpu-probe': {
      var hist = {}, n = m.samples || 4000;
      for (var pi = 0; pi < n; pi++) {
        var pc = CPU8080.status().pc;
        hist[pc] = (hist[pc] || 0) + 1;
        CPU8080.step1();
      }
      postMessage({ type: 'cpu-probe', status: CPU8080.status(), hist: hist, samples: n });
      break;
    }
    case 'set-cpu':                                                             // swap CPU core, then cold-boot
      CPU8080.setMode(m.mode);
      coldBoot();
      break;
    case 'set-rom':                                                             // swap monitor ROM, then cold-boot
      fetch(m.url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        rom = new Uint8Array(buf); coldBoot();
      }).catch(function (err) { postMessage({ type: 'error', msg: 'ROM load failed: ' + err.message }); });
      break;
    case 'clock':  CYCLES_PER_TICK = (m.cycles > 0) ? m.cycles : 8000; break;   // CPU speed
    case 'modem-config': Modem.config(m.cfg || {}); break;                      // proxy/token/telnet
    case 'modem-dial':   Modem.dialNow(m.target, m.telnet); wakeLoop(); break;  // phonebook dial
    case 'modem-hangup': Modem.hangupNow(); break;
    case 'key':
      if (booted) {
        input.push(m.code & 0xff);
        wakeLoop();
      }
      break;
    case 'stop':
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      flushPersist();
      if (booted) fpSnapshot(true);
      break;

    // ── CP-A front-panel monitor ──
    case 'fp-sense': senseHi = (m.value >> 8) & 0xff; break;   // upper 8 switches feed IN 0FFH
    case 'fp-run':
      if (booted && !running) { running = true; loop(); }
      break;
    case 'fp-stop':
      if (running) { running = false; if (timer) { clearTimeout(timer); timer = null; } }
      if (booted) fpSnapshot(true);
      break;
    case 'fp-extclr':
      input.length = 0; fdstate = 0; descno = 0;                // pulse-clear console + FIF
      if (booted) fpSnapshot(!running);
      break;
    // EXAMINE/DEPOSIT/STEP only act on a halted machine, like the real panel
    case 'fp-step':
      if (booted && !running) { CPU8080.step1(); flushPersist(); fpSnapshot(true); }
      break;
    case 'fp-examine':
      if (booted && !running) { CPU8080.set('PC', m.addr & 0xffff); fpSnapshot(true); }
      break;
    case 'fp-examine-next':
      if (booted && !running) { CPU8080.set('PC', (CPU8080.status().pc + 1) & 0xffff); fpSnapshot(true); }
      break;
    case 'fp-deposit':
      if (booted && !running) { byteTo(CPU8080.status().pc, m.val & 0xff); fpSnapshot(true); }
      break;
    case 'fp-deposit-next':
      if (booted && !running) {
        var dpc = (CPU8080.status().pc + 1) & 0xffff;
        CPU8080.set('PC', dpc); byteTo(dpc, m.val & 0xff); fpSnapshot(true);
      }
      break;
  }
};
