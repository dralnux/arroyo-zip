// Virtual Hayes 'AT' modem for the IMSAI's second SIO-2 port, running inside the
// CPU worker. Command mode interprets AT commands; ATDT opens a WebSocket — a
// direct ws://|wss:// target, or a host:port dialed through the configured proxy
// (which gets a {token,host,port,telnet} handshake) — then switches to online
// (data) mode, piping bytes to/from the socket. Optional minimal telnet (IAC).
// Modeled on z80pack's generic-at-modem.c, adapted to the browser (dial only).
var Modem = (function () {
  'use strict';

  var rx = [];                 // bytes queued toward the CPU (result codes + inbound data)
  var mode = 'cmd';            // 'cmd' | 'online'
  var line = '';               // accumulating command line
  var ws = null;
  var cfg = { proxy: '', token: '', telnet: false, wsDirect: false };
  var opt = { echo: true, quiet: false, verbose: true };
  var plus = 0;                // consecutive '+' for the +++ escape
  var wakeCb = null;           // wake the CPU loop when RX data lands

  function notify(o) { o.type = 'modem'; try { postMessage(o); } catch (e) {} }
  function queue(s) { for (var i = 0; i < s.length; i++) rx.push(s.charCodeAt(i) & 0xff); if (wakeCb) wakeCb(); }
  var RC = { OK: ['OK', '0'], CONNECT: ['CONNECT', '1'], NOCARRIER: ['NO CARRIER', '3'], ERROR: ['ERROR', '4'], NODIAL: ['NO DIALTONE', '6'] };
  function say(r) { if (opt.quiet) return; var v = RC[r]; queue('\r\n' + (opt.verbose ? v[0] : v[1]) + '\r\n'); }

  /* ── minimal telnet (IAC) negotiation ── */
  var IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
  var O_BIN = 0, O_ECHO = 1, O_SGA = 3, O_TTYPE = 24;
  var tn = 0, tnCmd = 0, tnSub = [];
  function tnSend(bytes) { if (ws && ws.readyState === 1) ws.send(new Uint8Array(bytes)); }
  function tnByte(b) {                          // returns true if consumed as telnet control
    switch (tn) {
      case 0: if (b === IAC) { tn = 1; return true; } return false;
      case 1:
        if (b === IAC) { tn = 0; rx.push(IAC); return true; }         // escaped 0xFF -> data
        if (b === SB) { tn = 3; tnSub = []; return true; }
        if (b === DO || b === DONT || b === WILL || b === WONT) { tn = 2; tnCmd = b; return true; }
        tn = 0; return true;                                          // other 2-byte cmd, ignore
      case 2:
        tn = 0;
        if (tnCmd === DO) tnSend([IAC, (b === O_SGA || b === O_TTYPE) ? WILL : WONT, b]);
        else if (tnCmd === WILL) tnSend([IAC, (b === O_SGA || b === O_ECHO || b === O_BIN) ? DO : DONT, b]);
        return true;                                                  // DONT/WONT: accept silently
      case 3: if (b === IAC) { tn = 4; return true; } tnSub.push(b); return true;
      case 4:
        if (b === SE) { tnSubEnd(); tn = 0; return true; }
        if (b === IAC) { tnSub.push(IAC); tn = 3; return true; }
        tn = 0; return true;
    }
    return true;
  }
  function tnSubEnd() {                          // answer TTYPE SEND with a terminal name
    if (tnSub.length >= 2 && tnSub[0] === O_TTYPE && tnSub[1] === 1) {
      var name = 'VT100', out = [IAC, SB, O_TTYPE, 0], i;
      for (i = 0; i < name.length; i++) out.push(name.charCodeAt(i));
      out.push(IAC, SE); tnSend(out);
    }
  }

  /* ── inbound bytes from the socket ── */
  function onData(u) {
    for (var i = 0; i < u.length; i++) {
      var b = u[i] & 0xff;
      if (cfg.telnet && tnByte(b)) continue;
      rx.push(b);
    }
    if (wakeCb) wakeCb();
  }

  /* ── dial / hang up ── */
  function dial(target) {
    target = target.replace(/\s+/g, '');
    if (!target) { say('NODIAL'); return; }
    var url, handshake = null, m;
    if (/^wss?:\/\//i.test(target)) {
      // A direct socket skips the proxy's token + allowlist, and the guest OS can
      // dial unattended, so it stays off unless the user opts in via Settings.
      if (!cfg.wsDirect) {
        queue('\r\n[modem] direct ws:// dialing is blocked — enable "Direct ws:// dial" in Settings to allow it\r\n');
        say('NODIAL'); return;
      }
      url = target;                                              // direct WebSocket
    } else if ((m = target.match(/^(.+):(\d+)$/))) {
      if (!cfg.proxy) { queue('\r\n[modem] no proxy configured — set the Proxy (wss://) URL in the Modem window\r\n'); say('NODIAL'); return; }
      url = cfg.proxy;
      handshake = { token: cfg.token, host: m[1], port: parseInt(m[2], 10), telnet: cfg.telnet ? 1 : 0 };
    } else { say('NODIAL'); return; }

    try { ws = new WebSocket(url); } catch (e) { queue('\r\n[modem] bad proxy URL: ' + url + '\r\n'); say('NODIAL'); return; }
    ws.binaryType = 'arraybuffer';
    tn = 0;
    notify({ state: 'dialing', target: target });
    ws.onopen = function () {
      if (handshake) ws.send(JSON.stringify(handshake));
      mode = 'online'; say('CONNECT'); notify({ state: 'connected', target: target });
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') { var a = [], i; for (i = 0; i < ev.data.length; i++) a.push(ev.data.charCodeAt(i) & 0xff); onData(a); }
      else onData(new Uint8Array(ev.data));
    };
    ws.onclose = function () { ws = null; if (mode === 'online') { mode = 'cmd'; say('NOCARRIER'); } notify({ state: 'idle' }); };
    ws.onerror = function () { if (mode !== 'online') { queue('\r\n[modem] proxy unreachable — check the wss:// URL is correct and the Worker is deployed\r\n'); say('NODIAL'); notify({ state: 'idle' }); } };
  }
  function hangup() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    mode = 'cmd';
  }

  /* ── AT command interpreter ── */
  function interpret(cmd) {
    var s = cmd.trim();
    if (s === '') return;
    if (!/^AT/i.test(s)) { say('ERROR'); return; }
    var body = s.slice(2), d = body.match(/^D[TP]?(.*)$/i);
    if (d) { dial(d[1]); return; }
    var i = 0;
    while (i < body.length) {
      var c = body[i].toUpperCase();
      if (c === 'H') { hangup(); say('OK'); return; }
      if (c === 'O') { if (ws && ws.readyState === 1) { mode = 'online'; say('CONNECT'); } else say('NOCARRIER'); return; }
      if (c === 'Z') { opt.echo = true; opt.quiet = false; opt.verbose = true; hangup(); i++; continue; }
      if (c === 'E') { opt.echo = body[i + 1] !== '0'; i += 2; continue; }
      if (c === 'Q') { opt.quiet = body[i + 1] === '1'; i += 2; continue; }
      if (c === 'V') { opt.verbose = body[i + 1] !== '0'; i += 2; continue; }
      i++;                                                       // ignore unknown (lenient)
    }
    say('OK');
  }

  /* ── byte from the CPU (OUT to the modem data port) ── */
  function tx(b) {
    b &= 0xff;
    if (mode === 'online') {
      if (b === 0x2B) { plus++; if (plus >= 3) { plus = 0; mode = 'cmd'; say('OK'); return; } }
      else plus = 0;
      if (ws && ws.readyState === 1) ws.send(new Uint8Array([b]));
      return;
    }
    if (opt.echo) { rx.push(b); if (wakeCb) wakeCb(); }
    var c = b & 0x7f;
    if (c === 13) { var l = line; line = ''; interpret(l); }
    else if (c === 8 || c === 127) { line = line.slice(0, -1); }
    else if (c >= 32) line += String.fromCharCode(c);
  }

  return {
    config: function (c) { cfg.proxy = c.proxy || ''; cfg.token = c.token || ''; cfg.telnet = !!c.telnet; cfg.wsDirect = !!c.wsDirect; },
    setWake: function (fn) { wakeCb = fn; },
    // UI-initiated dial (phonebook): drop any live call, then dial (entry's telnet wins)
    dialNow: function (target, telnet) { if (typeof telnet === 'boolean') cfg.telnet = telnet; hangup(); dial(target); },
    hangupNow: function () { hangup(); notify({ state: 'idle' }); },
    tx: tx,
    rxAvail: function () { return rx.length > 0; },
    rx: function () { return rx.length ? rx.shift() : 0; },
    reset: function () { try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {} ws = null; rx.length = 0; mode = 'cmd'; line = ''; plus = 0; tn = 0; }
  };
})();
