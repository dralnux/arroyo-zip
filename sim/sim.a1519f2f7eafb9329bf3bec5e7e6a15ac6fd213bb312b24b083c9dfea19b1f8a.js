// IMSAI-8080 UI: opens the "IMSAI-8080" desktop window, drives the CPU
// worker, and provides the device pane (power, reset, the IMSAI FIF drives, disk
// library). Disk images live in IndexedDB. The FIF addresses four 8" floppies
// (A:-D:, units 1/2/4/8) plus one 4 MB hard disk (I:, unit 15); NZ-COM's P: and
// similar are the disk's own BIOS RAM drives, not physical FIF slots.
(function () {
  'use strict';

  var FLOPPY_SIZE = 256256;        // 8" SSSD: 77 tracks * 26 sectors * 128 bytes
  var HD_SIZE = 4177920;           // z80pack 4 MB HD: 255 tracks * 128 sectors * 128 bytes
  var FLOPPY_DRIVES = [0, 1, 2, 3];   // A: B: C: D:  (FIF units 1/2/4/8)
  var HD_DRIVE = 8;                   // I:  (FIF unit 15) -> CP/M drive 8
  function driveLetter(idx) { return String.fromCharCode(65 + idx); }
  var DEFAULT_DISK = { id: 'cpm2.2', label: 'cpm2.2' };          // writeable working disk
  var REF_CPM = { id: 'ref-cpm22', label: 'New cpm2.2' };        // reference template (CP/M floppy)
  var REF_BLANK = { id: 'ref-blank', label: 'New blank' };       // reference template (blank floppy)
  var REF_HD = { id: 'ref-hd', label: 'New harddisk' };          // reference template (blank 4 MB HD)
  var REF_NZCOM = { id: 'ref-nzcom22', label: 'New nz-com-2.2' }; // reference template (NZ-COM CP/M 2.2)
  var DB_NAME = 'sim8080', STORE = 'disks';

  // fingerprinted asset URLs injected by the page (fall back to legacy paths)
  var scfg = (window.AARROYO && window.AARROYO.sim) || {};
  var ASSET = {
    xtermJs: scfg.xtermJs || '/vendor/js/xterm.js',
    xtermCss: scfg.xtermCss || '/vendor/css/xterm.css',
    css: scfg.css || '/sim/sim.css',
    worker: scfg.worker || '/sim/worker.js',
    cpu: scfg.cpu || '/sim/z80.js',
    cpu8080: scfg.cpu8080 || '/sim/i8080.js',
    modem: scfg.modem || '/sim/sim-modem.js',
    rom: scfg.rom || '/sim/mpu-b-rom.bin',
    romA: scfg.romA || '/sim/mpu-a-rom.bin',
    disk: scfg.disk || '/disks/cpm22.dsk',
    nzdisk: scfg.nzdisk || '/disks/nz-com-22-ref.dsk',
    docs: scfg.docs || { about: '/sim/docs/about.md', design: '/sim/docs/design.md', notice: '/sim/docs/notice.md' }
  };

  var instance = null;   // live session

  /* ── asset loading ── */
  function loadCss(href, marker) {
    if (document.querySelector('link[data-sim="' + marker + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-sim', marker);
    document.head.appendChild(link);
  }
  function ensureAssets(cb) {
    loadCss(ASSET.xtermCss, 'xterm');
    loadCss(ASSET.css, 'sim');
    if (window.Terminal) { cb(); return; }
    var s = document.createElement('script');
    s.src = ASSET.xtermJs;
    s.onload = function () { cb(); };
    s.onerror = function () { cb(new Error('could not load xterm.js')); };
    document.head.appendChild(s);
  }

  /* ── IndexedDB library ── */
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }
  function dbGetAll(db) {
    return new Promise(function (res, rej) {
      var r = tx(db, 'readonly').getAll();
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function dbGet(db, id) {
    return new Promise(function (res, rej) {
      var r = tx(db, 'readonly').get(id);
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function dbPut(db, rec) {
    return new Promise(function (res, rej) {
      var r = tx(db, 'readwrite').put(rec);
      r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); };
    });
  }
  function dbDelete(db, id) {
    return new Promise(function (res, rej) {
      var r = tx(db, 'readwrite').delete(id);
      r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); };
    });
  }
  function blankDisk(size) {
    var a = new Uint8Array(size);
    a.fill(0xE5);                     // CP/M format byte -> empty directory
    return a.buffer;
  }
  function ensureDisk(db, id, makeRec) {
    return dbGet(db, id).then(function (existing) {
      if (existing) return;
      return makeRec().then(function (rec) { return dbPut(db, rec); });
    });
  }
  function seedLibrary(db) {
    var pristine = null;
    function getPristine() {
      if (pristine) return Promise.resolve(pristine);
      return fetch(ASSET.disk)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (b) { pristine = b; return b; });
    }
    return ensureDisk(db, DEFAULT_DISK.id, function () {
      return getPristine().then(function (b) {
        return { id: DEFAULT_DISK.id, label: DEFAULT_DISK.label, kind: 'writeable', size: b.byteLength, data: b.slice(0) };
      });
    }).then(function () {
      return ensureDisk(db, REF_CPM.id, function () {
        return getPristine().then(function (b) {
          return { id: REF_CPM.id, label: REF_CPM.label, kind: 'reference', size: b.byteLength, data: b.slice(0) };
        });
      });
    }).then(function () {
      return ensureDisk(db, REF_NZCOM.id, function () {
        return fetch(ASSET.nzdisk)
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(function (b) {
            return { id: REF_NZCOM.id, label: REF_NZCOM.label, kind: 'reference', size: b.byteLength, data: b.slice(0) };
          });
      });
    }).then(function () {
      return ensureDisk(db, REF_BLANK.id, function () {
        return Promise.resolve({ id: REF_BLANK.id, label: REF_BLANK.label, kind: 'reference', size: FLOPPY_SIZE, data: blankDisk(FLOPPY_SIZE) });
      });
    }).then(function () {
      return ensureDisk(db, REF_HD.id, function () {
        return Promise.resolve({ id: REF_HD.id, label: REF_HD.label, kind: 'reference', size: HD_SIZE, data: blankDisk(HD_SIZE) });
      });
    });
  }

  function slugify(name) {
    return (name || '').replace(/\.(dsk|img|bin)$/i, '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'disk';
  }
  function uniqueId(db, base) {
    var slug = slugify(base);
    return dbGetAll(db).then(function (all) {
      var ids = {}; all.forEach(function (d) { ids[d.id] = true; });
      if (!ids[slug]) return slug;
      var n = 2; while (ids[slug + '-' + n]) n++; return slug + '-' + n;
    });
  }

  function mediaOf(size) { return size === HD_SIZE ? 'harddisk' : size === FLOPPY_SIZE ? 'floppy' : null; }
  function isValidDisk(size) { return mediaOf(size) !== null; }

  // Build the CP-A front panel (44 LEDs + 22 switches) into `root`, in the
  // authentic IMSAI layout. `ops` are the callbacks the switches drive. Returns
  // apply()/blank()/setPower(). LEDs are indexed by bit number, MSB-first.
  function buildFrontPanel(root, ops) {
    var STATUS = ['inta', 'wo', 'stak', 'hlta', 'out', 'mi', 'inp', 'memr'];   // caption per status bit 0..7
    var switchReg = 0;                                                          // the 16 data/address toggles

    function ledCell(cap) {
      var c = document.createElement('span'); c.className = 'fp-cell';
      var led = document.createElement('span'); led.className = 'fp-led';
      var l = document.createElement('span'); l.className = 'fp-cap'; l.textContent = cap;
      c.appendChild(led); c.appendChild(l);
      return { cell: c, led: led };
    }
    // a byte (or nibble) of LEDs with a name to its right; capFn maps bit->caption
    function makeName(lines) {                       // a group label, one word per line
      var nm = document.createElement('span'); nm.className = 'fp-name';
      lines.forEach(function (t) { var d = document.createElement('span'); d.className = 'fp-nameline'; d.textContent = t; nm.appendChild(d); });
      return nm;
    }
    function ledGroup(n, capFn, nameLines, cls) {
      var g = document.createElement('div'); g.className = 'fp-group' + (cls ? ' ' + cls : '');
      var row = document.createElement('div'); row.className = 'fp-byte';
      var leds = new Array(n);
      for (var i = n - 1; i >= 0; i--) { var cc = ledCell(capFn(i)); row.appendChild(cc.cell); leds[i] = cc.led; }
      g.appendChild(row);
      if (nameLines) g.appendChild(makeName(nameLines));
      return { el: g, leds: leds };
    }
    // the four discrete flag LEDs, keyed by internal name. Captions sit above the
    // lamps and are taken out of flow (INTERRUPTS ENABLED needs two lines), so the
    // cluster keeps the height of the address-bus group beside it and all four
    // lamps stay on that row's line.
    function flagGroup() {
      var g = document.createElement('div'); g.className = 'fp-group fp-flaggrp';
      var row = document.createElement('div'); row.className = 'fp-byte';
      var map = {};
      [['Enab', ['INTERRUPTS', 'ENABLED']], ['RUN', ['RUN']], ['WAIT', ['WAIT']], ['HOLD', ['HOLD']]].forEach(function (p) {
        var c = document.createElement('span'); c.className = 'fp-cell';
        var cap = document.createElement('span');
        cap.className = 'fp-flagcap' + (p[1].length > 1 ? ' fp-flagcap-int' : '');
        p[1].forEach(function (t) { var d = document.createElement('span'); d.textContent = t; cap.appendChild(d); });
        var led = document.createElement('span'); led.className = 'fp-led fp-flag';
        c.appendChild(cap); c.appendChild(led);
        row.appendChild(c); map[p[0]] = led;
      });
      g.appendChild(row);
      return { el: g, leds: map };
    }
    // a byte of toggle switches; hi=true is A15-A8 (also the sense/input port)
    function swByte(hi, sub) {
      var g = document.createElement('div'); g.className = 'fp-group fp-swgroup';
      var row = document.createElement('div'); row.className = 'fp-byte';
      for (var k = 7; k >= 0; k--) {
        (function (bit) {
          var c = document.createElement('span'); c.className = 'fp-swcell';
          var cap = document.createElement('span'); cap.className = 'fp-cap fp-cap-top'; cap.textContent = String(bit & 7);
          var sw = document.createElement('span'); sw.className = 'fp-toggle ' + ((bit & 7) >= 4 ? 'fp-blue' : 'fp-red');
          c.appendChild(cap); c.appendChild(sw);
          sw.addEventListener('click', function () {
            switchReg ^= (1 << bit);
            sw.classList.toggle('up', !!(switchReg & (1 << bit)));
            if (ops.sense) ops.sense(switchReg);
          });
          row.appendChild(c);
        })((hi ? 8 : 0) + k);
      }
      g.appendChild(row);
      if (sub) { var s = document.createElement('span'); s.className = 'fp-sub'; s.textContent = sub; g.appendChild(s); }
      return g;
    }
    // a control paddle: up/down labels around a coloured knob. momentary springs
    // back; a maintained toggle (power) holds its position.
    function paddle(up, dn, color, momentary, upAct, dnAct) {
      var g = document.createElement('div'); g.className = 'fp-paddle';
      var u = document.createElement('span'); u.className = 'fp-plabel'; u.textContent = up;
      var knob = document.createElement('span'); knob.className = 'fp-knob ' + color;
      var d = document.createElement('span'); d.className = 'fp-plabel'; d.textContent = dn;
      function flick(dir) {
        if (momentary) { knob.classList.add(dir); setTimeout(function () { knob.classList.remove(dir); }, 160); }
        else { knob.classList.toggle('up', dir === 'up'); knob.classList.toggle('dn', dir === 'dn'); }
      }
      u.addEventListener('click', function () { flick('up'); upAct(); });
      d.addEventListener('click', function () { flick('dn'); dnAct(); });
      g.appendChild(u); g.appendChild(knob); g.appendChild(d);
      return { el: g, set: function (on) { knob.classList.toggle('up', on); knob.classList.toggle('dn', !on); } };
    }

    var gOut = ledGroup(8, String, ['PROGRAMMED', 'OUTPUT']);
    var gStat = ledGroup(8, function (i) { return STATUS[i]; }, ['STATUS', 'BYTE']);
    var gData = ledGroup(8, String, ['DATA', 'BUS']);
    var gAhi = ledGroup(8, function (i) { return String(i + 8); }, ['ADDRESS', 'BUS']);
    var gAlo = ledGroup(8, String, ['ADDRESS', 'BUS']);
    var gFlags = flagGroup();
    var swHi = swByte(true, 'ADDRESS - PROGRAMMED INPUT');
    var swLo = swByte(false, 'ADDRESS - DATA');

    var pwr = paddle('PWR ON', 'PWR OFF', 'fp-red', false, function () { ops.power(true); }, function () { ops.power(false); });
    var ctl = document.createElement('div'); ctl.className = 'fp-controls';
    [ paddle('EXAMINE', 'EXAM NEXT', 'fp-blue', true, function () { ops.examine(switchReg); }, function () { ops.examineNext(); }),
      paddle('DEPOSIT', 'DEP NEXT', 'fp-red', true, function () { ops.deposit(switchReg & 0xff); }, function () { ops.depositNext(switchReg & 0xff); }),
      paddle('RESET', 'EXT CLR', 'fp-blue', true, function () { ops.reset(); }, function () { ops.extclr(); }),
      paddle('RUN', 'STOP', 'fp-red', true, function () { ops.run(); }, function () { ops.stop(); }),
      paddle('STEP', 'STEP', 'fp-blue', true, function () { ops.step(); }, function () { ops.step(); }),
      pwr
    ].forEach(function (p) { ctl.appendChild(p.el); });

    var grid = document.createElement('div'); grid.className = 'fp-grid';
    function blank() { var d = document.createElement('div'); d.className = 'fp-blank'; return d; }
    [ gOut.el, blank(), blank(),
      gStat.el, gData.el, blank(),
      gAhi.el, gAlo.el, gFlags.el,
      swHi, swLo, ctl
    ].forEach(function (c) { grid.appendChild(c); });
    root.appendChild(grid);

    var ledAddr = gAlo.leds.concat(gAhi.leds);   // index 0..15 = A0..A15
    var allLeds = gOut.leds.concat(gStat.leds, gData.leds, ledAddr,
      [gFlags.leds.Enab, gFlags.leds.RUN, gFlags.leds.WAIT, gFlags.leds.HOLD]);
    function bits(leds, val) { for (var i = 0; i < leds.length; i++) leds[i].classList.toggle('on', !!(val & (1 << i))); }

    return {
      // one bus cycle per frame, hard on/off — the worker picks which cycle
      apply: function (m) {
        bits(ledAddr, m.addr); bits(gData.leds, m.data); bits(gStat.leds, m.status); bits(gOut.leds, m.output);
        gFlags.leds.Enab.classList.toggle('on', !!m.inten);
        gFlags.leds.RUN.classList.toggle('on', !!m.run);
        gFlags.leds.WAIT.classList.toggle('on', !!m.wait);
        gFlags.leds.HOLD.classList.toggle('on', !!m.hold);
      },
      blank: function () { for (var i = 0; i < allLeds.length; i++) allLeds[i].classList.remove('on'); },
      setPower: function (on) { pwr.set(on); }
    };
  }

  // ── user settings (persisted) ──
  var PHOSPHOR = { green: '#00ff41', amber: '#ffb000', white: '#e6e6e6' };
  var CLOCKS = { 2: 8000, 4: 16000, 8: 32000, 0: 160000 };   // MHz -> T-states per 4 ms tick; 0 = Max
  // wsDirect defaults to false: a direct ws:// dial bypasses the proxy's token +
  // destination allowlist, and guest CP/M code can drive the modem on its own, so
  // untrusted disk images must not be able to open arbitrary sockets by default.
  var DEFAULT_SETTINGS = { startup: 'cpm', clock: 2, phosphor: 'green', frontPanel: true, rom: 'b', cpu: 'z80', wsDirect: false, theme: 'original' };
  var THEMES = [['original', 'Original'], ['cyberpunk', 'Cyberpunk']];   // default first, as with the other rows
  // MPU-A and MPU-B monitors are functionally equivalent in this emulation (MPU-B's
  // extra cassette/memory-protect commands need hardware we don't model).
  function romUrl(sel) { return sel === 'a' ? ASSET.romA : ASSET.rom; }
  function loadSettings() {
    try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('sim8080.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) { try { localStorage.setItem('sim8080.settings', JSON.stringify(s)); } catch (e) {} }

  // ── virtual AT modem config (persisted) ──
  var MODEM_DEFAULTS = { proxy: '', token: '', telnet: false, phonebook: [
    { label: 'IRC — Libera.Chat', target: 'irc.libera.chat:6667', telnet: false },
    { label: 'Telehack (telnet)', target: 'telehack.com:23', telnet: true }
  ] };
  function loadModem() {
    try { return Object.assign({}, MODEM_DEFAULTS, JSON.parse(localStorage.getItem('sim8080.modem') || '{}')); }
    catch (e) { return Object.assign({}, MODEM_DEFAULTS); }
  }
  function saveModem(m) { try { localStorage.setItem('sim8080.modem', JSON.stringify(m)); } catch (e) {} }

  var ICON_UPLOAD = '<svg class="sim-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21h14"/><path d="M12 17V4"/><path d="M6 10l6-6 6 6"/></svg>';
  var ICON_MODEM = '<svg class="sim-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';
  var ICON_ABOUT = '<svg class="sim-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7.2v.1"/></svg>';
  var ICON_GEAR = '<svg class="sim-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  /* ── About window: renders the shipped .md docs ──
     A deliberately small Markdown subset: headings, bold/italic, inline code,
     lists, tables, fenced code, links and rules. Everything is HTML-escaped
     FIRST and raw HTML in the source is never passed through, so a document can
     never inject markup into the page. Docs are fetched on demand and cached. */
  var docCache = {};
  function mdEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function mdInline(s) {
    return mdEscape(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, txt, url) {
        return /^(https?:\/\/|#)/i.test(url)
          ? '<a href="' + url + '" target="_blank" rel="noopener">' + txt + '</a>' : txt;
      })
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function mdToHtml(src) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var out = [], list = null, i = 0;
    function endList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function cells(row) {
      return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
    }
    while (i < lines.length) {
      var ln = lines[i];
      if (/^```/.test(ln)) {                                   // fenced code
        endList(); var buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push('<pre><code>' + mdEscape(buf.join('\n')) + '</code></pre>'); continue;
      }
      if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        endList();                                             // table
        var head = cells(ln); i += 2;
        var t = '<table><thead><tr>';
        head.forEach(function (h) { t += '<th>' + mdInline(h) + '</th>'; });
        t += '</tr></thead><tbody>';
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          t += '<tr>';
          cells(lines[i++]).forEach(function (c) { t += '<td>' + mdInline(c) + '</td>'; });
          t += '</tr>';
        }
        out.push(t + '</tbody></table>'); continue;
      }
      var h = ln.match(/^(#{1,4})\s+(.*)$/);
      if (h) { endList(); var n = h[1].length; out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>'); i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { endList(); out.push('<hr>'); i++; continue; }
      var li = ln.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
      if (li) {
        var want = /^\d/.test(li[1]) ? 'ol' : 'ul';
        if (list !== want) { endList(); out.push('<' + want + '>'); list = want; }
        var text = li[2]; i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) text += ' ' + lines[i++].trim();
        out.push('<li>' + mdInline(text) + '</li>'); continue;
      }
      if (!ln.trim()) { endList(); i++; continue; }
      endList();
      var para = [ln]; i++;                                    // paragraph
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + mdInline(para.join(' ')) + '</p>');
    }
    endList();
    return out.join('\n');
  }
  // Build stamp: Hugo puts a content hash in the filename, the standalone bundle
  // puts one in ?v= -- either identifies exactly which build is running.
  function buildId() {
    // try several assets: the site lazy-loads sim.js (so scfg.js exists), the
    // standalone loads it with a plain <script> and only stamps the others
    var urls = [(scfg && scfg.js), ASSET.worker, ASSET.css, ASSET.cpu];
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i] || '';
      var m = u.match(/[?&]v=([a-f0-9]{6,})/i) || u.match(/\.([a-f0-9]{8,})\.(js|css)/i);
      if (m) return m[1].slice(0, 10);
    }
    return 'dev';
  }
  // xterm swallows most keys, but it deliberately lets a plain A-Z keydown bubble
  // (it defers those to keypress for dead-key/AltGr layouts), and a bare <input>
  // never stops anything. The host page binds its own command line to <html>, so
  // uppercase typed anywhere in the sim also landed in the site's Terminal.
  function containKeys(el) {
    if (!el) return el;
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    return el;
  }
  // A theme is a palette swap in sim.css. The class lands on <html> because the
  // sim's child windows, modals and context menu are separate DOM roots; a falsy
  // name clears it, so the page is left as we found it on teardown.
  function applyTheme(name) {
    var el = document.documentElement;
    THEMES.forEach(function (t) { el.classList.toggle('sim-theme-' + t[0], t[0] === name); });
  }
  // Per-setting notes, shown from the (i) beside each Settings label rather than
  // as one block of prose under the controls.
  var HELP = {
    startup: 'What the machine does at power-on. "Boot CP/M" puts the default disk in A: and boots it. "ROM monitor" empties A: — the disk goes back to the Library, it is not deleted — so the ROM finds no boot disk and drops to its monitor prompt. Changing this cold-boots the machine.',
    rom: 'The firmware in ROM at D800. MPU-B ("IMSAI MPU-B MONITOR VERS 1.3") and MPU-A ("IMSAI IEEE MONITOR VERS 1.0") are functionally equivalent here: both boot CP/M from A:, and with no disk in A: both drop to a monitor prompt. Changing this cold-boots the machine.',
    cpu: 'The Z80 is a superset of the 8080, so it runs 8080 software too, and it is required for NZ-COM and the Z-System tools. The 8080 core is here for flag accuracy: the Z80 redefines the 8080’s parity flag as an overflow flag, so 8080-era code that branches on JPE/JPO can take a different path. Changing this cold-boots the machine.',
    clock: 'How fast the emulated CPU runs. 2 MHz is the authentic IMSAI speed and the one period software was timed against; the faster settings and "Maximum" are conveniences. Applies immediately.',
    theme: 'Repaints the simulator. "Original" is the machine as it shipped in 1975 — IMSAI blue trim, yellowed ivory lettering, red panel lamps and period disk icons. "Cyberpunk" is the neon-green alternative. The console’s text colour is the separate Phosphor setting.',
    phosphor: 'The console text colour, as though you had swapped the terminal’s tube: green, amber or white. Independent of Theme, so any combination works.',
    frontPanel: 'Show or hide the CP-A front panel below the console. Hiding it only removes the display — the machine keeps running, and the panel comes back with its lamps live.',
    wsDirect: 'Whether the modem may dial a raw ws:// or wss:// URL. Normally ATDT host:port goes through the proxy you configure in the Modem window, and that proxy enforces its own destination allowlist. A raw URL bypasses the allowlist completely, and software running inside the emulator can drive the modem unattended — so leave this blocked unless you trust the disk image.'
  };
  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><path d="M12 7.4v.1"/></svg>';

  // The note is fixed-positioned on <body>: the Settings window is only 288px
  // wide and .window clips its overflow, so an in-window popover would be cut off.
  var helpEl = null, helpAnchor = null;
  function hideHelp() {
    if (helpEl) helpEl.remove();
    if (helpAnchor) helpAnchor.classList.remove('sim-set-info-on');
    helpEl = null; helpAnchor = null;
  }
  function toggleHelp(anchor, title, text) {
    if (helpAnchor === anchor) { hideHelp(); return; }
    hideHelp();
    var pop = document.createElement('div'); pop.className = 'sim-set-help';
    var h = document.createElement('div'); h.className = 'sim-set-help-title'; h.textContent = title;
    var p = document.createElement('p'); p.textContent = text;
    pop.appendChild(h); pop.appendChild(p);
    document.body.appendChild(pop);
    // Sit clear of the whole Settings window, not just the icon, so the note never
    // covers the control it is describing. Vertically it still tracks its row.
    var r = anchor.getBoundingClientRect();
    var host = anchor.closest ? anchor.closest('.window') : null;
    var hr = host ? host.getBoundingClientRect() : r;
    var left = hr.right + 10;
    if (left + pop.offsetWidth > window.innerWidth - 8) left = hr.left - pop.offsetWidth - 10;
    var top = r.top - 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = window.innerHeight - pop.offsetHeight - 8;
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    helpEl = pop; helpAnchor = anchor;
    anchor.classList.add('sim-set-info-on');
  }
  // Capture phase: containKeys() stops key events at the sim windows on the way
  // back up, so a bubble-phase listener here would never see Escape.
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideHelp(); }, true);
  document.addEventListener('mousedown', function (e) {
    if (!helpEl) return;
    if (helpEl.contains(e.target) || (helpAnchor && helpAnchor.contains(e.target))) return;
    hideHelp();
  }, true);
  window.addEventListener('resize', hideHelp);

  function openAboutWindow() {
    var w = window.openWindow('About IMSAI-8080',
      '<div class="sim-about"><div class="sim-about-tabs"></div><div class="sim-about-body"></div></div>',
      { className: 'sim-aboutwin', width: '720px', height: '560px', resizable: true, minW: 320, minH: 220 });
    if (!w) return;
    containKeys(w);
    var tabsEl = w.querySelector('.sim-about-tabs');
    if (tabsEl.childElementCount) return;      // already open: openWindow just refocused it
    var bodyEl = w.querySelector('.sim-about-body');
    function show(key, btn) {
      [].forEach.call(tabsEl.children, function (b) { b.classList.toggle('sim-about-on', b === btn); });
      if (docCache[key]) { bodyEl.innerHTML = docCache[key]; bodyEl.scrollTop = 0; return; }
      bodyEl.innerHTML = '<p class="sim-about-msg">Loading…</p>';
      fetch((ASSET.docs && ASSET.docs[key]) || '')
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (txt) {
          docCache[key] = mdToHtml(txt.replace(/\{\{VERSION\}\}/g, buildId()));
          bodyEl.innerHTML = docCache[key]; bodyEl.scrollTop = 0;
        })
        .catch(function (e) {
          bodyEl.innerHTML = '<p class="sim-about-msg">Could not load ' + mdEscape(key) + '.md (' + mdEscape(e.message) + ')</p>';
        });
    }
    [['about', 'About'], ['design', 'Design'], ['notice', 'Credits']].forEach(function (d, idx) {
      var b = document.createElement('button');
      b.className = 'sim-about-tab';
      b.textContent = d[1];
      b.addEventListener('click', function () { show(d[0], b); });
      tabsEl.appendChild(b);
      if (idx === 0) show(d[0], b);
    });
  }

  function build() {
    var settings = loadSettings();
    var body =
      '<div class="sim-body">' +
        '<div class="sim-main">' +
          '<div class="sim-devices">' +
            '<div class="sim-panel-title">Floppy Drives</div>' +
            '<div class="sim-drives"></div>' +
            '<div class="sim-panel-title">Hard Disk</div>' +
            '<div class="sim-harddisk"></div>' +
            '<div class="sim-panel-title">Storage</div>' +
            '<div class="sim-library" title="Open Disk Library">' +
              '<div class="sim-lib-icon"></div><span>Library</span>' +
            '</div>' +
            '<div class="sim-tools">' +
              '<button class="sim-tool sim-upload-btn" title="Upload a disk image">' + ICON_UPLOAD + '<span>Upload</span></button>' +
              '<button class="sim-tool sim-settings-btn" title="Settings">' + ICON_GEAR + '<span>Settings</span></button>' +
              '<button class="sim-tool sim-modem-btn" title="Virtual AT modem">' + ICON_MODEM + '<span>Modem</span></button>' +
              '<button class="sim-tool sim-about-btn" title="About this simulator">' + ICON_ABOUT + '<span>About</span></button>' +
            '</div>' +
          '</div>' +
          '<div class="sim-terminal" id="sim-terminal"></div>' +
        '</div>' +
        '<div class="sim-frontpanel"></div>' +
      '</div>';

    var win = window.openWindow('IMSAI-8080', body, {
      // 924, not 920: the front panel is exactly as wide as the window's content
      // box, and the Original theme's 3px frame (border-box) takes 4px of it.
      className: 'sim-window', width: '924px', onClose: teardown,
      // Closing powers the machine down and discards the running session, so a
      // mis-clicked X asks first. Already powered off -> nothing to lose, just go.
      confirmClose: function (proceed) {
        if (!state.power) { proceed(); return; }
        confirmDialog('Power off the IMSAI-8080?\r\nThe running session ends — anything not saved to a disk from CP/M is lost. Disks in the Library are kept.', proceed);
      }
    });
    if (!win) return;
    containKeys(win);
    // Open near the top (just below the Terminal window), centered, so the tall
    // front-panel window stays clear of the bottom icon bar on shorter screens.
    if (window.innerWidth > 768) {
      win.style.top = '28px';
      win.style.left = Math.max(8, Math.round((window.innerWidth - win.offsetWidth) / 2)) + 'px';
    }

    var phosphor = PHOSPHOR[settings.phosphor] || PHOSPHOR.green;
    var term = new window.Terminal({
      cols: 80, rows: 24, scrollback: 10000, convertEol: false,
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 14,
      theme: { background: '#0a0a0a', foreground: phosphor, cursor: phosphor }
    });
    term.open(win.querySelector('#sim-terminal'));
    term.focus();

    // xterm measures one character to build its cell grid, once, inside open().
    // The page pulls IBM Plex Mono with display=swap, so that measurement can be
    // taken against the local fallback and then the real face swaps in at a
    // different advance — the grid is already committed, every row draws wider
    // than it, and the last column or two fall outside and get clipped.
    // Re-assigning a font option is the public way to force a fresh measurement;
    // it has to pass through a different value to register as a change.
    function remeasureCells() {
      try {
        var f = term.options.fontFamily;
        term.options.fontFamily = 'monospace';
        term.options.fontFamily = f;
      } catch (e) {}
    }
    if (document.fonts && document.fonts.ready) {
      // load() first, so `ready` waits for a face the page hasn't requested yet
      try { document.fonts.load(term.options.fontSize + 'px ' + term.options.fontFamily); } catch (e) {}
      document.fonts.ready.then(remeasureCells, function () {});
    } else {
      remeasureCells();
    }

    var fp = buildFrontPanel(win.querySelector('.sim-frontpanel'), {
      power: function (on) { if (on) powerOn(); else powerOff(); },
      reset: function () { resetMachine(); },
      extclr: function () { if (state.power) worker.postMessage({ type: 'fp-extclr' }); },
      run: function () { if (state.power) worker.postMessage({ type: 'fp-run' }); },
      stop: function () { if (state.power) worker.postMessage({ type: 'fp-stop' }); },
      step: function () { if (state.power) worker.postMessage({ type: 'fp-step' }); },
      examine: function (a) { if (state.power) worker.postMessage({ type: 'fp-examine', addr: a }); },
      examineNext: function () { if (state.power) worker.postMessage({ type: 'fp-examine-next' }); },
      deposit: function (v) { if (state.power) worker.postMessage({ type: 'fp-deposit', val: v }); },
      depositNext: function (v) { if (state.power) worker.postMessage({ type: 'fp-deposit-next', val: v }); },
      sense: function (reg) { worker.postMessage({ type: 'fp-sense', value: reg }); }
    });
    var fpLatest = null, fpRaf = 0;
    function applyFp() { fpRaf = 0; if (fpLatest) fp.apply(fpLatest); }

    // the worker URL may already carry a query (the standalone bundle stamps a
    // cache-busting ?v=), so pick the right separator before appending our params
    var worker = new Worker(ASSET.worker + (ASSET.worker.indexOf('?') >= 0 ? '&' : '?') + 'cpu=' + encodeURIComponent(ASSET.cpu) +
                            '&cpu8080=' + encodeURIComponent(ASSET.cpu8080) +
                            '&cpumode=' + encodeURIComponent(settings.cpu) +
                            '&rom=' + encodeURIComponent(romUrl(settings.rom)) +
                            '&modem=' + encodeURIComponent(ASSET.modem));
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'out') term.write(String.fromCharCode(m.data));
      else if (m.type === 'error') term.write('\r\n[sim] ' + m.msg + '\r\n');
      else if (m.type === 'persist') persistDisk(m.drive, m.buffer);
      else if (m.type === 'fp') {                       // front-panel LED snapshot, coalesced to a frame
        if (!state.power) return;
        fpLatest = m; if (!fpRaf) fpRaf = requestAnimationFrame(applyFp);
      }
      else if (m.type === 'modem') { modemState = m; updateModemStatus(); }
      else if (m.type === 'cpu') { state.cpuMode = m.mode; state.has8080 = m.has8080; }
      else if (m.type === 'cpu-probe') { state.cpuProbe = m; }
      else if (m.type === 'mem-probe') { state.memProbe = m; }
    };
    term.onData(function (data) {
      for (var i = 0; i < data.length; i++) worker.postMessage({ type: 'key', code: data.charCodeAt(i) });
    });

    var drives = [];
    for (var di = 0; di <= HD_DRIVE; di++) drives.push({ id: null });   // indices 0-3 floppy, 8 HD
    var state = {
      win: win, term: term, worker: worker, db: null, power: false,
      drives: drives,
      libBlobUrls: []
    };
    instance = state;

    // ── operations (also the internal API the drag/drop handlers call) ──
    function powerOn() {
      state.power = true;
      fp.setPower(true);
      term.reset();
      // the MPU-B ROM auto-boots from A: if present, else drops to its own monitor
      worker.postMessage({ type: 'boot' });
    }
    function powerOff() {
      state.power = false;
      fp.setPower(false);
      worker.postMessage({ type: 'stop' });
      fp.blank();                         // dark panel when the machine is off
      term.reset();
      term.write('\r\n  [ SYSTEM POWER OFF ]\r\n');
    }
    function resetMachine() {
      if (!state.power) return;
      term.reset();
      worker.postMessage({ type: 'reset' });
    }
    function insertDisk(driveIdx, diskId) {
      return dbGet(state.db, diskId).then(function (rec) {
        if (!rec) return;
        state.drives[driveIdx] = { id: diskId, label: rec.label };
        worker.postMessage({ type: 'insert', drive: driveIdx, buffer: rec.data.slice(0) });
        renderDrives();
        saveDriveState();
        if (state.refreshLibraryWindow) state.refreshLibraryWindow();   // update dimming
      });
    }
    function ejectDisk(driveIdx) {
      state.drives[driveIdx] = { id: null };
      worker.postMessage({ type: 'eject', drive: driveIdx });
      renderDrives();
      saveDriveState();
      if (state.refreshLibraryWindow) state.refreshLibraryWindow();
    }
    function isInDrive(diskId, exceptIdx) {
      return state.drives.some(function (d, i) { return d.id === diskId && i !== exceptIdx; });
    }
    // dropping a library disk on a drive: reference disks spawn a named copy;
    // writeable disks are inserted (unless already in another drive)
    function handleDropOnDrive(driveIdx, diskId) {
      dbGet(state.db, diskId).then(function (rec) {
        if (!rec) return;
        if ((driveIdx === HD_DRIVE) !== (rec.size === HD_SIZE)) {
          errorDialog(rec.size === HD_SIZE
            ? 'A 4 MB hard-disk image can only be mounted in the Hard Disk (I:) slot.'
            : 'A floppy image can only be inserted in a floppy drive (A:-D:).');
          return;
        }
        if (rec.kind === 'reference') {
          promptDialog('Name the new disk (copied from "' + rec.label + '"):', suggestCopyName(rec.label), function (name) {
            if (!name) return;
            createCopyAndInsert(driveIdx, rec, name);
          });
        } else if (isInDrive(diskId, driveIdx)) {
          errorDialog('"' + rec.label + '" is already in another drive. Eject it first.');
        } else {
          insertDisk(driveIdx, diskId);
        }
      });
    }
    // move an inserted disk from one drive to another; if the destination is
    // occupied its disk is ejected back to the Library first
    function moveDiskBetweenDrives(srcIdx, dstIdx) {
      if (srcIdx === dstIdx) return;
      var src = state.drives[srcIdx];
      if (!src || !src.id) return;
      // a floppy fits only floppy slots (A:-D:), an HD image only the HD slot (I:)
      if ((srcIdx === HD_DRIVE) !== (dstIdx === HD_DRIVE)) {
        errorDialog(srcIdx === HD_DRIVE
          ? 'A 4 MB hard-disk image can only go in the Hard Disk (I:) slot.'
          : 'A floppy image can only go in a floppy drive (A:-D:).');
        return;
      }
      var srcId = src.id;
      if (state.drives[dstIdx].id) ejectDisk(dstIdx);   // return the occupant to the Library
      ejectDisk(srcIdx);
      insertDisk(dstIdx, srcId);
    }

    // Touch/pen drag-and-drop: mobile browsers never fire the HTML5 drag events,
    // so for non-mouse pointers we run an equivalent drag (a ghost that follows
    // the finger + a drop hit-test) driving the same moves. Desktop mouse keeps
    // the native DnD path, so OS-file drop and drag-to-download still work.
    function fpDropTargetAt(x, y) {
      var t = document.elementFromPoint(x, y);
      return t ? t.closest('.sim-drive, .sim-library, .sim-libwin') : null;
    }
    function dropPayload(target, payload) {
      if (target.classList.contains('sim-drive')) {
        var idx = parseInt(target.getAttribute('data-drive'), 10);
        if (isNaN(idx)) return;
        if (payload.kind === 'disk') handleDropOnDrive(idx, payload.id);
        else if (payload.kind === 'drive') moveDiskBetweenDrives(payload.idx, idx);
      } else if (payload.kind === 'drive') {
        ejectDisk(payload.idx);                          // dropped on the Library = eject
      }
    }
    function enableTouchDrag(el, getPayload) {
      el.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse') return;           // mouse keeps native HTML5 DnD
        var payload = getPayload();
        if (!payload) return;
        var pid = e.pointerId, x0 = e.clientX, y0 = e.clientY;
        var dragging = false, ghost = null, over = null;
        function setOver(t) {
          if (t === over) return;
          if (over) over.classList.remove('sim-dragover');
          if (t) t.classList.add('sim-dragover');
          over = t;
        }
        function move(ev) {
          if (ev.pointerId !== pid) return;
          if (!dragging) {
            if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 8) return;   // tap vs drag
            dragging = true;
            ghost = el.cloneNode(true);
            ghost.classList.add('sim-drag-ghost');
            ghost.style.width = el.offsetWidth + 'px';
            document.body.appendChild(ghost);
            el.classList.add('sim-drag-src');
          }
          ev.preventDefault();                           // suppress scroll while dragging
          ghost.style.left = ev.clientX + 'px';
          ghost.style.top = ev.clientY + 'px';
          setOver(fpDropTargetAt(ev.clientX, ev.clientY));
        }
        function up(ev) {
          if (ev.pointerId !== pid) return;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          var target = dragging ? fpDropTargetAt(ev.clientX, ev.clientY) : null;
          setOver(null);
          if (ghost) ghost.remove();
          el.classList.remove('sim-drag-src');
          if (target) dropPayload(target, payload);
        }
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
    }
    function suggestCopyName(refLabel) {
      return refLabel.replace(/^New\s+/i, '') || 'disk';
    }
    function createCopyAndInsert(driveIdx, refRec, name) {
      uniqueId(state.db, name).then(function (id) {
        var copy = { id: id, label: name, kind: 'writeable', size: refRec.size, data: refRec.data.slice(0) };
        return dbPut(state.db, copy).then(function () { return insertDisk(driveIdx, id); });
      });
    }
    // write CP/M's own disk changes back to the library entry so files survive reloads
    function persistDisk(driveIdx, buffer) {
      var d = state.drives[driveIdx];
      if (!d || !d.id) return;
      dbGet(state.db, d.id).then(function (rec) {
        if (!rec) rec = { id: d.id, label: d.id };
        rec.data = buffer;
        rec.size = buffer.byteLength;
        return dbPut(state.db, rec);
      });
    }
    // remember which library disk sits in each drive across sessions
    function saveDriveState() {
      try {
        localStorage.setItem('sim8080.drives', JSON.stringify(state.drives.map(function (d) { return d.id; })));
      } catch (e) {}
    }
    function restoreDrives() {
      var saved;
      try { saved = JSON.parse(localStorage.getItem('sim8080.drives') || 'null'); } catch (e) { saved = null; }
      if (!saved) return Promise.resolve();
      var chain = Promise.resolve();
      saved.forEach(function (id, idx) {
        if (!id) return;
        chain = chain.then(function () {
          return dbGet(state.db, id).then(function (rec) {
            if (!rec) return;
            state.drives[idx] = { id: id, label: rec.label };
            worker.postMessage({ type: 'insert', drive: idx, buffer: rec.data.slice(0) });
          });
        });
      });
      return chain.then(renderDrives);
    }
    function uploadFile(file) {
      file.arrayBuffer().then(function (buf) {
        if (!isValidDisk(buf.byteLength)) {
          errorDialog('"' + file.name + '" is not a valid CP/M disk image.\r\nExpected a floppy (' +
            FLOPPY_SIZE + ' bytes) or 4 MB hard disk (' + HD_SIZE + ' bytes), got ' + buf.byteLength + '.');
          return;
        }
        typeDialog('Add "' + file.name + '" to the Library as which kind of disk?', function (kind) {
          if (!kind) return;
          var label = slugify(file.name);
          uniqueId(state.db, label).then(function (id) {
            return dbPut(state.db, { id: id, label: label, kind: kind, size: buf.byteLength, data: buf });
          }).then(refreshLibraryWindow);
        });
      });
    }
    state.ops = { powerOn: powerOn, powerOff: powerOff, reset: resetMachine,
      insertDisk: insertDisk, ejectDisk: ejectDisk, uploadFile: uploadFile,
      handleDropOnDrive: handleDropOnDrive, moveDiskBetweenDrives: moveDiskBetweenDrives };

    // ── device-pane rendering ──
    var drivesEl = win.querySelector('.sim-drives');
    var hdEl = win.querySelector('.sim-harddisk');
    function makeSlot(idx, isHd) {
      var d = state.drives[idx];
      var loaded = !!d.id;
      var el = document.createElement('div');
      el.className = 'sim-drive ' + (isHd ? 'sim-hd ' : '') + (loaded ? 'sim-loaded' : 'sim-empty');
      el.setAttribute('data-drive', idx);
      el.draggable = loaded;
      el.title = isHd ? 'Hard disk (4 MB). Drop a 4 MB image to mount; drag to the Library to eject.'
                      : 'Drop a floppy to insert. Drag to another drive to move it, or to the Library to eject.';
      // built as DOM (not innerHTML) so a disk label can never be parsed as markup
      var icon = document.createElement('span'); icon.className = 'sim-disk-icon';
      var dlab = document.createElement('span'); dlab.className = 'sim-drive-label';
      dlab.textContent = driveLetter(idx) + ':' + (loaded ? ' ' + d.label : '');
      if (isHd) {
        dlab.appendChild(document.createTextNode(' '));
        var tag = document.createElement('span'); tag.className = 'sim-hd-tag'; tag.textContent = 'HD';
        dlab.appendChild(tag);
      }
      el.appendChild(icon); el.appendChild(dlab);
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('sim-dragover'); });
      el.addEventListener('dragleave', function () { el.classList.remove('sim-dragover'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault(); el.classList.remove('sim-dragover');
        var diskId = e.dataTransfer.getData('application/x-sim-disk');
        if (diskId) { handleDropOnDrive(idx, diskId); return; }        // from the Library
        var srcDrive = e.dataTransfer.getData('application/x-sim-drive');
        if (srcDrive !== '') moveDiskBetweenDrives(parseInt(srcDrive, 10), idx);   // from another drive
      });
      el.addEventListener('dragstart', function (e) {
        if (loaded) e.dataTransfer.setData('application/x-sim-drive', String(idx));
      });
      enableTouchDrag(el, function () { return loaded ? { kind: 'drive', idx: idx } : null; });
      return el;
    }
    function renderDrives() {
      drivesEl.innerHTML = '';
      FLOPPY_DRIVES.forEach(function (idx) { drivesEl.appendChild(makeSlot(idx, false)); });
      if (hdEl) { hdEl.innerHTML = ''; hdEl.appendChild(makeSlot(HD_DRIVE, true)); }
    }
    renderDrives();

    // a Library drop target (the side-panel icon and the open Library window):
    // a file from the desktop is uploaded; a disk dragged from a drive is ejected
    function addLibraryDropTarget(el) {
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('sim-dragover'); });
      el.addEventListener('dragleave', function (e) {
        if (!el.contains(e.relatedTarget)) el.classList.remove('sim-dragover');
      });
      el.addEventListener('drop', function (e) {
        e.preventDefault(); el.classList.remove('sim-dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length) { uploadFile(e.dataTransfer.files[0]); return; }
        var driveIdx = e.dataTransfer.getData('application/x-sim-drive');
        if (driveIdx !== '') ejectDisk(parseInt(driveIdx, 10));   // drop a drive's disk back = eject
      });
    }

    var libIcon = win.querySelector('.sim-library');
    libIcon.addEventListener('click', openLibraryWindow);
    addLibraryDropTarget(libIcon);

    // ── Upload + Settings tools ──
    var fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.style.display = 'none';
    win.appendChild(fileInput);
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0]);
      fileInput.value = '';                                        // allow re-selecting the same file
    });
    win.querySelector('.sim-upload-btn').addEventListener('click', function () { fileInput.click(); });
    win.querySelector('.sim-settings-btn').addEventListener('click', openSettingsWindow);

    // ── virtual AT modem ──
    var modemCfg = loadModem();
    var modemState = { state: 'idle' };
    function pushModemConfig() { worker.postMessage({ type: 'modem-config', cfg: { proxy: modemCfg.proxy, token: modemCfg.token, telnet: modemCfg.telnet, wsDirect: settings.wsDirect } }); }
    pushModemConfig();   // so ATDT from terminal software works even before the window is opened
    win.querySelector('.sim-modem-btn').addEventListener('click', openModemWindow);
    win.querySelector('.sim-about-btn').addEventListener('click', openAboutWindow);

    function updateModemStatus() {
      var el = document.querySelector('.sim-modemwin .sim-modem-status');
      if (!el) return;
      var s = modemState.state, t = modemState.target || '';
      el.textContent = s === 'connected' ? ('Connected: ' + t) : s === 'dialing' ? ('Dialing ' + t + '…') : 'Idle';
      el.className = 'sim-modem-status sim-modem-' + s;
    }
    function openModemWindow() {
      var w = window.openWindow('Modem', '<div class="sim-modem"></div>', { className: 'sim-modemwin', width: '324px' });
      if (!w) return;
      containKeys(w);
      var root = w.querySelector('.sim-modem');
      if (root.childElementCount) { updateModemStatus(); return; }   // already open: just refocus

      function commit() { saveModem(modemCfg); pushModemConfig(); }
      function field(label, key, type) {
        var row = document.createElement('label'); row.className = 'sim-modem-row';
        var s = document.createElement('span'); s.className = 'sim-modem-label'; s.textContent = label;
        var inp = document.createElement('input'); inp.type = type || 'text'; inp.className = 'sim-modem-input';
        inp.value = modemCfg[key] || ''; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off');
        inp.addEventListener('change', function () { modemCfg[key] = inp.value.trim(); commit(); });
        row.appendChild(s); row.appendChild(inp); root.appendChild(row);
      }
      field('Proxy (wss://)', 'proxy', 'text');
      field('Token', 'token', 'password');
      var trow = document.createElement('label'); trow.className = 'sim-modem-row';
      var tl = document.createElement('span'); tl.className = 'sim-modem-label'; tl.textContent = 'Telnet default';
      var tsel = document.createElement('select'); tsel.className = 'sim-set-select';
      [['false', 'Off'], ['true', 'On']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; if (String(modemCfg.telnet) === o[0]) op.selected = true; tsel.appendChild(op); });
      tsel.addEventListener('change', function () { modemCfg.telnet = tsel.value === 'true'; commit(); });
      trow.appendChild(tl); trow.appendChild(tsel); root.appendChild(trow);

      var st = document.createElement('div'); st.className = 'sim-modem-status'; root.appendChild(st);

      var pbTitle = document.createElement('div'); pbTitle.className = 'sim-modem-pbtitle'; pbTitle.textContent = 'Phonebook'; root.appendChild(pbTitle);
      var pb = document.createElement('div'); pb.className = 'sim-modem-pb'; root.appendChild(pb);
      function renderPB() {
        pb.innerHTML = '';
        modemCfg.phonebook.forEach(function (e, i) {
          var row = document.createElement('div'); row.className = 'sim-modem-pbrow';
          var name = document.createElement('span'); name.className = 'sim-modem-pbname'; name.textContent = e.label;
          name.title = e.target + (e.telnet ? ' (telnet)' : '');
          var dial = document.createElement('button'); dial.className = 'sim-btn sim-modem-dial'; dial.textContent = 'Dial';
          dial.addEventListener('click', function () { worker.postMessage({ type: 'modem-dial', target: e.target, telnet: !!e.telnet }); });
          var del = document.createElement('button'); del.className = 'sim-btn sim-modem-del'; del.textContent = '×'; del.title = 'Remove';
          del.addEventListener('click', function () { modemCfg.phonebook.splice(i, 1); saveModem(modemCfg); renderPB(); });
          row.appendChild(name); row.appendChild(dial); row.appendChild(del); pb.appendChild(row);
        });
      }
      renderPB();
      var add = document.createElement('div'); add.className = 'sim-modem-add';
      var nlabel = document.createElement('input'); nlabel.placeholder = 'Name'; nlabel.className = 'sim-modem-input';
      var ntarget = document.createElement('input'); ntarget.placeholder = 'host:port or ws://'; ntarget.className = 'sim-modem-input';
      var ntel = document.createElement('label'); ntel.className = 'sim-modem-tel';
      var ntc = document.createElement('input'); ntc.type = 'checkbox'; ntel.appendChild(ntc); ntel.appendChild(document.createTextNode(' telnet'));
      var addBtn = document.createElement('button'); addBtn.className = 'sim-btn'; addBtn.textContent = 'Add';
      addBtn.addEventListener('click', function () {
        var l = nlabel.value.trim(), t = ntarget.value.trim();
        if (!l || !t) return;
        modemCfg.phonebook.push({ label: l, target: t, telnet: ntc.checked });
        saveModem(modemCfg); nlabel.value = ''; ntarget.value = ''; ntc.checked = false; renderPB();
      });
      add.appendChild(nlabel); add.appendChild(ntarget); add.appendChild(ntel); add.appendChild(addBtn);
      root.appendChild(add);

      var note = document.createElement('p'); note.className = 'sim-set-note';
      note.textContent = 'Run a terminal (e.g. QTERM) and dial with ATDT, or use a phonebook entry. host:port needs the proxy + token; ws:// connects directly.';
      root.appendChild(note);
      updateModemStatus();
    }

    function applyPhosphor(name) {
      var c = PHOSPHOR[name] || PHOSPHOR.green;
      try { term.options.theme = { background: '#0a0a0a', foreground: c, cursor: c }; } catch (e) {}
    }
    function applyClock(mhz) { worker.postMessage({ type: 'clock', cycles: CLOCKS[mhz] || 8000 }); }
    // Swapping the monitor ROM cold-boots the machine: CP/M reboots from A:, or an
    // empty A: drops to the newly-selected monitor. Clear the screen first so the
    // new firmware's banner shows and wakeMonitor's /MONITOR/ check doesn't match
    // the outgoing ROM's still-visible banner.
    // Swapping the CPU core cold-boots the machine (the cores hold separate
    // register state). 8080 mode is for flag accuracy, not compatibility — the Z80
    // is a superset and runs 8080 software fine.
    function applyCpu(mode) {
      try { term.reset(); } catch (e) {}
      worker.postMessage({ type: 'set-cpu', mode: mode });
      if (settings.startup === 'rom' && !(state.drives[0] && state.drives[0].id)) wakeMonitor();
    }
    function applyRom(sel) {
      try { term.reset(); } catch (e) {}
      worker.postMessage({ type: 'set-rom', url: romUrl(sel) });
      if (settings.startup === 'rom' && !(state.drives[0] && state.drives[0].id)) wakeMonitor();
    }
    function applyFrontPanel(show) {
      var el = win.querySelector('.sim-frontpanel');
      if (el) el.style.display = show ? '' : 'none';
    }
    // Startup reboots into either CP/M (default disk in A:) or the bare ROM monitor
    // (A: emptied — its disk returns to the Library, not deleted).
    function applyStartup(mode) {
      if (mode === 'rom') {
        if (state.drives[0] && state.drives[0].id) ejectDisk(0);
        resetMachine();
        wakeMonitor();
      } else if (state.drives[0] && !state.drives[0].id) {
        insertDisk(0, DEFAULT_DISK.id).then(resetMachine);
      } else {
        resetMachine();
      }
    }
    function termText() {
      try {
        var b = term.buffer.active, s = '';
        for (var i = Math.max(0, b.length - 30); i < b.length; i++) { var ln = b.getLine(i); if (ln) s += ln.translateToString(true) + '\n'; }
        return s;
      } catch (e) { return ''; }
    }
    // With no boot disk the MPU-B ROM sits polling its input ports; a space drops
    // it to the monitor prompt. Poke spaces until the prompt appears (an early one
    // can be eaten during boot init) so the user sees the monitor, not a blank.
    function wakeMonitor() {
      var tries = 0;
      (function poke() {
        if (!state.power || /MONITOR/.test(termText())) return;
        worker.postMessage({ type: 'key', code: 0x20 });
        if (++tries < 12) setTimeout(poke, 250);
      })();
    }
    applyTheme(settings.theme);
    applyClock(settings.clock);
    applyFrontPanel(settings.frontPanel);

    function openSettingsWindow() {
      var w = window.openWindow('Settings', '<div class="sim-settings"></div>', { className: 'sim-setwin', width: '340px' });
      if (!w) return;
      containKeys(w);
      var root = w.querySelector('.sim-settings');
      if (root.childElementCount) return;   // already open: openWindow just refocused it, don't rebuild the controls
      function addRow(label, key, options, apply, help) {
        var row = document.createElement('label'); row.className = 'sim-set-row';
        var span = document.createElement('span'); span.className = 'sim-set-label';
        span.appendChild(document.createTextNode(label));
        if (help) {
          // a <label> forwards its clicks to the select, so the button has to
          // swallow the event or opening the note would also drop the menu
          var info = document.createElement('button');
          info.type = 'button'; info.className = 'sim-set-info';
          info.setAttribute('aria-label', label + ' — what this does');
          info.title = 'What this does';
          info.innerHTML = ICON_INFO;
          info.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            toggleHelp(info, label, help);
          });
          span.appendChild(info);
        }
        var sel = document.createElement('select'); sel.className = 'sim-set-select';
        options.forEach(function (o) {
          var opt = document.createElement('option'); opt.value = String(o[0]); opt.textContent = o[1];
          if (String(settings[key]) === String(o[0])) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () {
          var raw = sel.value, val;
          if (raw === 'true') val = true; else if (raw === 'false') val = false;
          else if (/^-?\d+$/.test(raw)) val = parseInt(raw, 10); else val = raw;
          settings[key] = val; saveSettings(settings);
          if (apply) apply(val);
        });
        row.appendChild(span); row.appendChild(sel); root.appendChild(row);
      }
      addRow('Startup', 'startup', [['cpm', 'Boot CP/M'], ['rom', 'ROM monitor']], applyStartup, HELP.startup);
      addRow('Monitor ROM', 'rom', [['b', 'MPU-B'], ['a', 'MPU-A']], applyRom, HELP.rom);
      addRow('CPU', 'cpu', [['z80', 'Z80 (default)'], ['8080', '8080']], applyCpu, HELP.cpu);
      addRow('CPU clock', 'clock', [[2, '2 MHz (authentic)'], [4, '4 MHz'], [8, '8 MHz'], [0, 'Maximum']], applyClock, HELP.clock);
      addRow('Theme', 'theme', THEMES, applyTheme, HELP.theme);
      addRow('Phosphor', 'phosphor', [['green', 'Green'], ['amber', 'Amber'], ['white', 'White']], applyPhosphor, HELP.phosphor);
      addRow('Front panel', 'frontPanel', [[true, 'Shown'], [false, 'Hidden']], applyFrontPanel, HELP.frontPanel);
      addRow('Direct ws:// dial', 'wsDirect', [[false, 'Blocked (safer)'], [true, 'Allowed']], pushModemConfig, HELP.wsDirect);
    }

    // ── library window ──
    function openLibraryWindow() {
      // default size fits 3 icons across x 5 down; resizable, icons reflow to width
      var w = window.openWindow('Disk Library', '<div class="sim-lib-list"></div>',
        { className: 'sim-libwin', width: '340px', height: '512px', resizable: true, minW: 130, minH: 150 });
      if (w && !w._simDropWired) { w._simDropWired = true; addLibraryDropTarget(w); containKeys(w); }   // desktop files -> Library
      if (w) refreshLibraryWindow();
    }
    function freeBlobUrls() {
      state.libBlobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
      state.libBlobUrls = [];
    }
    function refreshLibraryWindow() {
      var listEl = document.querySelector('.sim-libwin .sim-lib-list');
      if (!listEl) return;
      freeBlobUrls();
      dbGetAll(state.db).then(function (disks) {
        listEl.innerHTML = '';
        if (!disks.length) { listEl.innerHTML = '<div class="sim-lib-empty">Library is empty.</div>'; return; }
        disks.forEach(function (rec) {
          // a blob URL kept alive for the element's lifetime so a drag-out to the
          // OS desktop can download the image (DownloadURL is a Chromium feature)
          var blobUrl = URL.createObjectURL(new Blob([rec.data], { type: 'application/octet-stream' }));
          state.libBlobUrls.push(blobUrl);
          var isRef = rec.kind === 'reference';
          var isHd = rec.size === HD_SIZE;
          var inUse = state.drives.some(function (d) { return d.id === rec.id; });
          var el = document.createElement('div');
          el.className = 'sim-lib-disk' + (isRef ? ' sim-ref' : '') + (isHd ? ' sim-hd-disk' : '') + (inUse ? ' sim-inuse' : '');
          // reference disks always draggable (they spawn copies); an inserted
          // writeable disk is locked to its drive until ejected
          el.draggable = isRef || !inUse;
          el.title = isRef ? 'Drag onto a drive to create a named copy. Right-click for options.'
            : inUse ? 'In a drive. Eject it (drag the drive back to the Library) to move it.'
            : 'Drag onto a drive to insert, or onto your desktop to download. Right-click for options.';
          // built as DOM (not innerHTML) so a disk label can never be parsed as markup
          var big = document.createElement('span'); big.className = 'sim-disk-big';
          var nm = document.createElement('span'); nm.className = 'sim-lib-name'; nm.textContent = rec.label;
          el.appendChild(big); el.appendChild(nm);
          el.addEventListener('dragstart', function (e) {
            if (!el.draggable) { e.preventDefault(); return; }
            e.dataTransfer.setData('application/x-sim-disk', rec.id);              // -> a drive
            e.dataTransfer.setData('DownloadURL',                                  // -> the desktop
              'application/octet-stream:' + (rec.label || rec.id) + '.dsk:' + blobUrl);
          });
          el.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            showDiskMenu(e.clientX, e.clientY, rec, blobUrl);
          });
          enableTouchDrag(el, function () { return (isRef || !inUse) ? { kind: 'disk', id: rec.id } : null; });
          listEl.appendChild(el);
        });
      });
    }
    state.refreshLibraryWindow = refreshLibraryWindow;

    // ── right-click context menu on a library disk ──
    function removeMenu(e) {
      // ignore the mousedown that lands on a menu item, so its click can fire
      if (e && e.target && e.target.closest && e.target.closest('.sim-ctxmenu')) return;
      var m = document.querySelector('.sim-ctxmenu');
      if (m) m.remove();
      document.removeEventListener('mousedown', removeMenu);
    }
    function showDiskMenu(x, y, rec, blobUrl) {
      removeMenu();
      var menu = document.createElement('div');
      menu.className = 'sim-ctxmenu';
      var items = [
        { label: 'Download to desktop', fn: function () { downloadDisk(rec, blobUrl); } },
        { label: 'Rename', fn: function () { renameDisk(rec); } }
      ];
      if (rec.id === DEFAULT_DISK.id) items.push({ label: 'Reset to pristine', fn: function () { resetPristine(rec); } });
      items.push({ label: 'Delete from library', danger: true, fn: function () { deleteDisk(rec); } });
      items.forEach(function (it) {
        var b = document.createElement('div');
        b.className = 'sim-ctxitem' + (it.danger ? ' sim-danger' : '');
        b.textContent = it.label;
        b.addEventListener('click', function () { removeMenu(); it.fn(); });
        menu.appendChild(b);
      });
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      document.body.appendChild(menu);
      setTimeout(function () { document.addEventListener('mousedown', removeMenu); }, 0);
    }
    function downloadDisk(rec, blobUrl) {
      var a = document.createElement('a');
      a.href = blobUrl || URL.createObjectURL(new Blob([rec.data], { type: 'application/octet-stream' }));
      a.download = (rec.label || rec.id) + '.dsk';
      document.body.appendChild(a); a.click(); a.remove();
    }
    function renameDisk(rec) {
      promptDialog('New name for "' + rec.label + '":', rec.label, function (name) {
        if (!name || name === rec.label) return;
        rec.label = name;
        dbPut(state.db, rec).then(function () {
          state.drives.forEach(function (d) { if (d.id === rec.id) d.label = name; });
          renderDrives();
          refreshLibraryWindow();
        });
      });
    }
    function resetPristine(rec) {
      confirmDialog('Reset "' + rec.label + '" to the original pristine image? Any files saved on it will be lost.', function () {
        fetch(ASSET.disk).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
          return dbPut(state.db, { id: rec.id, label: DEFAULT_DISK.label, size: buf.byteLength, data: buf }).then(function () {
            var rebootA = false;
            state.drives.forEach(function (d, idx) {
              if (d.id === rec.id) { worker.postMessage({ type: 'insert', drive: idx, buffer: buf.slice(0) }); if (idx === 0) rebootA = true; }
            });
            refreshLibraryWindow();
            if (rebootA && state.power) resetMachine();   // reboot straight into the pristine disk
          });
        });
      });
    }
    function deleteDisk(rec) {
      confirmDialog('Remove "' + rec.label + '" from the Library?', function () {
        state.drives.forEach(function (d, idx) { if (d.id === rec.id) ejectDisk(idx); });
        dbDelete(state.db, rec.id).then(refreshLibraryWindow);
      });
    }

    // ── modal dialogs ──
    // Dialog messages interpolate untrusted text (disk labels, dropped filenames),
    // so every one is escaped before it reaches modal()'s innerHTML.
    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function modal(html) {
      var back = document.createElement('div');
      back.className = 'sim-modal-back';
      back.innerHTML = '<div class="sim-modal">' + html + '</div>';
      document.body.appendChild(back);   // viewport-fixed so it works from any sim window
      return containKeys(back);
    }
    function confirmDialog(msg, onYes) {
      var back = modal('<p>' + escapeHtml(msg) + '</p><div class="sim-modal-btns">' +
        '<button class="sim-btn sim-no">CANCEL</button><button class="sim-btn sim-yes">OK</button></div>');
      back.querySelector('.sim-yes').addEventListener('click', function () { back.remove(); onYes(); });
      back.querySelector('.sim-no').addEventListener('click', function () { back.remove(); });
    }
    function errorDialog(msg) {
      var back = modal('<p>' + escapeHtml(msg) + '</p><div class="sim-modal-btns"><button class="sim-btn sim-ok">OK</button></div>');
      back.querySelector('.sim-ok').addEventListener('click', function () { back.remove(); });
    }
    function escapeAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function promptDialog(msg, defVal, onOk) {
      var back = modal('<p>' + escapeHtml(msg) + '</p><input class="sim-input" type="text" value="' + escapeAttr(defVal) + '">' +
        '<div class="sim-modal-btns"><button class="sim-btn sim-no">CANCEL</button><button class="sim-btn sim-yes">OK</button></div>');
      var inp = back.querySelector('.sim-input');
      inp.focus(); inp.select();
      function ok() { var v = inp.value.trim(); back.remove(); onOk(v); }
      back.querySelector('.sim-yes').addEventListener('click', ok);
      back.querySelector('.sim-no').addEventListener('click', function () { back.remove(); });
      inp.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') ok(); else if (e.key === 'Escape') back.remove();
      });
    }
    function typeDialog(msg, onChoose) {
      var back = modal('<p>' + escapeHtml(msg) + '</p><div class="sim-modal-btns">' +
        '<button class="sim-btn sim-no">CANCEL</button>' +
        '<button class="sim-btn sim-choose-ref">REFERENCE</button>' +
        '<button class="sim-btn sim-choose-wr">WRITEABLE</button></div>');
      back.querySelector('.sim-no').addEventListener('click', function () { back.remove(); onChoose(null); });
      back.querySelector('.sim-choose-ref').addEventListener('click', function () { back.remove(); onChoose('reference'); });
      back.querySelector('.sim-choose-wr').addEventListener('click', function () { back.remove(); onChoose('writeable'); });
    }
    state.confirmDialog = confirmDialog;
    state.errorDialog = errorDialog;

    // ── open library, restore any inserted disks, then power on ──
    // (empty A: on first run -> the MPU-B ROM monitor; returning users boot their A: disk)
    term.write('Initializing disk library...\r\n');
    openDB().then(function (db) {
      state.db = db;
      return seedLibrary(db);
    }).then(function () {
      return restoreDrives();
    }).then(function () {
      // first run (nothing restored): unless the user chose the ROM monitor, load
      // the default disk into A: so the ROM boots straight into CP/M
      if (settings.startup === 'cpm' && !state.drives.some(function (d) { return d.id; })) return insertDisk(0, DEFAULT_DISK.id);
    }).then(function () {
      powerOn();
      if (settings.startup === 'rom' && !(state.drives[0] && state.drives[0].id)) wakeMonitor();
    }).catch(function (err) {
      term.write('\r\n[sim] library error: ' + err.message + '\r\n');
    });
  }

  function teardown() {
    if (!instance) return;
    try { instance.worker.postMessage({ type: 'stop' }); } catch (e) {}
    try { instance.worker.terminate(); } catch (e) {}
    try { instance.term.dispose(); } catch (e) {}
    try { instance.libBlobUrls.forEach(function (u) { URL.revokeObjectURL(u); }); } catch (e) {}
    var menu = document.querySelector('.sim-ctxmenu');
    if (menu) menu.remove();
    // the child windows close over the now-dead worker, so dismiss them too
    if (window.openWindow && typeof window.openWindow.closeByTitle === 'function') {
      ['Disk Library', 'Settings', 'Modem'].forEach(function (t) { window.openWindow.closeByTitle(t); });
    }
    document.querySelectorAll('.sim-modal-back').forEach(function (el) { el.remove(); });
    hideHelp();
    applyTheme(null);
    instance = null;
  }

  window.Sim8080 = {
    open: function () {
      if (instance) { window.openWindow('IMSAI-8080'); instance.term.focus(); return; }
      ensureAssets(function (err) {
        if (err) { alert('IMSAI-8080: ' + err.message); return; }
        build();
      });
    },
    // internal API used by tests and drag/drop
    _instance: function () { return instance; }
  };
})();
