// Isolated pure avatar kernel from the user-provided Grok Bot renderer.
// Source: index.eager-platform-DUN5VkaE.js; formatted source SHA-256: fb22177b9de1db1216a08e6be5fe5feac87f246151427c842756ef42bf0f5237
// Only dependency-closed math, geometry, keyframes and SVG routines are retained.
// No application code, imports, I/O, timers, listeners, or runtime/agent state.
// Keep this vendor snapshot separate from the typed CMB adapter.
const To = (e) => ({ x: e, v: 0, t: e });
const Eo = (e, t, n, r) => {
    ((e.v += (-2 * n * t * e.v - t * t * (e.x - e.t)) * r),
      (e.x += e.v * r),
      (!Number.isFinite(e.x) || !Number.isFinite(e.v)) &&
        ((e.x = e.t), (e.v = 0)));
  };
const Jw = 1 / 120;
const Bf = (e) => Math.max(1, Math.ceil(e / Jw));
const le = (e, t, n) => Math.min(n, Math.max(t, e));
const Qo = (e) => (e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2);
const Ye = (e) => 1 - Math.pow(1 - e, 3);
const Es = (e) => 1 + 2.70158 * Math.pow(e - 1, 3) + 1.70158 * Math.pow(e - 1, 2);
const eb = (e) => e * e * (3 - 2 * e);
const nr = [0.42, 0, 0.58, 1];
const tb = [0.4, 0.06, 0.18, 1];
const nb = 0.28;
const ta = 0.35;
const na = 0.26;
const rb = 4.25 / 60;
const ob = 2 / 60;
const si = 1.06;
function el(e, t, n) {
  const r = 1 - e;
  return 3 * r * r * e * t + 3 * r * e * e * n + e * e * e;
}
function sb(e, t, n) {
  const r = 1 - e;
  return 3 * r * r * t + 6 * r * e * (n - t) + 3 * e * e * (1 - n);
}
function Qa(e, t) {
  const [n, r, o, s] = t;
  let i = e;
  for (let a = 0; a < 8; a++) {
    const c = el(i, n, o) - e,
      u = sb(i, n, o);
    if (Math.abs(c) < 1e-6 || Math.abs(u) < 1e-6) break;
    i = Math.min(1, Math.max(0, i - c / u));
  }
  return el(i, r, s);
}
function Jo(e) {
  const t = Math.min(1, Math.max(0, e));
  return t * t * (3 - 2 * t);
}
function ii(e, t) {
  const r = Math.min(0.28, (e ? ob : rb) / Math.max(t, 0.05)),
    o = (1 - r) * 0.42;
  return { u1: o, u2: o + r };
}
function ib(e) {
  const t = Math.min(1, Math.max(0, e));
  if (t < 0.7) {
    const n = t / 0.7;
    return (1 - (1 - n) * (1 - n)) * si;
  }
  return si + (1 - si) * Jo((t - 0.7) / 0.3);
}
function ab(e, { u1: t, u2: n }) {
  return e < t
    ? Jo(e / t)
    : e <= n
      ? 1
      : 1 - Jo((e - n) / Math.max(1e-6, 1 - n));
}
const vn = Math.PI / 180;
function ra(e, t) {
  return [
    e[0] * t[0] - e[1] * t[1] - e[2] * t[2] - e[3] * t[3],
    e[0] * t[1] + e[1] * t[0] + e[2] * t[3] - e[3] * t[2],
    e[0] * t[2] - e[1] * t[3] + e[2] * t[0] + e[3] * t[1],
    e[0] * t[3] + e[1] * t[2] - e[2] * t[1] + e[3] * t[0],
  ];
}
function Po(e, t) {
  const n = Math.sin(t / 2);
  return [Math.cos(t / 2), e[0] * n, e[1] * n, e[2] * n];
}
function cb(e) {
  const t = Math.hypot(e[0], e[1], e[2], e[3]) || 1;
  return [e[0] / t, e[1] / t, e[2] / t, e[3] / t];
}
function ub(e, t) {
  const n = 1 + (e[0] * t[0] + e[1] * t[1] + e[2] * t[2]);
  return cb([
    n,
    e[1] * t[2] - e[2] * t[1],
    e[2] * t[0] - e[0] * t[2],
    e[0] * t[1] - e[1] * t[0],
  ]);
}
function ir(e) {
  const [t, n, r, o] = e;
  return [
    1 - 2 * (r * r + o * o),
    2 * (n * r - t * o),
    2 * (n * o + t * r),
    2 * (n * r + t * o),
    1 - 2 * (n * n + o * o),
    2 * (r * o - t * n),
    2 * (n * o - t * r),
    2 * (r * o + t * n),
    1 - 2 * (n * n + r * r),
  ];
}
function lb(e, t, n) {
  return ra(Po([0, 0, 1], n), ra(Po([0, 1, 0], t), Po([1, 0, 0], e)));
}
function Hf(e) {
  const t = e[0],
    n = e[3],
    r = e[5],
    o = e[4],
    s = e[6],
    i = e[7],
    a = e[8],
    c = Math.max(-1, Math.min(1, -s)),
    u = Math.asin(c);
  return Math.abs(c) > 0.999999
    ? [Math.atan2(-r, o), u, 0]
    : [Math.atan2(i, a), u, Math.atan2(n, t)];
}
function db(e) {
  return Hf(ir(e));
}
function Et(e, t) {
  return [
    e[0] * t[0] + e[1] * t[1] + e[2] * t[2],
    e[3] * t[0] + e[4] * t[1] + e[5] * t[2],
    e[6] * t[0] + e[7] * t[1] + e[8] * t[2],
  ];
}
const tl = 0.1305;
const Ja = [
    {
      A: [0.01722, 0.45638, 0.88962],
      B: [0.186, 0.20949, 0.95996],
      N: [0.82924, 0.4906, -0.26773],
    },
    {
      A: [0.48863, 0.67924, 0.54762],
      B: [0.65674, 0.43195, 0.61815],
      N: [0.60389, 0.18972, -0.77416],
    },
  ];
function es(e) {
  const t = Math.hypot(e[0], e[1], e[2]) || 1;
  return [e[0] / t, e[1] / t, e[2] / t];
}
const fb = (() => {
    let e = [0, 0, 0];
    for (const { A: t, B: n } of Ja) {
      const r = es([t[0] + n[0], t[1] + n[1], t[2] + n[2]]);
      e = [e[0] + r[0], e[1] + r[1], e[2] + r[2]];
    }
    return es(e);
  })();
const br = (() => {
    const e = ub(fb, [0, 0, 1]),
      t = ir(e);
    let n = 0,
      r = 0;
    for (const { A: i, B: a } of Ja) {
      const c = Et(t, [a[0] - i[0], a[1] - i[1], a[2] - i[2]]);
      ((n += c[0]), (r += c[1]));
    }
    const o = Math.atan2(r, n),
      s =
        ((((Math.PI / 2 - o + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) -
        Math.PI / 2;
    return ra(Po([0, 0, 1], s), e);
  })();
const hb = (() => {
    const e = ir(br);
    return Ja.map(({ A: t, B: n, N: r }) => ({
      A: Et(e, t),
      B: Et(e, n),
      N: Et(e, r),
    }));
  })();
const pb = [br[0], -br[1], -br[2], -br[3]];
const Vf = (() => {
    const e = ({ A: r, B: o }) => {
        const s = es([r[0] + o[0], r[1] + o[1], r[2] + o[2]]),
          i = o[0] * s[0] + o[1] * s[1] + o[2] * s[2];
        let a = es([o[0] - i * s[0], o[1] - i * s[1], o[2] - i * s[2]]);
        a[1] < 0 && (a = [-a[0], -a[1], -a[2]]);
        let c = [
          s[1] * a[2] - s[2] * a[1],
          s[2] * a[0] - s[0] * a[2],
          s[0] * a[1] - s[1] * a[0],
        ];
        return (
          c[0] * s[0] < 0 && (c = [-c[0], -c[1], -c[2]]),
          { M: s, T: a, C: c }
        );
      },
      [t, n] = hb;
    if (t == null || n == null)
      throw new Error("Motion Lab defines exactly two eye capsules");
    return [e(t), e(n)];
  })();
const mb = [
    "sphere",
    "cloud",
    "square",
    "sparkle",
    "clover",
    "heartChubby",
    "starFlower",
    "teardrop",
    "tablet",
    "wedge",
    "house",
    "star6",
    "pebble",
    "bean",
    "egg",
    "squircle",
    "capsule",
    "cylinder",
    "hex",
    "gem",
    "crystal",
    "shield",
    "dome",
    "arch",
    "leaf",
  ];
const gb = [
    "neutral",
    "happy",
    "surprised",
    "sad",
    "sleepy",
    "squinted",
    "calm",
    "inspecting",
    "confused",
  ];
const xr = 0.26;
const yb = 21;
const kb = 18;
const wb = new Map([
    ["thinking", "sad"],
    ["strange", "inspecting"],
    ["angry", "neutral"],
    ["inspect", "inspecting"],
    ["squint", "squinted"],
    ["idle", "neutral"],
    ["smile", "happy"],
    ["sleep", "sleepy"],
  ]);
const bb = new Set(["sad", "happy", "confused", "squinted", "sleepy"]);
function uo(e, t) {
  return [e[t * 6], e[t * 6 + 1]];
}
function lo(e, t, n) {
  const r = n ? 4 : 2;
  return [e[t * 6] + e[t * 6 + r], e[t * 6 + 1] + e[t * 6 + r + 1]];
}
function Gf(e) {
  const t = (yb + 1) >> 1,
    n = [],
    r = (o, s, i, a, c) => {
      for (let u = c; u < t; u++) {
        const l = u / (t - 1),
          d = 1 - l,
          f = d * d * d,
          h = 3 * d * d * l,
          p = 3 * d * l * l,
          g = l * l * l;
        n.push([
          f * o[0] + h * s[0] + p * i[0] + g * a[0],
          f * o[1] + h * s[1] + p * i[1] + g * a[1],
        ]);
      }
    };
  return (
    r(uo(e, 0), lo(e, 0, !0), lo(e, 1, !1), uo(e, 1), 0),
    r(uo(e, 1), lo(e, 1, !0), lo(e, 2, !1), uo(e, 2), 1),
    n
  );
}
function xb({ p0: e, p1: t, p2: n, isArc: r }) {
  const [o, s] = e,
    [i, a] = t,
    [c, u] = n,
    l = new Array(kb).fill(0),
    d = (y, w) => {
      ((l[y * 6] = w[0]), (l[y * 6 + 1] = w[1]));
    },
    f = (y, w) => {
      ((l[y * 6 + 2] = w[0] - l[y * 6]), (l[y * 6 + 3] = w[1] - l[y * 6 + 1]));
    },
    h = (y, w) => {
      ((l[y * 6 + 4] = w[0] - l[y * 6]), (l[y * 6 + 5] = w[1] - l[y * 6 + 1]));
    };
  if (r) {
    const y = 2 * (o * (a - u) + i * (u - s) + c * (s - a));
    if (Math.abs(y) > 1e-9) {
      const S = o * o + s * s,
        b = i * i + a * a,
        v = c * c + u * u,
        T = (S * (a - u) + b * (u - s) + v * (s - a)) / y,
        A = (S * (c - i) + b * (o - c) + v * (i - o)) / y,
        F = Math.hypot(o - T, s - A),
        N = Math.atan2(s - A, o - T),
        R = Math.atan2(u - A, c - T),
        B = Math.atan2(a - A, i - T),
        E = Math.PI * 2,
        I = (R - N + E) % E,
        O = (B - N + E) % E <= I ? I : I - E,
        H = (K) => [T + F * Math.cos(K), A + F * Math.sin(K)],
        L = (K) => [-Math.sin(K), Math.cos(K)],
        j = O / 2,
        J = (4 / 3) * Math.tan(j / 4) * F,
        fe = [N, N + j, N + O];
      for (let K = 0; K < 3; K++) {
        const te = H(fe[K]),
          Z = L(fe[K]);
        (d(K, te),
          K > 0 && f(K, [te[0] - J * Z[0], te[1] - J * Z[1]]),
          K < 2 && h(K, [te[0] + J * Z[0], te[1] + J * Z[1]]));
      }
      return l;
    }
    const w = [(o + c) / 2, (s + u) / 2];
    return (
      d(0, [o, s]),
      d(1, w),
      d(2, [c, u]),
      h(0, [o + (w[0] - o) / 3, s + (w[1] - s) / 3]),
      f(1, [w[0] - (w[0] - o) / 3, w[1] - (w[1] - s) / 3]),
      h(1, [w[0] + (c - w[0]) / 3, w[1] + (u - w[1]) / 3]),
      f(2, [c - (c - w[0]) / 3, u - (u - w[1]) / 3]),
      l
    );
  }
  const p = [(o + i) / 2, (s + a) / 2],
    g = [(i + c) / 2, (a + u) / 2],
    m = [(p[0] + g[0]) / 2, (p[1] + g[1]) / 2];
  return (
    d(0, [o, s]),
    d(1, m),
    d(2, [c, u]),
    h(0, [o + (2 / 3) * (p[0] - o), s + (2 / 3) * (p[1] - s)]),
    f(1, [m[0] + (2 / 3) * (p[0] - m[0]), m[1] + (2 / 3) * (p[1] - m[1])]),
    h(1, [m[0] + (2 / 3) * (g[0] - m[0]), m[1] + (2 / 3) * (g[1] - m[1])]),
    f(2, [c + (2 / 3) * (g[0] - c), u + (2 / 3) * (g[1] - u)]),
    l
  );
}
function Pr(e, t, n, r, o) {
  const s = xb(r);
  return {
    off: e,
    tilt: t,
    wid: n,
    lidY: 1,
    oval: o,
    ovalMix: 0,
    pts: Gf(s),
    path: s,
    fillRing: null,
  };
}
function ec(e, t, n, r, o) {
  const s = Math.max(0, (t - e) / 2),
    i = (n * Math.PI) / 180,
    a = Math.sin(i) * s,
    c = Math.cos(i) * s;
  return Pr(
    r,
    o,
    e / 2,
    { p0: [-a, -c], p1: [0, 0], p2: [a, c], isArc: !1 },
    [0, 0],
  );
}
function zn(e, t, n, r) {
  return ec(e, t, n, [r, 0], 0);
}
function vb(e, t, n) {
  const r = { p0: [-e, 0], p1: [0, 0], p2: [e, 0], isArc: !1 };
  return Pr([n, 0], 0, t, r, [e, t]);
}
function Zt(e) {
  return [e, e];
}
const bn = {
  neutral: Zt(zn(xr, 0.57, 0, 0)),
  happy: Zt(
    Pr(
      [0.03, 0.03],
      0,
      tl,
      { p0: [0.16, -0.04], p1: [0, 0.12], p2: [-0.16, -0.04], isArc: !0 },
      [0, 0],
    ),
  ),
  surprised: Zt(zn(0.42, 0.86, 0, 0.03)),
  inspecting: [zn(0.54, 0.54, 0, 0.04), zn(0.36, 0.36, 0, 0.04)],
  sad: Zt(zn(xr, 0.5, -28, -0.05)),
  sleepy: Zt(
    Pr(
      [0.01, 0],
      0,
      xr / 2,
      { p0: [-0.11, 0.025], p1: [0, -0.05], p2: [0.11, 0.025], isArc: !1 },
      [0, 0],
    ),
  ),
  squinted: Zt(zn(xr, 0.5, 90, 0.01)),
  calm: Zt(vb(0.296, 0.247, 0.05)),
  confused: Zt(
    Pr(
      [-0.1, 0],
      0,
      tl,
      { p0: [0.01, 0.16], p1: [-0.17, 0], p2: [0.01, -0.16], isArc: !1 },
      [0, 0],
    ),
  ),
};
function Sb(e) {
  return gb.some((t) => t === e);
}
function Mb(e) {
  const t = e.trim().toLowerCase(),
    n = wb.get(t) ?? t;
  return Sb(n) ? n : "neutral";
}
function Lr(e) {
  return bb.has(e);
}
function Tb(e) {
  return !Lr(e) && !bn[e].some(jt);
}
function nt(e, t) {
  return [t(e[0], 0), t(e[1], 1)];
}
function wt(e) {
  return { ...e, ovalMix: 0 };
}
function jt(e) {
  return e.oval[0] > 1e-4 && e.oval[1] > 1e-4;
}
function ts(e) {
  if (jt(e) || e.pts.length < 3) return !1;
  const t = e.pts[0],
    n = e.pts[e.pts.length - 1],
    r = n[0] - t[0],
    o = n[1] - t[1],
    s = r * r + o * o;
  if (s < 1e-8) return !1;
  let i = 0;
  for (const a of e.pts) {
    const c = ((a[0] - t[0]) * r + (a[1] - t[1]) * o) / s,
      u = t[0] + c * r,
      l = t[1] + c * o,
      d = Math.hypot(a[0] - u, a[1] - l);
    d > i && (i = d);
  }
  return i > Math.max(0.012, e.wid * 0.2);
}
const Eb = 0.03;
const Pb = 0.6;
const Ab = 0.42;
const Ib = 20;
function Zn(e, t, n) {
  return e + (t - e) * n;
}
function Ao(e, t, n) {
  return [Zn(e[0], t[0], n), Zn(e[1], t[1], n)];
}
function nl(e, t, n) {
  if (e.length === 0) return [0, 0];
  if (e.length === 1 || n <= 1) return e[0];
  const r = (t / (n - 1)) * (e.length - 1),
    o = Math.min(Math.floor(r), e.length - 2);
  return Ao(e[o], e[o + 1], r - o);
}
function _b(e, t, n) {
  const r = {
    off: Ao(e.off, t.off, n),
    tilt: Zn(e.tilt, t.tilt, n),
    wid: Zn(e.wid, t.wid, n),
    lidY: Zn(e.lidY, t.lidY, n),
    oval: Ao(e.oval, t.oval, n),
    ovalMix: 0,
    fillRing: null,
  };
  if (e.path && t.path && e.path.length === t.path.length) {
    const i = t.path,
      a = e.path.map((c, u) => Zn(c, i[u], n));
    return { ...r, path: a, pts: Gf(a) };
  }
  const o = Math.max(e.pts.length, t.pts.length, 2),
    s = [];
  for (let i = 0; i < o; i++) s.push(Ao(nl(e.pts, i, o), nl(t.pts, i, o), n));
  return { ...r, path: null, pts: s };
}
function ns(e) {
  if (jt(e)) {
    const [o, s] = e.oval;
    return {
      cx: e.off[0],
      cy: e.off[1],
      ang: o >= s ? Math.PI / 2 : 0,
      halfLen: Math.max(o, s),
      halfW: Math.min(o, s),
    };
  }
  const t = e.wid;
  if (e.pts.length < 2)
    return { cx: e.off[0], cy: e.off[1], ang: e.tilt, halfLen: t, halfW: t };
  const n = e.pts[0],
    r = e.pts[e.pts.length - 1];
  return {
    cx: e.off[0] + (n[0] + r[0]) / 2,
    cy: e.off[1] + (n[1] + r[1]) / 2,
    ang: Math.atan2(r[0] - n[0], r[1] - n[1]) + e.tilt,
    halfLen: Math.hypot(r[0] - n[0], r[1] - n[1]) / 2 + t,
    halfW: t,
  };
}
function Wf(e, t) {
  let n = t.ang - e.ang;
  for (; n > Math.PI / 2; ) n -= Math.PI;
  for (; n < -Math.PI / 2; ) n += Math.PI;
  return n;
}
function Cb(e, t, n) {
  const o = Math.max(0, e - t),
    s = Math.max(0, Math.min(1, n)),
    i = [];
  for (let a = 0; a < 48; a++) {
    const c = (a / 48) * Math.PI * 2,
      u = Math.cos(c),
      l = Math.sin(c),
      d = t * u,
      f = e * l,
      h = t / Math.max(Math.abs(u), 1e-6);
    let p;
    if (h * Math.abs(l) <= o + 1e-6 && Number.isFinite(h)) p = h;
    else {
      const w = (l >= 0 ? 1 : -1) * o * l,
        S = Math.max(0, w * w - o * o + t * t);
      p = w + Math.sqrt(S);
    }
    const g = p * u,
      m = p * l;
    i.push([g + (d - g) * s, m + (f - m) * s]);
  }
  return i;
}
function oa(e, t, n, r) {
  return ec(Math.max(e, 1e-4), Math.max(t, e), 0, r, n);
}
function Rb(e, t, n) {
  if (n <= 1e-4) return wt(e);
  if (n >= 0.995) return wt(t);
  const r = ns(e),
    o = ns(t),
    s = Wf(r, o),
    i = jt(t),
    a = i ? 1 - (1 - n) ** 3 : n * n * n,
    c = r.ang + s * n,
    u = Math.max(r.halfLen + (o.halfLen - r.halfLen) * n, 1e-4),
    l = Math.max(r.halfW + (o.halfW - r.halfW) * n, 1e-4),
    d = jt(e) ? 1 : 0,
    f = d + ((i ? 1 : 0) - d) * a,
    h = oa(2 * l, 2 * u, c, [
      r.cx + (o.cx - r.cx) * n,
      r.cy + (o.cy - r.cy) * n,
    ]),
    p = f > 1e-4;
  return {
    ...h,
    oval: p ? [l, u] : h.oval,
    ovalMix: p ? f : 0,
    fillRing: Cb(u, l, f),
  };
}
function $b(e, t, n) {
  if (n >= 1 - 1e-4) return wt(t);
  const r = ns(e),
    o = ns(t),
    s = r.ang + Wf(r, o) * n,
    i = Math.max(1e-4, r.halfW + (o.halfW - r.halfW) * n),
    a =
      Math.max(0, r.halfLen - r.halfW) * (1 - n) +
      Math.max(0, o.halfLen - o.halfW) * n,
    c = [r.cx + (o.cx - r.cx) * n, r.cy + (o.cy - r.cy) * n];
  return ec(2 * i, 2 * (a + i), (s * 180) / Math.PI, c, 0);
}
function Ob(e) {
  const t = jt(e);
  if (!(e.wid > 0) && !t) return null;
  const n = e.lidY,
    r = e.tilt * (180 / Math.PI);
  if (t)
    return {
      width: 2 * e.oval[0],
      height: 2 * e.oval[1] * n,
      tilt: r,
      cx: e.off[0],
      cy: e.off[1],
    };
  if (e.pts.length < 2) return null;
  const o = e.pts[0],
    s = e.pts[e.pts.length - 1],
    i = s[0] - o[0],
    a = s[1] - o[1],
    c = Math.hypot(i, a),
    u = 2 * e.wid;
  return {
    width: u,
    height: (c + u) * n,
    tilt: Math.atan2(i, a) * (180 / Math.PI) + r,
    cx: e.off[0] + (o[0] + s[0]) / 2,
    cy: e.off[1] + ((o[1] + s[1]) / 2) * n,
  };
}
function Lb(e) {
  const t = Ob(e);
  if (t == null) return { w: xr, h: 0.57, cx: e.off[0], cy: e.off[1] };
  const n = (t.tilt * Math.PI) / 180,
    r = Math.abs(Math.cos(n)),
    o = Math.abs(Math.sin(n));
  return {
    w: t.width * r + t.height * o,
    h: t.width * o + t.height * r,
    cx: t.cx,
    cy: t.cy,
  };
}
function Nb(e, t, n, r) {
  return t >= e ? oa(e, t, 0, [n, r]) : oa(t, e, Math.PI / 2, [n, r]);
}
function rl(e, t) {
  if (t <= 0) return e;
  const n = Math.min(1, t),
    r = Lb(e),
    o = Math.max(r.w, 1e-4),
    s = Math.max(r.h, o),
    i = o * Ab;
  return Nb(o, s + (i - s) * n, r.cx, r.cy);
}
function Fb(e) {
  return { ...e, wid: 0, oval: [0, 0] };
}
function zb(e) {
  let t, n;
  if (jt(e)) ((t = -e.oval[1]), (n = e.oval[1]));
  else {
    let r = 1e9,
      o = -1e9;
    for (const s of e.pts) (s[1] < r && (r = s[1]), s[1] > o && (o = s[1]));
    ((t = r - e.wid), (n = o + e.wid));
  }
  return t + (1 - Pb) * (n - t);
}
function Db(e) {
  if (e.pts.length < 2) return e;
  const t = e.pts[0],
    n = e.pts[e.pts.length - 1],
    r = n[0] - t[0],
    o = n[1] - t[1];
  if (Math.abs(o) < Math.abs(r)) return e;
  const s = Math.atan2(r, o);
  if (Math.abs(s) < 1e-5) return e;
  const i = Math.cos(s),
    a = Math.sin(s);
  return {
    ...e,
    tilt: e.tilt + s,
    pts: e.pts.map((c) => [c[0] * i - c[1] * a, c[0] * a + c[1] * i]),
  };
}
function ol(e, t) {
  if (t === 0) return e;
  const n = Db(e),
    r = Math.max(Eb, 1 - t),
    o = zb(n) * (1 - r),
    s = Math.cos(-n.tilt),
    i = Math.sin(-n.tilt);
  return { ...n, off: [n.off[0] - i * o, n.off[1] + s * o], lidY: n.lidY * r };
}
function jb(e, t, n, r) {
  if (t < 0.001) return e;
  const o = n.isFollowingTurn ? Math.min(1, Math.max(-1, r / Ib)) : n.bias,
    [s, i] = bn.inspecting,
    a = Math.max(1e-4, s.wid),
    c = Math.max(1e-4, i.wid),
    u = (1 + o) / 2,
    l = (d, f) => {
      const h = 1 + (f - 1) * t;
      return {
        ...wt(d),
        wid: d.wid * h,
        pts: d.pts.map((p) => [p[0] * h, p[1] * h]),
      };
    };
  return [l(e[0], Math.pow(c / a, u)), l(e[1], Math.pow(a / c, u))];
}
function sl(e) {
  return e === "inspecting" ? 1 : 0;
}
function qb(e, t, n) {
  return !(e.some(ts) || t.some(ts)) && (e.some(jt) || t.some(jt))
    ? "oval"
    : n
      ? "spine"
      : "stadium";
}
function il(e) {
  return Qa(Math.min(Math.max(e.t / e.dur, 0), 1), tb);
}
function Bb() {
  let e = "neutral",
    t = nt(bn.neutral, wt),
    n = 0,
    r = null;
  const o = () => {
      if (r == null) return t;
      if (r.kind === "blink") return r.from;
      if (r.kind === "morph") {
        const m = Math.max(0, Math.min(1, il(r))),
          { from: y, to: w, path: S } = r;
        return S === "oval"
          ? nt(y, (b, v) => Rb(b, w[v], m))
          : S === "spine"
            ? nt(y, (b, v) => _b(b, w[v], m))
            : nt(y, (b, v) => $b(b, w[v], m));
      }
      const f = Math.min(r.t / r.dur, 1),
        { u1: h, u2: p } = ii(!1, r.dur);
      if (f < h) return nt(r.from, (m) => ol(m, Jo(f / h)));
      if (f <= p) return nt(r.to, Fb);
      const g = ib((f - p) / Math.max(1e-6, 1 - p));
      return nt(r.to, (m) => ol(m, 1 - g));
    },
    s = () => {
      if (r == null) return n;
      if (r.kind === "blink") return r.fromInspect;
      const f = r.fromInspect,
        h = sl(r.toName);
      if (r.kind === "morph") return f + (h - f) * il(r);
      const p = Math.min(r.t / r.dur, 1),
        { u1: g, u2: m } = ii(!1, r.dur);
      return p <= g ? f : p < m ? 0 : h;
    },
    i = (f) => {
      const h = nt(o(), wt),
        p = bn[f],
        g = h.some(ts) || p.some(ts) || e === "sleepy" || f === "sleepy";
      ((r = {
        kind: "morph",
        path: qb(h, p, g),
        fromInspect: s(),
        toName: f,
        from: h,
        to: p,
        t: 0,
        dur: nb,
        isHeld: !1,
      }),
        (e = f));
    },
    a = (f) => {
      ((r = {
        kind: "lidMorph",
        fromInspect: s(),
        toName: f,
        from: nt(o(), wt),
        to: bn[f],
        t: 0,
        dur: ta,
        isHeld: !1,
      }),
        (e = f));
    },
    c = () => {
      (r != null && !r.isHeld) ||
        (r = {
          kind: "blink",
          fromInspect: n,
          toName: e,
          from: nt(t, wt),
          to: bn[e],
          t: 0,
          dur: na,
          isHeld: !1,
        });
    },
    u = (f) => {
      (f.name === e && (r == null || r.toName === f.name)) ||
        (f.isThroughBlink && !Lr(f.name) && !Lr(e) ? a(f.name) : i(f.name));
    },
    l = (f, h) => {
      h >= f.dur
        ? ((t = nt(f.to, wt)), (n = sl(f.toName)), (r = null))
        : (r = h < 0 ? null : { ...f, t: h });
    },
    d = (f) => {
      r != null && (r = { ...r, isHeld: f });
    };
  return {
    get name() {
      return e;
    },
    get isMorphing() {
      return r != null && r.kind !== "blink" && !r.isHeld;
    },
    eyes: o,
    inspectWeight: s,
    blinkAmount() {
      if (r?.kind !== "blink" || r.isHeld) return null;
      const f = Math.min(r.t / r.dur, 1);
      return Math.min(1, Math.max(0, ab(f, ii(!0, r.dur))));
    },
    morph: i,
    lidMorph: a,
    blink: c,
    play: u,
    step(f) {
      r != null && !r.isHeld && l(r, r.t + f);
    },
    release() {
      d(!1);
    },
    seek(f, h) {
      ((e = "neutral"), (t = nt(bn.neutral, wt)), (n = 0), (r = null));
      let p = 0;
      const g = (m) => {
        r != null && l(r, m - p);
      };
      for (const m of f) {
        if (m.t > h + 1e-9) break;
        (g(m.t), u(m), (p = m.t));
      }
      (g(h), d(!0));
    },
  };
}
const Hb = 0.9;
const Vb = 0.4;
const Gb = 0.62;
const Wb = 0.3;
const Ub = 0.5;
const Kb = 16;
function Uf({ poke: e, turns: t }) {
  switch (e) {
    case "spin":
      return Hb + Vb * (t - 1);
    case "bounce":
      return Gb;
    case "nod":
      return Ub;
  }
}
function Xb(e) {
  let t = 0,
    n = 0,
    r = 0,
    o = 1,
    s = 1;
  for (const i of e) {
    const a = Math.min(1, i.t / Uf(i));
    switch (i.poke) {
      case "spin":
        n += 180 * i.turns * (1 - Math.cos(Math.PI * a));
        break;
      case "nod":
        t += Kb * fo(a, 0, 1);
        break;
      case "bounce": {
        const c = fo(a, 0, 0.18) + fo(a, 0.82, 1),
          u = fo(a, 0.18, 0.82);
        ((r += Wb * Math.sin(Math.PI * le((a - 0.14) / 0.72, 0, 1))),
          (o *= 1 + 0.08 * c - 0.04 * u),
          (s *= 1 - 0.1 * c + 0.06 * u));
        break;
      }
    }
  }
  return { pitch: t, yaw: n, lift: r, squash: [o, s] };
}
function fo(e, t, n) {
  return e <= t || e >= n ? 0 : Math.sin((Math.PI * (e - t)) / (n - t)) ** 2;
}
const Yb = 0.14;
const Zb = 0.55;
const Qb = { heartChubby: 0.6, wedge: 0.55 };
function al(e, t, n) {
  const r = e !== "sphere",
    o = Qb[e] ?? 1;
  return {
    rx: -(r ? 19 : 14) * o * n,
    ry: (r ? 26 : 18) * o * t,
    px: (r ? 0.07 : 0.03) * t,
    py: (r ? 0.055 : 0.024) * n,
  };
}
const tx = {
    thinking: "dots",
    orbit: "orbit",
    radar: "radar",
    progress: "progress",
    spawning: "gather",
    dictating: "wave",
    sending: "send",
    receiving: "receive",
    uploading: "dock",
    bouncing: "ball",
    writing: "pencil",
    alerting: "bang",
    "powering-down": "standby",
  };
const nx = Math.PI;
const rx = 0.1;
const ox = 2654435769;
const sx = new Set(["progress", "spawning"]);
const ix = { progress: 2.5, spawning: 2 };
const ax = 1.5;
function tc(e) {
  let t = e | 0;
  return () => {
    t = (t + 1831565813) | 0;
    let n = Math.imul(t ^ (t >>> 15), t | 1);
    return (
      (n ^= n + Math.imul(n ^ (n >>> 7), n | 61)),
      ((n ^ (n >>> 14)) >>> 0) / 4294967296
    );
  };
}
function nc(e) {
  return ix[e] ?? 2.5;
}
function cx(e = {}) {
  const t = e.isReducedMotion ?? !1,
    n = tc(e.seed ?? ox),
    r = To(0),
    o = To(1),
    s = To(0);
  let i = null,
    a = null,
    c = null,
    u = null,
    l = !1,
    d = 0,
    f = 0,
    h = 1,
    p = !1,
    g = 0,
    m = 0,
    y = 0,
    w = 0,
    S = 0;
  const b = () => {
    const v = i == null ? null : tx[i],
      T = y;
    i !== a && ((a = i), i != null && ((y = g), (l = !1)));
    let A = v != null;
    (i != null &&
      sx.has(i) &&
      (!l && g - y > nc(i)
        ? ((l = !0), (d = g))
        : l && g - d > ax && ((l = !1), (y = g)),
      (A = !l)),
      (r.t = A ? 1 : 0),
      v != null &&
        v !== c &&
        (c != null && r.x > 0.02
          ? ((u = c), (w = m), (S = T), (o.x = t ? 1 : 0))
          : ((u = null), (o.x = 1)),
        (o.v = 0),
        (o.t = 1),
        (c = v),
        (m = g)),
      v == null && r.x < 0.004 && ((c = null), (u = null)),
      o.x > 0.996 && (u = null),
      A !== p &&
        (A && !t && (h = n() < 0.5 ? 1 : -1),
        t || ((f += nx * h), (s.t = f)),
        (p = A)));
  };
  return {
    get target() {
      return i;
    },
    set(v) {
      i = v;
    },
    advance(v) {
      const T = v > 0 ? Math.min(v, rx) : 0;
      ((g += T), b());
      const A = Bf(T),
        F = T / A;
      for (let N = 0; N < A; N++)
        (Eo(r, 14, 1, F), Eo(o, 11, 1, F), Eo(s, 14, 1, F));
      t && ((o.x = 1), (s.x = s.t), (r.x = r.t));
    },
    settle() {
      b();
      for (const v of [r, o, s]) ((v.x = v.t), (v.v = 0));
      b();
    },
    snapshot() {
      return {
        amount: le(r.x, 0, 1),
        spin: s.x,
        kind: c,
        outgoing: u,
        swap: le(o.x, 0, 1),
        clock: { stateTime: g - m, shotTime: g - y },
        outgoingClock: { stateTime: g - w, shotTime: g - S },
        isReducedMotion: t,
        isSettled:
          Math.abs(r.x - r.t) < 0.001 &&
          Math.abs(s.t - s.x) < 0.01 &&
          o.x > 0.996,
      };
    },
  };
}
const ux = new Map([
    ["position", "position"],
    ["rotation", "rotation"],
    ["squash", "squash"],
    ["scale", "zoom"],
    ["lids", "lids"],
    ["expression", "expression"],
    ["pos", "position"],
    ["rot", "rotation"],
    ["scl", "squash"],
    ["zoom", "zoom"],
    ["expr", "expression"],
  ]);
const lx = new Map([
    ["blob", "sphere"],
    ["sphereWide", "sphere"],
    ["arch", "horseshoe"],
    ["spark", "sparkle"],
    ["star", "star6"],
    ["heart", "heartChubby"],
    ["hexagon", "hex"],
  ]);
const dx = [0.4, 0, 0.2, 1];
const $n = 0.6;
const Kf = (() => {
    const [e, t, n] = db(pb);
    return [e / vn, t / vn, n / vn];
  })();
const Xf = {
    duration: 10,
    body: null,
    squashAnchor: 0,
    restTime: 0,
    inspect: {},
    position: [],
    rotation: [],
    squash: [],
    zoom: [],
    lids: [],
    expression: [],
  };
const cl = { ...Xf, rotation: [{ t: 0, v: Kf, ease: nr }] };
function fx(e) {
  return mb.some((t) => t === e);
}
function hx(e) {
  const t = lx.get(e) ?? e;
  return fx(t) ? t : "sphere";
}
function px(e) {
  return e != null && e.length === 4;
}
function mx({ t: e, v: t, ease: n }) {
  return { t: e, v: typeof t == "string" ? [] : t, ease: px(n) ? n : nr };
}
function gx(e) {
  return [
    { t: e, v: [0], ease: nr },
    { t: e + na * 0.45, v: [1], ease: nr },
    { t: e + na, v: [0], ease: nr },
  ];
}
function yx({ inspect: e }) {
  const t = e?.bias;
  return {
    bias:
      t !== void 0 && Number.isFinite(t)
        ? Math.min(1, Math.max(-1, t))
        : void 0,
    isFollowingTurn: e?.follow,
  };
}
function kx(e) {
  const t = new Map();
  for (const [i, a] of Object.entries(e.tracks)) {
    const c = ux.get(i);
    c !== void 0 && t.set(c, a);
  }
  const n = (i) => (t.get(i) ?? []).map(mx),
    r = n("lids"),
    o = [];
  let s = !1;
  for (const i of t.get("expression") ?? []) {
    if (i.v === "blink") {
      ((s = !0), r.push(...gx(i.t)));
      continue;
    }
    o.push({
      t: i.t,
      name: typeof i.v == "string" ? Mb(i.v) : "neutral",
      isThroughBlink: i.cut === !1,
    });
  }
  return (
    s && r.sort((i, a) => i.t - a.t),
    {
      duration: e.duration,
      body: hx(e.body ?? "sphere"),
      squashAnchor: e.squashAnchor ?? 0,
      restTime: e.workArea ? e.workArea.start : 0,
      inspect: yx(e),
      position: n("position"),
      rotation: n("rotation"),
      squash: n("squash"),
      zoom: n("zoom"),
      lids: r,
      expression: o,
    }
  );
}
function vt(e, t) {
  if (e.length === 0) return null;
  if (t <= e[0].t) return e[0].v;
  const n = e[e.length - 1];
  if (t >= n.t) return n.v;
  let r = 0;
  for (; r < e.length - 2 && e[r + 1].t <= t; ) r++;
  const o = e[r],
    s = e[r + 1],
    i = (t - o.t) / Math.max(s.t - o.t, 1e-9),
    a = Qa(i, o.ease);
  return o.v.map((c, u) => c + (s.v[u] - c) * a);
}
function ul(e) {
  const t = e.restTime,
    n = vt(e.rotation, t),
    r = vt(e.position, t),
    o = vt(e.squash, t),
    s = vt(e.zoom, t),
    i = vt(e.lids, t);
  let a = "neutral",
    c = !1;
  for (const u of e.expression)
    (c || ((a = u.name), (c = !0)), u.t <= t + 1e-9 && (a = u.name));
  return {
    rot: n ? [n[0], n[1], n[2]] : [0, 0, 0],
    pos: r ? [r[0], r[1]] : [0, 0],
    scl: o ? [o[0], o[1]] : [1, 1],
    zoom: s ? s[0] : $n,
    lids: i ? Math.min(1, Math.max(0, i[0])) : 0,
    expr: a,
    squashAnchor: e.squashAnchor,
  };
}
function ai(e, t) {
  return e + 360 * Math.round((t - e) / 360);
}
function ci(e, t) {
  return Math.abs(((((e - t) % 360) + 540) % 360) - 180);
}
function wx(e, t) {
  return (
    ci(e.rot[0], t.rot[0]) < 4 &&
    ci(e.rot[1], t.rot[1]) < 4 &&
    ci(e.rot[2], t.rot[2]) < 4 &&
    Math.abs(e.pos[0] - t.pos[0]) < 0.015 &&
    Math.abs(e.pos[1] - t.pos[1]) < 0.015 &&
    Math.abs(e.scl[0] - t.scl[0]) < 0.02 &&
    Math.abs(e.scl[1] - t.scl[1]) < 0.02 &&
    Math.abs(e.zoom - t.zoom) < 0.02 &&
    Math.abs(e.lids - t.lids) < 0.05
  );
}
function bx(e, t) {
  const n = (o, s) => [
      { t: 0, v: o, ease: dx },
      { t: ta, v: s, ease: nr },
    ],
    r = [
      ai(t.rot[0], e.rot[0]),
      ai(t.rot[1], e.rot[1]),
      ai(t.rot[2], e.rot[2]),
    ];
  return {
    ...Xf,
    duration: ta,
    squashAnchor: e.squashAnchor,
    position: n(e.pos, t.pos),
    rotation: n(e.rot, r),
    squash: n(e.scl, t.scl),
    zoom: n([e.zoom], [t.zoom]),
    lids: e.lids === 0 && t.lids === 0 ? [] : n([e.lids], [t.lids]),
  };
}
const xx = {
    left: { rot: [0, -20, 0], pos: [-0.1, 0] },
    right: { rot: [0, 20, 0], pos: [0.1, 0] },
    up: { rot: [-20, 0, 0], pos: [0, 0.1] },
    down: { rot: [20, 0, 0], pos: [0, -0.1] },
    center: { rot: [0, 0, 0], pos: [0, 0] },
  };
const vx = [0.42, 0, 0.58, 1];
const Sx = 0.5;
const Mx = 0.1;
const Tx = 10;
const Ex = 1e-4;
const Px = 0.5;
const Ax = 0.001;
const ll = "rest";
function ui(e) {
  return 360 * Math.round(e / 360);
}
function dl(e, t) {
  let n = "neutral";
  for (const r of e) {
    if (r.t > t + 1e-9) break;
    n = r.name;
  }
  return n;
}
function Yf(e = {}) {
  const t = Math.min(3, Math.max(0.2, e.zoomMul || 1)),
    n = Bb();
  let r = e.body ?? "sphere",
    o = e.body !== void 0,
    s = [];
  const i = To(1),
    a = cx();
  let c = null,
    u = Kf,
    l = [0, 0],
    d = [1, 1],
    f = 0,
    h = $n * t,
    p = { bias: -1, isFollowingTurn: !0 },
    g = null,
    m = {
      isHeld: !1,
      isAlways: e.isGazeAlways ?? !1,
      x: 0,
      y: 0,
      cx: 0,
      cy: 0,
      hold: 0,
    },
    y = cl,
    w = 0,
    S = !1,
    b = !0,
    v = !1,
    T = null,
    A = null,
    F = null,
    N = 0,
    R = 0,
    B = null,
    E = null,
    I = !1,
    _ = [];
  const O = () => {
      const $ = vt(y.position, w);
      l = $ ? [$[0], $[1]] : [0, 0];
      const q = vt(y.rotation, w);
      u = q ? [q[0], q[1], q[2]] : [0, 0, 0];
      const U = vt(y.squash, w);
      d = U ? [U[0], U[1]] : [1, 1];
      const P = vt(y.zoom, w);
      P && (h = Math.min(2.5, Math.max(0.25, P[0])) * t);
    },
    H = ($) => {
      if ((n.blinkAmount() ?? fe()) > 0) {
        E = $;
        return;
      }
      ($(), K());
    },
    L = ($, q) => {
      if (B == null)
        for (const U of y.expression) U.t <= $ || U.t > q || H(() => n.play(U));
    },
    j = ($) => {
      ((w = $),
        (g = null),
        (E = null),
        O(),
        n.seek(y.expression, $),
        B != null && n.seek([{ t: 0, name: B, isThroughBlink: !1 }], 0));
    },
    J = () => {
      const $ = vt(y.lids, w);
      return $ ? Math.min(1, Math.max(0, $[0])) : 0;
    },
    fe = () => (I ? 0 : J()),
    K = () => {
      !Tb(n.name) || n.isMorphing ? (I = !0) : I && J() === 0 && (I = !1);
    },
    te = () => ({
      rot: u,
      pos: l,
      scl: d,
      zoom: h / t,
      lids: fe(),
      expr: n.name,
      squashAnchor: f,
    }),
    Z = ($) => {
      ((S = !1),
        (y = $),
        (w = 0),
        (f = $.squashAnchor),
        $.body != null && !o && (r = $.body),
        (p = {
          bias: $.inspect.bias ?? p.bias,
          isFollowingTurn: $.inspect.isFollowingTurn ?? p.isFollowingTurn,
        }));
    },
    D = ($) => {
      if (
        ((A = null),
        Z($.clip),
        (T = { clip: $.clip, name: $.name }),
        (b = !0),
        !$.isPlaying)
      ) {
        (j(0), $.isRest && (m = { ...m, hold: 0 }));
        return;
      }
      ((S = !0),
        $.phase > 0 && j($.phase * $.clip.duration),
        n.release(),
        $.phase <= 0 && L(-1e-9, 0));
    },
    G = ($) => {
      const q = te(),
        U = ul($.clip);
      ((A = $),
        Z(bx(q, U)),
        (b = !1),
        (S = !0),
        B == null && q.expr !== U.expr && H(() => n.morph(U.expr)));
    },
    Y = () =>
      A != null || T == null || wx(te(), ul(T.clip))
        ? !1
        : (G({ ...T, isPlaying: !0, phase: 0, isRest: !1 }), !0),
    Q = ($) => {
      const q = w;
      let U = q + $;
      if (U >= y.duration)
        if ((L(q, y.duration), b)) {
          if (((R += 1), Y())) return;
          ((U = U - y.duration),
            U >= y.duration && (U = 0),
            L(-1e-9, U),
            (w = U));
        } else ((w = y.duration), (S = !1), A != null && D(A));
      else (L(q, U), (w = U));
      ((g = null), O());
    },
    ne = ($, q) => {
      const U = $ + (q - $) * Yb;
      return Math.abs(q - U) < Ax ? q : U;
    },
    se = () => {
      if (
        v ||
        (!m.isHeld && m.hold === 0) ||
        ((m = {
          ...m,
          cx: ne(m.cx, m.x),
          cy: ne(m.cy, m.y),
          hold: ne(m.hold, m.isHeld ? 1 : 0),
        }),
        S)
      )
        return;
      O();
      const $ = al(r, m.cx, m.cy),
        { hold: q } = m;
      ((u = [
        u[0] + ($.rx - u[0]) * q,
        u[1] + ($.ry - u[1]) * q,
        u[2] * (1 - q),
      ]),
        (l = [l[0] + ($.px - l[0]) * q, l[1] + ($.py - l[1]) * q]));
    },
    ee = ($) => {
      if (g == null) return;
      const q = g.t + $,
        U = Math.min(q / Sx, 1),
        P = Qa(U, vx),
        { fromRot: C, toRot: z, fromPos: W, toPos: V } = g;
      ((u = [
        C[0] + (z[0] - C[0]) * P,
        C[1] + (z[1] - C[1]) * P,
        C[2] + (z[2] - C[2]) * P,
      ]),
        (l = [W[0] + (V[0] - W[0]) * P, W[1] + (V[1] - W[1]) * P]),
        U >= 1 ? ((u = z), (l = V), (g = null)) : (g = { ...g, t: q }));
    },
    me = () => {
      if (s.length === 0) return [{ body: r, weight: 1 }];
      const $ = Qo(le(i.x, 0, 1)),
        q = new Map();
      for (const C of s)
        q.set(C.body, (q.get(C.body) ?? 0) + C.weight * (1 - $));
      q.set(r, (q.get(r) ?? 0) + $);
      const U = [...q].filter(([, C]) => C > Ex),
        P = U.reduce((C, [, z]) => C + z, 0);
      return U.map(([C, z]) => ({ body: C, weight: z / P }));
    },
    de = ($) => {
      $ !== r && ((s = me()), (r = $), (i.x = 0), (i.v = 0), (i.t = 1));
    },
    xe = ($) => {
      if (s.length === 0) return;
      const q = Bf($);
      for (let U = 0; U < q; U++) Eo(i, Tx, 1, $ / q);
      Math.abs(i.x - 1) < 0.001 &&
        Math.abs(i.v) < 0.01 &&
        ((i.x = 1), (i.v = 0), (s = []));
    },
    Pe = () => n.blinkAmount() ?? fe(),
    be = ($, q) => {
      const U = jb(n.eyes(), q, p, $),
        P = Pe();
      return P <= 1e-4 ? U : [rl(U[0], P), rl(U[1], P)];
    };
  return {
    get isPlaying() {
      return S;
    },
    get time() {
      return w;
    },
    get duration() {
      return y.duration;
    },
    get loopCount() {
      return R;
    },
    get face() {
      return n.name;
    },
    get isSettled() {
      const $ =
        v ||
        (m.hold === (m.isHeld ? 1 : 0) &&
          (!m.isHeld || (m.cx === m.x && m.cy === m.y)));
      return (
        !S &&
        _.length === 0 &&
        s.length === 0 &&
        g == null &&
        E == null &&
        !n.isMorphing &&
        n.blinkAmount() == null &&
        a.snapshot().isSettled &&
        $
      );
    },
    load(
      $,
      { isPlaying: q = !0, transition: U = "bridge", phase: P = 0 } = {},
    ) {
      const C = $.name || T?.name || "recipe",
        z = {
          clip: kx($),
          name: C,
          isPlaying: q,
          phase: le(P, 0, 1) % 1,
          isRest: !1,
        };
      U === "bridge" && T != null && (A != null || T.name !== C) ? G(z) : D(z);
    },
    play() {
      ((v = !1), (S = !0));
    },
    pause() {
      ((v = !0), (S = !1));
    },
    stop() {
      ((S = !1), j(0));
    },
    rest() {
      v = !1;
      const $ = { clip: cl, name: ll, isPlaying: !1, phase: 0, isRest: !0 };
      if (A == null && (T == null || T.name === ll)) {
        T == null && D($);
        return;
      }
      G($);
    },
    seek: j,
    setBody($, { isInstant: q = !1 } = {}) {
      if (((o = !0), !q)) {
        de($);
        return;
      }
      ((r = $), (s = []), (i.x = 1), (i.v = 0));
    },
    setMorph($, { isInstant: q = !1 } = {}) {
      (a.set($), q && a.settle());
    },
    setExpression($, { isThroughBlink: q = !1 } = {}) {
      H(() => {
        q && !Lr($) && !Lr(n.name) ? n.lidMorph($) : n.morph($);
      });
    },
    holdFace($) {
      $ !== B &&
        ((B = $),
        H(() => {
          const q =
            B ?? (A == null ? dl(y.expression, w) : dl(A.clip.expression, 0));
          q !== n.name && n.morph(q);
        }));
    },
    poke($, { turns: q = 1 } = {}) {
      _ = [..._, { poke: $, t: 0, turns: Math.max(1, Math.round(q)) }];
    },
    blink() {
      n.blink();
    },
    setInspect({ bias: $, isFollowingTurn: q }) {
      p = {
        bias: $ === void 0 ? p.bias : Math.min(1, Math.max(-1, $)),
        isFollowingTurn: q ?? p.isFollowingTurn,
      };
    },
    setGaze($) {
      if ($ == null) {
        m = { ...m, isHeld: !1 };
        return;
      }
      const q = le($[0] || 0, -1, 1),
        U = le($[1] || 0, -1, 1);
      m =
        m.hold === 0
          ? { ...m, isHeld: !0, x: q, y: U, cx: q, cy: U }
          : { ...m, isHeld: !0, x: q, y: U };
    },
    setGazeAlways($) {
      m = { ...m, isAlways: $ };
    },
    look($) {
      const q = xx[$];
      g = { t: 0, fromRot: u, toRot: q.rot, fromPos: l, toPos: q.pos };
    },
    setGlow($) {
      F = $;
    },
    advance($) {
      se();
      const q = Math.min($, Mx),
        U = 1 - a.snapshot().amount;
      if (
        (S && Q(q * U),
        ee(q),
        n.step(q),
        E != null && (n.blinkAmount() ?? fe()) === 0)
      ) {
        const C = E;
        ((E = null), C());
      }
      (K(),
        xe(q),
        (_ = _.map((C) => ({ ...C, t: C.t + q })).filter((C) => C.t < Uf(C))),
        a.advance(q));
      const P = a.snapshot();
      (P.amount > 0 || !P.isSettled
        ? (c ??= [ui(u[0]), ui(u[1]), ui(u[2])])
        : (c = null),
        (N += $));
    },
    frame() {
      const $ = m.isAlways && S && !v ? al(r, m.cx, m.cy) : null,
        q = Zb * m.hold,
        U = Xb(_),
        P = [
          u[0] + ($ ? $.rx * q : 0) + U.pitch,
          u[1] + ($ ? $.ry * q : 0) + U.yaw,
          u[2],
        ],
        C = [l[0] + ($ ? $.px * q : 0), l[1] + ($ ? $.py * q : 0) + U.lift],
        z = [d[0] * U.squash[0], d[1] * U.squash[1]],
        W = n.inspectWeight(),
        V = a.snapshot(),
        X = 1 - V.amount,
        ie = (V.spin % (2 * Math.PI)) / vn,
        he = c ?? [0, 0, 0],
        pe = (ue) => he[ue] + (P[ue] - he[ue]) * X,
        ge = pe(1);
      return {
        body: r,
        quat: lb(pe(0) * vn, (ge + ie) * vn, pe(2) * vn),
        zoom: h,
        offset: X === 1 ? C : [C[0] * X, C[1] * X],
        squash: X === 1 ? z : [1 + (z[0] - 1) * X, 1 + (z[1] - 1) * X],
        squashAnchor: f,
        eyes: V.amount >= Px ? null : be(ge, W),
        glow: F && { ...F, midT: 0.5 + 0.5 * Math.sin((N * 1e3) / 860) },
        inspectWeight: W,
        bodies: me(),
        morph: V.kind === null && V.isSettled ? null : V,
      };
    },
  };
}
function Nr(e) {
  const t = (n) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${t(e[0])}${t(e[1])}${t(e[2])}`;
}
function rc(e) {
  return e.inkPaint ?? Nr(e.ink);
}
function oc(e) {
  return e.spotPaint ?? Nr(e.spot);
}
const Ix = [
    {
      name: "Blocked_A",
      duration: 2.12,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 2.1 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0,
            v: [0, 0],
            ease: [
              0.7968976121829217, 0.023358873568246466, 0.25805236576790014,
              0.9399472349279558,
            ],
          },
          {
            t: 0.38639855209383034,
            v: [0.020362603567309623, 0.0321716960933944],
            ease: [
              0.7968976121829217, 0.023358873568246466, 0.25805236576790014,
              0.9399472349279558,
            ],
          },
          {
            t: 0.7460619029579755,
            v: [-0.13200621755876568, 0.04928491306786316],
            ease: [
              0.16206624605678288, 0.6573718201333453, 0.4776581771164943,
              0.9890940068909632,
            ],
          },
          {
            t: 0.8660990266653926,
            v: [-0.0027221809712659807, 0.05083886406795958],
            ease: [
              0.34720720728860055, -0.008777460320222181, 0.2695010548130348,
              1.02521711915982,
            ],
          },
          {
            t: 1.0493565888199954,
            v: [-0.12038936798795193, 0.04235181137057312],
            ease: [
              0.2773807176656155, 0.29281356631792965, 0.35341088328075676,
              1.0737667821535892,
            ],
          },
          {
            t: 1.2986659810851888,
            v: [-0.0027221809712659807, 0.05083886406795958],
            ease: [
              0.34720720728860055, -0.008777460320222181, 0.2695010548130348,
              1.02521711915982,
            ],
          },
          { t: 1.7569209127327317, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0,
            v: [0, 0, 0],
            ease: [
              0.8199958981940145, -0.1753438779653778, 0.35490544014951186,
              0.958837837092147,
            ],
          },
          {
            t: 0.38639855209383034,
            v: [6.596421550520286, 26.266588805679774, 6.122577979110701],
            ease: [
              0.8199958981940145, -0.1753438779653778, 0.35490544014951186,
              0.958837837092147,
            ],
          },
          {
            t: 0.7460619029579755,
            v: [4.03072349953808, -14.070821783965659, -8.088521350792867],
            ease: [
              0.16206624605678288, 0.6573718201333453, 0.4776581771164943,
              0.9890940068909632,
            ],
          },
          {
            t: 0.8660990266653926,
            v: [10.306252195330941, 13.969026095064219, 7.524804229298955],
            ease: [
              0.34720720728860055, -0.008777460320222181, 0.2695010548130348,
              1.02521711915982,
            ],
          },
          {
            t: 1.0493565888199954,
            v: [8.006914468651756, -9.270764174998455, -8.505309845875193],
            ease: [
              0.2773807176656155, 0.29281356631792965, 0.35341088328075676,
              1.0737667821535892,
            ],
          },
          {
            t: 1.2986659810851888,
            v: [10.306252195330941, 13.969026095064219, 7.524804229298955],
            ease: [
              0.34720720728860055, -0.008777460320222181, 0.2695010548130348,
              1.02521711915982,
            ],
          },
          { t: 1.7569209127327317, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        scale: [
          {
            t: 0,
            v: [0.6],
            ease: [0.42, 0, 0.06944264684998447, 0.9679740678629829],
          },
          {
            t: 0.38639855209383034,
            v: [0.6],
            ease: [0.42, 0, 0.06944264684998447, 0.9679740678629829],
          },
          {
            t: 1.1494959879909783,
            v: [0.5],
            ease: [
              0.7910272291113791, -0.026550296201944556, 0.19732842008291107, 1,
            ],
          },
          {
            t: 1.900275655021834,
            v: [0.6],
            ease: [0.42, 0, 0.06944264684998447, 0.9679740678629829],
          },
        ],
        expression: [
          { t: 0.46926065284592233, v: "confused", ease: [0.42, 0, 0.58, 1] },
          { t: 1.606008694397346, v: "neutral", ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
    {
      name: "Blocked_B",
      duration: 3,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 3 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 1.2593574149757256,
            v: [0.004259404064870088, -0.22320548763819217],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        rotation: [
          {
            t: 1.2593574149757256,
            v: [22.38040777312499, -0.11374925549943268, -1.3254543924838493],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0,
            v: "sad",
            ease: [
              0.8458217358299596, 0.40487753378378377, 0.13769926619433198,
              0.9154349662162162,
            ],
          },
        ],
      },
    },
    {
      name: "Blocked_C",
      duration: 1.4,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 1.3929879324776784 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0,
            v: [-0.10159994888361161, 0.0005766171900318479],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.6816231863839288,
            v: [0.06829453998737205, 0.0005766171900318479],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 1.3929879324776784,
            v: [-0.10159994888361161, 0.0005766171900318479],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        rotation: [
          {
            t: 0,
            v: [22.100629997955743, -15.657630964434397, -4.681428255949899],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.6816231863839288,
            v: [21.919069173693785, 11.388653232575262, 0.7382242020910257],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 1.3929879324776784,
            v: [22.100629997955743, -15.657630964434397, -4.681428255949899],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0,
            v: "sleepy",
            ease: [
              0.8458217358299596, 0.40487753378378377, 0.13769926619433198,
              0.9154349662162162,
            ],
          },
        ],
      },
    },
    {
      name: "Bodymoves_A",
      duration: 5,
      body: "clover",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          { t: 0, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 0.3316869300911854, v: [-0.1, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 0.6673157294832825, v: [-0.1, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 1, v: [0.1, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 1.3356762917933132, v: [0.1, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 1.654302811550152, v: [0, 0.1], ease: [0.42, 0, 0.58, 1] },
          { t: 2, v: [0, 0.1], ease: [0.42, 0, 0.58, 1] },
          { t: 2.329549772036474, v: [0, -0.1], ease: [0.42, 0, 0.58, 1] },
          { t: 2.667601683029453, v: [0, -0.1], ease: [0.42, 0, 0.58, 1] },
          { t: 2.9985974754558207, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          { t: 0, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 0.3316869300911854, v: [0, -20, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 0.6673157294832825, v: [0, -20, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 1, v: [0, 20, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 1.3356762917933132, v: [0, 20, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 1.654302811550152, v: [-20, 0, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 2, v: [-20, 0, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 2.329549772036474, v: [20, 0, 0], ease: [0.42, 0, 0.58, 1] },
          { t: 2.667601683029453, v: [20, 0, 0], ease: [0.42, 0, 0.58, 1] },
          {
            t: 2.9985974754558207,
            v: [0, 0, 0],
            ease: [0.7340521114106021, 0, 0.024581648697214575, 1],
          },
          { t: 4.546161721267454, v: [0, 360, 0], ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
    {
      name: "Done_A",
      duration: 3.7,
      body: "sphere",
      squashAnchor: -1,
      workArea: { start: 0.07228455190755256, end: 2.4415076840284984 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        expression: [
          {
            t: 0.5404427256792492,
            v: "happy",
            ease: [
              0.9601942054655871, -0.052470439189189255, 0.20804339574898786,
              0.9135346283783784,
            ],
          },
          {
            t: 1.1009640885188103,
            v: "neutral",
            ease: [
              0.9601942054655871, -0.052470439189189255, 0.20804339574898786,
              0.9135346283783784,
            ],
          },
        ],
        squash: [
          { t: 0.026170163234005256, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
          { t: 0.1712334301051709, v: [1.095, 0.95], ease: [0.42, 0, 0.58, 1] },
          { t: 0.2519479897020158, v: [1, 1.1], ease: [0.42, 0, 0.58, 1] },
          { t: 0.5890803023663453, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
          { t: 0.7128174264881666, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
          { t: 0.7669564766634516, v: [1.095, 0.95], ease: [0.42, 0, 0.58, 1] },
          {
            t: 0.9897759640666083,
            v: [1, 1.05],
            ease: [0.42, 0, 0.8951431517668547, 0.3407570422535186],
          },
          {
            t: 1.2017846598233752,
            v: [1, 1],
            ease: [0.31159929257512675, 0.38869681601739836, 0.58, 1],
          },
          {
            t: 1.2442602578454727,
            v: [1.02, 0.95],
            ease: [0.42, 0, 0, 0.9636255030181098],
          },
          {
            t: 1.3707862721816209,
            v: [1, 1.05],
            ease: [0.42, -0.06206202263065829, 0.58, 1],
          },
          {
            t: 1.5659785175305556,
            v: [1, 1.05],
            ease: [0.42, -0.06206202263065829, 0.58, 1],
          },
          { t: 1.7225242861726335, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          { t: 0.07894117002629274, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
          {
            t: 0.5890803023663453,
            v: [-30.114678799869385, -0.3481515921755908, 14.22102163595976],
            ease: [
              0.7300325174456456, -0.12405425024558042, 0.3365835061031919,
              0.8017889379937657,
            ],
          },
          {
            t: 1.1421861305872043,
            v: [-22.577941336944804, 6.412920843838687, -21.655639323327193],
            ease: [
              0.583298559499341, -0.33760664743211344, 0.32045494511798944,
              1.0963542960860653,
            ],
          },
          {
            t: 1.9672542725679227,
            v: [-2.0781042925060573, 2.7701174100260233, -1.1097245079483975],
            ease: [0.42, 0, 0.58, 1],
          },
          { t: 2.265132022348826, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        position: [
          {
            t: 0.21523060911481157,
            v: [0, 0],
            ease: [
              0.26223486988161915, 0.6947245975855132, 0.19480556164846297,
              0.9038661358145291,
            ],
          },
          {
            t: 0.4114390589896057,
            v: [4251034064187152e-20, 0.2658889947011273],
            ease: [
              0.6174717437059508, -0.1285535110701914, 0.9558063166458642,
              1.4558335539794296,
            ],
          },
          {
            t: 0.7733546480351897,
            v: [0, 0.0027633019963448496],
            ease: [
              0.09538195235865887, 0.5878716966122386, 0.07993556895591414,
              0.9424688534678969,
            ],
          },
          {
            t: 0.9897759640666083,
            v: [4251034064187152e-20, 0.2724621969461928],
            ease: [
              0.8363729761758775, -0.06230462217533443, 0.9982539187302559, 1.5,
            ],
          },
          {
            t: 1.2463303718735304,
            v: [0, 0.004098894994698572],
            ease: [
              0.0027852407545025976, 0.747585125427439, 0.2902850468489716,
              1.075893533235889,
            ],
          },
          {
            t: 1.4277545322137832,
            v: [4251034064187152e-20, 0.20927514060819213],
            ease: [
              0.6418193857854623, 0.06919682671194852, 0.999114846102708,
              1.0051682084254565,
            ],
          },
          {
            t: 1.6154571730378309,
            v: [0, -0.0012722231452485869],
            ease: [
              0.1439324608778934, 0.5569463954729904, 0.40675790714828725,
              0.8986649812795062,
            ],
          },
          {
            t: 1.6919913573024103,
            v: [4251034064187152e-20, 0.12826705419287673],
            ease: [
              0.7357127354801332, -0.23608339420075217, 0.998983119560359,
              1.0241908800770656,
            ],
          },
          {
            t: 1.838861098534871,
            v: [0, -0.00406003797139351],
            ease: [
              0.16778668894268609, 0.5982980173372091, 0.2604597520439014,
              0.8844972998628613,
            ],
          },
          {
            t: 1.8667112801287638,
            v: [4251034064187152e-20, 0.07903432452816228],
            ease: [
              0.4685028760838894, -0.42953625372100485, 0.9202731953835559,
              0.8525061773543536,
            ],
          },
          {
            t: 1.9472873681398353,
            v: [0, -0.006228275916527491],
            ease: [
              0.0027852407545025976, 1.5, 0.48865476645304945,
              0.9551260679225434,
            ],
          },
        ],
      },
    },
    {
      name: "Done_B",
      duration: 1.8,
      body: "sphere",
      squashAnchor: -1,
      workArea: null,
      inspect: { bias: -1, follow: !1 },
      tracks: {
        expression: [{ t: 0.1, v: "happy", ease: [0.4, 0.22, 0.28, 1.34] }],
        squash: [
          { t: 0, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
          { t: 0.24, v: [1.12, 0.88], ease: [0.42, 0, 0.58, 1] },
          { t: 0.46, v: [0.93, 1.09], ease: [0.42, 0, 0.58, 1] },
          { t: 0.68, v: [1.04, 0.97], ease: [0.42, 0, 0.58, 1] },
          { t: 0.92, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
    {
      name: "Done_C",
      duration: 2,
      body: "sphere",
      squashAnchor: -1,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        expression: [
          {
            t: 0,
            v: "happy",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 1.1902334624750293,
            v: "neutral",
            ease: [
              0.8458217358299596, 0.40487753378378377, 0.13769926619433198,
              0.9154349662162162,
            ],
          },
        ],
        position: [
          {
            t: 0,
            v: [0, 0],
            ease: [0.42, 0, 0.4073342890672376, 1.018190339792799],
          },
          {
            t: 0.3798103165938864,
            v: [-0.1054748164006256, 0.1247799599228919],
            ease: [
              0.6446428602987402, 0.013555142906648983, 0.26273657853993304,
              1.0464437149441994,
            ],
          },
          {
            t: 0.9426716022659842,
            v: [0.10617803719053583, 0.1550632852223643],
            ease: [
              0.8992655949641883, 0.06226468791954258, 0.6897429932929974,
              1.0606800225733635,
            ],
          },
          {
            t: 1.3822867688368345,
            v: [0.011140244111415301, -0.17250079856992764],
            ease: [
              0.5369766709678977, 0.09639530999237222, 0.4242841447981972,
              0.8655803895199093,
            ],
          },
          {
            t: 1.5768176200981194,
            v: [0.009657934584899294, 0.02418870866616249],
            ease: [0.10285717371228631, 0.44298137016142797, 0.58, 1],
          },
          {
            t: 1.7545755610844578,
            v: [0.005569779366063913, -0.08650009457623184],
            ease: [0.11393164333435832, 0.20842906107559217, 0.58, 1],
          },
          { t: 1.9557554786340765, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0,
            v: [0, 0, 0],
            ease: [
              0.7521899922111783, 0, 0.29680419697434735, 1.2284132127170915,
            ],
          },
          {
            t: 0.3798103165938864,
            v: [-31.25365067481446, -5.533499139447874, 13.746823539571478],
            ease: [
              0.6650959278914218, 0.08187947429053509, 0.027403916739799694,
              1.175374728587553,
            ],
          },
          {
            t: 0.9426716022659842,
            v: [-30.6162399609899, 14.144576441037861, -12.73974221895198],
            ease: [
              0.8992655949641883, 0.06226468791954258, 0.6897429932929974,
              1.0606800225733635,
            ],
          },
          {
            t: 1.3972576410224693,
            v: [19.356472882732792, 0.12303000388944017, -1.6697872707546177],
            ease: [
              0.5369766709678977, 0.09639530999237222, 0.4242841447981972,
              0.8655803895199093,
            ],
          },
          {
            t: 1.5873362914457065,
            v: [-4.965245810760847, -1.410803032494741, -0.08557034006007683],
            ease: [0.10285717371228631, 0.44298137016142797, 0.58, 1],
          },
          {
            t: 1.7574889536920633,
            v: [12.945220298267941, -0.9549298574076148, -1.3541756721371099],
            ease: [0.11393164333435832, 0.20842906107559217, 0.58, 1],
          },
          {
            t: 1.9557554786340765,
            v: [0, 0, 0],
            ease: [
              0.7521899922111783, 0, 0.29680419697434735, 1.2284132127170915,
            ],
          },
        ],
      },
    },
    {
      name: "Idle_A",
      duration: 6,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.4874467656537753,
            v: [0, 0],
            ease: [
              0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1,
            ],
          },
          {
            t: 1.3832000000000173,
            v: [-0.14647919001828796, 0.027266090496135924],
            ease: [
              0.5825263567433967, 0.31017058172003364, 0.04617913732408452,
              1.3610608114532912,
            ],
          },
          {
            t: 1.77965296961326,
            v: [-0.14647919001828796, 0.027266090496135924],
            ease: [
              0.22005965712189499, 0.31017058172003364, 0.04617913732408452,
              0.9652306378531971,
            ],
          },
          {
            t: 2.75,
            v: [-0.0745899946905787, -0.16596550351011732],
            ease: [
              0.7924378812353865, 0.08203268815009183, 0.20257664629337524,
              0.5708768022766131,
            ],
          },
          {
            t: 2.9261481353591154,
            v: [-0.0745899946905787, -0.16596550351011732],
            ease: [
              0.9024115240536277, 0.09528443113772456, 0.31187154968454267,
              0.9286115269461079,
            ],
          },
          {
            t: 4.0795674814720835,
            v: [0, 0],
            ease: [
              0.8772841365461845, 0.09396460316883949, 0, 0.9378491736838274,
            ],
          },
          { t: 5.754212106241882, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0.4874467656537753,
            v: [0, 0, 0],
            ease: [
              0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1,
            ],
          },
          {
            t: 1.3832000000000173,
            v: [-16.083597442672094, -32.69316873461356, -11.038560548848148],
            ease: [
              0.5825263567433967, 0.31017058172003364, 0.04617913732408452,
              1.3610608114532912,
            ],
          },
          {
            t: 1.77965296961326,
            v: [-13.471262391203387, -31.664036845872012, -11.622988481798327],
            ease: [
              0.22005965712189499, 0.31017058172003364, 0.04617913732408452,
              0.9652306378531971,
            ],
          },
          {
            t: 2.75,
            v: [10.37381753258554, 13.583422586232203, 10.666197221172675],
            ease: [
              0.7924378812353865, 0.08203268815009183, 0.20257664629337524,
              0.5708768022766131,
            ],
          },
          {
            t: 2.9261481353591154,
            v: [22.819835891847944, 5.292311893891789, 5.163005094237094],
            ease: [1, -0.5, 0.4051656151419559, 0.8872272583365959],
          },
          {
            t: 4.0795674814720835,
            v: [-24.875244874578584, 31.812786832669843, 15.07444269105954],
            ease: [
              0.8772841365461845, 0.09396460316883949, 0, 0.9378491736838274,
            ],
          },
          {
            t: 5.754212106241882,
            v: [0, 360, 0],
            ease: [
              0.9122920380277829, 0.038550560528246756, 0.4251612081579069,
              0.8172019143128422,
            ],
          },
        ],
        expression: [
          { t: 1.1628970994475138, v: "blink", ease: [0.42, 0, 0.58, 1] },
          { t: 4.00439785911593, v: "blink", ease: [0.42, 0, 0.58, 1] },
          { t: 5.643314779005485, v: "neutral", ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
    {
      name: "Idle_B",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          { t: 1.6054821209465213, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0.9010370289220491,
            v: [0, 0, 0],
            ease: [0.42, 0, 0.28927730966925536, 0.9624241226685105],
          },
          {
            t: 1.6163686240140267,
            v: [0.12032076750937498, -8.658512604326788, -2.5426418939710658],
            ease: [
              0.8747812559101849, -0.03625853912624016, 0.25467036702156304,
              0.8980229024542974,
            ],
          },
          {
            t: 2.4902049517966525,
            v: [0.9659548057072269, 5.658900089349377, 1.7129240357574211],
            ease: [
              0.6027205111294465, -0.23084976154500042, 0.2902495275740431,
              0.9815467952425966,
            ],
          },
          { t: 3.45704978089402, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        scale: [
          {
            t: 0,
            v: [0.6],
            ease: [
              0.6180446538332104, 0.0012432525890504465, 0.1839130507609582,
              0.9358696746423821,
            ],
          },
          {
            t: 1.6054821209465213,
            v: [0.64],
            ease: [
              0.8658706538170823, -0.07995460153625837, 0.29979142380351903,
              1.0195121615474219,
            ],
          },
          {
            t: 3.841942375109553,
            v: [0.6],
            ease: [
              0.6180446538332104, 0.0012432525890504465, 0.1839130507609582,
              0.9405530305724485,
            ],
          },
        ],
        expression: [
          { t: 1.4811034202342213, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
          { t: 3.45704978089402, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        ],
      },
    },
    {
      name: "Idle_D",
      duration: 6,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.6511065418455951, 0, 0.3268385117846959, 1],
          },
          {
            t: 0.5867355510752692,
            v: [-34.32339609164593, 16.86196736106905, 15.137354734738835],
            ease: [0.5996715199956071, 0, 0.24671113951908907, 1],
          },
          {
            t: 1.0783308131720428,
            v: [-34.32339609164593, 16.86196736106905, 15.137354734738835],
            ease: [0.5996715199956071, 0, 0.10657397408207336, 1],
          },
          {
            t: 1.962638608870968,
            v: [-6.1682538522357975, 3.098853229789992, 14.349419848128031],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 2.671748991935484,
            v: [-6.1682538522357975, 3.098853229789992, 14.349419848128031],
            ease: [0.42, 0, 0.2029056425485961, 1],
          },
          {
            t: 3.914377520161291,
            v: [7.572938650100637, 40.386943374478015, 25.47389006919084],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 4.785706485215049,
            v: [7.572938650100637, 40.386943374478015, 25.47389006919084],
            ease: [0.6315554130669547, 0, 0.21641299946004333, 1],
          },
          {
            t: 5.632732694892469,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.6511065418455951, 0, 0.3268385117846959, 1],
          },
        ],
        expression: [
          { t: 0.5929099462365591, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
          { t: 2.0691383064517033, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
          { t: 2.3722908266129035, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
          { t: 4.247479838709677, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        ],
      },
    },
    {
      name: "Logo_A",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 2.0002578769692425 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.940308570092613, 0, 0.8322175812019608, 0.42841310531523513,
            ],
          },
          {
            t: 0.9325431465191484,
            v: [-15.896271043294888, 290.3612956381275, 25.38480127460161],
            ease: [
              0.08370250411471428, 0.7821860109261747, 0.1762354651162792, 1,
            ],
          },
          {
            t: 1.9567938859714928,
            v: [-15.896271043294888, 393.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
      },
    },
    {
      name: "Logo_B",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 3.1220695798949736 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.77323790487339, 0, 0.19818347223390587, 0.9476806070764106,
            ],
          },
          {
            t: 0.7185100111661579,
            v: [-11.287778634690255, -33.00231519019303, -21.062449423926747],
            ease: [
              0.2717748154604947, -0.2636988609351958, 0.6005198984279181,
              0.023491972600300434,
            ],
          },
          {
            t: 1.141527569392348,
            v: [-11.399396607755296, -31.39663474186699, -19.937494120163255],
            ease: [
              0.9137669521901326, 0.04016940837145343, 0.8322175812019608,
              0.42841310531523513,
            ],
          },
          {
            t: 2.074070715911496,
            v: [-15.896271043294888, 290.3612956381275, 25.38480127460161],
            ease: [
              0.08370250411471428, 0.7821860109261747, 0.1762354651162792, 1,
            ],
          },
          {
            t: 3.0983214553638407,
            v: [-15.896271043294888, 393.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
      },
    },
    {
      name: "Marketing_A",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.6167064755838638,
            v: [0, 0],
            ease: [0.5771393784786643, 0, 0.41654104823747684, 1],
          },
          {
            t: 1.4190773177636233,
            v: [-0.16387514369529332, 0],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 2.2684226822363764,
            v: [-0.16387514369529332, 0.05904395257747427],
            ease: [0.580719503710575, 0, 0, 1],
          },
          {
            t: 3.1610281808035716,
            v: [0, 0],
            ease: [0.5771393784786643, 0, 0.41654104823747684, 1],
          },
        ],
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.6167064755838638,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.8625910776088882, -0.041613616273912, 0.25952275632662025,
              1.049784301761229,
            ],
          },
          {
            t: 1.4190773177636233,
            v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
            ease: [
              0.7818125791576046, 0.15346315752484826, 0.32687664998404986,
              1.1173618829561318,
            ],
          },
          {
            t: 2.2684226822363764,
            v: [-31.58476211869586, -3.710798107118315, 24.071416454447956],
            ease: [
              0.36229770668640776, -0.17418027527991467, 0.2875659277885649,
              1.2452842602722636,
            ],
          },
          {
            t: 2.7962446921443735,
            v: [-27.874087487241205, 0.739249290532289, 5.007074162025872],
            ease: [0.42, 0.044881803684311196, 0.58, 1],
          },
          {
            t: 3.2725893489030398,
            v: [-19.255583925594408, -17.414119894980235, -7.023063437300964],
            ease: [
              0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1,
            ],
          },
          {
            t: 3.8435756138392856,
            v: [-19.353875077555468, 20.03044512007725, 19.013275491556097],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 3.9805733816964284,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0.05960518973214285,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 2.2434315286624202,
            v: "surprised",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Marketing_B",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.6167064755838638,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.8625910776088882, -0.041613616273912, 0.25952275632662025,
              1.049784301761229,
            ],
          },
          {
            t: 1.4190773177636233,
            v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
            ease: [
              0.7818125791576046, 0.15346315752484826, 0.32687664998404986,
              1.1173618829561318,
            ],
          },
          {
            t: 2.2684226822363764,
            v: [20.16565207199379, -20.644446669166673, 22.47273384376682],
            ease: [
              0.36229770668640776, -0.17418027527991467, 0.2875659277885649,
              1.2452842602722636,
            ],
          },
          {
            t: 3.2725893489030398,
            v: [-20.98869306129836, -21.248460672675545, -6.20573622722674],
            ease: [
              0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1,
            ],
          },
          {
            t: 4,
            v: [-23.757982259034762, 24.83627384870201, 18.82083960330674],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 1.4471868365180467,
            v: "calm",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Marketing_C",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.6167064755838638,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.8625910776088882, -0.041613616273912, 0.25952275632662025,
              1.049784301761229,
            ],
          },
          {
            t: 1.4190773177636233,
            v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
            ease: [
              0.7818125791576046, 0.15346315752484826, 0.32687664998404986,
              1.1173618829561318,
            ],
          },
          {
            t: 2.2684226822363764,
            v: [20.16565207199379, -20.644446669166673, 22.47273384376682],
            ease: [
              0.36229770668640776, -0.17418027527991467, 0.2875659277885649,
              1.2452842602722636,
            ],
          },
          {
            t: 3.2725893489030398,
            v: [-20.98869306129836, -21.248460672675545, -6.20573622722674],
            ease: [
              0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1,
            ],
          },
          {
            t: 4,
            v: [-23.757982259034762, 24.83627384870201, 18.82083960330674],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 1.4471868365180467,
            v: "calm",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Marketing_D",
      duration: 4,
      body: "sphere",
      squashAnchor: -1,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        expression: [
          {
            t: 0.05498053786270347,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 0.7522248761500355,
            v: "happy",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 3.188380537862626,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
        squash: [
          { t: 0.6800000000000002, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
          { t: 0.9199999999999999, v: [1.12, 0.88], ease: [0.42, 0, 0.58, 1] },
          { t: 1.1400000000000001, v: [0.93, 1.09], ease: [0.42, 0, 0.58, 1] },
          { t: 1.3600000000000003, v: [1.04, 0.97], ease: [0.42, 0, 0.58, 1] },
          { t: 1.6, v: [1, 1], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0,
            v: [-6.345525006325851, 19.726304895345887, 7.225894380877916],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.68,
            v: [-6.345525006325851, 19.726304895345887, 7.225894380877916],
            ease: [0.6287715517241379, 0, 0.1652870297805643, 1],
          },
          {
            t: 1.80886178343963,
            v: [7.946317173704124, -27.372379409841862, -13.611633161590936],
            ease: [0.5888217507250163, 0, 0, 1],
          },
          { t: 3.406449044585987, v: [0, 0, 0], ease: [0.42, 0, 0.58, 1] },
          {
            t: 3.887429228591649,
            v: [-6.345525006325851, 19.726304895345887, 7.225894380877916],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
      },
    },
    {
      name: "Rotation_A",
      duration: 6,
      body: "cloud",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [2.3120950657104795, -34.698071961330996, 6.287220573778937],
            ease: [0.001, 0.001, 0.999, 0.999],
          },
          {
            t: 3.0420576880625374,
            v: [-15.896271043294888, 393.29315635042974, 25.38480127460161],
            ease: [0.001, 0.001, 0.999, 0.999],
          },
          {
            t: 5.685518927730484,
            v: [-26.2, 719.4, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
      },
    },
    {
      name: "Rotation_B",
      duration: 10,
      body: "cloud",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-5.86170199829258, -66.48579621643268, 11.013855401509232],
            ease: [0.001, 0.001, 0.999, 0.999],
          },
          {
            t: 10,
            v: [-5.86170199829258, 293.5142037835673, 11.013855401509232],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
      },
    },
    {
      name: "Rotation_C",
      duration: 4,
      body: "cloud",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [{ t: 0, v: [0, 0], ease: [0.42, 0, 0.58, 1] }],
        rotation: [
          { t: 0, v: [-35, -28.5, 8.9], ease: [0.001, 0.001, 0.999, 0.999] },
          {
            t: 3.954889112903226,
            v: [30.3, -25.03032384031022, 25.838583124958074],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          { t: 2.02137936827957, v: "blink", ease: [0.4, 0.22, 0.28, 1.34] },
        ],
      },
    },
    {
      name: "Streaming_A",
      duration: 2.6,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 2.593141413751879 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        rotation: [
          {
            t: 0,
            v: [-17.330877831673277, 2.263279637703984, 15.443629275983977],
            ease: [
              0.7300325174456456, -0.12405425024558042, 0.40585908939755444,
              1.0050376870076922,
            ],
          },
          {
            t: 0.3458182816671912,
            v: [9.638628832336948, 2.025895269795649, -1.2527648183630171],
            ease: [
              0.4224707625763918, 0.0022972310598335997, 0.58,
              0.9927354054381194,
            ],
          },
          {
            t: 0.5813687143348092,
            v: [-15.366003917619995, -2.619836674995623, -2.16549892253304],
            ease: [
              0.7322498965237162, -0.011667049678267111, 0, 0.9141484219009502,
            ],
          },
          {
            t: 0.8343818658890081,
            v: [4.338039365692767, 0.49348825557993187, -3.7087410402723067],
            ease: [
              0.1580317356155577, -0.07611268668891613, 0.32045494511798944,
              1.0963542960860653,
            ],
          },
          {
            t: 1.2183655201918815,
            v: [-0.2793440526930908, 0, 0],
            ease: [
              0.7202644919359068, 0, 0.414580660247694, 0.9498001208025284,
            ],
          },
          {
            t: 1.6185917357603328,
            v: [-5.399115822872089, 14.530502605079048, 3.1285787766973128],
            ease: [
              0.603730806420981, -0.0304892240026259, 0.2700959962528573,
              0.9305186654092706,
            ],
          },
          {
            t: 2.0602042690217752,
            v: [-2.088336039091766, -10.814208972017363, -20.009405175503947],
            ease: [
              0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1,
            ],
          },
          {
            t: 2.593141413751879,
            v: [-17.330877831673277, 2.263279637703984, 15.443629275983977],
            ease: [
              0.7300325174456456, -0.12405425024558042, 0.40585908939755444,
              1.0050376870076922,
            ],
          },
        ],
        position: [
          { t: 0.008051106963364502, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
          {
            t: 0.34800758255567965,
            v: [0, -0.09893530004977505],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.5873549334090005,
            v: [0, 0.04654750224419043],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.8343818658890081,
            v: [0, 0.004683687521738383],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 1.2183655201918815,
            v: [0, 0],
            ease: [0.42, 0, 0.27743996350027533, 0.9367983894536062],
          },
          {
            t: 1.6185917357603328,
            v: [0.12655004394233813, 0],
            ease: [
              0.603730806420981, -0.0304892240026259, 0.2700959962528573,
              0.9282552090918559,
            ],
          },
          {
            t: 2.0602042690217752,
            v: [-0.1362091399555723, 0],
            ease: [
              0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1,
            ],
          },
          { t: 2.593141413751879, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
    {
      name: "Streaming_B",
      duration: 2.6,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 2.593141413751879 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        expression: [
          {
            t: 0.8343818658890081,
            v: "surprised",
            ease: [
              0.8458217358299596, 0.40487753378378377, 0.13769926619433198,
              0.9154349662162162,
            ],
            cut: !0,
          },
          {
            t: 2.1679160926807017,
            v: "neutral",
            ease: [
              0.8458217358299596, 0.40487753378378377, 0.13769926619433198,
              0.9154349662162162,
            ],
            cut: !0,
          },
        ],
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.7300325174456456, -0.12405425024558042, 0.40585908939755444,
              1.0050376870076922,
            ],
          },
          {
            t: 0.3458182816671912,
            v: [9.638628832336948, 2.025895269795649, -1.2527648183630171],
            ease: [
              0.4224707625763918, 0.0022972310598335997, 0.58,
              0.9927354054381194,
            ],
          },
          {
            t: 0.8343818658890081,
            v: [-13.158704916519811, -16.90797681471658, -2.914418472822627],
            ease: [
              0.1580317356155577, -0.07611268668891613, 0.32045494511798944,
              1.0963542960860653,
            ],
          },
          {
            t: 1.2183655201918815,
            v: [3.3337098816649693, 21.543227556484112, 4.461698658684633],
            ease: [
              0.7202644919359068, 0, 0.414580660247694, 0.9498001208025284,
            ],
          },
          {
            t: 1.6185917357603328,
            v: [-5.399115822872089, 14.530502605079048, 3.1285787766973128],
            ease: [
              0.603730806420981, -0.0304892240026259, 0.2700959962528573,
              0.9305186654092706,
            ],
          },
          {
            t: 2.0602042690217752,
            v: [-2.088336039091766, -10.814208972017363, -20.009405175503947],
            ease: [
              0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1,
            ],
          },
          {
            t: 2.593141413751879,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.7300325174456456, -0.12405425024558042, 0.40585908939755444,
              1.0050376870076922,
            ],
          },
        ],
        position: [
          { t: 0.008051106963364502, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
          {
            t: 0.34800758255567965,
            v: [0, -0.09893530004977505],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.8343818658890081,
            v: [0, 0.004683687521738383],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 1.36568364300849,
            v: [0.12655004394233813, 0],
            ease: [
              0.603730806420981, -0.0304892240026259, 0.2700959962528573,
              0.9282552090918559,
            ],
          },
          {
            t: 2.0602042690217752,
            v: [-0.1362091399555723, 0],
            ease: [
              0.48373539910046165, -0.09542268080702558, 0.26548699703136136, 1,
            ],
          },
          { t: 2.593141413751879, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
    {
      name: "Streaming_C",
      duration: 2.4,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        expression: [
          {
            t: 0.0930430477108114,
            v: "squinted",
            ease: [
              0.9601942054655871, -0.052470439189189255, 0.20804339574898786,
              0.9135346283783784,
            ],
          },
        ],
        rotation: [
          {
            t: 0.007536501544973762,
            v: [-30.114678799869385, -0.3481515921755908, 10.657733527966457],
            ease: [
              0.8069695446331039, 0.06068366162676136, 0.22176992691461772,
              1.0529567094556063,
            ],
          },
          {
            t: 0.6967011702649526,
            v: [-25.983934007381276, 7.767555485689494, -17.97884031792412],
            ease: [
              0.6337438554404256, 0.03915919163464518, 0.24060607252134747,
              0.9552013782917067,
            ],
          },
          {
            t: 1.3,
            v: [-27.316297934452344, -1.3907007432867593, 11.301625700367927],
            ease: [
              0.8069695446331039, 0.06068366162676136, 0.05967881944444445,
              0.9976179673321233,
            ],
          },
          {
            t: 2.3830582002457,
            v: [-30.114678799869385, 359.6518484078244, 10.657733527966457],
            ease: [0.545887017284529, -0.16488185903681707, 0.58, 1],
          },
        ],
        position: [
          {
            t: 0.007536501544973762,
            v: [0, 0],
            ease: [
              0.8069695446331039, 0.06068366162676136, 0.22176992691461772,
              1.0529567094556063,
            ],
          },
          {
            t: 0.6967011702649526,
            v: [0.16304040871678732, 0.1060830475460072],
            ease: [
              0.6337438554404256, 0.03915919163464518, 0.24060607252134747,
              0.9552013782917067,
            ],
          },
          {
            t: 1.3,
            v: [-0.16109273893088566, 0.1112767252235085],
            ease: [
              0.8069695446331039, 0.06068366162676136, 0.05967881944444445,
              0.9976179673321233,
            ],
          },
          {
            t: 2.3830582002457,
            v: [0, 0],
            ease: [
              0.7622975213794354, -0.39274360300976613, 0.22176992691461772,
              1.0529567094556063,
            ],
          },
        ],
      },
    },
    {
      name: "Working_A",
      duration: 8,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.4874467656537753,
            v: [0, 0],
            ease: [
              0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1,
            ],
          },
          {
            t: 1.3832000000000173,
            v: [-0.14647919001828796, 0.027266090496135924],
            ease: [
              0.5825263567433967, 0.31017058172003364, 0.04617913732408452,
              1.3610608114532912,
            ],
          },
          {
            t: 1.77965296961326,
            v: [-0.14647919001828796, 0.027266090496135924],
            ease: [
              0.22005965712189499, 0.31017058172003364, 0.04617913732408452,
              0.9652306378531971,
            ],
          },
          {
            t: 2.5961328343722427,
            v: [0.06209379465135341, 0.0363636826260471],
            ease: [
              0.6823010997778416, 0.03975119923438924, 0.58, 0.7462988396745895,
            ],
          },
          {
            t: 3.066377943544433,
            v: [-0.016487420591570615, 0.0804209848791122],
            ease: [
              0.8034080182827295, -0.08276325518488785, 0.6510110561346553,
              0.8128258749805829,
            ],
          },
          {
            t: 3.426085780646072,
            v: [-0.008916270094194876, -0.2135819760518346],
            ease: [
              0.1744021985074266, -0.5, 0.8865519014643501, -0.2214168917492133,
            ],
          },
          {
            t: 4.00439785911593,
            v: [-0.0052248049102180776, -0.12515593913381462],
            ease: [
              0.023812816055625345, 0.31341394515796384, 0.0448947139696587,
              1.0658309377957906,
            ],
          },
          { t: 5.005029942257856, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
          {
            t: 6.298778790534628,
            v: [0.03813914798218992, -0.019258402700427682],
            ease: [
              0.576933472628317, 0.007827540903749368, 0.12610215878412523,
              0.9598864308897559,
            ],
          },
          {
            t: 6.952426906222622,
            v: [-0.25, -0.004137934943726919],
            ease: [
              0.8326089284460128, -0.06392110845094923, 0.3654460022570882,
              1.0352901568389925,
            ],
          },
          {
            t: 7.900964066608238,
            v: [0, 0],
            ease: [
              0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1,
            ],
          },
        ],
        rotation: [
          {
            t: 0.4874467656537753,
            v: [0, 0, 0],
            ease: [
              0.39919726822734797, -0.1380913825536936, 0.15951040179591214, 1,
            ],
          },
          {
            t: 1.3832000000000173,
            v: [-11.013174031248813, -20.059833580125414, -12.896783267756348],
            ease: [
              0.5825263567433967, 0.31017058172003364, 0.04617913732408452,
              1.3610608114532912,
            ],
          },
          {
            t: 1.77965296961326,
            v: [-17.48975478197329, -18.703976724880516, -12.678205332257816],
            ease: [
              0.22005965712189499, 0.31017058172003364, 0.04617913732408452,
              0.9652306378531971,
            ],
          },
          {
            t: 2.5961328343722427,
            v: [-14.554913391638532, 17.164836260093473, 9.376528927180779],
            ease: [
              0.6823010997778416, 0.03975119923438924, 0.58, 0.9240336563778733,
            ],
          },
          {
            t: 3.1796016343940767,
            v: [-24.586251970533304, 0.14133926125606477, -0.7477216271856462],
            ease: [
              0.8034080182827295, -0.08276325518488785, 0.9143306014396848,
              0.4851034680582119,
            ],
          },
          {
            t: 3.4679142027965795,
            v: [-1.0943281912285556, -1.1346215368163393, -0.7116952620126241],
            ease: [
              0.12040927423864656, -0.18872517040581954, 0.9481776569383256,
              -0.20917925086224787,
            ],
          },
          {
            t: 4.001861402631413,
            v: [-147.11069531984157, -0.6757806869448113, -0.4238857605398247],
            ease: [
              0.03131913716814155, 0.8644907690193963, 0.0448947139696587,
              1.0658309377957906,
            ],
          },
          {
            t: 5.005029942257856,
            v: [-360, 0, 0],
            ease: [
              0.7970933306500759, -0.5, 0.24118105710043447, 0.7361553789450831,
            ],
          },
          {
            t: 6.298778790534628,
            v: [-364.89323527138873, 18.626179650675688, -0.2598233988596897],
            ease: [
              0.576933472628317, 0.007827540903749368, 0.12610215878412523,
              0.9742744867440337,
            ],
          },
          {
            t: 6.952426906222622,
            v: [-366.80423922162356, -23.365336474310464, -3.339162411443921],
            ease: [
              0.8326089284460128, -0.06392110845094923, 0.3654460022570882,
              1.0352901568389925,
            ],
          },
          { t: 7.900964066608238, v: [-360, 0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        expression: [
          { t: 1.1672000000000002, v: "blink", ease: [0.42, 0, 0.58, 1] },
          {
            t: 1.77965296961326,
            v: "surprised",
            ease: [
              0.7394673582995951, 0.10409628378378377, 0.6676682692307693, 1.5,
            ],
          },
          { t: 5.643314779005485, v: "neutral", ease: [0.42, 0, 0.58, 1] },
          {
            t: 6.298778790534628,
            v: "strange",
            ease: [
              0.9601942054655871, -0.052470439189189255, 0.20804339574898786,
              0.9135346283783784,
            ],
          },
          {
            t: 7.3115338882283,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Working_B",
      duration: 4.8,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 4.8 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.17746730083234244,
            v: [0, 0],
            ease: [
              0.807066718478605, 0.026672824415491948, 0.05397305674842967,
              1.0519668384455731,
            ],
          },
          {
            t: 1.4141067024830507,
            v: [-0.1, -14911040730998862e-21],
            ease: [
              0.7054694160272805, 0.15290809768637542, 0, 0.9011176996605331,
            ],
          },
          {
            t: 2.75,
            v: [0.1, -0.0019533463357608513],
            ease: [
              0.8240202817829232, -0.24792725943516045, 0.2993925437700369, 1,
            ],
          },
          {
            t: 4.7824019024970275,
            v: [0, 0],
            ease: [0.42, 0, 0.07071724310528026, 1.3032158407916754],
          },
        ],
        rotation: [
          {
            t: 0.17746730083234244,
            v: [0, 0, 0],
            ease: [
              0.807066718478605, 0.026672824415491948, 0.05397305674842967,
              1.0519668384455731,
            ],
          },
          {
            t: 1.4141067024830507,
            v: [1.431495026310406, -16.140319998213133, -36.05175434586088],
            ease: [
              0.7054694160272805, 0.15290809768637542, 0, 0.9507801322055007,
            ],
          },
          {
            t: 2.75,
            v: [-3.793664340840882, 16.145026960161896, 23.111555762366347],
            ease: [
              0.8145184258410576, 0.05868417745499387, 0.7187386211123404,
              0.8220737938312388,
            ],
          },
          {
            t: 3.300369915174868,
            v: [-0.658471135071176, 32.094524718170625, 23.00284198348812],
            ease: [
              0.9529378729987852, -0.03412152368009878, 0.7143170242443122,
              0.5254015949332431,
            ],
          },
          {
            t: 3.896330300821882,
            v: [-0.03018222484427137, -273.02901001946327, 5.757592653481982],
            ease: [
              0.11270319506726437, 0.6690303636987784, 0.23166630377840014,
              0.9738369897382892,
            ],
          },
          {
            t: 4.7824019024970275,
            v: [-0.02727988727869867, -360, 0],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        scale: [
          {
            t: 0.17779177760649373,
            v: [0.6],
            ease: [
              0.807066718478605, 0.026672824415491948, 0.05397305674842967,
              0.9010023979880923,
            ],
          },
          {
            t: 1.4141067024830507,
            v: [0.4215844279727266],
            ease: [
              0.758517646256336, -0.08984960385218788, 0.3074500979615823,
              0.9070651813931356,
            ],
          },
          {
            t: 2.25,
            v: [0.5281520264776418],
            ease: [
              1, 0.12529134929810246, 0.3851632150743237, 0.8426351606267645,
            ],
          },
          {
            t: 2.9883359098579825,
            v: [0.6153393854797824],
            ease: [
              0.6185932743021068, -0.26875053521000764, 0.341686978852472, 1,
            ],
          },
          {
            t: 4.608223713420763,
            v: [0.6],
            ease: [
              0.807066718478605, 0.026672824415491948, 0.05397305674842967,
              1.0519668384455731,
            ],
          },
        ],
        expression: [
          {
            t: 0.7466486120839366,
            v: "inspect",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 2.556108799048751,
            v: "surprised",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 3.7592152199762188,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Working_C",
      duration: 5,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.17491812227074233,
            v: [-0.06835221071089878, -14911040730998862e-21],
            ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
          },
          {
            t: 1.5108114197876916,
            v: [0.032133292775302545, -0.0019533463357608513],
            ease: [0.001, 0.24090214653366723, 0.58, 1],
          },
          {
            t: 1.7971520856616507,
            v: [-0.06835221071089878, -14911040730998862e-21],
            ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
          },
          {
            t: 3.1330453831785996,
            v: [0.032133292775302545, -0.0019533463357608513],
            ease: [0.001, 0.24090214653366723, 0.58, 1],
          },
          {
            t: 3.4083292556973226,
            v: [-0.06835221071089878, -14911040730998862e-21],
            ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
          },
          {
            t: 4.777367618612606,
            v: [0.032133292775302545, -0.0019533463357608513],
            ease: [0.001, 0.24090214653366723, 0.58, 1],
          },
          {
            t: 5,
            v: [-0.06835221071089878, -14911040730998862e-21],
            ease: [0.48050979200063776, 0.06136202638923106, 0.999, 1.5],
          },
        ],
        rotation: [
          {
            t: 0.17491812227074233,
            v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
            ease: [
              0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5,
            ],
          },
          {
            t: 1.5108114197876916,
            v: [25.82236401380847, 8.163455755358939, 36.34926880424543],
            ease: [0, 0.24090214653366723, 0.58, 1],
          },
          {
            t: 1.7971520856616507,
            v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
            ease: [
              0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5,
            ],
          },
          {
            t: 3.1330453831785996,
            v: [25.82236401380847, 8.163455755358939, 36.34926880424543],
            ease: [0, 0.24090214653366723, 0.58, 1],
          },
          {
            t: 3.4083292556973226,
            v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
            ease: [
              0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5,
            ],
          },
          {
            t: 4.777367618612606,
            v: [25.82236401380847, 8.163455755358939, 36.34926880424543],
            ease: [0, 0.24090214653366723, 0.58, 1],
          },
          {
            t: 5,
            v: [22.808320996747383, -5.474402376762305, -34.85465299871112],
            ease: [
              0.48050979200063776, 0.06136202638923106, 0.9994333239875214, 1.5,
            ],
          },
        ],
        expression: [
          {
            t: 0,
            v: "surprised",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Working_D",
      duration: 5,
      body: "sphere",
      squashAnchor: 0,
      workArea: { start: 0, end: 5 },
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 1.5264103096017296,
            v: [0, 0],
            ease: [
              0.8183794558884002, 0, 0.42063048773799955, 0.8916191063669083,
            ],
          },
          {
            t: 2.2538209606986896,
            v: [0.13302558581350077, 0.08599672420051416],
            ease: [
              0.7164816671975539, -0.07059803322016199, 0.15856161687281733, 1,
            ],
          },
          { t: 2.636972068926158, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0,
            v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
            ease: [
              0.7818125791576046, 0.15346315752484826, 0.32687664998404986,
              1.1173618829561318,
            ],
          },
          {
            t: 0.003820960698689868,
            v: [2.4615600363954893, -24.921015876700608, 2.790543200988768],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.5222436429350663,
            v: [20.16565207199379, -20.644446669166673, 22.47273384376682],
            ease: [
              0.36229770668640776, -0.17418027527991467, 0.2875659277885649,
              1.2452842602722636,
            ],
          },
          {
            t: 1.5264103096017296,
            v: [-20.98869306129836, -21.248460672675545, -6.20573622722674],
            ease: [
              0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1,
            ],
          },
          {
            t: 2.2538209606986896,
            v: [-23.757982259034762, 24.83627384870201, 18.82083960330674],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 2.636972068926158,
            v: [8.316132781421524, -27.390741199393897, -9.531735566337252],
            ease: [
              0.12247552635300568, -0.002557518043474879, 0.7043012111749869,
              0.5773041000961353,
            ],
          },
          {
            t: 3.494456667932666,
            v: [6.3335276735657375, -0.1762970079864843, 0.6565665872756274],
            ease: [0.42, 0.5038392468370619, 0.58, 1],
          },
          {
            t: 4.25382096069869,
            v: [8.1703683326745, 24.729657859977713, 10.395084291173474],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 4.971120960698738,
            v: [2.4615600363954893, -24.921015876700608, 2.790543200988768],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0.003820960698689868,
            v: "calm",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Working_E",
      duration: 4,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.6167064755838638,
            v: [0, 0],
            ease: [0.5771393784786643, 0, 0.41654104823747684, 1],
          },
          {
            t: 1.4190773177636233,
            v: [-0.16387514369529332, 0],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 2.2684226822363764,
            v: [-0.16387514369529332, 0.05904395257747427],
            ease: [0.580719503710575, 0, 0, 1],
          },
          {
            t: 3.1610281808035716,
            v: [0, 0],
            ease: [0.5771393784786643, 0, 0.41654104823747684, 1],
          },
        ],
        rotation: [
          {
            t: 0,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 0.6167064755838638,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [
              0.8625910776088882, -0.041613616273912, 0.25952275632662025,
              1.049784301761229,
            ],
          },
          {
            t: 1.4190773177636233,
            v: [-2.97589945531819, -26.234478989223906, -3.2544499064295738],
            ease: [
              0.7818125791576046, 0.15346315752484826, 0.32687664998404986,
              1.1173618829561318,
            ],
          },
          {
            t: 2.2684226822363764,
            v: [-31.58476211869586, -3.710798107118315, 24.071416454447956],
            ease: [
              0.36229770668640776, -0.17418027527991467, 0.2875659277885649,
              1.2452842602722636,
            ],
          },
          {
            t: 2.7962446921443735,
            v: [-27.874087487241205, 0.739249290532289, 5.007074162025872],
            ease: [0.42, 0.044881803684311196, 0.58, 1],
          },
          {
            t: 3.2725893489030398,
            v: [-19.255583925594408, -17.414119894980235, -7.023063437300964],
            ease: [
              0.49415439617951884, -0.031041466813226757, 0.2907565775851124, 1,
            ],
          },
          {
            t: 3.8435756138392856,
            v: [-10.064416055441825, 12.982763466855692, 19.192265328801522],
            ease: [0.42, 0, 0.58, 1],
          },
          {
            t: 3.9805733816964284,
            v: [-15.896271043294888, 33.29315635042974, 25.38480127460161],
            ease: [0.42, 0, 0.58, 1],
          },
        ],
        expression: [
          {
            t: 0.05960518973214285,
            v: "neutral",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
          {
            t: 2.2434315286624202,
            v: "surprised",
            ease: [
              0.7416814271255061, 0.03220016891891886, 0.26459703947368424,
              1.0216427364864864,
            ],
          },
        ],
      },
    },
    {
      name: "Working_F",
      duration: 5,
      body: "sphere",
      squashAnchor: 0,
      workArea: null,
      inspect: { bias: -1, follow: !0 },
      tracks: {
        position: [
          {
            t: 0.4874467656537753,
            v: [0, 0],
            ease: [
              0.6778358120868745, -0.22439715100065685, 0.15951040179591214, 1,
            ],
          },
          {
            t: 1.3832000000000173,
            v: [-0.14647919001828796, 0.027266090496135924],
            ease: [
              0.5825263567433967, 0.31017058172003364, 0.04617913732408452,
              1.3610608114532912,
            ],
          },
          {
            t: 1.77965296961326,
            v: [-0.14647919001828796, 0.027266090496135924],
            ease: [
              0.22005965712189499, 0.31017058172003364, 0.04617913732408452,
              0.9652306378531971,
            ],
          },
          {
            t: 2.5961328343722427,
            v: [0.06209379465135341, 0.0363636826260471],
            ease: [
              0.6823010997778416, 0.03975119923438924, 0.58, 0.7462988396745895,
            ],
          },
          {
            t: 3.066377943544433,
            v: [-0.016487420591570615, 0.0804209848791122],
            ease: [
              0.8034080182827295, -0.08276325518488785, 0.6510110561346553,
              0.8128258749805829,
            ],
          },
          {
            t: 3.426085780646072,
            v: [-0.008916270094194876, -0.2135819760518346],
            ease: [
              0.1744021985074266, -0.5, 0.8865519014643501, -0.2214168917492133,
            ],
          },
          {
            t: 4.00439785911593,
            v: [-0.0052248049102180776, -0.12515593913381462],
            ease: [
              0.023812816055625345, 0.31341394515796384, 0.0448947139696587,
              1.0658309377957906,
            ],
          },
          { t: 4.893926749555462, v: [0, 0], ease: [0.42, 0, 0.58, 1] },
        ],
        rotation: [
          {
            t: 0.4874467656537753,
            v: [0, 0, 0],
            ease: [
              0.6778358120868745, -0.22439715100065685, 0.15951040179591214, 1,
            ],
          },
          {
            t: 1.3832000000000173,
            v: [-11.013174031248813, -20.059833580125414, -12.896783267756348],
            ease: [
              0.5825263567433967, 0.31017058172003364, 0.04617913732408452,
              1.3610608114532912,
            ],
          },
          {
            t: 1.77965296961326,
            v: [-17.48975478197329, -18.703976724880516, -12.678205332257816],
            ease: [
              0.22005965712189499, 0.31017058172003364, 0.04617913732408452,
              0.9652306378531971,
            ],
          },
          {
            t: 2.5961328343722427,
            v: [-14.554913391638532, 17.164836260093473, 9.376528927180779],
            ease: [
              0.6823010997778416, 0.03975119923438924, 0.58, 0.9240336563778733,
            ],
          },
          {
            t: 3.1796016343940767,
            v: [-24.586251970533304, 0.14133926125606477, -0.7477216271856462],
            ease: [
              0.8034080182827295, -0.08276325518488785, 0.9143306014396848,
              0.4851034680582119,
            ],
          },
          {
            t: 3.4679142027965795,
            v: [-1.0943281912285556, -1.1346215368163393, -0.7116952620126241],
            ease: [
              0.12040927423864656, -0.18872517040581954, 0.9481776569383256,
              -0.20917925086224787,
            ],
          },
          {
            t: 4.001861402631413,
            v: [-147.11069531984157, -0.6757806869448113, -0.4238857605398247],
            ease: [
              0.03131913716814155, 0.8644907690193963, 0.0448947139696587,
              1.0658309377957906,
            ],
          },
          {
            t: 4.893926749555462,
            v: [-360, 0, 0],
            ease: [
              0.7970933306500759, -0.5, 0.24118105710043447, 0.7361553789450831,
            ],
          },
        ],
        expression: [
          {
            t: 1.8508295659644571,
            v: "surprised",
            ease: [
              0.7394673582995951, 0.10409628378378377, 0.6676682692307693, 1.5,
            ],
          },
          {
            t: 4.893926749555462,
            v: "neutral",
            ease: [
              0.8458217358299596, 0.40487753378378377, 0.13769926619433198,
              0.9154349662162162,
            ],
            cut: !0,
          },
        ],
        lids: [
          { t: 1.1672000000000002, v: [0], ease: [0.42, 0, 0.58, 1] },
          { t: 1.2797000000000003, v: [1], ease: [0.42, 0, 0.58, 1] },
          { t: 1.4172000000000002, v: [0], ease: [0.42, 0, 0.58, 1] },
        ],
      },
    },
  ];
const Cx = 120;
const Dn = {
    clips: [
      "Working_A",
      "Working_B",
      "Working_C",
      "Working_D",
      "Working_E",
      "Working_F",
    ],
  };
const fl = {
    idle: {
      clips: ["Idle_B", "Idle_B", "Idle_D", "Idle_B", "Idle_A"],
      compactClips: ["Idle_B"],
    },
    listening: { clips: ["Idle_D"], face: "calm" },
    thinking: { clips: ["Idle_B"], morph: "thinking" },
    streaming: { clips: ["Streaming_A", "Streaming_B", "Streaming_C"] },
    searching: { clips: ["Idle_B"], morph: "radar" },
    reading: Dn,
    working: Dn,
    coding: Dn,
    running: Dn,
    computing: Dn,
    controlling: Dn,
    waiting: { clips: ["Idle_B"], morph: "orbit" },
    blocked: { clips: ["Blocked_A"], next: "drowsy", holdSeconds: Cx },
    finished: { clips: ["Done_B", "Done_A"], face: "happy", next: "idle" },
    failed: { clips: ["Blocked_B"], next: "idle" },
    sleeping: { clips: ["Idle_B"], face: "sleepy" },
    waking: {
      clips: ["Idle_B"],
      face: "surprised",
      next: "idle",
      holdSeconds: 1.6,
    },
    happy: { clips: ["Done_A"] },
    excited: { clips: ["Done_C"] },
    laughing: { clips: ["Done_B"] },
    proud: { clips: ["Marketing_B"] },
    curious: { clips: ["Working_B"], face: "inspecting" },
    playful: { clips: ["Bodymoves_A"] },
    shy: { clips: ["Idle_D"], face: "calm" },
    surprised: { clips: ["Idle_B"], face: "surprised" },
    suspicious: { clips: ["Idle_D"], face: "squinted" },
    angry: { clips: ["Blocked_A"], face: "squinted" },
    confused: { clips: ["Blocked_A"] },
    sad: { clips: ["Blocked_B"] },
    drowsy: { clips: ["Blocked_C"] },
    bored: { clips: ["Idle_B"], face: "sleepy" },
    scared: { clips: ["Idle_D"], face: "surprised" },
    celebrate: { clips: ["Rotation_A"], face: "happy" },
    approving: { clips: ["Rotation_C"], next: "idle" },
    orbit: { clips: ["Idle_B"], morph: "orbit" },
    radar: { clips: ["Idle_B"], morph: "radar" },
    progress: { clips: ["Idle_B"], morph: "progress" },
    spawning: { clips: ["Idle_B"], morph: "spawning" },
    loading: { clips: ["Idle_B"], morph: "progress" },
    dictating: { clips: ["Idle_B"], morph: "dictating" },
    sending: { clips: ["Idle_B"], morph: "sending" },
    receiving: { clips: ["Idle_B"], morph: "receiving" },
    uploading: { clips: ["Idle_B"], morph: "uploading" },
    writing: { clips: ["Idle_B"], morph: "writing" },
    alerting: { clips: ["Idle_B"], morph: "alerting" },
    bouncing: { clips: ["Idle_B"], morph: "bouncing" },
    "powering-down": { clips: ["Idle_B"], morph: "powering-down" },
    humming: { clips: ["Idle_B"], face: "calm" },
    notifying: { clips: ["Done_B"], face: "surprised" },
    dragging: { clips: ["Idle_B"], face: "surprised" },
    logo: { clips: ["Logo_A", "Logo_B"] },
    showcase: {
      clips: ["Marketing_A", "Marketing_B", "Marketing_C", "Marketing_D"],
    },
    turntable: { clips: ["Rotation_B"] },
  };
const Rx = new Map(Ix.map((e) => [e.name, e]));
function $x(e) {
  const t = Rx.get(e);
  if (t == null) throw new Error(`No motion recipe named ${e}`);
  return t;
}
const Ox = "surprised";
function Lx(e, t, n) {
  const r = [...e];
  for (let s = r.length - 1; s > 0; s -= 1) hl(r, s, Math.floor(t() * (s + 1)));
  const o = r.findIndex((s) => s !== n);
  return (o > 0 && hl(r, 0, o), r);
}
function hl(e, t, n) {
  const r = e[t],
    o = e[n];
  r === void 0 || o === void 0 || ((e[t] = o), (e[n] = r));
}
function Nx(e, t, n = {}) {
  const r = tc(n.seed ?? 1),
    o = new Map();
  let s = n.isCompact ?? !1,
    i = n.isResting ?? !1,
    a = !1,
    c = i,
    u = t,
    l = fl[t],
    d = 0,
    f = 0,
    h = e.loopCount,
    p = null;
  const g = () => (s && l.compactClips != null ? l.compactClips : l.clips),
    m = () => l.next != null && l.holdSeconds == null,
    y = () => {
      const v = g(),
        T = o.get(v) ?? [];
      return (T.length === 0 && T.push(...Lx(v, r, p)), o.set(v, T), T.shift());
    },
    w = () => {
      const v = m() ? g()[f] : y();
      if (((h = e.loopCount), v === void 0 || v === p)) return;
      const T = c || m();
      (e.load($x(v), { phase: T ? 0 : (n.firstPhase ?? r()) }),
        (c = !0),
        (p = v),
        (h = e.loopCount));
    },
    S = () => {
      e.holdFace(l.face ?? (a ? Ox : null));
    },
    b = (v) => {
      ((u = v),
        (l = fl[v]),
        (d = 0),
        (f = 0),
        e.setMorph(l.morph ?? null),
        S(),
        i || w());
    };
  return (
    i && e.rest(),
    b(t),
    {
      get state() {
        return u;
      },
      get clip() {
        return p;
      },
      setState(v) {
        v !== u && b(v);
      },
      setCompact(v) {
        s = v;
      },
      setEmphasis(v) {
        v !== a && ((a = v), S());
      },
      setResting(v) {
        if (v !== i) {
          if (((i = v), !i)) {
            w();
            return;
          }
          (e.rest(), (p = null));
        }
      },
      advance(v) {
        if (i) return;
        d += v;
        const T = l.next;
        if (T != null && l.holdSeconds != null && d >= l.holdSeconds) {
          b(T);
          return;
        }
        if (e.loopCount !== h) {
          if (
            T != null &&
            l.holdSeconds == null &&
            ((f += 1), f >= g().length)
          ) {
            b(T);
            return;
          }
          w();
        }
      },
    }
  );
}
const Fx = 0.26;
const zx = 0.57;
const rs = 0.64;
const pl = 11;
const Dx = 18;
const os = 48;
const ml = 10;
const gl = 64;
const yl = { on: !1, oval: !1, width: 0, height: 0, tilt: 0, cx: 0, cy: 0 };
const jx = {
    cloud: {
      width: 0.21294,
      height: 0.4668299999999999,
      gap: 0.47001600000000004,
      shiftY: 0.06999999999999999,
    },
    square: {
      width: 0.2553258426966292,
      height: 0.559752808988764,
      gap: 0.529408,
      shiftY: 0.12,
    },
    sparkle: {
      width: 0.18381999999999998,
      height: 0.40298999999999996,
      gap: 0.41215999999999997,
      shiftY: 0,
    },
    clover: {
      width: 0.23296,
      height: 0.51072,
      gap: 0.559104,
      shiftY: -0.020000000000000018,
    },
    heartChubby: {
      width: 0.18657600000000002,
      height: 0.409032,
      gap: 0.44620799999999994,
      shiftY: 0.051999999999999935,
    },
    starFlower: {
      width: 0.19292,
      height: 0.42294,
      gap: 0.38297600000000004,
      shiftY: 0.12,
    },
    teardrop: {
      width: 0.20779200000000003,
      height: 0.455544,
      gap: 0.45260800000000007,
      shiftY: 0.18,
    },
    tablet: {
      width: 0.2132,
      height: 0.4673999999999999,
      gap: 0.587776,
      shiftY: 0.01999999999999999,
    },
    wedge: {
      width: 0.2132,
      height: 0.4673999999999999,
      gap: 0.46771199999999996,
      shiftY: 0.18,
    },
    house: {
      width: 0.2295124,
      height: 0.5031617999999999,
      gap: 0.5125120000000001,
      shiftY: 0.18499534000463813,
    },
    star6: {
      width: 0.184782,
      height: 0.44965988999999995,
      gap: 0.41913343999999997,
      shiftY: 0.12,
    },
    pebble: {
      width: 0.23920000000000002,
      height: 0.5244,
      gap: 0.546304,
      shiftY: 0.12,
    },
    bean: { width: 0.2028, height: 0.4446, gap: 0.4608, shiftY: 0.12 },
    egg: {
      width: 0.23920000000000002,
      height: 0.5244,
      gap: 0.433664,
      shiftY: 0.11299906800092761,
    },
    squircle: {
      width: 0.23920000000000002,
      height: 0.5244,
      gap: 0.5632,
      shiftY: 0.12,
    },
    capsule: {
      width: 0.2106,
      height: 0.4617,
      gap: 0.36044800000000005,
      shiftY: 0.12,
    },
    cylinder: {
      width: 0.23920000000000002,
      height: 0.5244,
      gap: 0.47872000000000003,
      shiftY: 0.12,
    },
    hex: { width: 0.26, height: 0.57, gap: 0.64, shiftY: 0.12 },
    gem: {
      width: 0.23920000000000002,
      height: 0.5244,
      gap: 0.501248,
      shiftY: 0.12,
    },
    crystal: { width: 0.1612, height: 0.3534, gap: 0.3712, shiftY: 0.12 },
    shield: {
      width: 0.26790400000000003,
      height: 0.5873280000000001,
      gap: 0.44492800000000005,
      shiftY: 0.12,
    },
    dome: {
      width: 0.2132,
      height: 0.4673999999999999,
      gap: 0.47872000000000003,
      shiftY: 0.10599813600185524,
    },
    arch: {
      width: 0.19240000000000002,
      height: 0.42179999999999995,
      gap: 0.44799999999999995,
      shiftY: 0.16,
    },
    leaf: {
      width: 0.1872,
      height: 0.41039999999999993,
      gap: 0.44799999999999995,
      shiftY: 0.039999999999999994,
    },
  };
function qx(e, t) {
  const n = jx[e],
    r = n.width / Fx,
    o = n.height / zx,
    s = n.gap / rs;
  return t.every((a) => sc(a) && !(a.fillRing != null && a.fillRing.length > 0))
    ? Bx(wl(t[0]), wl(t[1]), n, r, o, s)
    : { loops: Hx(t, r, s, o, n.shiftY), shiftY: 0 };
}
function Bx(e, t, n, r, o, s) {
  const i = Oe(e.width * r),
    a = Oe(e.height * r),
    c = Oe(t.width * r),
    u = Oe(t.height * r),
    l = Math.max(0, Oe(Math.min(i, a))),
    d = Math.max(0, Oe(Math.max(i, a))),
    f = Math.max(0, Oe(Math.min(c, u))),
    h = Math.max(0, Oe(Math.max(c, u))),
    p = Math.max(
      0,
      Oe((rs + (e.on ? Oe(e.cx) : 0) + (t.on ? Oe(t.cx) : 0)) * s, rs * s),
    ),
    g = Math.max(0.05, Math.min(1.8, p));
  return {
    loops: [
      kl(-1, l, d, -Oe(Oe(e.tilt) + (i >= a ? 0 : 90)), g),
      kl(1, f, h, Oe(Oe(t.tilt) + (c >= u ? 0 : 90)), g),
    ],
    shiftY: Oe(n.shiftY + ((Oe(e.cy) + Oe(t.cy)) / 2) * o, n.shiftY),
  };
}
function kl(e, t, n, r, o) {
  const s = Math.max(0.01, Math.min(1, t)) / 2,
    i = Math.max(0.02, Math.min(1.8, Math.max(n, t))) / 2,
    a = (-r * Math.PI) / 180,
    c = Math.cos(a),
    u = Math.sin(a);
  return Array.from({ length: gl }, (l, d) => {
    const f = (2 * Math.PI * d) / gl,
      h = e * i * Math.cos(f),
      p = s * Math.sin(f);
    return { x: h * c - p * u + (e * o) / 2, y: h * u + p * c };
  });
}
function wl(e) {
  const t = sc(e);
  if (!(e.wid > 0) && !t) return yl;
  const n = e.lidY || 1,
    r = (e.tilt || 0) * (180 / Math.PI);
  if (t)
    return {
      on: !0,
      oval: !0,
      width: 2 * e.oval[0],
      height: 2 * e.oval[1] * n,
      tilt: r,
      cx: e.off[0],
      cy: e.off[1],
    };
  const o = e.pts;
  if (o.length < 2) return { ...yl, cx: e.off[0], cy: e.off[1] };
  const s = o[0],
    i = o[o.length - 1],
    a = i[0] - s[0],
    c = i[1] - s[1],
    u = Math.hypot(a, c),
    l = 2 * e.wid;
  return {
    on: !0,
    oval: !1,
    width: l,
    height: (u + l) * n,
    tilt: Math.atan2(a, c) * (180 / Math.PI) + r,
    cx: e.off[0] + (s[0] + i[0]) / 2,
    cy: e.off[1] + ((s[1] + i[1]) / 2) * n,
  };
}
function Hx(e, t, n, r, o) {
  const s = [],
    i = -Math.sin(o);
  return (
    e.forEach((a, c) => {
      const u = sc(a);
      if ((!(a.wid > 0) && !u) || (!u && a.pts.length < 2)) return;
      const l = c === 0 ? -1 : 1,
        d = a.lidY || 1,
        f = Math.cos(a.tilt || 0),
        h = Math.sin(a.tilt || 0),
        p = l * ((rs / 2 + Oe(a.off[0])) * n),
        g = i + Oe(a.off[1]) * r,
        m = (S, b) => {
          const v = S * f - b * h,
            T = S * h + b * f;
          return { x: p + l * v * t, y: g + T * t * d };
        };
      if (a.fillRing != null && a.fillRing.length >= 3) {
        const S = Oe(a.off[0]),
          b = Oe(a.off[1]);
        s.push(a.fillRing.map(([v, T]) => m(v - S, (T - b) * d)));
        return;
      }
      if (u) {
        const S = [];
        for (let b = 0; b < os; b++) {
          const v = (2 * Math.PI * b) / os;
          S.push(m(a.oval[0] * Math.cos(v), a.oval[1] * d * Math.sin(v)));
        }
        s.push(S);
        return;
      }
      const y = a.wid * t,
        w =
          a.path != null && a.path.length === Dx
            ? Gx(a.path, m, y)
            : Vx(
                a.pts.map((S) => m(S[0], S[1])),
                y,
              );
      w.length > 0 && s.push(w);
    }),
    s
  );
}
function Vx(e, t) {
  const n = [];
  for (const u of e) {
    const l = n.at(-1);
    (l == null || Math.hypot(u.x - l.x, u.y - l.y) > 1e-6) && n.push(u);
  }
  if (n.length === 0 || t <= 0) return [];
  const r = Qf(n, t);
  if (r != null) return r;
  const o = n.length;
  if (o < 2) return [];
  const s = [],
    i = [];
  for (let u = 0; u < o; u++) {
    const l = n[Math.max(0, u - 1)],
      d = n[Math.min(o - 1, u + 1)],
      f = Math.hypot(d.x - l.x, d.y - l.y) || 1;
    let h = -(d.y - l.y) / f,
      p = (d.x - l.x) / f;
    (u > 0 && h * s[u - 1] + p * i[u - 1] < 0 && ((h = -h), (p = -p)),
      s.push(h),
      i.push(p));
  }
  const a = Sl(n[1].x - n[0].x, n[1].y - n[0].y),
    c = Sl(n[o - 1].x - n[o - 2].x, n[o - 1].y - n[o - 2].y);
  return Zf(n, s, i, t, a, c);
}
function Gx(e, t, n) {
  if (n <= 0) return [];
  const r = [];
  for (let f = 0; f < 2; f++) {
    const h = xl(e, f),
      p = vl(e, f, 4),
      g = vl(e, f + 1, 2),
      m = xl(e, f + 1);
    for (let y = f === 0 ? 0 : 1; y < pl; y++) {
      const w = y / (pl - 1),
        S = Wx(h, p, g, m, w),
        b = Ux(h, p, g, m, w),
        v = t(S[0], S[1]),
        T = t(S[0] + b[0], S[1] + b[1]);
      r.push({ x: v.x, y: v.y, tx: T.x - v.x, ty: T.y - v.y });
    }
  }
  const o = Qf(r, n);
  if (o != null) return o;
  const s = r.length,
    i = [],
    a = [];
  for (let f = 0; f < s; f++) {
    const h = Math.hypot(r[f].tx, r[f].ty) || 1;
    let p = -r[f].ty / h,
      g = r[f].tx / h;
    (f > 0 && p * i[f - 1] + g * a[f - 1] < 0 && ((p = -p), (g = -g)),
      i.push(p),
      a.push(g));
  }
  const c = r[0],
    u = r[s - 1],
    l = Math.hypot(c.tx, c.ty) || 1,
    d = Math.hypot(u.tx, u.ty) || 1;
  return Zf(
    r,
    i,
    a,
    n,
    { x: c.tx / l, y: c.ty / l },
    { x: u.tx / d, y: u.ty / d },
  );
}
function Zf(e, t, n, r, o, s) {
  const i = e.length,
    a = e.map((d, f) => ({ x: d.x + t[f] * r, y: d.y + n[f] * r })),
    c = e.map((d, f) => ({ x: d.x - t[f] * r, y: d.y - n[f] * r })),
    u = { x: e[0].x - o.x * r, y: e[0].y - o.y * r },
    l = { x: e[i - 1].x + s.x * r, y: e[i - 1].y + s.y * r };
  return [
    ...a,
    ...bl(e[i - 1], a[i - 1], l, r),
    ...[...c].reverse(),
    ...bl(e[0], c[0], u, r),
  ];
}
function bl(e, t, n, r) {
  const o = [],
    s = Math.atan2(t.y - e.y, t.x - e.x);
  let a = Math.atan2(n.y - e.y, n.x - e.x) - s;
  for (; a > Math.PI; ) a -= 2 * Math.PI;
  for (; a < -Math.PI; ) a += 2 * Math.PI;
  const c = a >= 0 ? 1 : -1;
  for (let u = 1; u < ml; u++) {
    const l = s + c * (u / ml) * Math.PI;
    o.push({ x: e.x + r * Math.cos(l), y: e.y + r * Math.sin(l) });
  }
  return o;
}
function Qf(e, t) {
  let n = 0,
    r = 0;
  for (const i of e) ((n += i.x), (r += i.y));
  ((n /= e.length), (r /= e.length));
  let o = 0;
  for (const i of e) o = Math.max(o, Math.hypot(i.x - n, i.y - r));
  if (t <= o * 1.05) return null;
  const s = [];
  for (let i = 0; i < os; i++) {
    const a = (2 * Math.PI * i) / os,
      c = Math.cos(a),
      u = Math.sin(a);
    let l = -1 / 0,
      d = 0,
      f = 0;
    for (const h of e) {
      const p = h.x * c + h.y * u;
      p > l && ((l = p), (d = h.x), (f = h.y));
    }
    s.push({ x: d + c * t, y: f + u * t });
  }
  return s;
}
function xl(e, t) {
  return [e[t * 6], e[t * 6 + 1]];
}
function vl(e, t, n) {
  return [e[t * 6] + e[t * 6 + n], e[t * 6 + 1] + e[t * 6 + n + 1]];
}
function Wx(e, t, n, r, o) {
  const s = 1 - o;
  return [
    s * s * s * e[0] +
      3 * s * s * o * t[0] +
      3 * s * o * o * n[0] +
      o * o * o * r[0],
    s * s * s * e[1] +
      3 * s * s * o * t[1] +
      3 * s * o * o * n[1] +
      o * o * o * r[1],
  ];
}
function Ux(e, t, n, r, o) {
  const s = 1 - o;
  return [
    3 * s * s * (t[0] - e[0]) +
      6 * s * o * (n[0] - t[0]) +
      3 * o * o * (r[0] - n[0]),
    3 * s * s * (t[1] - e[1]) +
      6 * s * o * (n[1] - t[1]) +
      3 * o * o * (r[1] - n[1]),
  ];
}
function Sl(e, t) {
  const n = Math.hypot(e, t) || 1;
  return { x: e / n, y: t / n };
}
function sc(e) {
  return e.oval[0] > 1e-4 && e.oval[1] > 1e-4;
}
function Oe(e, t = 0) {
  return Number.isFinite(e) ? e : t;
}
const x = 114.2705;
const Kx = (e, t, n) =>
    e.map(([r, o], s) => [r + (t[s][0] - r) * n, o + (t[s][1] - o) * n]);
const Jf = 1e-10;
const Xx = 2 ** 26;
function Yx(e) {
  const t = Zx(e);
  if (t == null) return [];
  const n = Qx(t.map((c) => e[c])),
    [r, o, s, i] = t;
  let a = [
    [r, o, s],
    [r, o, i],
    [r, s, i],
    [o, s, i],
  ].map(([c, u, l]) => {
    const d = li(e, [c, u, l]);
    return Ml(d, n) > 0 ? li(e, [c, l, u]) : d;
  });
  return (
    e.forEach((c, u) => {
      if (t.includes(u)) return;
      const l = a.map((h) => Ml(h, c) > Jf);
      if (!l.includes(!0)) return;
      const d = new Set();
      a.forEach((h, p) => {
        if (!l[p])
          for (let g = 0; g < 3; g++)
            d.add(Tl(h.corners[g], h.corners[(g + 1) % 3]));
      });
      const f = [];
      (a.forEach((h, p) => {
        if (!l[p]) {
          f.push(h);
          return;
        }
        for (let g = 0; g < 3; g++) {
          const m = h.corners[g],
            y = h.corners[(g + 1) % 3];
          d.has(Tl(y, m)) && f.push(li(e, [m, y, u]));
        }
      }),
        (a = f));
    }),
    a.map((c) => c.corners)
  );
}
function Zx(e) {
  if (e.length < 4) return null;
  let t = 0;
  e.forEach((i, a) => {
    i[0] < e[t][0] && (t = a);
  });
  const n = di(e, (i) => ia(Rt(i, e[t]))),
    r = di(e, (i) => ia(sa(Rt(e[n], e[t]), Rt(i, e[t])))),
    o = sa(Rt(e[n], e[t]), Rt(e[r], e[t])),
    s = di(e, (i) => Math.abs(ss(o, Rt(i, e[t]))));
  return Math.abs(ss(o, Rt(e[s], e[t]))) < Jf ? null : [t, n, r, s];
}
function li(e, t) {
  const n = e[t[0]],
    r = sa(Rt(e[t[1]], n), Rt(e[t[2]], n)),
    o = ia(r) || 1,
    s = [r[0] / o, r[1] / o, r[2] / o];
  return { corners: t, normal: s, offset: ss(s, n) };
}
function Ml(e, t) {
  return ss(e.normal, t) - e.offset;
}
function Tl(e, t) {
  return e * Xx + t;
}
function di(e, t) {
  let n = 0,
    r = -1 / 0;
  return (
    e.forEach((o, s) => {
      const i = t(o);
      i > r && ((r = i), (n = s));
    }),
    n
  );
}
function Qx(e) {
  const t = e.length;
  return [
    e.reduce((n, r) => n + r[0], 0) / t,
    e.reduce((n, r) => n + r[1], 0) / t,
    e.reduce((n, r) => n + r[2], 0) / t,
  ];
}
function Rt(e, t) {
  return [e[0] - t[0], e[1] - t[1], e[2] - t[2]];
}
function sa(e, t) {
  return [
    e[1] * t[2] - e[2] * t[1],
    e[2] * t[0] - e[0] * t[2],
    e[0] * t[1] - e[1] * t[0],
  ];
}
function ss(e, t) {
  return e[0] * t[0] + e[1] * t[1] + e[2] * t[2];
}
function ia(e) {
  return Math.hypot(e[0], e[1], e[2]);
}
const Jx = [
    { x: 0.934475052698969, y: 0.004363180216799212 },
    { x: 0.948891570423846, y: 0.039714756021395174 },
    { x: 0.9608728659762679, y: 0.07607039935952659 },
    { x: 0.9703302557200477, y: 0.11326502451357987 },
    { x: 0.977189539605176, y: 0.15112675873557632 },
    { x: 0.9813908922405818, y: 0.18947802927479046 },
    { x: 0.9828887074578869, y: 0.2281365499571005 },
    { x: 0.9816519990958227, y: 0.2669163757988432 },
    { x: 0.9776625497902636, y: 0.30562830330137525 },
    { x: 0.9709166586711733, y: 0.3440810419322467 },
    { x: 0.9614266573440594, y: 0.3820827122339433 },
    { x: 0.949221424670692, y: 0.41944230284893746 },
    { x: 0.9343467338379507, y: 0.45597122804302315 },
    { x: 0.9168643128164508, y: 0.49148439126889626 },
    { x: 0.8968538338085426, y: 0.5258027955519334 },
    { x: 0.8744135590875667, y: 0.5587560766363049 },
    { x: 0.8496605481016927, y: 0.5901852347689388 },
    { x: 0.8227287687893752, y: 0.6199442885313702 },
    { x: 0.7937617531488526, y: 0.6478973166280976 },
    { x: 0.762905919754175, y: 0.6739136951531549 },
    { x: 0.7303134746505421, y: 0.6978700569784003 },
    { x: 0.6961411032024281, y: 0.7196491755310737 },
    { x: 0.6605596057818293, y: 0.7391502303914683 },
    { x: 0.6237513457393834, y: 0.7562897143525837 },
    { x: 0.5859073404691287, y: 0.7710015652906158 },
    { x: 0.5472248974285161, y: 0.7832374824769789 },
    { x: 0.507904865265839, y: 0.7929662862613107 },
    { x: 0.4681494646643414, y: 0.8001734773422571 },
    { x: 0.4281602030115182, y: 0.8048604074486263 },
    { x: 0.38813613170852307, y: 0.8070434681543606 },
    { x: 0.34827256966973696, y: 0.8067537475134688 },
    { x: 0.3087597745583025, y: 0.8040363403785654 },
    { x: 0.26978201344672026, y: 0.7989504065912386 },
    { x: 0.23151662960878241, y: 0.7915694823366872 },
    { x: 0.19413194481287305, y: 0.7819778247879767 },
    { x: 0.1577852845947917, y: 0.7702630818507747 },
    { x: 0.12262733079593371, y: 0.7565354795442158 },
    { x: 0.08880015313138229, y: 0.7409422361214794 },
    { x: 0.05642586889159421, y: 0.7236017950683938 },
    { x: 0.02561647598492663, y: 0.704659966051552 },
    { x: -0.0036037810305528913, y: 0.6895105233164277 },
    { x: -0.03317542334906984, y: 0.7095400285365243 },
    { x: -0.06438496917371282, y: 0.7280864309789705 },
    { x: -0.0971349646590295, y: 0.7450166000084965 },
    { x: -0.13130575647382275, y: 0.7601465770772312 },
    { x: -0.16677330012669841, y: 0.7733777436363767 },
    { x: -0.20339569964825052, y: 0.7845796245158417 },
    { x: -0.24101725346433553, y: 0.7936313321637897 },
    { x: -0.27947704857143557, y: 0.8004456020397803 },
    { x: -0.3186049196302664, y: 0.8049436403918587 },
    { x: -0.35822225014656567, y: 0.8070572252942809 },
    { x: -0.398143514039767, y: 0.8067313311007664 },
    { x: -0.438177182680152, y: 0.8039242993502419 },
    { x: -0.478126841210925, y: 0.7986084072202804 },
    { x: -0.5177925726656645, y: 0.7907706714017452 },
    { x: -0.5569723963185897, y: 0.7804134068929688 },
    { x: -0.5954640748960385, y: 0.7675550146764192 },
    { x: -0.6330671972405764, y: 0.7522306880298593 },
    { x: -0.6695855487964426, y: 0.734492987733704 },
    { x: -0.7048299443180804, y: 0.714412410733904 },
    { x: -0.7386209319309059, y: 0.6920772477931056 },
    { x: -0.7707921245520308, y: 0.6675935661866239 },
    { x: -0.8011924150225685, y: 0.641083697347949 },
    { x: -0.8296683466506882, y: 0.612669941116809 },
    { x: -0.8560711521836232, y: 0.5824818706921402 },
    { x: -0.8802586099360401, y: 0.550657644865542 },
    { x: -0.9021016261853626, y: 0.5173474030319016 },
    { x: -0.921488351217944, y: 0.48271361643050537 },
    { x: -0.9383250626073236, y: 0.44692900756649523 },
    { x: -0.9525363976829352, y: 0.4101742582574272 },
    { x: -0.9640652637601566, y: 0.37263580242597466 },
    { x: -0.9728702117174652, y: 0.3345029815392968 },
    { x: -0.9789264673905609, y: 0.2959671170672982 },
    { x: -0.9822255348467005, y: 0.25722000690078245 },
    { x: -0.982774894246464, y: 0.21845258628445002 },
    { x: -0.9805967489497907, y: 0.17985349925722946 },
    { x: -0.9757258679433654, y: 0.1416078138454962 },
    { x: -0.9682107746348935, y: 0.1038965717106635 },
    { x: -0.9581143826889033, y: 0.06689596974801386 },
    { x: -0.9455146116784895, y: 0.03077634172969411 },
    { x: -0.9305051553319804, y: -0.004299067407576291 },
    { x: -0.9131952327192244, y: -0.038175545674491246 },
    { x: -0.8937019647378253, y: -0.07070785611844921 },
    { x: -0.8721591451869681, y: -0.10176130887451734 },
    { x: -0.8487362913086253, y: -0.1312168064224554 },
    { x: -0.8236207468105732, y: -0.15897343836917888 },
    { x: -0.7970979502287641, y: -0.18497038865757742 },
    { x: -0.7710541733734617, y: -0.2096139557882936 },
    { x: -0.7461193861529073, y: -0.23320814197562353 },
    { x: -0.7221519248227056, y: -0.2558870618710858 },
    { x: -0.6990265515010246, y: -0.27776911859221876 },
    { x: -0.6766318459161248, y: -0.29895980890191903 },
    { x: -0.6548676461286994, y: -0.31955389248594185 },
    { x: -0.6336431338424889, y: -0.3396372581810514 },
    { x: -0.6128753135059731, y: -0.359288557412959 },
    { x: -0.5924873537443393, y: -0.3785803988633805 },
    { x: -0.5724075923763201, y: -0.3975806113171165 },
    { x: -0.5525683653066091, y: -0.4163531831687479 },
    { x: -0.5329051623123328, y: -0.43495923867716463 },
    { x: -0.5133556323648999, y: -0.45345775659418885 },
    { x: -0.49385881021048816, y: -0.47190633957419137 },
    { x: -0.4743544952965227, y: -0.4903620705111528 },
    { x: -0.4547822689301765, y: -0.5088820023697915 },
    { x: -0.43508096787875605, y: -0.5275240823754965 },
    { x: -0.41518776564532156, y: -0.5463477370262614 },
    { x: -0.39503744073179237, y: -0.565414738403984 },
    { x: -0.37456138068841166, y: -0.584789881188713 },
    { x: -0.3536868090571391, y: -0.6045421927475639 },
    { x: -0.33233545822868515, y: -0.6247456276706727 },
    { x: -0.31042247776931897, y: -0.6454805113116225 },
    { x: -0.28785488995869934, y: -0.6668347728530055 },
    { x: -0.26452992996104363, y: -0.6889057008744045 },
    { x: -0.24032737271767535, y: -0.7117848186103969 },
    { x: -0.21465925160321186, y: -0.7340046463187382 },
    { x: -0.18703495679704094, y: -0.7534714425430167 },
    { x: -0.15772553428835867, y: -0.7700652053068575 },
    { x: -0.1270070450444056, y: -0.7836711911119708 },
    { x: -0.0951684130469074, y: -0.7942311382405959 },
    { x: -0.062495032850901626, y: -0.8016579582061256 },
    { x: -0.02928242470209217, y: -0.8059763869703366 },
    { x: 0.00418250025635626, y: -0.8071603933705995 },
    { x: 0.03761179305139532, y: -0.8051997052887491 },
    { x: 0.07071763099568142, y: -0.8001090083866196 },
    { x: 0.10320959245128111, y: -0.7918885098432591 },
    { x: 0.134798677354145, y: -0.7805799374564395 },
    { x: 0.16519657722647352, y: -0.7662371932046725 },
    { x: 0.1941137081486192, y: -0.748919054724023 },
    { x: 0.22126182274327255, y: -0.7287044591356419 },
    { x: 0.24646172395988103, y: -0.705992917688509 },
    { x: 0.27042811605651085, y: -0.6833113574191189 },
    { x: 0.2935522498121435, y: -0.6614269249128338 },
    { x: 0.31594558408750634, y: -0.6402340573221494 },
    { x: 0.33770831010282365, y: -0.6196380408622824 },
    { x: 0.3589311734375708, y: -0.5995528607013482 },
    { x: 0.3796973337781967, y: -0.579900027393222 },
    { x: 0.40008347985475634, y: -0.5606067493570983 },
    { x: 0.4201613352275292, y: -0.5416052696177914 },
    { x: 0.4399985323371352, y: -0.5228315569692281 },
    { x: 0.4596595725296922, y: -0.504224454308306 },
    { x: 0.47920690986264164, y: -0.4857251046289992 },
    { x: 0.4987013585100146, y: -0.46727574968264535 },
    { x: 0.5182031792984406, y: -0.44881937116377135 },
    { x: 0.5377727619439542, y: -0.4302988919363394 },
    { x: 0.5574712942997964, y: -0.41165639717445024 },
    { x: 0.5773615598171413, y: -0.39283243400856016 },
    { x: 0.5975088031531646, y: -0.3737652763272414 },
    { x: 0.6179815681468954, y: -0.3543900575947271 },
    { x: 0.6388526754619042, y: -0.3346378544777047 },
    { x: 0.6602003073706015, y: -0.3144346462096216 },
    { x: 0.6821093031111911, y: -0.2937001458611249 },
    { x: 0.7046726622334125, y: -0.2723464324690267 },
    { x: 0.7279930725720649, y: -0.25027624068777876 },
    { x: 0.752199978996238, y: -0.22738555814564856 },
    { x: 0.7774207173704459, y: -0.20355017023582161 },
    { x: 0.8037647094696927, y: -0.17862206250636986 },
    { x: 0.8300422031017065, y: -0.15219910918500412 },
    { x: 0.8547554784773178, y: -0.1240094996536292 },
    { x: 0.8777124848745345, y: -0.09414272665900433 },
    { x: 0.8987592287763329, y: -0.06270816362882596 },
    { x: 0.9177264967761565, y: -0.029827205842901418 },
  ];
const Pt = Math.PI * 2;
const Te = (e) => Math.round(e * 100) / 100;
const ic = (e, t, n) => (e < t ? t : e > n ? n : e);
class gn {
  d = "";
  move(t, n) {
    return ((this.d += `M${Te(t)} ${Te(n)}`), this);
  }
  line(t, n) {
    return ((this.d += `L${Te(t)} ${Te(n)}`), this);
  }
  curve(t, n, r, o, s, i) {
    return (
      (this.d += `C${Te(t)} ${Te(n)} ${Te(r)} ${Te(o)} ${Te(s)} ${Te(i)}`),
      this
    );
  }
  corner(t, n, r, o) {
    const s = (l, d) => {
        const f = l[0] - d[0],
          h = l[1] - d[1],
          p = Math.hypot(f, h) || 1;
        return [f / p, h / p];
      },
      i = s(t, n),
      a = s(r, n),
      c = [n[0] + i[0] * o, n[1] + i[1] * o],
      u = [n[0] + a[0] * o, n[1] + a[1] * o];
    return (
      this.d ? this.line(c[0], c[1]) : this.move(c[0], c[1]),
      (this.d += `Q${Te(n[0])} ${Te(n[1])} ${Te(u[0])} ${Te(u[1])}`),
      this
    );
  }
  arc(t, n, r, o, s, i) {
    const a = Math.max(1, Math.ceil(Math.abs(i - s) / (Math.PI / 2))),
      c = (i - s) / a,
      u = (4 / 3) * Math.tan(c / 4);
    let l = s;
    for (let d = 0; d < a; d++) {
      const f = l + c,
        h = [t + r * Math.cos(l), n + o * Math.sin(l)],
        p = [t + r * Math.cos(f), n + o * Math.sin(f)];
      (this.curve(
        h[0] - u * r * Math.sin(l),
        h[1] + u * o * Math.cos(l),
        p[0] + u * r * Math.sin(f),
        p[1] - u * o * Math.cos(f),
        p[0],
        p[1],
      ),
        (l = f));
    }
    return this;
  }
  close() {
    return this.d + "Z";
  }
}
const ev = (e) => {
    const t = e.length;
    let n = `M${Te(e[0][0])} ${Te(e[0][1])}`;
    for (let r = 0; r < t; r++) {
      const o = e[(r - 1 + t) % t],
        s = e[r],
        i = e[(r + 1) % t],
        a = e[(r + 2) % t];
      n += `C${Te(s[0] + (i[0] - o[0]) / 6)} ${Te(s[1] + (i[1] - o[1]) / 6)} ${Te(i[0] - (a[0] - s[0]) / 6)} ${Te(i[1] - (a[1] - s[1]) / 6)} ${Te(i[0])} ${Te(i[1])}`;
    }
    return n + "Z";
  };
const ar = (e, t = 128) => {
    const n = [];
    for (let r = 0; r < t; r++) n.push(e((r / t) * Pt));
    return ev(n);
  };
const ac = (e, t) => {
    const n = new gn(),
      r = e.length;
    for (let o = 0; o < r; o++) {
      const s = typeof t == "number" ? t : t[o % t.length];
      n.corner(e[(o - 1 + r) % r], e[o], e[(o + 1) % r], s);
    }
    return n.close();
  };
const eh = (e, t, n, r = 0) =>
    ac(
      Array.from({ length: t }, (o, s) => {
        const i = r + (s / t) * Pt;
        return [x + Math.cos(i) * e, x + Math.sin(i) * e];
      }),
      n,
    );
const th = (e, t = 160) =>
    ar((n) => {
      const r = Math.cos(n),
        o = Math.sin(n);
      let s = 0;
      for (const [i, a, c] of e) {
        const u = i - x,
          l = a - x,
          d = r * u + o * l,
          f = d * d - (u * u + l * l) + c * c;
        if (f <= 0) continue;
        const h = d + Math.sqrt(f);
        h > s && (s = h);
      }
      return [x + r * s, x + o * s];
    }, t);
const El = (e, t, n) =>
    ar((r) => {
      const o = Math.cos(r),
        s = Math.sin(r);
      return [
        x + Math.sign(o) * Math.pow(Math.abs(o), 2 / n) * e,
        x + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * t,
      ];
    });
const tv = (e, t) =>
    new gn()
      .move(x - e + t, x - t)
      .line(x + e - t, x - t)
      .arc(x + e - t, x, t, t, -Math.PI / 2, Math.PI / 2)
      .line(x - e + t, x + t)
      .arc(x - e + t, x, t, t, Math.PI / 2, (Math.PI * 3) / 2)
      .close();
const nv = (e, t) =>
    new gn()
      .move(x - e, x + t - e)
      .line(x - e, x - t + e)
      .arc(x, x - t + e, e, e, Math.PI, Pt)
      .line(x + e, x + t - e)
      .arc(x, x + t - e, e, e, 0, Math.PI)
      .close();
const rv = (e, t, n) =>
    new gn()
      .move(x - e, x - t + n)
      .arc(x, x - t + n, e, n, Math.PI, Pt)
      .line(x + e, x + t - n)
      .arc(x, x + t - n, e, n, 0, Math.PI)
      .close();
const ov = (e, t, n) => {
    const r = x + t;
    return new gn()
      .move(x - e, r - n)
      .arc(x, r - n, e, 2 * t - n, Math.PI, Pt)
      .line(x + e, r - n)
      .curve(x + e, r, x + e, r, x + e - n, r)
      .line(x - e + n, r)
      .curve(x - e, r, x - e, r, x - e, r - n)
      .close();
  };
const sv = (e, t, n) => {
    const r = x + t,
      o = x - t + e;
    return new gn()
      .move(x - e, o)
      .arc(x, o, e, e, Math.PI, Pt)
      .line(x + e, r - n)
      .curve(x + e, r, x + e, r, x + e - n, r)
      .line(x - e + n, r)
      .curve(x - e, r, x - e, r, x - e, r - n)
      .close();
  };
const iv = (e, t, n) => {
    const r = x - t,
      o = x + t;
    return new gn()
      .move(x - e, r + n)
      .curve(x - e, r - 2, x - e * 0.5, r - 10, x, r - 10)
      .curve(x + e * 0.5, r - 10, x + e, r - 2, x + e, r + n)
      .curve(x + e, x + t * 0.42, x + e * 0.62, o, x, o)
      .curve(x - e * 0.62, o, x - e, x + t * 0.42, x - e, r + n)
      .close();
  };
const av = (e, t, n) =>
    ar((r) => {
      const o = Math.cos(r),
        s = Math.sin(r),
        i = (1 - s) / 2;
      return [x + o * e * (1 - n * i * i), x + s * t];
    });
const cv = (e, t, n, r) => {
    const o = ic(e / (n - t), -1, 1),
      s = Math.sqrt(1 - o * o),
      i = [x + e * s, n - e * o],
      a = [x - e * s, n - e * o],
      c = Math.atan2(i[1] - n, i[0] - x);
    return new gn()
      .corner(i, [x, t], a, r)
      .line(a[0], a[1])
      .arc(x, n, e, e, Math.PI - c, c)
      .close();
  };
const uv = (e, t) =>
    ac(
      [
        [x - e, x - e],
        [x + e, x - e],
        [x + e, x + e],
        [x - e, x + e],
      ],
      t,
    );
const lv = (e, t, n, r) =>
    ac(
      [
        [x - e, x + t],
        [x + e, x + t],
        [x + e, x - t + n],
        [x, x - t],
        [x - e, x - t + n],
      ],
      r,
    );
const dv =
    "M79.4511 11.5693C94.8767 -3.85636 119.887 -3.85622 135.312 11.5693C150.738 26.995 150.738 52.0049 135.312 67.4306L129.302 73.4404L129.303 73.4414L83.7724 118.972C81.8111 120.933 79.4309 122.22 76.9199 122.833C76.463 122.944 76.0018 123.034 75.538 123.101C74.1477 123.301 72.734 123.301 71.3437 123.101C70.8802 123.034 70.4194 122.944 69.9628 122.833C69.8486 122.805 69.7347 122.776 69.621 122.745C69.3938 122.684 69.1679 122.616 68.9433 122.544C67.4837 122.073 66.0831 121.367 64.8017 120.426C64.6047 120.281 64.4108 120.13 64.2197 119.975C63.837 119.662 63.466 119.328 63.1093 118.972L11.5693 67.4306C-3.85643 52.0049 -3.85642 26.995 11.5693 11.5693C26.995 -3.85643 52.0049 -3.85643 67.4306 11.5693L73.4404 17.579L79.4511 11.5693Z";
const fv =
    "M58.9438 9.25323C63.2492 -3.08441 80.6974 -3.08441 85.0027 9.25322L91.7612 28.6207C94.0136 35.0751 100.652 38.9078 107.368 37.6311L127.52 33.8004C140.357 31.3602 149.081 46.4708 140.549 56.3681L127.156 71.9049C122.692 77.0827 122.692 84.748 127.156 89.9258L140.549 105.463C149.081 115.36 140.357 130.471 127.52 128.03L107.368 124.2C100.652 122.923 94.0136 126.756 91.7612 133.21L85.0027 152.577C80.6974 164.915 63.2492 164.915 58.9438 152.577L52.1853 133.21C49.933 126.756 43.2946 122.923 36.5788 124.2L16.4268 128.03C3.58942 130.471 -5.1347 115.36 3.39733 105.463L16.7908 89.9258C21.2543 84.748 21.2543 77.0827 16.7908 71.9049L3.39734 56.3681C-5.13469 46.4708 3.58941 31.3602 16.4268 33.8004L36.5787 37.6311C43.2946 38.9078 49.933 35.0751 52.1853 28.6207L58.9438 9.25323Z";
const hv =
    "M93.9365 0.100586C98.4439 -0.387322 102.691 0.897134 106.341 4.03418C111.502 8.47087 114.842 16.0545 116.636 25.2725C118.36 34.1341 118.716 44.8177 117.701 56.4346L117.707 56.4375L117.706 56.4443C122.25 58.5638 126.519 60.8171 130.449 63.168C130.485 63.1891 130.52 63.2103 130.556 63.2314C131.25 63.6478 131.934 64.067 132.607 64.4893C132.68 64.5349 132.753 64.5813 132.825 64.627C133.074 64.7838 133.322 64.941 133.567 65.0986C133.692 65.1787 133.816 65.2596 133.94 65.3398C134.138 65.4676 134.335 65.5954 134.53 65.7236C134.653 65.8039 134.775 65.8844 134.896 65.9648C135.112 66.1073 135.325 66.2506 135.538 66.3936C135.625 66.4522 135.713 66.5106 135.8 66.5693C138.866 68.645 141.667 70.7792 144.163 72.9502C149.754 77.8126 153.981 83.0002 156.136 88.2578C156.159 88.3133 156.181 88.3693 156.203 88.4248C156.268 88.5868 156.332 88.749 156.393 88.9111C156.435 89.0226 156.475 89.1346 156.516 89.2461C156.541 89.3175 156.566 89.3895 156.591 89.4609C157.443 91.8917 157.839 94.3199 157.696 96.7109C157.522 99.7997 156.469 102.655 154.613 105.192C154.236 105.709 153.826 106.208 153.388 106.692C153.365 106.717 153.343 106.742 153.32 106.767C153.171 106.93 153.019 107.091 152.863 107.25C152.844 107.27 152.824 107.29 152.804 107.311C152.3 107.822 151.762 108.316 151.191 108.79C151.168 108.81 151.144 108.83 151.12 108.85C150.952 108.988 150.781 109.125 150.607 109.261C150.558 109.299 150.509 109.337 150.46 109.375C150.282 109.512 150.101 109.648 149.917 109.781C149.903 109.792 149.888 109.801 149.874 109.812C149.255 110.26 148.605 110.689 147.926 111.1C147.795 111.179 147.662 111.256 147.528 111.334C147.41 111.403 147.292 111.473 147.173 111.541C146.915 111.687 146.653 111.832 146.388 111.974C146.316 112.012 146.243 112.047 146.171 112.085C145.978 112.186 145.783 112.287 145.586 112.386C145.459 112.449 145.331 112.511 145.203 112.573C145.048 112.649 144.891 112.723 144.733 112.797C144.614 112.853 144.494 112.909 144.373 112.964C144.198 113.044 144.021 113.122 143.843 113.2C143.722 113.253 143.6 113.306 143.478 113.358C143.288 113.439 143.096 113.519 142.903 113.598C142.836 113.625 142.769 113.655 142.701 113.683C142.662 113.698 142.622 113.712 142.583 113.728C142.371 113.812 142.156 113.895 141.94 113.978C141.847 114.013 141.753 114.051 141.658 114.086C140.71 114.441 139.731 114.771 138.725 115.078C138.613 115.112 138.502 115.145 138.39 115.179C138.257 115.218 138.123 115.26 137.989 115.299C137.911 115.322 137.831 115.343 137.752 115.365C137.61 115.406 137.467 115.446 137.324 115.485C137.095 115.549 136.863 115.611 136.63 115.672C136.52 115.701 136.41 115.73 136.3 115.759C136.064 115.819 135.827 115.879 135.588 115.938C135.451 115.971 135.314 116.004 135.177 116.037C134.975 116.085 134.772 116.131 134.568 116.178C134.312 116.236 134.054 116.294 133.795 116.35C133.535 116.406 133.274 116.461 133.011 116.515C132.85 116.547 132.688 116.578 132.525 116.61C132.333 116.648 132.14 116.686 131.946 116.723C131.689 116.771 131.43 116.818 131.17 116.864C131.075 116.881 130.979 116.898 130.884 116.914C130.595 116.964 130.304 117.012 130.012 117.06C129.932 117.073 129.851 117.085 129.771 117.098C129.484 117.143 129.196 117.188 128.906 117.23C128.818 117.243 128.729 117.256 128.641 117.269C127.33 117.457 125.983 117.62 124.601 117.755C124.468 117.768 124.336 117.782 124.203 117.794C123.92 117.82 123.636 117.845 123.351 117.869C123.24 117.878 123.13 117.888 123.02 117.897C122.701 117.923 122.381 117.948 122.059 117.971C121.967 117.977 121.874 117.984 121.782 117.99C121.463 118.012 121.143 118.033 120.82 118.053C120.73 118.058 120.639 118.063 120.549 118.068C119.546 118.126 118.527 118.171 117.492 118.202C117.322 118.207 117.151 118.213 116.979 118.218C116.785 118.223 116.59 118.225 116.395 118.229C116.147 118.235 115.899 118.24 115.65 118.244C115.415 118.248 115.178 118.25 114.94 118.252C114.688 118.254 114.435 118.256 114.181 118.257C114.008 118.257 113.835 118.257 113.662 118.257C113.32 118.256 112.976 118.255 112.631 118.252C112.503 118.251 112.375 118.25 112.247 118.248C111.858 118.243 111.466 118.237 111.073 118.229C110.984 118.227 110.894 118.226 110.804 118.224C107.734 118.154 104.558 117.977 101.289 117.69C96.3593 128.261 90.7082 137.338 84.7832 144.151C78.6204 151.238 71.9357 156.137 65.2471 157.399C60.5179 158.292 56.1975 157.281 52.5381 154.604C48.9431 151.975 46.1246 147.845 44.0479 142.691C40.0321 132.725 38.5457 118.333 40.043 101.281C40.0382 101.279 40.0331 101.277 40.0283 101.274C39.6986 101.121 39.3711 100.965 39.0449 100.811C38.8351 100.711 38.6254 100.612 38.417 100.512C38.0794 100.35 37.7438 100.186 37.4102 100.023C37.2392 99.9399 37.0684 99.8563 36.8984 99.7725C36.5886 99.6196 36.2801 99.4663 35.9736 99.3125C35.7564 99.2034 35.5398 99.0939 35.3242 98.9844C34.9817 98.8104 34.6409 98.636 34.3027 98.4609C34.2424 98.4297 34.1823 98.3975 34.1221 98.3662C19.2858 90.6566 8.70839 81.8767 3.56055 73.3232C3.50461 73.2303 3.44926 73.137 3.39453 73.0439C3.37308 73.0075 3.35134 72.971 3.33008 72.9346C3.19352 72.7003 3.06142 72.4652 2.93262 72.2305C2.19429 70.8865 1.58552 69.5375 1.11816 68.1895C1.10444 68.1499 1.09161 68.1099 1.07813 68.0703C1.04009 67.9586 1.00191 67.847 0.96582 67.7354C0.954674 67.7009 0.943578 67.6663 0.932617 67.6318C0.823298 67.2877 0.723275 66.9435 0.632813 66.5996C-0.103732 63.8123 -0.218301 61.0433 0.402344 58.3643C1.34437 54.2986 3.89972 50.7745 7.875 47.9023C7.90661 47.8794 7.93796 47.8559 7.96973 47.833C8.12646 47.7208 8.2852 47.6092 8.44629 47.499C8.57825 47.4084 8.71216 47.3194 8.84668 47.2305C8.87052 47.2148 8.89404 47.1983 8.91797 47.1826C10.608 46.0723 12.497 45.0908 14.5547 44.2324C14.6355 44.1986 14.7165 44.1643 14.7979 44.1309C14.8508 44.1092 14.9038 44.087 14.957 44.0654L15.25 43.9482C15.3501 43.9084 15.4509 43.8694 15.5518 43.8301C15.6093 43.8078 15.6668 43.7848 15.7246 43.7627C23.7646 40.6682 34.1765 39.3165 45.6846 39.4756C45.8574 39.4779 46.0307 39.4814 46.2041 39.4844C46.4305 39.4884 46.6576 39.4909 46.8848 39.4961C47.3568 39.5065 47.8313 39.5207 48.3076 39.5361C48.4142 39.5397 48.5212 39.5441 48.6279 39.5479C51.1795 39.6366 53.791 39.7967 56.4512 40.0293C63.6811 24.5137 72.1655 12.7934 80.627 6.1709C85.0025 2.74635 89.5085 0.57999 93.9365 0.100586Z";
const pv = (e, t) =>
    th([
      [x - e, x - e, t],
      [x + e, x - e, t],
      [x + e, x + e, t],
      [x - e, x + e, t],
    ]);
const mv = (e, t, n) =>
    ar((r) => {
      const o = Math.cos(r),
        s = Math.sin(r);
      return [
        x + o * e * Math.pow(Math.max(1 - s * s, 0), n / 2 - 0.5) * 1,
        x + s * t,
      ];
    });
const gv = (e, t, n, r) =>
    ar((o) => {
      const s = (a) => {
          const c = Math.abs(((((o - a + Math.PI) % Pt) + Pt) % Pt) - Math.PI);
          return Math.exp(-(c * c) / 0.4232);
        },
        i = 1 - n * s(r) + n * 0.34 * s(r + Math.PI);
      return [x + Math.cos(o) * e * i, x + Math.sin(o) * t * i];
    });
const yv = (e, t, n) =>
    ar((r) => {
      const o =
        e * (1 + t * (Math.sin(r * 2 + n) * 0.6 + Math.sin(r * 3 - n) * 0.4));
      return [x + Math.cos(r) * o, x + Math.sin(r) * o * 0.98];
    });
const is = (e, t = 4) => {
    const n = e.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [],
      r = [];
    let o = 0,
      s = "",
      i = 0,
      a = 0,
      c = 0,
      u = 0;
    const l = () => parseFloat(n[o++]),
      d = (f, h) => {
        const p = Math.max(2, Math.ceil(h / t));
        for (let g = 1; g <= p; g++) r.push(f(g / p));
      };
    for (; o < n.length; ) {
      if ((/[a-z]/i.test(n[o]) && (s = n[o++].toUpperCase()), s === "Z")) {
        (Math.hypot(c - i, u - a) > 0.01 &&
          d(
            (f) => [i + (c - i) * f, a + (u - a) * f],
            Math.hypot(c - i, u - a),
          ),
          (i = c),
          (a = u));
        continue;
      }
      if (o >= n.length) break;
      if (s === "M")
        ((i = l()), (a = l()), (c = i), (u = a), r.push([i, a]), (s = "L"));
      else if (s === "L") {
        const f = l(),
          h = l();
        (d((p) => [i + (f - i) * p, a + (h - a) * p], Math.hypot(f - i, h - a)),
          (i = f),
          (a = h));
      } else if (s === "Q") {
        const f = l(),
          h = l(),
          p = l(),
          g = l(),
          m = i,
          y = a;
        (d(
          (w) => {
            const S = 1 - w;
            return [
              S * S * m + 2 * S * w * f + w * w * p,
              S * S * y + 2 * S * w * h + w * w * g,
            ];
          },
          Math.hypot(f - i, h - a) + Math.hypot(p - f, g - h),
        ),
          (i = p),
          (a = g));
      } else {
        const f = l(),
          h = l(),
          p = l(),
          g = l(),
          m = l(),
          y = l(),
          w = i,
          S = a;
        (d(
          (b) => {
            const v = 1 - b;
            return [
              v * v * v * w +
                3 * v * v * b * f +
                3 * v * b * b * p +
                b * b * b * m,
              v * v * v * S +
                3 * v * v * b * h +
                3 * v * b * b * g +
                b * b * b * y,
            ];
          },
          Math.hypot(f - i, h - a) +
            Math.hypot(p - f, g - h) +
            Math.hypot(m - p, y - g),
        ),
          (i = m),
          (a = y));
      }
    }
    return r;
  };
const kv = (e, t = 160) => {
    let n = 1 / 0,
      r = -1 / 0;
    for (const d of e) (d[1] < n && (n = d[1]), d[1] > r && (r = d[1]));
    const o = r - n,
      s = (d) => n + (o * (d + 0.5)) / t,
      i = new Float64Array(t),
      a = new Float64Array(t),
      c = new Float64Array(t),
      u = new Float64Array(t);
    for (let d = 0; d < t; d++) {
      const f = s(d);
      let h = -1 / 0,
        p = 1 / 0,
        g = 1 / 0,
        m = -1 / 0;
      for (let y = 0; y < e.length; y++) {
        const w = e[y],
          S = e[(y + 1) % e.length];
        if (w[1] <= f == S[1] <= f) continue;
        const b = w[0] + ((S[0] - w[0]) * (f - w[1])) / (S[1] - w[1]);
        (b <= x ? b > h && (h = b) : b < p && (p = b),
          b < g && (g = b),
          b > m && (m = b));
      }
      ((i[d] = Number.isFinite(h) ? h : x),
        (a[d] = Number.isFinite(p) ? p : x),
        (c[d] = Number.isFinite(g) ? g : x),
        (u[d] = Number.isFinite(m) ? m : x));
    }
    const l = (d, f) => (h) => {
      const p = ic(((h - n) / o) * t - 0.5, 0, t - 1),
        g = Math.floor(p),
        m = p - g,
        y = Math.min(g + 1, t - 1);
      return [d[g] + (d[y] - d[g]) * m, f[g] + (f[y] - f[g]) * m];
    };
    return { top: n, bottom: r, spanAt: l(i, a), outerAt: l(c, u) };
  };
const Pl = 96;
const wv = (e) =>
    Array.from({ length: Pl }, (t, n) => {
      const r = (n / Pl) * Pt,
        o = Math.cos(r),
        s = Math.sin(r);
      let i = 0;
      for (let a = 0; a < e.length; a++) {
        const c = e[a],
          u = e[(a + 1) % e.length],
          l = c[0] - x,
          d = c[1] - x,
          f = u[0] - x,
          h = u[1] - x,
          p = (f - l) * s - (h - d) * o;
        if (Math.abs(p) < 1e-9) continue;
        const g = (l * s - d * o) / -p;
        if (g < 0 || g > 1) continue;
        const m = (l + (f - l) * g) * o + (d + (h - d) * g) * s;
        m > i && (i = m);
      }
      return [x + o * i, x + s * i];
    });
const bv = (e, t, n, r) => {
    let o = 0;
    return e.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (s) => {
      o ^= 1;
      const i = parseFloat(s) + (o ? n : r);
      return String(Te(x + (i - x) * t));
    });
  };
const xv = 228.44;
const vv = (e) => {
    let t = 1 / 0,
      n = -1 / 0,
      r = 1 / 0,
      o = -1 / 0;
    for (const c of e)
      (c[0] < t && (t = c[0]),
        c[0] > n && (n = c[0]),
        c[1] < r && (r = c[1]),
        c[1] > o && (o = c[1]));
    const s = x - (t + n) / 2,
      i = x - (r + o) / 2;
    return { k: ic(xv / Math.max(n - t, o - r), 0.9, 1.35), dx: s, dy: i };
  };
const Sv = (e, t) => {
    const { k: n, dx: r, dy: o } = vv(t);
    return Math.abs(n - 1) < 0.005 && Math.abs(r) < 0.5 && Math.abs(o) < 0.5
      ? e
      : bv(e, n, r, o);
  };
const cc = (e) => {
    const t = Sv(e, is(e)),
      n = is(t),
      { top: r, bottom: o, spanAt: s, outerAt: i } = kv(n);
    let a = 0;
    for (let c = r; c <= o; c += 2) {
      const [u, l] = i(c);
      a = Math.max(a, (l - u) / 2);
    }
    return {
      path: t,
      ring: wv(n),
      top: Te(r),
      bottom: Te(o),
      spanAt: s,
      beltRadius: Te(a),
    };
  };
const Mv = {
    pebble: () => yv(108, 0.075, 1.1),
    bean: () => gv(94, 112, 0.34, Math.PI),
    egg: () => av(98, 113, 0.22),
    squircle: () => El(107, 107, 3.2),
    square: () => uv(107, 28),
    tablet: () => tv(114, 74),
    capsule: () => nv(72, 113),
    cylinder: () => rv(94, 110, 48),
    hex: () => eh(114, 6, 20, Math.PI / 6),
    gem: () => El(112, 113, 1.5),
    shield: () => iv(98, 108, 30),
    dome: () => ov(114, 82, 26),
    arch: () => sv(76, 113, 42),
    cloud: () =>
      th([
        [x - 62, x + 26, 56],
        [x + 62, x + 26, 54],
        [x, x + 34, 62],
        [x - 24, x - 30, 62],
        [x + 38, x - 26, 54],
      ]),
    leaf: () => mv(88, 113, 1.5),
    clover: () => pv(38, 58),
    house: () => lv(100, 110, 78, 29),
    heart: () => dv,
    sparkle: () => hv,
    star6: () => fv,
  };
const Al = new Map();
function Kr(e) {
  const t = Al.get(e);
  if (t != null) return t;
  const n = cc(Mv[e]());
  return (Al.set(e, n), n);
}
const mt = (e, t = 4) => is(Kr(e).path, t);
const Il = (e) => is(e);
const nh = (e, t) => cc(cv(e, x - 114, x + 26, t));
const Tv = (e, t) => cc(eh(130, 3, [t, e, e], -Math.PI / 2));
const Fr = Math.PI * 2;
const Ev = 0.36;
const Pv = 0.22;
const Ar = 4;
const _l = 96;
const Cl = 64;
const Rl = 33;
const Av = 40;
const rh = 0.72;
const $l = 16;
const Ol = 160;
const jn = 180;
const fi = 64;
const ho = 1e-5;
const Iv = {
    pebble: () => qn(1.2167999999999999, "pebble"),
    bean: () => {
      const e = Lv("bean");
      return {
        size: 1.17,
        silhouette: { kind: "solid", samples: [], balls: e, isLoop: !1 },
        seat: sh("bean", e),
      };
    },
    egg: () => qn(1.17, "egg"),
    squircle: () => ({
      size: 1.17,
      silhouette: Qn(Rv("squircle", 0.28, 0.11)),
      seat: { kind: "front", faceZ: 0.28 },
    }),
    tablet: () => {
      const { x0: e, x1: t, y0: n, y1: r } = aa("tablet"),
        o = (t - e) / 2 / x,
        s = (r - n) / 2 / x,
        i = Math.max(0, o - s);
      return {
        size: 1.3922999999999999,
        silhouette: {
          kind: "solid",
          samples: [],
          balls: jl("tablet", "x"),
          isLoop: !1,
        },
        seat: {
          kind: "wrapX",
          wrapR: s,
          wrapX0: -o + 0.02,
          wrapX1: o - 0.02,
          radiusAtX: (a) => {
            const c = Math.abs(a) - i;
            return c <= 0 ? s : Math.sqrt(Math.max(0, s * s - c * c));
          },
        },
      };
    },
    capsule: () => {
      const e = jl("capsule", "y"),
        { y0: t, y1: n } = aa("capsule"),
        r = -(n - x) / x,
        o = -(t - x) / x,
        { hx: s, hz: i } = Ov(e);
      return {
        size: 1.17,
        silhouette: { kind: "solid", samples: [], balls: e, isLoop: !1 },
        seat: {
          kind: "wrap",
          wrapR: Math.max(0.35, (s + i) * 0.5),
          wrapY0: r,
          wrapY1: o,
          eyeY: (r + o) * 0.5,
        },
      };
    },
    cylinder: () => Fl("cylinder", (e, t) => (t + e) * 0.5),
    hex: () => Bn(1.2519, Jt(mt("hex"))),
    gem: () => qn(1.17, "gem"),
    crystal: () => ({
      size: 1.3805999999999998,
      silhouette: Qn($v()),
      seat: { kind: "front", faceZ: 0.64 * (Math.sqrt(3) / 2) },
    }),
    wedge: () => {
      const e = Tv(60, 80),
        t = Il(e.path),
        [n, r] = e.spanAt(e.top + (e.bottom - e.top) * 0.5),
        o = -(e.top - x) / x,
        s = -(e.bottom - x) / x;
      return {
        size: 1.3590719999999998,
        silhouette: Qn(ca(t)),
        seat: {
          kind: "wrap",
          wrapR: Math.max(0.2, (r - n) / 2 / x),
          wrapY0: s,
          wrapY1: o,
          eyeY: o + (s - o) * 0.5,
          radiusAt: ua(t),
        },
      };
    },
    shield: () => qn(1.17, "shield"),
    dome: () => qn(1.17, "dome"),
    arch: () => Fl("arch", (e, t) => e + (t - e) * 0.42),
    cloud: () => zl(1.3455, Jt(mt("cloud", 1)), 0.72),
    teardrop: () => {
      const e = nh(88, 48),
        t = Il(e.path),
        [n, r] = e.spanAt(e.top + (e.bottom - e.top) * 0.62),
        o = -(e.bottom - x) / x,
        s = -(e.top - x) / x;
      return {
        size: 1.318122,
        silhouette: Qn(ca(t)),
        seat: {
          kind: "wrap",
          wrapR: Math.max(0.2, (r - n) / 2 / x),
          wrapY0: o,
          wrapY1: s,
          eyeY: (o + s) * 0.5,
          radiusAt: ua(t),
        },
      };
    },
    leaf: () => qn(1.17, "leaf"),
    square: () => Bn(1.0413, Jt(mt("square"))),
    starFlower: () => Bn(1.3922999999999999, Fv()),
    sparkle: () => Bn(1.521, Jt(mt("sparkle"))),
    clover: () => Bn(1.0881, Jt(mt("clover"))),
    heartChubby: () => zl(1.3571999999999997, Jx, 0.62),
    house: () => Bn(1.17, Jt(mt("house"))),
    star6: () => oh(1.4976, Jt(mt("star6")), 0.3, 0.18),
  };
const Ll = new Map();
let Nl = null;
function As(e) {
  const t = Ll.get(e);
  if (t != null) return t;
  const n = Iv[e]();
  return (Ll.set(e, n), n);
}
function _v() {
  return (
    (Nl ??= {
      size: 1.17,
      silhouette: {
        kind: "solid",
        samples: Jt(mt("bean")),
        balls: [],
        isLoop: !0,
      },
      seat: null,
    }),
    Nl
  );
}
function Qn(e) {
  return { kind: "solid", samples: e, balls: [], isLoop: !1 };
}
function qn(e, t) {
  return { size: e, silhouette: Qn(ah(t)), seat: sh(t, []) };
}
function Fl(e, t) {
  const n = Kr(e),
    r = -(n.top - x) / x,
    o = -(n.bottom - x) / x;
  return {
    size: 1.17,
    silhouette: Qn(ah(e)),
    seat: {
      kind: "wrap",
      wrapR: n.beltRadius / x,
      wrapY0: o,
      wrapY1: r,
      eyeY: t(r, o),
      radiusAt: ch(e),
    },
  };
}
function Bn(e, t) {
  return oh(e, t, Ev, Pv);
}
function oh(e, t, n, r) {
  return {
    size: e,
    silhouette: { kind: "extrusion", rings: Nv(t, n, r) },
    seat: { kind: "front", faceZ: n },
  };
}
function zl(e, t, n) {
  const r = zv(t, n);
  return {
    size: e,
    silhouette: { kind: "loft", rings: r.rings },
    seat: { kind: "loft", surfaceZ: Dv(r) },
  };
}
function sh(e, t) {
  const n = Kr(e),
    r = -(n.bottom - x) / x,
    o = -(n.top - x) / x,
    s = ch(e),
    i = Math.min(o - 0.02, Math.max(r + 0.02, 0));
  return {
    kind: "wrap",
    wrapR: s(i),
    wrapY0: r,
    wrapY1: o,
    eyeY: i,
    radiusAt: s,
    puffAt: t.length > 0 ? (a, c) => Cv(t, a, c) : void 0,
  };
}
function Cv(e, t, n) {
  let r = e[0],
    o = -1 / 0,
    s = 1 / 0,
    i = !1;
  for (const a of e) {
    const c = Math.hypot(t - a[0], n - a[1]);
    if (c < a[3]) {
      const u = a[2] + Math.sqrt(a[3] * a[3] - c * c);
      (!i || u > o) && ((i = !0), (o = u), (r = a));
    } else !i && c - a[3] < s && ((s = c - a[3]), (r = a));
  }
  return { x: r[0], y: r[1], z: r[2], r: r[3] };
}
function Jt(e) {
  return e.map(([t, n]) => ({ x: (t - x) / x, y: -(n - x) / x, z: 0 }));
}
function aa(e) {
  let t = 1 / 0,
    n = -1 / 0,
    r = 1 / 0,
    o = -1 / 0;
  for (const [s, i] of Kr(e).ring)
    (s < t && (t = s), s > n && (n = s), i < r && (r = i), i > o && (o = i));
  return { x0: t, x1: n, y0: r, y1: o };
}
function Rv(e, t, n) {
  const r = Kr(e).ring.map(([i, a]) => ({ x: (i - x) / x, y: -(a - x) / x })),
    o = r.length,
    s = [];
  for (let i = 0; i < o; i++) {
    const a = r[i],
      c = r[(i - 1 + o) % o],
      u = r[(i + 1) % o];
    let l = u.y - c.y,
      d = -(u.x - c.x);
    const f = Math.hypot(l, d) || 1;
    ((l /= f), (d /= f), l * a.x + d * a.y < 0 && ((l = -l), (d = -d)));
    for (let h = 0; h <= Ar; h++) {
      const p = (h / Ar) * (Math.PI / 2),
        g = n * (1 - Math.cos(p)),
        m = t - n + n * Math.sin(p);
      (s.push({ x: a.x - l * g, y: a.y - d * g, z: m }),
        s.push({ x: a.x - l * g, y: a.y - d * g, z: -m }));
    }
  }
  return s;
}
function $v() {
  const o = 1.1600000000000001,
    s = [
      { x: 0, y: o - 0.12, z: 0 },
      { x: 0, y: -o + 0.12, z: 0 },
    ],
    i = 0.54 - 0.12 * 0.25,
    a = 0.64 - 0.12;
  for (const d of [-1, 1])
    for (let f = 0; f < 6; f++) {
      const h = (f / 6) * Fr;
      s.push({ x: a * Math.cos(h), y: d * i, z: a * Math.sin(h) });
    }
  const c = [],
    u = 8,
    l = 14;
  for (const d of s)
    for (let f = 0; f <= u; f++) {
      const h = (f / u) * Math.PI,
        p = Math.sin(h),
        g = f === 0 || f === u ? 1 : l;
      for (let m = 0; m < g; m++) {
        const y = (m / g) * Fr;
        c.push({
          x: d.x + 0.12 * p * Math.sin(y),
          y: d.y + 0.12 * Math.cos(h),
          z: d.z + 0.12 * p * Math.cos(y),
        });
      }
    }
  return c;
}
function ih(e) {
  const t = e.length;
  let n = 1 / 0,
    r = -1 / 0;
  for (const [, i] of e) (i < n && (n = i), i > r && (r = i));
  ((n -= ho), (r += ho));
  const o = (i) => Math.min(fi - 1, Math.floor(((i - n) / (r - n)) * fi)),
    s = Array.from({ length: fi }, () => []);
  for (let i = 0; i < t; i++) {
    const a = e[i][1],
      c = e[(i + 1) % t][1],
      u = o(Math.max(a, c) + ho);
    for (let l = o(Math.min(a, c) - ho); l <= u; l++) s[l].push(i);
  }
  return (i) => {
    let a = 1 / 0,
      c = -1 / 0;
    if (!(i >= n && i <= r)) return c - a;
    for (const u of s[o(i)]) {
      const [l, d] = e[u],
        [f, h] = e[(u + 1) % t];
      if (Math.abs(h - d) < 1e-9) {
        Math.abs(d - i) < 1e-6 &&
          ((a = Math.min(a, l, f)), (c = Math.max(c, l, f)));
        continue;
      }
      if ((d <= i && h >= i) || (h <= i && d >= i)) {
        const p = l + ((f - l) * (i - d)) / (h - d);
        (p < a && (a = p), p > c && (c = p));
      }
    }
    return c - a;
  };
}
function ah(e) {
  return ca(mt(e));
}
function ca(e) {
  let t = 1 / 0,
    n = -1 / 0;
  for (const [, h] of e) (h < t && (t = h), h > n && (n = h));
  const r = [],
    o = -(t - x) / x,
    s = -(n - x) / x,
    i = ih(e),
    a = (h) => {
      const p = i(h);
      return p < 0 ? 0 : p / 2 / x;
    },
    c = n - t,
    u = (h, p) => {
      if (a(h) >= 0.06) return null;
      const g = a(h);
      let m = c * 0.02;
      for (let y = c / 512; y <= c * 0.05; y += c / 512)
        if (Math.abs(a(h + p * y) - g) > 1e-4) {
          m = y;
          break;
        }
      return { yEdge: h, sign: p, dJoin: m, rJoin: a(h + p * m) };
    },
    l = [u(t, 1), u(n, -1)].filter((h) => h !== null),
    d = (h) => {
      let p = a(h);
      for (const g of l) {
        const m = (h - g.yEdge) * g.sign;
        m >= 0 &&
          m < g.dJoin &&
          (p = Math.min(p, g.rJoin * Math.sqrt(m / g.dJoin)));
      }
      return p;
    },
    f = (h, p) => {
      const g = d(p);
      g < 0.06 ? r.push({ x: 0, y: h, z: 0 }) : r.push(...Dl(h, g));
    };
  f(o, t);
  for (let h = 1; h < _l - 1; h++) {
    const p = (1 - Math.cos(Math.PI * (h / (_l - 1)))) / 2,
      g = t + (n - t) * p,
      m = d(g),
      y = -(g - x) / x;
    if (m < 1e-4) {
      r.push({ x: 0, y, z: 0 });
      continue;
    }
    r.push(...Dl(y, m));
  }
  return (f(s, n), r);
}
function Dl(e, t) {
  const n = [];
  for (let r = 0; r < Cl; r++) {
    const o = (r / Cl) * Fr;
    n.push({ x: t * Math.sin(o), y: e, z: t * Math.cos(o) });
  }
  return n;
}
function ch(e) {
  return ua(mt(e));
}
function ua(e) {
  const t = ih(e);
  let n = 1 / 0,
    r = -1 / 0;
  for (const [, o] of e) (o < n && (n = o), o > r && (r = o));
  return (o) => {
    const s = Math.max(n, Math.min(r, x - o * x));
    return Math.max(0.02, t(s) / 2 / x);
  };
}
function jl(e, t) {
  const { x0: n, x1: r, y0: o, y1: s } = aa(e),
    i = (r - n) / 2 / x,
    a = (s - o) / 2 / x,
    c = t === "x" ? a : i,
    u = Math.max(0, (t === "x" ? i : a) - c),
    l = -u,
    d = [];
  for (let f = 0; f < Rl; f++) {
    const h = l + (u - l) * (f / (Rl - 1));
    d.push(t === "x" ? [h, 0, 0, c] : [0, h, 0, c]);
  }
  return d;
}
function Ov(e) {
  let t = 0.55,
    n = 0.35;
  for (const [r, , o, s] of e)
    ((t = Math.max(t, Math.abs(r) + s)), (n = Math.max(n, Math.abs(o) + s)));
  return { hx: t, hz: n };
}
function Lv(e) {
  const t = mt(e);
  let n = 1 / 0,
    r = -1 / 0,
    o = 1 / 0,
    s = -1 / 0;
  for (const [l, d] of t)
    ((n = Math.min(n, l)),
      (r = Math.max(r, l)),
      (o = Math.min(o, d)),
      (s = Math.max(s, d)));
  const i = (l, d) => {
      let f = !1;
      const h = t.length;
      for (let p = 0, g = h - 1; p < h; g = p++) {
        const [m, y] = t[p],
          [w, S] = t[g];
        y > d != S > d && l < m + ((w - m) * (d - y)) / (S - y) && (f = !f);
      }
      return f;
    },
    a = Math.max(r - n, s - o) / Av,
    c = [];
  for (let l = o + a / 2; l < s; l += a)
    for (let d = n + a / 2; d < r; d += a) {
      if (!i(d, l)) continue;
      let f = 1 / 0;
      for (const [p, g] of t) f = Math.min(f, (p - d) ** 2 + (g - l) ** 2);
      const h = Math.sqrt(f);
      h > a && c.push({ x: d, y: l, r: h });
    }
  c.sort((l, d) => d.r - l.r);
  const u = [];
  for (const l of c)
    u.some((d) => Math.hypot(l.x - d.x, l.y - d.y) + l.r <= d.r + a * 0.25) ||
      u.push(l);
  return u.map((l) => [(l.x - x) / x, -(l.y - x) / x, 0, l.r / x]);
}
function Nv(e, t, n) {
  let r = 1 / 0,
    o = -1 / 0,
    s = 1 / 0,
    i = -1 / 0;
  for (const f of e)
    ((r = Math.min(r, f.x)),
      (o = Math.max(o, f.x)),
      (s = Math.min(s, f.y)),
      (i = Math.max(i, f.y)));
  const a = (r + o) / 2,
    c = (s + i) / 2,
    u = Math.max(1e-4, Math.min((o - r) / 2, (i - s) / 2)),
    l = (f, h) => {
      const p = (f / Ar) * (Math.PI / 2),
        g = t - n + n * Math.sin(p);
      return { z: h < 0 ? -g : g, scale: 1 - (n / u) * (1 - Math.cos(p)) };
    },
    d = [];
  for (let f = Ar; f >= 0; f--) d.push(l(f, -1));
  for (let f = 0; f <= Ar; f++) d.push(l(f, 1));
  return d.map(({ z: f, scale: h }) =>
    e.map((p) => ({ x: a + (p.x - a) * h, y: c + (p.y - c) * h, z: f })),
  );
}
function Fv() {
  const r = [{ x: 0, y: 0, r: 0.36 }];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Fr) / 6;
    r.push({ x: 0.58 * Math.cos(a), y: 0.58 * Math.sin(a), r: 0.33 });
  }
  const o = 240,
    s = [];
  for (let i = 0; i < o; i++) {
    const a = (i / o) * Fr,
      c = Math.cos(a),
      u = Math.sin(a);
    let l = 0,
      d = 0.58 + 0.33;
    for (let f = 0; f < 22; f++) {
      const h = (l + d) / 2,
        p = h * c,
        g = h * u;
      r.some((m) => (p - m.x) * (p - m.x) + (g - m.y) * (g - m.y) <= m.r * m.r)
        ? (l = h)
        : (d = h);
    }
    s.push({ x: l * c, y: l * u, z: 0 });
  }
  return s;
}
function zv(e, t) {
  const n = e.length / Ol,
    r = n > 1 ? Array.from({ length: Ol }, (l, d) => e[Math.floor(d * n)]) : e;
  let o = 1 / 0,
    s = -1 / 0,
    i = 1 / 0,
    a = -1 / 0;
  for (const l of r)
    ((o = Math.min(o, l.x)),
      (s = Math.max(s, l.x)),
      (i = Math.min(i, l.y)),
      (a = Math.max(a, l.y)));
  const c = { x: (o + s) / 2, y: (i + a) / 2 },
    u = [];
  for (let l = 0; l <= $l; l++) {
    const d = -Math.PI / 2 + (Math.PI * l) / $l,
      f = Math.pow(Math.max(0, Math.cos(d)), rh),
      h = t * Math.sin(d);
    u.push(
      r.map((p) => ({
        x: c.x + (p.x - c.x) * f,
        y: c.y + (p.y - c.y) * f,
        z: h,
      })),
    );
  }
  return { rings: u, center: c, depth: t };
}
function Dv({ rings: e, center: t, depth: n }) {
  const r = e[Math.floor(e.length / 2)],
    o = new Float64Array(jn);
  for (let i = 0; i < jn; i++) {
    const a = ((i + 0.5) / jn) * Math.PI * 2,
      c = Math.cos(a),
      u = Math.sin(a);
    let l = 0;
    for (let d = 0; d < r.length; d++) {
      const f = r[d],
        h = r[(d + 1) % r.length],
        p = h.x - f.x,
        g = h.y - f.y,
        m = c * g - u * p;
      if (Math.abs(m) < 1e-9) continue;
      const y = f.x - t.x,
        w = f.y - t.y,
        S = (y * g - w * p) / m,
        b = (y * u - w * c) / m;
      S > l && b >= 0 && b <= 1 && (l = S);
    }
    o[i] = l;
  }
  const s = (i, a) => {
    const c = i - t.x,
      u = a - t.y,
      l = Math.hypot(c, u);
    if (l < 1e-8) return 0;
    const f =
        (((Math.atan2(u, c) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) *
        jn,
      h = Math.floor(f) % jn,
      p = f - Math.floor(f),
      g = o[h],
      m = o[(h + 1) % jn];
    return Math.min(1, l / Math.max(1e-8, g * (1 - p) + m * p));
  };
  return (i, a) => n * Math.sqrt(Math.max(0, 1 - Math.pow(s(i, a), 2 / rh)));
}
const Ir = Math.PI * 2;
const jv = 0.2;
const qv = 0.36;
const Bv = 1.18;
const Hv = 160;
const ot = 480;
const Vv = uh(Hv);
const ql = uh(ot);
const Gv = 1.01;
const Wv = 1e-5;
const Uv = 0.01;
const Kv = 8;
function uh(e) {
  return Array.from({ length: e }, (t, n) => {
    const r = (n / e) * Ir;
    return { x: Math.cos(r), y: Math.sin(r) };
  });
}
function uc(e, t) {
  return Math.max(jv, e.size) * ((qv * t) / Bv);
}
function lh(e, t, n) {
  return Zv(e.silhouette, dh(e, t, n)).flatMap(fh);
}
function Xv(e, t, n, r) {
  return e.seat == null ? [] : tS(e.seat, r, dh(e, t, n)).flatMap(fh);
}
function dh(e, t, n) {
  const r = n / 2,
    o = uc(e, n),
    s = Yv(
      (t.yaw * Math.PI) / 180,
      (t.pitch * Math.PI) / 180,
      (t.roll * Math.PI) / 180,
    );
  return {
    rotate: s,
    project: (i) => {
      const a = s(i);
      return { x: r + o * a.x, y: r - o * a.y };
    },
    origin: { x: r, y: r },
    radius: o,
  };
}
function Yv(e, t, n) {
  const [r, o, s] = hi(e),
    [i, a, c] = hi(t),
    [u, l, d] = hi(n);
  return ({ x: f, y: h, z: p }) => {
    const g = f * r + p * o,
      m = h * r + h * s,
      y = p * r - f * o,
      w = g * i + g * c,
      S = m * i - y * a,
      b = y * i + m * a;
    return { x: w * u - S * l, y: S * u + w * l, z: b * u + b * d };
  };
}
function hi(e) {
  const t = Math.cos(e);
  return [t, Math.sin(e), 1 - t];
}
function fh(e) {
  const [t] = e;
  if (e.length < 2 || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return [];
  const n = [];
  for (const r of e)
    Number.isFinite(r.x) && Number.isFinite(r.y) && n.push(r.x, r.y);
  return n.length >= 6 ? [n] : [];
}
function Zv(e, t) {
  if (e.kind === "loft") return [eS(e.rings, t)];
  if (e.kind === "solid") return [Qv(e, t)];
  const n = e.rings.map((i) => i.map(t.project)),
    r = n[0],
    o = n[n.length - 1],
    s = [o, r];
  for (let i = 1; i < n.length; i++) {
    const a = n[i - 1],
      c = n[i];
    for (let u = 0; u < c.length; u++) {
      const l = (u + 1) % o.length;
      s.push([a[u], a[l], c[l], c[u]]);
    }
  }
  return s;
}
function Qv(e, { project: t, origin: n, radius: r }) {
  const o = [];
  for (const c of e.samples) {
    const u = t(c);
    Number.isFinite(u.x) && Number.isFinite(u.y) && o.push(u);
  }
  if (e.isLoop) return o;
  if (e.balls.length === 0) return pi(o);
  const s = e.balls
    .map(([c, u, l, d]) => ({ ...t({ x: c, y: u, z: l }), r: d * r }))
    .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.r > 1e-6);
  let i = n.x,
    a = n.y;
  if (s.length > 0) {
    ((i = 0), (a = 0));
    for (const c of s) ((i += c.x), (a += c.y));
    ((i /= s.length), (a /= s.length));
  }
  for (const { x: c, y: u } of Vv) {
    let l = 0;
    for (const d of s) {
      const f = d.x - i,
        h = d.y - a,
        p = c * f + u * h,
        g = p * p - (f * f + h * h) + d.r * d.r;
      if (g <= 0) continue;
      const m = p + Math.sqrt(g);
      m > l && (l = m);
    }
    l > 0 && o.push({ x: i + c * l, y: a + u * l });
  }
  if (e.samples.length > 0) return pi(o);
  if (o.length >= 3) return o;
  for (const c of s)
    for (let u = 0; u < 48; u++) {
      const l = (u / 48) * Ir;
      o.push({ x: c.x + c.r * Math.cos(l), y: c.y + c.r * Math.sin(l) });
    }
  return o.length >= 3 ? pi(o) : o;
}
function pi(e) {
  const t = Jv(e.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y)));
  if (t.length < 3) return t;
  const n = (s, i, a) => (i.x - s.x) * (a.y - s.y) - (i.y - s.y) * (a.x - s.x),
    r = [];
  for (const s of t) {
    for (; r.length >= 2 && n(r[r.length - 2], r[r.length - 1], s) <= 0; )
      r.pop();
    r.push(s);
  }
  const o = [];
  for (let s = t.length - 1; s >= 0; s--) {
    const i = t[s];
    for (; o.length >= 2 && n(o[o.length - 2], o[o.length - 1], i) <= 0; )
      o.pop();
    o.push(i);
  }
  return (r.pop(), o.pop(), [...r, ...o]);
}
function Jv(e) {
  let t = 1 / 0,
    n = -1 / 0;
  for (const { x: u } of e) (u < t && (t = u), u > n && (n = u));
  const r = Math.ceil(e.length / Kv),
    o = n > t ? r / (n - t) : 0,
    s = (u) => Math.min(r - 1, Math.floor((u - t) * o)),
    i = new Int32Array(r + 1);
  for (const { x: u } of e) i[s(u) + 1]++;
  for (let u = 0; u < r; u++) i[u + 1] += i[u];
  const a = i.slice(0, r),
    c = new Array(e.length);
  for (const u of e) c[a[s(u.x)]++] = u;
  for (let u = 0; u < r; u++)
    for (let l = i[u] + 1; l < i[u + 1]; l++) {
      const d = c[l];
      let f = l - 1;
      for (
        ;
        f >= i[u] && (c[f].x > d.x || (c[f].x === d.x && c[f].y > d.y));
        f--
      )
        c[f + 1] = c[f];
      c[f + 1] = d;
    }
  return c;
}
function eS(e, { project: t, origin: n }) {
  const r = e.map((m) => m.map(t)),
    o = (m) => {
      let y = 0,
        w = 0;
      for (const S of m) ((y += S.x), (w += S.y));
      return { x: y / m.length, y: w / m.length };
    },
    s = o(r[0]),
    i = o(r[r.length - 1]);
  if (Math.hypot(i.x - s.x, i.y - s.y) < 1e-4) {
    let m = r[0],
      y = 0;
    for (const w of r) {
      let S = 0;
      for (let b = 0; b < w.length; b++) {
        const v = w[b],
          T = w[(b + 1) % w.length];
        S += v.x * T.y - T.x * v.y;
      }
      Math.abs(S) > y && ((m = w), (y = Math.abs(S)));
    }
    return m;
  }
  const a = r.map((m) =>
      m.map(({ x: y, y: w }) => (y - n.x) * (y - n.x) + (w - n.y) * (w - n.y)),
    ),
    c = a.map((m) => Math.max(...m)),
    u = Wv * Math.max(...c) + Uv,
    l = (m, y) => {
      const w = (y - u) / Gv;
      return w > 0 && m < w * w;
    },
    d = r.map((m) =>
      m.map((y) => {
        const w = (Math.atan2(y.y - n.y, y.x - n.x) + Ir) % Ir;
        return Math.floor((w / Ir) * ot) % ot;
      }),
    ),
    f = new Float64Array(ot);
  let h = 0;
  const p = (m, y, w, S, b) => {
      if (l(b, h)) return;
      let v = S - w;
      v > ot / 2 ? (v -= ot) : v < -ot / 2 && (v += ot);
      const T = v < 0 ? -1 : 1,
        A = Math.abs(v);
      let F = 1 / 0;
      for (let I = -1; I <= A + 1; I++) {
        const _ = (w + T * I + ot) % ot;
        f[_] < F && (F = f[_]);
      }
      if (l(b, F)) return;
      const N = y.x - m.x,
        R = y.y - m.y,
        B = m.x - n.x,
        E = m.y - n.y;
      for (let I = -1; I <= A + 1; I++) {
        const _ = (w + T * I + ot) % ot,
          { x: O, y: H } = ql[_],
          L = O * R - H * N;
        if (Math.abs(L) < 1e-9) continue;
        const j = (B * R - E * N) / L,
          J = (B * H - E * O) / L;
        j > f[_] && J >= 0 && J <= 1 && (f[_] = j);
      }
    },
    g = c.map((m, y) => y).sort((m, y) => c[y] - c[m]);
  for (const m of g) {
    const y = r[m];
    for (let w = 0; w < y.length; w++) {
      const S = (w + 1) % y.length;
      p(y[w], y[S], d[m][w], d[m][S], Math.max(a[m][w], a[m][S]));
    }
    h = Math.min(...f);
  }
  for (let m = 0; m < r.length - 1; m++) {
    const y = r[m],
      w = r[m + 1];
    for (let S = 0; S < Math.min(y.length, w.length); S++)
      p(y[S], w[S], d[m][S], d[m + 1][S], Math.max(a[m][S], a[m + 1][S]));
  }
  return ql.flatMap(({ x: m, y }, w) =>
    f[w] > 0 ? [{ x: n.x + m * f[w], y: n.y + y * f[w] }] : [],
  );
}
function tS(e, t, n) {
  switch (e.kind) {
    case "front":
      return nS(e.faceZ, t, n);
    case "loft":
      return rS(e.surfaceZ, t, n);
    case "wrap":
      return oS(e, t, n);
    case "wrapX":
      return sS(e, t, n);
  }
}
function nS(e, { loops: t, shiftY: n }, r) {
  if (!(r.rotate({ x: 0, y: 0, z: 1 }).z > 0.03)) return [];
  const s = Math.sin(n);
  return t
    .filter((i) => i.length >= 3)
    .map((i) => i.map((a) => r.project({ x: a.x, y: a.y - s, z: e })));
}
function rS(e, { loops: t, shiftY: n }, { rotate: r, project: o }) {
  if (!(r({ x: 0, y: 0, z: 1 }).z >= 0.05)) return [];
  const i = Math.sin(n),
    a = [];
  for (const c of t) {
    if (c.length < 3) continue;
    const u = c.map((y) => ({ x: y.x, y: y.y - i }));
    let l = 0,
      d = 0;
    for (const y of u) ((l += y.x), (d += y.y));
    ((l /= u.length), (d /= u.length));
    const f = 0.004,
      h = (e(l + f, d) - e(l - f, d)) / (2 * f),
      p = (e(l, d + f) - e(l, d - f)) / (2 * f),
      g = Math.hypot(h, p, 1);
    if (r({ x: -h / g, y: -p / g, z: 1 / g }).z < 0.12) continue;
    const m = e(l, d);
    a.push(
      u.map((y) => o({ x: y.x, y: y.y, z: m + (y.x - l) * h + (y.y - d) * p })),
    );
  }
  return a;
}
function oS(e, { loops: t, shiftY: n }, { rotate: r, project: o }) {
  const { wrapR: s, wrapY0: i, wrapY1: a, radiusAt: c, puffAt: u } = e,
    l = c ? 0.02 : 0.06,
    d = Math.min(a - l, Math.max(i + l, e.eyeY - n)),
    f = (b) => Math.min(a, Math.max(i, b)),
    h = (b) => {
      const v = [];
      for (const T of b) {
        const A = f(d + T.y),
          F = c ? c(A) : s,
          N = Math.max(-2.6, Math.min(2.6, T.x / Math.max(0.12, F)));
        let R = 0;
        (c &&
          (R =
            -(c(Math.min(a, A + 0.012)) - c(Math.max(i, A - 0.012))) /
            (2 * 0.012)),
          r({ x: Math.sin(N), y: R, z: Math.cos(N) }).z >= 0.05 &&
            v.push(o({ x: F * Math.sin(N), y: A, z: F * Math.cos(N) })));
      }
      return v;
    },
    p = (b) => {
      if (!u || b.length === 0) return [];
      let v = 0,
        T = 0;
      for (const R of b) ((v += R.x), (T += R.y));
      const A = u(v / b.length, f(d + T / b.length)),
        F = r({ x: 0, y: 0, z: 1 }).z,
        N = [];
      for (const R of b) {
        const B = R.x - A.x,
          E = f(d + R.y) - A.y,
          I = Math.hypot(B, E);
        let _ = Math.min(I / A.r, Math.PI - 0.02);
        const O = I > 1e-9 ? B / I : 1,
          H = I > 1e-9 ? E / I : 0,
          L = r({ x: O, y: H, z: 0 }).z,
          j = (K) => L * Math.sin(K) + F * Math.cos(K);
        if (j(_) < 0.06 && F > 0.06) {
          let K = 0,
            te = _;
          for (let Z = 0; Z < 20; Z++) {
            const D = (K + te) / 2;
            j(D) >= 0.06 ? (K = D) : (te = D);
          }
          _ = K;
        }
        const J = A.r * Math.sin(_),
          fe = { x: O * Math.sin(_), y: H * Math.sin(_), z: Math.cos(_) };
        r(fe).z >= 0.05 &&
          N.push(
            o({ x: A.x + O * J, y: A.y + H * J, z: A.z + A.r * Math.cos(_) }),
          );
      }
      return N;
    };
  let g = 1 / 0,
    m = -1 / 0;
  for (const b of t)
    for (const v of b) (v.y < g && (g = v.y), v.y > m && (m = v.y));
  let y = 0;
  m - g <= a - i &&
    (d + g < i ? (y = i - (d + g)) : d + m > a && (y = a - (d + m)));
  const w = y === 0 ? t : t.map((b) => b.map((v) => ({ x: v.x, y: v.y + y }))),
    S = u ? p : h;
  return w.map(S).filter((b) => b.length > 2);
}
function sS(e, { loops: t, shiftY: n }, { rotate: r, project: o }) {
  const { wrapR: s, wrapX0: i, wrapX1: a, radiusAtX: c } = e,
    u = Math.max(-2.4, Math.min(2.4, -n / s));
  let l = 1 / 0,
    d = -1 / 0;
  for (const p of t)
    for (const g of p) (g.x < l && (l = g.x), g.x > d && (d = g.x));
  let f = 0;
  return (
    d - l <= a - i && (l < i ? (f = i - l) : d > a && (f = a - d)),
    (f === 0 ? t : t.map((p) => p.map((g) => ({ x: g.x + f, y: g.y }))))
      .map((p) => {
        const g = [];
        for (const m of p) {
          const y = Math.min(a, Math.max(i, m.x)),
            w = c(y),
            S = u + Math.max(-2.6, Math.min(2.6, m.y / Math.max(0.12, s))),
            b = 0.012,
            v = -(c(Math.min(a, y + b)) - c(Math.max(i, y - b))) / (2 * b);
          r({ x: v, y: Math.sin(S), z: Math.cos(S) }).z >= 0.05 &&
            g.push(o({ x: y, y: w * Math.sin(S), z: w * Math.cos(S) }));
        }
        return g;
      })
      .filter((p) => p.length > 2)
  );
}
const Hn = { kind: "extrusion", halfDepth: 0.36, bevel: 0.22 };
const iS = {
    cloud: { kind: "loft", depth: 0.72 },
    square: Hn,
    sparkle: Hn,
    clover: Hn,
    heartChubby: { kind: "loft", depth: 0.62 },
    starFlower: Hn,
    teardrop: { kind: "revolve" },
    tablet: { kind: "pill", axis: 0 },
    wedge: { kind: "revolve" },
    house: Hn,
    star6: { kind: "extrusion", halfDepth: 0.3, bevel: 0.18 },
    pebble: { kind: "revolve" },
    bean: { kind: "inscribedBalls" },
    egg: { kind: "revolve" },
    squircle: { kind: "roundedSlab", halfDepth: 0.28, edge: 0.11 },
    capsule: { kind: "pill", axis: 1 },
    cylinder: { kind: "revolve" },
    hex: Hn,
    gem: { kind: "revolve" },
    crystal: { kind: "crystal" },
    shield: { kind: "revolve" },
    dome: { kind: "revolve" },
    arch: { kind: "revolve" },
    leaf: { kind: "revolve" },
  };
const as = Math.PI * 2;
const mi = 1024;
const aS = { yaw: 0, pitch: 0, roll: 0 };
const gi = 4;
const Bl = 64;
const Hl = 96;
const Vl = 4;
const cS = 0.72;
const Gl = 16;
const Wl = 33;
const uS = 40;
const Ul = 1e-9;
const Kl = 1e-9;
const lS = 1e-15;
const Xl = new Map();
function dS(e) {
  const t = Xl.get(e);
  if (t != null) return t;
  const n = fS(e, iS[e]);
  return (Xl.set(e, n), n);
}
function fS(e, t) {
  if (t.kind === "inscribedBalls")
    return { kind: "balls", balls: wS(Yl(_v())[0]) };
  const n = Yl(As(e));
  switch (t.kind) {
    case "extrusion":
      return hS(n, t.halfDepth, t.bevel);
    case "revolve":
      return pS(vr(n[0]));
    case "roundedSlab":
      return mS(bS(vr(n[0])), t.halfDepth, t.edge);
    case "pill":
      return { kind: "balls", balls: gS(vr(n[0]), t.axis) };
    case "crystal":
      return yS();
    case "loft":
      return kS(vr(n[0]), t.depth);
  }
}
function Yl(e) {
  const t = uc(e, mi),
    n = mi / 2;
  return lh(e, aS, mi).map((r) =>
    r.map((o, s) => (s % 2 === 0 ? (o - n) / t : (n - o) / t)),
  );
}
function hS(e, t, n) {
  const r = e[0].length / 2,
    o = Array.from({ length: r }, (v, T) => {
      const A = e[2 + gi * r + T];
      return [A[0], A[1]];
    }),
    s = gh(o),
    { x0: i, x1: a, y0: c, y1: u } = lc(s),
    l = (i + a) / 2,
    d = (c + u) / 2,
    f = Math.max(1e-4, Math.min((a - i) / 2, (u - c) / 2)),
    h = Math.min(t * 0.8, n),
    p = (v) => {
      const T = (v / gi) * (Math.PI / 2);
      return {
        z: t - h + h * Math.sin(T),
        scale: 1 - (h / f) * (1 - Math.cos(T)),
      };
    },
    g = Array.from({ length: gi + 1 }, (v, T) => p(T)),
    y = [
      ...g.map(({ z: v, scale: T }) => ({ z: -v, scale: T })).reverse(),
      ...g,
    ].map(({ z: v, scale: T }) =>
      s.map(([A, F]) => [l + (A - l) * T, d + (F - d) * T, v]),
    ),
    { vertices: w, faces: S } = hh(y, !0),
    b = S.length - 1;
  return {
    kind: "mesh",
    vertices: w,
    faces: S.map((v, T) => ({ corners: v, isBounding: T === 0 || T === b })),
  };
}
function pS(e) {
  const t = new Map();
  for (const [a, c] of e) a > -Ul && t.set(c, Math.max(t.get(c) ?? 0, a));
  const n = [],
    r = (a) => n.push(a) - 1,
    o = [...t]
      .sort((a, c) => c[0] - a[0])
      .map(([a, c]) =>
        c <= Ul
          ? [r([0, a, 0])]
          : Array.from({ length: Bl }, (u, l) => {
              const d = (l / Bl) * as;
              return r([c * Math.sin(d), a, c * Math.cos(d)]);
            }),
      ),
    s = [o[0], o[o.length - 1]].filter((a) => a.length > 1),
    i = o.slice(1).flatMap((a, c) => xS(o[c], a));
  return vS(n, [...s, ...i]);
}
function mS(e, t, n) {
  const r = e.length,
    o = e.map((i, a) => {
      const c = e[(a - 1 + r) % r],
        u = e[(a + 1) % r];
      let l = u[1] - c[1],
        d = -(u[0] - c[0]);
      const f = Math.hypot(l, d) || 1;
      return ((l /= f), (d /= f), l * i[0] + d * i[1] < 0 ? [-l, -d] : [l, d]);
    }),
    s = [];
  return (
    e.forEach(([i, a], c) => {
      for (let u = 0; u <= Vl; u++) {
        const l = (u / Vl) * (Math.PI / 2),
          d = n * (1 - Math.cos(l)),
          f = t - n + n * Math.sin(l),
          h = i - o[c][0] * d,
          p = a - o[c][1] * d;
        s.push([h, p, f], [h, p, -f]);
      }
    }),
    ph(s)
  );
}
function gS(e, t) {
  const n = Math.max(...e.map((o) => Math.abs(o[1 - t]))),
    r = Math.max(...e.map((o) => Math.abs(o[t]))) - n;
  return Array.from({ length: Wl }, (o, s) => {
    const i = -r + 2 * r * (s / (Wl - 1));
    return { center: t === 0 ? [i, 0, 0] : [0, i, 0], radius: n };
  });
}
function yS() {
  const e = 1.1600000000000001,
    t = 0.12,
    n = [
      [0, e - t, 0],
      [0, -e + t, 0],
    ],
    r = 0.54 - t * 0.25,
    o = 0.64 - t;
  for (const i of [-1, 1])
    for (let a = 0; a < 6; a++) {
      const c = (a / 6) * as;
      n.push([o * Math.cos(c), i * r, o * Math.sin(c)]);
    }
  const s = [];
  for (const [i, a, c] of n)
    for (let u = 0; u <= 8; u++) {
      const l = (u / 8) * Math.PI,
        d = Math.sin(l),
        f = u === 0 || u === 8 ? 1 : 14;
      for (let h = 0; h < f; h++) {
        const p = (h / f) * as;
        s.push([
          i + t * d * Math.sin(p),
          a + t * Math.cos(l),
          c + t * d * Math.cos(p),
        ]);
      }
    }
  return ph(s);
}
function kS(e, t) {
  const n = gh(e),
    { x0: r, x1: o, y0: s, y1: i } = lc(n),
    a = (r + o) / 2,
    c = (s + i) / 2,
    u = Array.from({ length: Gl + 1 }, (f, h) => {
      const p = -Math.PI / 2 + (Math.PI * h) / Gl,
        g = Math.pow(Math.max(0, Math.cos(p)), cS),
        m = t * Math.sin(p);
      return n.map(([y, w]) => [a + (y - a) * g, c + (w - c) * g, m]);
    }),
    { vertices: l, faces: d } = hh(u, !1);
  return {
    kind: "mesh",
    vertices: l,
    faces: d.map((f) => ({ corners: f, isBounding: !1 })),
  };
}
function wS(e) {
  const t = vr(e).map(([l, d]) => [x + x * l, x - x * d]),
    { x0: n, x1: r, y0: o, y1: s } = lc(t),
    i = (l, d) => {
      let f = !1;
      for (let h = 0, p = t.length - 1; h < t.length; p = h++) {
        const [g, m] = t[h],
          [y, w] = t[p];
        m > d != w > d && l < g + ((y - g) * (d - m)) / (w - m) && (f = !f);
      }
      return f;
    },
    a = Math.max(r - n, s - o) / uS,
    c = [];
  for (let l = o + a / 2; l < s; l += a)
    for (let d = n + a / 2; d < r; d += a) {
      if (!i(d, l)) continue;
      let f = 1 / 0;
      for (const [p, g] of t) f = Math.min(f, (p - d) ** 2 + (g - l) ** 2);
      const h = Math.sqrt(f);
      h > a && c.push({ x: d, y: l, r: h });
    }
  c.sort((l, d) => d.r - l.r);
  const u = [];
  for (const l of c)
    u.some((d) => Math.hypot(l.x - d.x, l.y - d.y) + l.r <= d.r + a * 0.25) ||
      u.push(l);
  return u.map((l) => ({
    center: [(l.x - x) / x, -(l.y - x) / x, 0],
    radius: l.r / x,
  }));
}
function bS(e) {
  return Array.from({ length: Hl }, (t, n) => {
    const r = (n / Hl) * as,
      o = Math.cos(r),
      s = -Math.sin(r);
    let i = 0;
    return (
      e.forEach((a, c) => {
        const u = e[(c + 1) % e.length],
          l = u[0] - a[0],
          d = u[1] - a[1],
          f = o * d - s * l;
        if (Math.abs(f) < lS) return;
        const h = (a[0] * d - a[1] * l) / f,
          p = (a[0] * s - a[1] * o) / f;
        h > i && p >= -Kl && p <= 1 + Kl && (i = h);
      }),
      [o * i, s * i]
    );
  });
}
function hh(e, t) {
  const n = e[0].length,
    r = e.flat(),
    o = [],
    s = (i, a) => i * n + (a % n);
  t && o.push(Array.from({ length: n }, (i, a) => s(0, n - 1 - a)));
  for (let i = 1; i < e.length; i++)
    for (let a = 0; a < n; a++)
      o.push([s(i - 1, a), s(i - 1, a + 1), s(i, a + 1), s(i, a)]);
  return (
    t && o.push(Array.from({ length: n }, (i, a) => s(e.length - 1, a))),
    { vertices: r, faces: o }
  );
}
function ph(e) {
  return {
    kind: "mesh",
    vertices: e,
    faces: Yx(e).map((t) => ({ corners: t, isBounding: !0 })),
  };
}
function xS(e, t) {
  return e.length === 1 && t.length === 1
    ? []
    : e.length === 1
      ? t.map((n, r) => [e[0], n, t[(r + 1) % t.length]])
      : t.length === 1
        ? e.map((n, r) => [n, t[0], e[(r + 1) % e.length]])
        : e.map((n, r) => [
            n,
            t[r],
            t[(r + 1) % t.length],
            e[(r + 1) % e.length],
          ]);
}
function vS(e, t) {
  const n = e.length,
    r = [
      e.reduce((s, i) => s + i[0], 0) / n,
      e.reduce((s, i) => s + i[1], 0) / n,
      e.reduce((s, i) => s + i[2], 0) / n,
    ],
    o = t.map((s) => {
      const [i, a, c] = mh(e, s),
        u = s.reduce(
          (f, h) => [f[0] + e[h][0], f[1] + e[h][1], f[2] + e[h][2]],
          [0, 0, 0],
        ),
        l = s.length;
      return {
        corners:
          i * (u[0] / l - r[0]) +
            a * (u[1] / l - r[1]) +
            c * (u[2] / l - r[2]) <
          0
            ? [...s].reverse()
            : s,
        isBounding: !0,
      };
    });
  return { kind: "mesh", vertices: e, faces: o };
}
function mh(e, t) {
  let n = 0,
    r = 0,
    o = 0;
  for (let s = 0; s < t.length; s++) {
    const i = e[t[s]],
      a = e[t[(s + 1) % t.length]];
    ((n += (i[1] - a[1]) * (i[2] + a[2])),
      (r += (i[2] - a[2]) * (i[0] + a[0])),
      (o += (i[0] - a[0]) * (i[1] + a[1])));
  }
  return [n, r, o];
}
function gh(e) {
  let t = 0;
  return (
    e.forEach((n, r) => {
      const o = e[(r + 1) % e.length];
      t += n[0] * o[1] - o[0] * n[1];
    }),
    t < 0 ? [...e].reverse() : e
  );
}
function lc(e) {
  let t = 1 / 0,
    n = -1 / 0,
    r = 1 / 0,
    o = -1 / 0;
  for (const [s, i] of e)
    ((t = Math.min(t, s)),
      (n = Math.max(n, s)),
      (r = Math.min(r, i)),
      (o = Math.max(o, i)));
  return { x0: t, x1: n, y0: r, y1: o };
}
function vr(e) {
  return Array.from({ length: e.length / 2 }, (t, n) => [
    e[2 * n],
    e[2 * n + 1],
  ]);
}
const Sr = 1024;
const Zl = 2 ** 23;
const SS = 2 ** 25;
const on = 2 ** 26;
class Is {
  xs = [];
  ys = [];
  #e = new Map();
  id(t, n) {
    const r = (t + Zl) * SS + (n + Zl);
    let o = this.#e.get(r);
    return (
      o == null &&
        ((o = this.xs.length),
        this.xs.push(t),
        this.ys.push(n),
        this.#e.set(r, o)),
      o
    );
  }
}
function dc(e) {
  let t = "";
  for (const n of e) {
    t += `M${cn(n[0])} ${cn(n[1])}`;
    for (let r = 2; r < n.length; r += 2) t += ` ${cn(n[r])} ${cn(n[r + 1])}`;
    t += "Z";
  }
  return t;
}
function MS(e) {
  const t = TS(e),
    n = ES(t);
  return CS(_S(IS(t.flatMap((r) => PS(r, n)))));
}
function TS(e) {
  const t = new Is(),
    n = new Map(),
    r = [],
    o = [],
    s = (c) => {
      const u = $S(c);
      if (u === 0) return;
      const l = c.length / 2;
      o.length = 0;
      for (let d = 0; d < l; d++) {
        const f = u > 0 ? d : l - 1 - d;
        o.push(t.id(c[2 * f], c[2 * f + 1]));
      }
      for (let d = 0; d < l; d++) {
        const f = o[d],
          h = o[(d + 1) % l];
        if (f === h) continue;
        const p = h * on + f,
          g = n.get(p) ?? 0;
        g > 1
          ? n.set(p, g - 1)
          : g === 1
            ? n.delete(p)
            : n.set(f * on + h, (n.get(f * on + h) ?? 0) + 1);
      }
    };
  for (const c of e) {
    r.length = c.length;
    for (let l = 0; l < c.length; l++) r[l] = Math.round(c[l] * Sr);
    const u = r.length === 8 ? RS(r) : null;
    if (u == null) s(r);
    else for (const l of u) s(l);
  }
  const { xs: i, ys: a } = t;
  return [...n].map(([c, u]) => {
    const l = Math.floor(c / on),
      d = c - l * on;
    return { ax: i[l], ay: a[l], bx: i[d], by: a[d], count: u };
  });
}
function ES(e) {
  const t = new Is();
  for (const s of e) (t.id(s.ax, s.ay), t.id(s.bx, s.by));
  const n = e.map((s, i) => i).sort((s, i) => yi(e[s]) - yi(e[i]));
  n.forEach((s, i) => {
    const a = e[s],
      c = Math.max(a.ax, a.bx);
    for (let u = i + 1; u < n.length; u++) {
      const l = e[n[u]];
      if (yi(l) > c) break;
      if (
        Math.min(l.ay, l.by) > Math.max(a.ay, a.by) ||
        Math.max(l.ay, l.by) < Math.min(a.ay, a.by)
      )
        continue;
      const d = Math.sign(gt(a.ax, a.ay, a.bx, a.by, l.ax, l.ay)),
        f = Math.sign(gt(a.ax, a.ay, a.bx, a.by, l.bx, l.by)),
        h = gt(l.ax, l.ay, l.bx, l.by, a.ax, a.ay),
        p = gt(l.ax, l.ay, l.bx, l.by, a.bx, a.by);
      if (d * f >= 0 || Math.sign(h) * Math.sign(p) >= 0) continue;
      const g = h / (h - p);
      t.id(
        Math.round(a.ax + (a.bx - a.ax) * g),
        Math.round(a.ay + (a.by - a.ay) * g),
      );
    }
  });
  const { xs: r, ys: o } = t;
  return r.map((s, i) => ({ x: s, y: o[i] })).sort((s, i) => s.x - i.x);
}
function PS(e, t) {
  const n = e.bx - e.ax,
    r = e.by - e.ay,
    o = Math.abs(n) + Math.abs(r),
    s = Math.min(e.ay, e.by) - 0.5,
    i = Math.max(e.ay, e.by) + 0.5,
    a = Math.max(e.ax, e.bx) + 0.5,
    c = [];
  for (
    let l = AS(t, Math.min(e.ax, e.bx) - 0.5);
    l < t.length && t[l].x <= a;
    l++
  ) {
    const { x: d, y: f } = t[l];
    f < s ||
      f > i ||
      2 * Math.abs(gt(e.ax, e.ay, e.bx, e.by, d, f)) > o ||
      c.push({
        t: ((d - e.ax) * n + (f - e.ay) * r) / (n * n + r * r),
        x: d,
        y: f,
      });
  }
  c.sort((l, d) => l.t - d.t);
  const u = [];
  for (let l = 1; l < c.length; l++) {
    const d = c[l - 1],
      f = c[l];
    (d.x !== f.x || d.y !== f.y) &&
      u.push({ ax: d.x, ay: d.y, bx: f.x, by: f.y, count: e.count });
  }
  return u;
}
function AS(e, t) {
  let n = 0,
    r = e.length;
  for (; n < r; ) {
    const o = (n + r) >> 1;
    e[o].x < t ? (n = o + 1) : (r = o);
  }
  return n;
}
function IS(e) {
  const t = new Is(),
    n = new Map();
  for (const i of e) {
    const a = t.id(i.ax, i.ay),
      c = t.id(i.bx, i.by),
      u = Math.min(a, c) * on + Math.max(a, c);
    n.set(u, (n.get(u) ?? 0) + (a < c ? i.count : -i.count));
  }
  const { xs: r, ys: o } = t,
    s = [];
  for (const [i, a] of n) {
    if (a === 0) continue;
    const c = Math.floor(i / on),
      u = i - c * on;
    s.push({ ax: r[c], ay: o[c], bx: r[u], by: o[u], count: a });
  }
  return s;
}
function _S(e) {
  const t = [];
  for (const n of e) {
    const r = n.ax + n.bx,
      o = n.ay + n.by;
    let s = 0;
    for (const u of e) {
      if (u === n) continue;
      const l = 2 * u.ay,
        d = 2 * u.by;
      l <= o
        ? d > o && gt(2 * u.ax, l, 2 * u.bx, d, r, o) > 0 && (s += u.count)
        : d <= o && gt(2 * u.ax, l, 2 * u.bx, d, r, o) < 0 && (s -= u.count);
    }
    const a = n.ay < n.by || (n.ay === n.by && n.ax > n.bx) ? s + n.count : s,
      c = a - n.count;
    (a !== 0) != (c !== 0) &&
      t.push(
        a !== 0
          ? { ...n, count: 1 }
          : { ax: n.bx, ay: n.by, bx: n.ax, by: n.ay, count: 1 },
      );
  }
  return t;
}
function CS(e) {
  const t = new Is(),
    n = [];
  for (const i of e) {
    const a = t.id(i.ax, i.ay),
      c = t.id(i.bx, i.by);
    for (; n.length <= Math.max(a, c); ) n.push([]);
    for (let u = 0; u < Math.abs(i.count); u++)
      i.count > 0 ? n[a].push(c) : n[c].push(a);
  }
  const { xs: r, ys: o } = t;
  let s = "";
  return (
    n.forEach((i, a) => {
      for (; i.length > 0; ) {
        s += `M${cn(r[a] / Sr)} ${cn(o[a] / Sr)}`;
        let c = i.pop();
        for (; c != null && c !== a; )
          ((s += ` ${cn(r[c] / Sr)} ${cn(o[c] / Sr)}`), (c = n[c].pop()));
        s += "Z";
      }
    }),
    s
  );
}
function RS(e) {
  const [t, n, r, o, s, i, a, c] = e,
    u = Ql(t, n, r, o, s, i, a, c);
  if (u != null)
    return [
      [t, n, u[0], u[1], a, c],
      [u[0], u[1], r, o, s, i],
    ];
  const l = Ql(r, o, s, i, a, c, t, n);
  return l != null
    ? [
        [r, o, l[0], l[1], t, n],
        [l[0], l[1], s, i, a, c],
      ]
    : null;
}
function Ql(e, t, n, r, o, s, i, a) {
  const c = Math.sign(gt(e, t, n, r, o, s)),
    u = Math.sign(gt(e, t, n, r, i, a)),
    l = gt(o, s, i, a, e, t),
    d = gt(o, s, i, a, n, r);
  if (!(c * u < 0 && Math.sign(l) * Math.sign(d) < 0)) return null;
  const f = l / (l - d);
  return [Math.round(e + (n - e) * f), Math.round(t + (r - t) * f)];
}
function gt(e, t, n, r, o, s) {
  return (n - e) * (s - t) - (r - t) * (o - e);
}
function $S(e) {
  let t = 0;
  for (let n = 0; n < e.length; n += 2) {
    const r = (n + 2) % e.length;
    t += e[n] * e[r + 1] - e[r] * e[n + 1];
  }
  return t;
}
function yi(e) {
  return Math.min(e.ax, e.bx);
}
function cn(e) {
  return String(Math.round(e * 100) / 100);
}
const Jl = Math.PI / 6;
const OS = 1.17;
const ki = -1.24;
const wi = 0.79;
const pr = 3.24;
const mr = 48;
const po = 160;
const LS = 0.001;
const cs = 0.18;
const at = HS([-0.5, 0.6, 0.62]);
const NS = [
    ...[0, 1, 2, 3, 4, 5].map((e) => {
      const t = e * Jl;
      return {
        center: [0, 0, 0],
        a: [Math.sin(t), 0, Math.cos(t)],
        b: [0, 1, 0],
        isEquator: !1,
      };
    }),
    ...[-2, -1, 0, 1, 2].map((e) => {
      const t = e * Jl,
        n = Math.cos(t);
      return {
        center: [0, Math.sin(t), 0],
        a: [0, 0, n],
        b: [n, 0, 0],
        isEquator: e === 0,
      };
    }),
  ];
let mo = null;
function FS(e, t) {
  const n = Et(t, e.center),
    r = Et(t, e.a),
    o = Et(t, e.b),
    s = Math.hypot(r[2], o[2]);
  let i = 0,
    a = 2 * Math.PI;
  if (s > Math.abs(n[2])) {
    const c = Math.atan2(o[2], r[2]),
      u = Math.acos(-n[2] / s);
    ((i = c - u), (a = c + u));
  } else if (n[2] <= 0) return null;
  return {
    center: [n[0], n[1]],
    a: [r[0], r[1]],
    b: [o[0], o[1]],
    from: i,
    to: a,
  };
}
function zS(e, t) {
  const n = Math.sqrt(Math.max(0, 1 - e * e - t * t)),
    r = at[0] * e + at[1] * t + at[2] * n;
  return cs + (1 - cs) * Math.max(0, r);
}
function DS() {
  if (mo !== null) return mo;
  const e = Math.hypot(at[0], at[1]),
    t = [at[0] / e, at[1] / e],
    n = {
      origin: [ki * at[0], ki * at[1]],
      axisX: [wi * pr * t[0], wi * pr * t[1]],
      axisY: [-pr * t[1], pr * t[0]],
      focus: ((OS - ki) * e) / (wi * pr),
    };
  return ((mo = { ...n, stops: qS(n) }), mo);
}
function jS(e, t, n) {
  const r = t - e.origin[0],
    o = n - e.origin[1],
    s = (r * e.axisX[0] + o * e.axisX[1]) / (e.axisX[0] ** 2 + e.axisX[1] ** 2),
    i = (r * e.axisY[0] + o * e.axisY[1]) / (e.axisY[0] ** 2 + e.axisY[1] ** 2),
    a = e.focus,
    c = a * a - 1,
    u = 2 * a * (s - a),
    l = (s - a) ** 2 + i * i;
  return (-u - Math.sqrt(u * u - 4 * c * l)) / (2 * c);
}
function qS(e) {
  const t = mr + 1,
    n = new Float64Array(t),
    r = new Float64Array(t),
    o = new Float64Array(t);
  let s = 0;
  for (let c = 0; c < po; c++)
    for (let u = 0; u < po; u++) {
      const l = ((c + 0.5) / po) * 2 - 1,
        d = ((u + 0.5) / po) * 2 - 1;
      if (l * l + d * d >= 1) continue;
      const f = Math.min(1, jS(e, l, d)) * mr,
        h = Math.min(mr - 1, Math.floor(f)),
        p = f - h,
        g = zS(l, d);
      ((n[h] += (1 - p) ** 2),
        (n[h + 1] += p * p),
        (r[h] += (1 - p) * p),
        (o[h] += (1 - p) * g),
        (o[h + 1] += p * g),
        s++);
    }
  const i = (LS * s) / t;
  for (let c = 0; c < mr; c++) ((n[c] += i), (n[c + 1] += i), (r[c] -= i));
  const a = BS(n, r, o);
  return Array.from(a, (c, u) => ({ offset: u / mr, shade: c }));
}
function BS(e, t, n) {
  const r = e.length,
    o = new Float64Array(r),
    s = new Float64Array(r);
  ((o[0] = t[0] / e[0]), (s[0] = n[0] / e[0]));
  for (let a = 1; a < r; a++) {
    const c = e[a] - t[a - 1] * o[a - 1];
    ((o[a] = t[a] / c), (s[a] = (n[a] - t[a - 1] * s[a - 1]) / c));
  }
  const i = new Float64Array(r);
  i[r - 1] = s[r - 1];
  for (let a = r - 2; a >= 0; a--) i[a] = s[a] - o[a] * i[a + 1];
  return i;
}
function HS(e) {
  const t = Math.hypot(e[0], e[1], e[2]);
  return [e[0] / t, e[1] / t, e[2] / t];
}
const VS = 0.4;
const GS = 1e-9;
const go = 6;
const Io = 24;
const la = 0.004;
const Vn = Math.PI / 180;
function WS(e, t, n, r) {
  const o = dS(e),
    s = US(t),
    i = uc(As(e), n),
    a = n / 2,
    c = r.map((f) => f + (1 - f) * VS),
    u = (f) => {
      const h = f[0] * at[0] + f[1] * at[1] + f[2] * at[2],
        p = cs + (1 - cs) * Math.max(0, h);
      return JS(c.map((g) => g * p));
    },
    l = (f) => [a + i * f[0], a - i * f[1]],
    d = o.kind === "mesh" ? KS(o, s, l, u) : XS(o.balls, s, l, i, u);
  return { baseFill: u([0, 0, 1]), faces: d };
}
function US(e) {
  const [t, n] = [Math.cos(e.yaw * Vn), Math.sin(e.yaw * Vn)],
    [r, o] = [Math.cos(e.pitch * Vn), Math.sin(e.pitch * Vn)],
    [s, i] = [Math.cos(e.roll * Vn), Math.sin(e.roll * Vn)];
  return ([a, c, u]) => {
    const l = a * t + u * n,
      d = u * t - a * n,
      f = c * r - d * o,
      h = c * o + d * r;
    return [l * s - f * i, l * i + f * s, h];
  };
}
function KS(e, t, n, r) {
  const o = e.vertices.map(t),
    s = [],
    i = new Map();
  for (const a of e.faces) {
    const [c, u, l] = mh(o, a.corners),
      d = Math.hypot(c, u, l);
    if (d === 0 || l <= GS * d) continue;
    const f = r([c / d, u / d, l / d]),
      h = a.corners.flatMap((g) => n(o[g]));
    if (a.isBounding) {
      yh(i, f, h);
      continue;
    }
    const p = a.corners.reduce((g, m) => g + o[m][2], 0) / a.corners.length;
    s.push({ polygon: h, fill: f, depth: p });
  }
  return (
    s.sort((a, c) => a.depth - c.depth),
    [...YS(s), ...[...i].map(([a, c]) => fc(c, a))]
  );
}
function XS(e, t, n, r, o) {
  const s = e.map((c) => ({ center: t(c.center), radius: c.radius })),
    i = s
      .map((c, u) => u)
      .sort(
        (c, u) => s[c].center[2] + s[c].radius - (s[u].center[2] + s[u].radius),
      ),
    a = la / r;
  return i.flatMap((c) => {
    const { center: u, radius: l } = s[c],
      d = s.filter((m, y) => y !== c && s[y].radius > a),
      f = (m) =>
        d.some((y) => m.every((w) => QS(w, y.center) < (y.radius - a) ** 2)),
      h = (m, y) => [
        u[0] + l * Math.sin(m) * Math.cos(y),
        u[1] + l * Math.sin(m) * Math.sin(y),
        u[2] + l * Math.cos(m),
      ],
      p = ZS(l * r),
      g = new Map();
    for (let m = 0; m < go; m++) {
      const y = (m / go) * (Math.PI / 2),
        w = ((m + 1) / go) * (Math.PI / 2),
        S = m === go - 1 ? p : 1;
      for (let b = 0; b < Io; b++) {
        const v = (b / Io) * 2 * Math.PI,
          T = ((b + 1) / Io) * 2 * Math.PI,
          A = [
            ...(m === 0 ? [h(0, 0)] : [h(y, v)]),
            ...Array.from({ length: S + 1 }, (B, E) =>
              h(w, v + ((T - v) * E) / S),
            ),
            ...(m === 0 ? [] : [h(y, T)]),
          ];
        if (f(A)) continue;
        const F = (y + w) / 2,
          N = (v + T) / 2,
          R = o([
            Math.sin(F) * Math.cos(N),
            Math.sin(F) * Math.sin(N),
            Math.cos(F),
          ]);
        yh(g, R, A.flatMap(n));
      }
    }
    return [...g].map(([m, y]) => fc(y, m));
  });
}
function YS(e) {
  const t = [];
  let n = 0;
  for (let r = 1; r <= e.length; r++)
    (r < e.length && e[r].fill === e[n].fill) ||
      (t.push(
        fc(
          e.slice(n, r).map((o) => o.polygon),
          e[n].fill,
        ),
      ),
      (n = r));
  return t;
}
function yh(e, t, n) {
  const r = e.get(t);
  r == null ? e.set(t, [n]) : r.push(n);
}
function fc(e, t) {
  return { d: dc(e), fill: t };
}
function ZS(e) {
  if (e <= la) return 1;
  const t = 2 * Math.acos(1 - la / e);
  return Math.max(1, Math.ceil((2 * Math.PI) / Io / t));
}
function QS(e, t) {
  return (e[0] - t[0]) ** 2 + (e[1] - t[1]) ** 2 + (e[2] - t[2]) ** 2;
}
function JS(e) {
  const t = (n) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${e.map(t).join("")}`;
}
function re(e, t, n = []) {
  return { tag: e, attrs: t, children: n };
}
function hc(e, t, n, r) {
  return re(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      id: t,
      width: n,
      height: n,
      viewBox: `0 0 ${e} ${e}`,
    },
    r,
  );
}
const wh = 144;
const bh = 184 / 256;
const _o = 180 / Math.PI;
const rM = 16e6;
const oM = 0.6;
const Gn = new Map();
let bi = 0;
function sM(e, t, n, r = {}) {
  const o = Math.max(8, Math.round((n * e.zoom) / bh)),
    s = Math.max(o, wh),
    i = xh(e.quat, vh(n, e.zoom)),
    { body: a, eyes: c } = Sh(e.body, i, s, e.eyes),
    [u, l, d, f] = Mh(e, n, o, s),
    h = `matrix(${ko(u)} 0 0 ${ko(l)} ${ko(d)} ${ko(f)})`,
    p = r.isProof === !0 ? WS(e.body, i, s, t.ink) : null;
  if (e.glow != null) {
    const y = lM(e.glow, s);
    return {
      size: n,
      sprite: s,
      transform: h,
      body: a,
      bodyFill: y,
      eyes: [],
      eyeFill: null,
      proof: p,
    };
  }
  const g = t.cutout ? null : oc(t),
    m = e.eyes == null ? [] : c;
  return {
    size: n,
    sprite: s,
    transform: h,
    body: a,
    bodyFill: rc(t),
    eyes: m,
    eyeFill: g,
    proof: p,
  };
}
function iM(e, t) {
  const n = Math.max(8, Math.round((t * e.zoom) / bh)),
    r = Math.max(n, wh),
    o = xh(e.quat, vh(t, e.zoom)),
    { body: s, eyes: i } = Sh(e.body, o, r, e.eyes),
    [a, c, u, l] = Mh(e, t, n, r),
    d = ([f, h]) => [a * f + u, c * h + l];
  return {
    center: [(a * r) / 2 + u, (c * r) / 2 + l],
    radius: (e.zoom * t) / 2,
    body: s.flatMap(nd).map((f) => f.map(d)),
    eyes: e.eyes == null ? [] : i.flatMap(nd).map((f) => f.map(d)),
  };
}
function aM(e, t, n = e.size) {
  const r = e.sprite,
    o = `${t}-body`,
    s = { maskUnits: "userSpaceOnUse", x: 0, y: 0, width: r, height: r },
    i = (f) => e.eyes.map((h) => re("path", { d: h, fill: f })),
    a = e.body.map((f) => re("path", { d: f })),
    c = [re("g", { id: o }, a)];
  let u = {};
  const l = [];
  e.eyes.length > 0 && e.eyeFill == null
    ? (c.push(
        re("mask", { id: `${t}-holes`, ...s }, [
          re("rect", { width: r, height: r, fill: "#fff" }),
          ...i("#000"),
        ]),
      ),
      (u = { mask: `url(#${t}-holes)` }))
    : e.eyes.length > 0 &&
      e.eyeFill != null &&
      (c.push(
        re("mask", { id: `${t}-inside`, ...s }, [
          re("use", { href: `#${o}`, fill: "#fff" }),
        ]),
      ),
      l.push(re("g", { mask: `url(#${t}-inside)` }, i(e.eyeFill))));
  let d;
  if (e.proof != null)
    (c.push(re("clipPath", { id: `${t}-solid` }, a)),
      (d = re("g", { "clip-path": `url(#${t}-solid)`, ...u }, [
        re("use", { href: `#${o}`, fill: e.proof.baseFill }),
        ...e.proof.faces.map((f) => re("path", { d: f.d, fill: f.fill })),
      ])));
  else if (typeof e.bodyFill == "string")
    d = re("use", { href: `#${o}`, fill: e.bodyFill, ...u });
  else {
    const { cx: f, cy: h, r: p, stops: g } = e.bodyFill;
    (c.push(
      re(
        "radialGradient",
        {
          id: `${t}-glow`,
          gradientUnits: "userSpaceOnUse",
          cx: f,
          cy: h,
          r: p,
        },
        g.map((m) => re("stop", { offset: m.offset, "stop-color": m.color })),
      ),
    ),
      (d = re("use", { href: `#${o}`, fill: `url(#${t}-glow)`, ...u })));
  }
  return hc(e.size, t, n, [
    re("defs", {}, c),
    re("g", { transform: e.transform }, [d, ...l]),
  ]);
}
function xh(e, t = 0) {
  const n = ir(e),
    [r, o, s] = Hf(
      n[8] >= 0
        ? n
        : [-n[0], n[1], -n[2], -n[3], n[4], -n[5], -n[6], n[7], -n[8]],
    ),
    i = (a) => (t > 0 ? Math.round(a / t) * t : a);
  return { yaw: ed(i(o * _o)), pitch: ed(i(r * _o)), roll: i(s * _o) };
}
function vh(e, t) {
  const n = (oM / Math.max((e * t) / 2, 1)) * _o;
  return 2 ** Math.floor(Math.log2(n));
}
function ed(e) {
  const t = ((e % 180) + 180) % 180;
  return Math.abs(t - 90) >= 0.5 ? e : e + (t <= 90 ? 89.5 - t : 90.5 - t);
}
function Sh(e, t, n, r) {
  const o = r == null ? [] : Xv(As(e), t, n, qx(e, r));
  return { body: cM(e, t, n), eyes: o.map((s) => dc([s])) };
}
function cM(e, t, n) {
  const r = `${e} ${n} ${t.yaw} ${t.pitch} ${t.roll}`,
    o = Gn.get(r);
  if (o != null) return (Gn.delete(r), Gn.set(r, o), o);
  const s = uM(lh(As(e), t, n));
  (Gn.set(r, s), (bi += td(s)));
  for (const [i, a] of Gn) {
    if (bi <= rM) break;
    (Gn.delete(i), (bi -= td(a)));
  }
  return s;
}
function td(e) {
  return e.reduce((t, n) => t + n.length, 0);
}
function uM(e) {
  if (e.length === 1) return [dc(e)];
  const t = MS(e);
  return t === "" ? [] : [t];
}
function Mh(e, t, n, r) {
  const o = t / 2,
    s = o + e.offset[0] * e.zoom * o,
    i = o - e.offset[1] * e.zoom * o,
    a = i - e.squashAnchor * e.zoom * o,
    [c, u] = e.squash,
    l = n / r;
  return [c * l, u * l, s - (c * n) / 2, a + u * (i - n / 2 - a)];
}
function nd(e) {
  const t = [];
  for (const n of e.split("Z")) {
    const r = n
      .replace("M", " ")
      .trim()
      .split(/\s+/)
      .filter((s) => s !== "")
      .map(Number);
    if (r.length < 6) continue;
    const o = [];
    for (let s = 0; s + 1 < r.length; s += 2) o.push([r[s], r[s + 1]]);
    t.push(o);
  }
  return t;
}
function lM(e, t) {
  const n = t / 2;
  return {
    cx: n,
    cy: n,
    r: n,
    stops: [
      { offset: 0, color: yo(e.inner) },
      { offset: 0.42 + e.midT * 0.16, color: yo(e.mid) },
      { offset: 0.93, color: yo(e.rim) },
      { offset: 1, color: yo(e.rim) },
    ],
  };
}
function yo(e) {
  return `rgb(${Math.round(e[0] * 255)}, ${Math.round(e[1] * 255)}, ${Math.round(e[2] * 255)})`;
}
function ko(e) {
  return Math.round(e * 1e6) / 1e6;
}
const ut = Math.PI * 2;
const rd = 1e-9;
const dM = 1e-7;
const fM = 1e-7;
const tn = 720;
function hM(e) {
  return Array.from({ length: e }, (t, n) => (n / e) * ut);
}
function pM(e, t) {
  return e.flatMap((n) => n.map(([r, o]) => us(t, r, o)));
}
function mM(e) {
  const t = e.flat().sort((n, r) => n - r);
  return t.filter((n, r) => r === 0 || n - t[r - 1] > dM);
}
function gM(e, t, n) {
  const r = EM(e, t),
    o = AM(n.map((s) => PM(r, t, s)));
  return n.map((s, i) => [
    t[0] + Math.cos(s) * o[i],
    t[1] + Math.sin(s) * o[i],
  ]);
}
function yM(e, t, n) {
  const [r, o] = t;
  return Array.from({ length: n }, (s, i) => {
    const a = (i / n) * ut,
      c = Math.cos(a),
      u = Math.sin(a),
      l = r === 0 || o === 0 ? 0 : 1 / Math.hypot(c / r, u / o);
    return [e[0] + c * l, e[1] + u * l];
  });
}
function kM(e, t, n) {
  const r = e
    .map(([o, s]) => ({
      angle: us(t, o, s),
      reach: Math.hypot(o - t[0], s - t[1]),
    }))
    .sort((o, s) => o.angle - s.angle);
  return n.map((o) => {
    const s = IM(r, o);
    return [t[0] + Math.cos(o) * s, t[1] + Math.sin(o) * s];
  });
}
function wM(e) {
  const t = TM(e) < 0 ? [...e].reverse() : e,
    n = _M(t, Eh(t)),
    r =
      n == null
        ? t
        : [n.point, ...t.slice(n.edge + 1), ...t.slice(0, n.edge + 1)],
    o = [0];
  for (let i = 0; i < r.length; i++) {
    const [a, c] = r[i],
      [u, l] = r[(i + 1) % r.length];
    o.push(o[i] + Math.hypot(u - a, l - c));
  }
  const s = o[r.length] ?? 0;
  return { points: r, stations: o.map((i) => (s === 0 ? 0 : i / s)) };
}
function bM({ points: e, stations: t }, n) {
  if (e.length === 0) return [];
  let r = 0;
  return n.map((o) => {
    for (; r < e.length - 1 && t[r + 1] < o; ) r++;
    const [s, i] = e[r],
      [a, c] = e[(r + 1) % e.length],
      u = t[r + 1] - t[r],
      l = u === 0 ? 0 : (o - t[r]) / u;
    return [s + (a - s) * l, i + (c - i) * l];
  });
}
function xM(e) {
  return Array.from({ length: e }, (t, n) => n / e);
}
function vM(e) {
  const t = e
    .flat()
    .filter((n) => n < 1)
    .sort((n, r) => n - r);
  return t.filter((n, r) => r === 0 || n - t[r - 1] > fM);
}
function Th(e) {
  const t = e.reduce((r, o) => r + o.weight, 0),
    [n] = e;
  return n == null || t === 0
    ? []
    : n.outline.map((r, o) => {
        let s = 0,
          i = 0;
        for (const { outline: a, weight: c } of e)
          ((s += a[o][0] * c), (i += a[o][1] * c));
        return [s / t, i / t];
      });
}
function SM(e, t, n) {
  return e.map(([r, o], s) => [r + (t[s][0] - r) * n, o + (t[s][1] - o) * n]);
}
function MM(e, t) {
  return Array.from({ length: t }, () => [e[0], e[1]]);
}
function Eh(e) {
  if (e.length === 0) return [0, 0];
  let t = 0,
    n = 0;
  for (const [r, o] of e) ((t += r), (n += o));
  return [t / e.length, n / e.length];
}
function da(e) {
  return e.length === 0
    ? ""
    : `M${e.map(([t, n]) => `${od(t)} ${od(n)}`).join("L")}Z`;
}
function TM(e) {
  let t = 0;
  for (let n = 0; n < e.length; n++) {
    const [r, o] = e[n],
      [s, i] = e[(n + 1) % e.length];
    t += r * i - s * o;
  }
  return t / 2;
}
function EM(e, t) {
  const n = Array.from({ length: tn }, () => []);
  for (const r of e)
    for (let o = 0; o < r.length; o++) {
      const s = r[o],
        i = r[(o + 1) % r.length],
        a = us(t, s[0], s[1]);
      let c = us(t, i[0], i[1]) - a;
      (c > Math.PI && (c -= ut), c < -Math.PI && (c += ut));
      const u = Math.floor(((c < 0 ? a + c : a) / ut) * tn) - 1,
        l = Math.floor(((c < 0 ? a : a + c) / ut) * tn) + 1;
      for (let d = u; d <= l; d++) n[((d % tn) + tn) % tn].push([s, i]);
    }
  return n;
}
function PM(e, [t, n], r) {
  const o = Math.cos(r),
    s = Math.sin(r);
  let i = Number.NaN;
  for (const [[a, c], [u, l]] of e[Math.floor((r / ut) * tn) % tn]) {
    const d = u - a,
      f = l - c,
      h = o * f - s * d;
    if (Math.abs(h) < 1e-12) continue;
    const p = a - t,
      g = c - n,
      m = (p * f - g * d) / h,
      y = (p * s - g * o) / h;
    m >= 0 && y >= -rd && y <= 1 + rd && !(m <= i) && (i = m);
  }
  return i;
}
function us(e, t, n) {
  const r = Math.atan2(n - e[1], t - e[0]);
  return r < 0 ? r + ut : r;
}
function AM(e) {
  const t = e.length,
    n = e.flatMap((r, o) => (Number.isNaN(r) ? [] : [o]));
  return n.length === 0
    ? e.map(() => 0)
    : e.map((r, o) => {
        if (!Number.isNaN(r)) return r;
        const s = n.find((c) => c > o) ?? n[0] + t,
          i = [...n].reverse().find((c) => c < o) ?? (n.at(-1) ?? 0) - t,
          a = (o - i) / (s - i);
        return e[(i + t) % t] * (1 - a) + e[s % t] * a;
      });
}
function IM(e, t) {
  const n = e.length;
  if (n === 0) return 0;
  let r = e.findIndex((c) => c.angle >= t);
  r < 0 && (r = 0);
  const o = e[r],
    s = e[(r - 1 + n) % n],
    i = (o.angle - s.angle + ut) % ut;
  if (i === 0) return o.reach;
  const a = ((t - s.angle + ut) % ut) / i;
  return s.reach + (o.reach - s.reach) * a;
}
function _M(e, [t, n]) {
  let r = null;
  for (let o = 0; o < e.length; o++) {
    const [s, i] = e[o],
      [a, c] = e[(o + 1) % e.length];
    if (i === c || (i - n) * (c - n) > 0) continue;
    const u = s + ((n - i) / (c - i)) * (a - s);
    u >= t && (r == null || u > r.point[0]) && (r = { edge: o, point: [u, n] });
  }
  return r;
}
function od(e) {
  return String(Math.round(e * 100) / 100);
}
const CM = [1, 1];
function RM(e, t) {
  const n = e.length;
  let r = -1;
  for (let a = 0; a < n && r < 0; a++)
    e[a][2] <= 0 && e[(a + 1) % n][2] > 0 && (r = a);
  if (r < 0)
    return n === 0 || e[0][2] <= 0
      ? null
      : e.map(([a, c]) => ({ kind: "line", to: [a, c] }));
  const o = [];
  let s = [1, 0],
    i = null;
  for (let a = 0; a < n; a++) {
    const c = e[(r + a) % n],
      u = e[(r + a + 1) % n],
      l = c[2] > 0,
      d = u[2] > 0;
    if (l && d) o.push({ kind: "line", to: [u[0], u[1]] });
    else if (l) ((i = sd(c, u)), o.push({ kind: "line", to: i }));
    else if (d) {
      const f = sd(c, u);
      (i === null ? (s = f) : o.push(id(i, f, t)),
        o.push({ kind: "line", to: [u[0], u[1]] }));
    }
  }
  return (i !== null && o.push(id(i, s, t)), o);
}
function $M(e, t) {
  const n = LM(e, t),
    r = n.length;
  if (n.every((c) => c.isInside)) return e;
  let o = -1;
  for (let c = 0; c < r && o < 0; c++)
    n[c].isInside && !n[(c + r - 1) % r].isInside && (o = c);
  if (o < 0) {
    const c = n.reduce((u, l) => u + l.sweep, 0);
    return Math.abs(c) > Math.PI ? zr(t, Math.sign(c)) : null;
  }
  const s = [];
  let i = null,
    a = 0;
  for (let c = 0; c < r; c++) {
    const u = n[(o + c) % r];
    u.isInside
      ? (i !== null && s.push({ kind: "arc", to: u.from, radii: t, sweep: a }),
        (i = null),
        s.push(u.segment))
      : (i === null && ((i = u.from), (a = 0)), (a += u.sweep));
  }
  return (
    i !== null && s.push({ kind: "arc", to: n[o].from, radii: t, sweep: a }),
    s
  );
}
function OM(e, t) {
  const n = (a) =>
      a.kind === "arc" && a.radii[0] === e[0] && a.radii[1] === e[1],
    r = [],
    o = [],
    s = [],
    i = [];
  for (const a of t) {
    const c = a.findIndex(n);
    if (c < 0) {
      r.push(a);
      continue;
    }
    let u = a[c].to,
      l = [],
      d = u;
    for (let f = 1; f <= a.length; f++) {
      const h = a[(c + f) % a.length];
      (n(h)
        ? (s.push({ from: d, sweep: h.sweep }),
          i.push(d, h.to),
          l.length > 0 && o.push(zM(u, l)),
          (l = []),
          (u = h.to))
        : l.push(h),
        (d = h.to));
    }
  }
  return s.length === 0
    ? [zr(e, 1), ...r]
    : [...qM([...o, ...DM(e, s, i)]), ...r];
}
function zr(e, t) {
  return [
    { kind: "arc", to: [-e[0], 0], radii: e, sweep: t * Math.PI },
    { kind: "arc", to: [e[0], 0], radii: e, sweep: t * Math.PI },
  ];
}
function Ph(e, t) {
  const n = Math.cos(t),
    r = Math.sin(t),
    o = 1 / Math.sqrt((n * n) / (e[0] * e[0]) + (r * r) / (e[1] * e[1]));
  return [o * n, o * r];
}
function sd(e, t) {
  const n = e[2] / (e[2] - t[2]),
    r = e[0] + (t[0] - e[0]) * n,
    o = e[1] + (t[1] - e[1]) * n,
    s = Math.sqrt(r * r + o * o);
  return [r / s, o / s];
}
function id(e, t, n) {
  const r = cd(Math.atan2(t[1], t[0]) - n) - cd(Math.atan2(e[1], e[0]) - n);
  return { kind: "arc", to: t, radii: CM, sweep: r };
}
function LM(e, t) {
  const n = 1 / (t[0] * t[0]),
    r = 1 / (t[1] * t[1]),
    o = (a) => n * a[0] * a[0] + r * a[1] * a[1] - 1,
    s = [];
  let i = e[e.length - 1].to;
  for (const a of e) {
    if (a.kind === "line") {
      const c = NM(i, a.to, n, r);
      let u = i;
      for (let l = 0; l <= c.length; l++) {
        const d = l === 0 ? 0 : c[l - 1],
          f = l === c.length ? 1 : c[l],
          h = l === c.length ? a.to : ad(i, a.to, f);
        (s.push({
          from: u,
          segment: { kind: "line", to: h },
          sweep: Math.atan2(
            u[0] * h[1] - u[1] * h[0],
            u[0] * h[0] + u[1] * h[1],
          ),
          isInside: o(ad(i, a.to, (d + f) / 2)) < 0,
        }),
          (u = h));
      }
    } else {
      const c = a.radii[0],
        u = Math.atan2(i[1], i[0]),
        l = FM(c, u, a.sweep, n, r);
      let d = i;
      for (let f = 0; f <= l.length; f++) {
        const h = f === 0 ? 0 : l[f - 1],
          p = f === l.length ? 1 : l[f],
          g = u + a.sweep * p,
          m = f === l.length ? a.to : [c * Math.cos(g), c * Math.sin(g)],
          y = u + (a.sweep * (h + p)) / 2,
          w = a.sweep * (p - h);
        (s.push({
          from: d,
          segment: { kind: "arc", to: m, radii: a.radii, sweep: w },
          sweep: w,
          isInside: o([c * Math.cos(y), c * Math.sin(y)]) < 0,
        }),
          (d = m));
      }
    }
    i = a.to;
  }
  return s;
}
function NM(e, t, n, r) {
  const o = t[0] - e[0],
    s = t[1] - e[1],
    i = n * o * o + r * s * s,
    a = n * e[0] * o + r * e[1] * s,
    c = n * e[0] * e[0] + r * e[1] * e[1] - 1,
    u = a * a - i * c;
  if (i === 0 || u <= 0) return [];
  const l = Math.sqrt(u),
    d = -(a + (a < 0 ? -l : l));
  return [d / i, c / d].filter((f) => f > 0 && f < 1).sort((f, h) => f - h);
}
function FM(e, t, n, r, o) {
  if (r === o || n === 0) return [];
  const s = (1 / (e * e) - o) / (r - o);
  if (!(s > 0 && s < 1)) return [];
  const i = Math.acos(Math.sqrt(s)),
    a = [];
  for (const c of [i, -i, Math.PI - i, Math.PI + i]) {
    const l = (n > 0 ? Dr(c - t) : Dr(t - c)) / Math.abs(n);
    l > 0 && l < 1 && a.push(l);
  }
  return a.sort((c, u) => c - u);
}
function zM(e, t) {
  const n = [e, ...t.map((o) => o.to)],
    r = t
      .map((o, s) =>
        o.kind === "line"
          ? { kind: "line", to: n[s] }
          : { ...o, to: n[s], sweep: -o.sweep },
      )
      .reverse();
  return { from: n[n.length - 1], to: e, segments: r };
}
function DM(e, t, n) {
  const r = n
      .map((s) => ({ point: s, angle: Dr(Math.atan2(s[1], s[0])) }))
      .sort((s, i) => s.angle - i.angle),
    o = [];
  for (let s = 0; s < r.length; s++) {
    const i = r[s],
      a = r[(s + 1) % r.length],
      c =
        s + 1 < r.length ? a.angle - i.angle : a.angle + 2 * Math.PI - i.angle;
    if (c <= 0) continue;
    const u = i.angle + c / 2;
    t.reduce((l, d) => l + jM(d, u), 0) === 0 &&
      o.push({
        from: i.point,
        to: a.point,
        segments: [{ kind: "arc", to: a.point, radii: e, sweep: c }],
      });
  }
  return o;
}
function jM(e, t) {
  const n = Math.atan2(e.from[1], e.from[0]);
  return (e.sweep > 0 ? Dr(t - n) : Dr(n - t)) < Math.abs(e.sweep)
    ? Math.sign(e.sweep)
    : 0;
}
function qM(e) {
  const t = (s) => `${s[0]} ${s[1]}`,
    n = new Map();
  for (const s of e) {
    const i = n.get(t(s.from));
    i === void 0 ? n.set(t(s.from), [s]) : i.push(s);
  }
  const r = new Set(),
    o = [];
  for (const s of e) {
    const i = [];
    let a = s;
    for (; a !== void 0 && !r.has(a); )
      (r.add(a),
        i.push(...a.segments),
        (a = n.get(t(a.to))?.find((c) => !r.has(c))));
    i.length > 0 && o.push(i);
  }
  return o;
}
function ad(e, t, n) {
  return [e[0] + (t[0] - e[0]) * n, e[1] + (t[1] - e[1]) * n];
}
function cd(e) {
  return e - 2 * Math.PI * Math.round(e / (2 * Math.PI));
}
function Dr(e) {
  const t = e % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}
const BM = 60;
const HM = 256;
const VM = 24;
const GM = 2e4;
const WM = 0.2;
function UM(e, t, n) {
  const r = {
      field: e,
      tolerance: n,
      root: n.deviation * 0.001,
      reach: t.step * Math.hypot(t.nx, t.ny),
    },
    o = [];
  for (const s of KM(r, t)) {
    const i = ZM(XM(r, s), n);
    i.length >= 3 && o.push(i);
  }
  return o;
}
function KM(e, t) {
  const { field: n } = e,
    { x0: r, y0: o, step: s, nx: i, ny: a } = t,
    c = i + 1,
    u = new Float64Array(c * (a + 1));
  for (let b = 0; b <= a; b++)
    for (let v = 0; v <= i; v++) u[b * c + v] = n(r + v * s, o + b * s);
  const l = 2 * c * (a + 1),
    d = new Int32Array(l).fill(-1),
    f = new Map(),
    h = (b) => {
      const v = f.get(b);
      if (v !== void 0) return v;
      const T = b >> 1,
        A = b & 1 ? T + c : T + 1,
        F = r + (T % c) * s,
        N = o + Math.floor(T / c) * s,
        R = r + (A % c) * s,
        B = o + Math.floor(A / c) * s,
        E = Ah(e, F, N, u[T], R, B, u[A]),
        I = [F + (R - F) * E, N + (B - N) * E];
      return (f.set(b, I), I);
    },
    p = [0, 0, 0, 0],
    g = [0, 0, 0, 0],
    m = [],
    y = [];
  for (let b = 0; b < a; b++)
    for (let v = 0; v < i; v++) {
      const T = b * c + v;
      ((p[0] = T),
        (p[1] = T + 1),
        (p[2] = T + 1 + c),
        (p[3] = T + c),
        (g[0] = 2 * T),
        (g[1] = 2 * (T + 1) + 1),
        (g[2] = 2 * (T + c)),
        (g[3] = 2 * T + 1),
        (m.length = 0),
        (y.length = 0));
      for (let A = 0; A < 4; A++) {
        const F = u[p[A]] < 0,
          N = u[p[(A + 1) & 3]] < 0;
        F !== N && (m.push(g[A]), y.push(F));
      }
      if (m.length === 2) {
        const A = y[0] ? 0 : 1;
        d[m[A]] = m[1 - A];
      } else if (m.length === 4) {
        const A = n(r + (v + 0.5) * s, o + (b + 0.5) * s) < 0;
        for (let F = 0; F < 4; F++)
          y[F] && (d[m[F]] = m[(F + (A ? 1 : 3)) & 3]);
      }
    }
  const w = [],
    S = new Uint8Array(l);
  for (let b = 0; b < l; b++) {
    if (d[b] < 0 || S[b]) continue;
    const v = [];
    let T = b;
    for (; T >= 0 && !S[T]; ) ((S[T] = 1), v.push(h(T)), (T = d[T]));
    T === b && w.push(v);
  }
  return w;
}
function Ah(e, t, n, r, o, s, i) {
  let a = 0,
    c = r,
    u = 1,
    l = i,
    d = 0,
    f = 0;
  for (let h = 0; h < BM; h++) {
    f = (a * l - u * c) / (l - c);
    const p = e.field(t + (o - t) * f, n + (s - n) * f);
    if (Math.abs(p) <= e.root || u - a <= 1e-15) break;
    p < 0 == l < 0
      ? ((u = f), (l = p), d === -1 && (c /= 2), (d = -1))
      : ((a = f), (c = p), d === 1 && (l /= 2), (d = 1));
  }
  return f;
}
function XM(e, t) {
  const n = [];
  for (let r = 0; r < t.length; r++) {
    const o = t[r],
      s = t[(r + 1) % t.length];
    (o[0] === s[0] && o[1] === s[1]) || (n.push(o), fa(e, o, s, 0, n));
  }
  return n;
}
function fa(e, t, n, r, o) {
  const s = n[0] - t[0],
    i = n[1] - t[1],
    a = Math.sqrt(s * s + i * i);
  if (a === 0 || r >= VM || o.length >= GM) return;
  const c = (t[0] + n[0]) / 2,
    u = (t[1] + n[1]) / 2,
    l = e.field(c, u);
  if (!Number.isFinite(l)) return;
  const d = l > 0 ? 1 : -1,
    f = (-i / a) * d,
    h = (s / a) * d,
    p = Ih(e, c, u, l, f, h);
  if (p === null || (p <= e.tolerance.deviation / 2 && a <= e.tolerance.edge))
    return;
  const g = l > 0 ? YM(e, c, u, l, f, h, p) : [c + f * p, u + h * p];
  (fa(e, t, g, r + 1, o), o.push(g), fa(e, g, n, r + 1, o));
}
function YM(e, t, n, r, o, s, i) {
  const a = [t + o * i, n + s * i],
    c = i * 0.001,
    u = e.field(t + c, n) - e.field(t - c, n),
    l = e.field(t, n + c) - e.field(t, n - c),
    d = Math.sqrt(u * u + l * l);
  if (d === 0) return a;
  const f = u * s - l * o < 0 ? -1 : 1,
    h = (-l / d) * f,
    p = (u / d) * f;
  if (h * o + p * s < WM) return a;
  const g = Ih(e, t, n, r, h, p);
  return g === null || g * (h * o + p * s) <= i ? a : [t + h * g, n + p * g];
}
function Ih(e, t, n, r, o, s) {
  if (r === 0) return 0;
  let i = 0,
    a = r;
  for (let c = 0; c < HM; c++) {
    const u = i + Math.max(Math.abs(a), e.root);
    if (u > e.reach) return null;
    const l = t + o * u,
      d = n + s * u,
      f = e.field(l, d);
    if (f < 0 != r < 0)
      return i + (u - i) * Ah(e, t + o * i, n + s * i, a, l, d, f);
    ((i = u), (a = f));
  }
  return null;
}
function ZM(e, t) {
  const n = e.length;
  if (n < 4) return e;
  const r = new Uint8Array(n);
  let o = 0,
    s = -1;
  for (let a = 1; a < n; a++) {
    const c = ud(e[0], e[a]);
    c > s && ((s = c), (o = a));
  }
  ((r[0] = 1), (r[o] = 1));
  const i = (a, c) => {
    if (c - a < 2) return;
    const u = e[a],
      l = e[c % n];
    let d = -1,
      f = a;
    for (let p = a + 1; p < c; p++) {
      const g = QM(e[p], u, l);
      g > d && ((d = g), (f = p));
    }
    const h = d > t.deviation / 2;
    (!h && Math.sqrt(ud(u, l)) <= t.edge) ||
      (h || (f = (a + c) >> 1), (r[f] = 1), i(a, f), i(f, c));
  };
  return (i(0, o), i(o, n), e.filter((a, c) => r[c] === 1));
}
function ud(e, t) {
  const n = t[0] - e[0],
    r = t[1] - e[1];
  return n * n + r * r;
}
function QM(e, t, n) {
  const r = n[0] - t[0],
    o = n[1] - t[1],
    s = e[0] - t[0],
    i = e[1] - t[1],
    a = r * r + o * o,
    c = a > 0 ? Math.min(1, Math.max(0, (s * r + i * o) / a)) : 0,
    u = s - r * c,
    l = i - o * c;
  return Math.sqrt(u * u + l * l);
}
const JM = 0.02;
const eT = 16;
const tT = 0.015;
const nT = 400;
const rT = 512;
const ls = 5;
const kn = new Map();
function oT(e, t) {
  const n = Math.min(eT, Math.max(0, Math.ceil(Math.log2(Math.max(t, 1))))),
    r = `${n}|${e.wid}|${e.oval.join()}|${e.ovalMix}|${e.pts.join()}`,
    o = kn.get(r);
  if (o !== void 0) return (kn.delete(r), kn.set(r, o), o);
  const s = cT(sT(e), JM / 2 ** n);
  if ((kn.set(r, s), kn.size > rT)) {
    const i = kn.keys().next();
    i.done !== !0 && kn.delete(i.value);
  }
  return s;
}
function sT(e) {
  const [t, n] = e.oval,
    o =
      t > 1e-5 && n > 1e-5
        ? e.ovalMix > 1e-4
          ? Math.min(1, e.ovalMix)
          : uT(0, 0.08, Math.min(t, n))
        : 0,
    s = Math.max(0, e.pts.length - 1),
    i = new Float64Array(s * ls);
  for (let a = 0; a < s; a++) {
    const [c, u] = e.pts[a],
      l = e.pts[a + 1][0] - c,
      d = e.pts[a + 1][1] - u,
      f = l * l + d * d;
    i.set([c, u, l, d, f > 0 ? 1 / f : 0], a * ls);
  }
  return {
    segments: i,
    halfWidth: e.wid > 0 ? e.wid : -1,
    rx: t,
    ry: n,
    ellipseMix: o,
  };
}
function iT(e, t, n) {
  const r = aT(e.segments, t, n) - e.halfWidth;
  if (e.ellipseMix === 0) return r;
  const o = t / e.rx,
    s = n / e.ry,
    i = (Math.sqrt(o * o + s * s) - 1) * Math.min(e.rx, e.ry);
  return r * (1 - e.ellipseMix) + i * e.ellipseMix;
}
function aT(e, t, n) {
  let r = 1e6;
  for (let o = 0; o < e.length; o += ls) {
    const s = t - e[o],
      i = n - e[o + 1],
      a = e[o + 2],
      c = e[o + 3],
      u = (s * a + i * c) * e[o + 4],
      l = u < 0 ? 0 : u > 1 ? 1 : u,
      d = s - a * l,
      f = i - c * l,
      h = d * d + f * f;
    h < r && (r = h);
  }
  return Math.sqrt(r);
}
function cT(e, t) {
  let n = 1 / 0,
    r = 1 / 0,
    o = -1 / 0,
    s = -1 / 0,
    i = 1 / 0;
  const { segments: a, halfWidth: c } = e;
  if (c > 0 && e.ellipseMix < 1 && a.length > 0) {
    for (let d = 0; d < a.length; d += ls)
      for (const [f, h] of [
        [a[d], a[d + 1]],
        [a[d] + a[d + 2], a[d + 1] + a[d + 3]],
      ])
        ((n = Math.min(n, f - c)),
          (r = Math.min(r, h - c)),
          (o = Math.max(o, f + c)),
          (s = Math.max(s, h + c)));
    i = c;
  }
  if (
    (e.ellipseMix > 0 &&
      ((n = Math.min(n, -e.rx)),
      (r = Math.min(r, -e.ry)),
      (o = Math.max(o, e.rx)),
      (s = Math.max(s, e.ry)),
      (i = Math.min(i, e.rx, e.ry))),
    !(o > n && s > r))
  )
    return [];
  const u = Math.max(Math.min(tT, i / 3), Math.max(o - n, s - r) / nT),
    l = {
      x0: n - 2 * u,
      y0: r - 2 * u,
      step: u,
      nx: Math.ceil((o - n) / u) + 4,
      ny: Math.ceil((s - r) / u) + 4,
    };
  return UM((d, f) => iT(e, d, f), l, { deviation: t, edge: Math.sqrt(4 * t) });
}
function uT(e, t, n) {
  const r = Math.min(1, Math.max(0, (n - e) / (t - e)));
  return r * r * (3 - 2 * r);
}
const ld = 48;
const dd = 11;
const gr = 0.055;
const _h = Math.PI * 0.999;
const lT = 0.4;
const dT = 0.0035;
const fT = 0.75;
const hT = 0.45;
const pT = 1.8;
const mT = 0.8;
const gT = Vf.map(MT);
const yT = 192;
const kT = Math.PI / 48;
function wT(e, t, n, r = {}) {
  const o = (e.zoom * n) / 2,
    [s, i] = e.squash;
  if (o === 0 || s === 0 || i === 0)
    return { size: n, body: "", eyes: "", glow: null, proof: null };
  const a = [Math.abs(s), Math.abs(i)],
    c = n / 2 + o * e.offset[0],
    u = n / 2 - o * (e.squashAnchor * (1 - i) + e.offset[1]),
    l = (h) => `${qt(c + h[0] * o)} ${qt(u - h[1] * o)}`,
    d = (h) => h.map((p) => ha(p, l, Math.abs(o))).join(""),
    f = Ch(e, Math.abs(o));
  return {
    size: n,
    body: d(t.cutout ? OM(a, f) : [zr(a, 1)]),
    eyes: t.cutout ? "" : d(f),
    glow: e.glow === null ? null : TT(e.glow, a, l, Math.abs(o)),
    proof: r.isProof === !0 ? ET(e, t, a, l, o, n) : null,
  };
}
function Ch(e, t) {
  if (e.eyes === null) return [];
  const n = ir(e.quat),
    r = [Math.abs(e.squash[0]), Math.abs(e.squash[1])],
    o = r[0] < 1 || r[1] < 1,
    s = [];
  return (
    e.eyes.forEach((i, a) => {
      for (const c of ST(i, Vf[a], gT[a], n, t)) {
        const u = o ? $M(c, r) : c;
        u !== null && s.push(u);
      }
    }),
    s
  );
}
function bT(e, t) {
  const n = (e.zoom * t) / 2,
    [r, o] = e.squash,
    s = [
      t / 2 + n * e.offset[0],
      t / 2 - n * (e.squashAnchor * (1 - o) + e.offset[1]),
    ],
    i = Math.abs(n),
    a = ([c, u]) => [s[0] + c * n, s[1] - u * n];
  return {
    center: s,
    radius: i,
    body: [yM(s, [Math.abs(r) * i, Math.abs(o) * i], yT)],
    eyes: Ch(e, i).map((c) => xT(c).map(a)),
  };
}
function xT(e) {
  const t = [];
  let n = e[e.length - 1]?.to ?? [0, 0];
  for (const r of e) {
    if (r.kind === "arc") {
      const o = Math.atan2(n[1], n[0]),
        s = Math.max(1, Math.ceil(Math.abs(r.sweep) / kT));
      for (let i = 1; i < s; i++) t.push(Ph(r.radii, o + (r.sweep * i) / s));
    }
    (t.push(r.to), (n = r.to));
  }
  return t;
}
function vT(e, t, n = "grok-sphere", r = e.size) {
  const o = [],
    s = [];
  let i = rc(t);
  if (
    (e.glow?.halo != null &&
      (o.push(vi(`${n}-halo`, e.glow.halo.gradient)),
      s.push(
        re("path", {
          d: e.glow.halo.d,
          fill: `url(#${n}-halo)`,
          "fill-rule": "evenodd",
        }),
      )),
    e.proof !== null
      ? ((i = `url(#${n}-light)`),
        o.push(
          vi(`${n}-light`, e.proof.light),
          re("clipPath", { id: `${n}-proof` }, [
            re("path", { d: e.body, "clip-rule": "evenodd" }),
          ]),
        ))
      : e.glow !== null &&
        ((i = `url(#${n}-body)`), o.push(vi(`${n}-body`, e.glow.body))),
    s.push(re("path", { d: e.body, fill: i, "fill-rule": "evenodd" })),
    e.eyes !== "" && s.push(re("path", { d: e.eyes, fill: oc(t) })),
    e.proof !== null)
  ) {
    const a = e.proof.lines
      .filter((c) => c.d !== "")
      .map((c) =>
        re("path", {
          d: c.d,
          fill: "none",
          stroke: c.color,
          "stroke-width": qt(c.width),
          "stroke-opacity": c.opacity,
        }),
      );
    s.push(re("g", { "clip-path": `url(#${n}-proof)` }, a));
  }
  return hc(e.size, n, r, [...(o.length > 0 ? [re("defs", {}, o)] : []), ...s]);
}
function ST(e, t, n, r, o) {
  const s = oT(e, o * Math.max(1, e.lidY));
  if (s.length === 0) return [];
  const i = Et(r, t.M),
    a = Et(r, t.C),
    c = Et(r, t.T),
    u = Math.atan2(i[1], i[0]),
    l = Math.cos(e.tilt),
    d = Math.sin(e.tilt),
    [f, h] = e.off,
    p = ([m, y]) => {
      const w = y * e.lidY,
        S = f + l * m + d * w,
        b = h - d * m + l * w,
        v = Math.sqrt(S * S + b * b),
        T = v > 1e-12 ? Math.sin(v) / v : 1,
        A = Math.cos(v);
      return [
        A * i[0] + T * (S * a[0] + b * c[0]),
        A * i[1] + T * (S * a[1] + b * c[1]),
        A * i[2] + T * (S * a[2] + b * c[2]),
      ];
    },
    g = [];
  for (const m of s) {
    const y = m.map(p);
    n && y.reverse();
    const w = RM(y, u);
    w !== null && g.push(w);
  }
  return g;
}
function MT({ M: e, T: t, C: n }) {
  const r = [
    n[1] * t[2] - n[2] * t[1],
    n[2] * t[0] - n[0] * t[2],
    n[0] * t[1] - n[1] * t[0],
  ];
  return r[0] * e[0] + r[1] * e[1] + r[2] * e[2] < 0;
}
function ha(e, t, n) {
  let r = e[e.length - 1].to,
    o = `M${t(r)}`;
  for (const s of e)
    ((o += s.kind === "line" ? `L${t(s.to)}` : pa(r, s, t, n)), (r = s.to));
  return `${o}Z`;
}
function pa(e, t, n, r) {
  if (t.sweep === 0) return "";
  if (Math.abs(t.sweep) > _h) {
    const s = t.sweep / 2,
      i = Ph(t.radii, Math.atan2(e[1], e[0]) + s);
    return (
      pa(e, { ...t, to: i, sweep: s }, n, r) + pa(i, { ...t, sweep: s }, n, r)
    );
  }
  return `A${`${qt(t.radii[0] * r)} ${qt(t.radii[1] * r)}`} 0 0 ${t.sweep > 0 ? 0 : 1} ${n(t.to)}`;
}
function TT(e, t, n, r) {
  const o = 0.42 + 0.16 * e.midT,
    s = [];
  for (let u = 0; u <= ld; u++) {
    const l = 1 - (1 - u / ld) ** 2;
    s.push({ offset: l, color: Nr(AT(e, o, l)), opacity: 1 });
  }
  const i = { transform: pd(t, n, r), focus: 0, stops: s };
  if (!(e.halo > 0)) return { body: i, halo: null };
  const a = [];
  for (let u = 0; u <= dd; u++) {
    const l = (gr * u) / dd,
      d = Math.min(1, e.halo * (1 - ma(0, gr, l)));
    a.push({ offset: (1 + l) / (1 + gr), color: Nr(e.rim), opacity: d });
  }
  const c = [t[0] * (1 + gr), t[1] * (1 + gr)];
  return {
    body: i,
    halo: {
      d: ha(zr(c, 1), n, r) + ha(zr(t, 1), n, r),
      gradient: { transform: pd(c, n, r), focus: 0, stops: a },
    },
  };
}
function ET(e, t, n, r, o, s) {
  const i = ir(e.quat);
  let a = "",
    c = "";
  for (const h of NS) {
    const p = FS(h, i);
    p !== null && (h.isEquator ? (c += fd(p, r, o)) : (a += fd(p, r, o)));
  }
  const u = hd(t.ink, [1, 1, 1], lT),
    l = DS(),
    d =
      0.2126 * u[0] + 0.7152 * u[1] + 0.0722 * u[2] > 0.6
        ? "#000000"
        : "#ffffff",
    f = Math.max(fT, s * dT);
  return {
    light: {
      transform: PT(l, n, r, o),
      focus: l.focus,
      stops: l.stops.map((h) => ({
        offset: h.offset,
        color: Nr(hd([0, 0, 0], u, h.shade)),
        opacity: 1,
      })),
    },
    lines: [
      { d: a, color: d, width: f, opacity: hT },
      { d: c, color: d, width: f * pT, opacity: mT },
    ],
  };
}
function fd(e, t, n) {
  const r = (p) => [
      e.center[0] + e.a[0] * Math.cos(p) + e.b[0] * Math.sin(p),
      e.center[1] + e.a[1] * Math.cos(p) + e.b[1] * Math.sin(p),
    ],
    o = 0.5 * Math.atan2(2 * xi(e.a, e.b), xi(e.a, e.a) - xi(e.b, e.b)),
    [s, i] = [Math.cos(o), Math.sin(o)],
    a = [e.a[0] * s + e.b[0] * i, e.a[1] * s + e.b[1] * i],
    c = [e.b[0] * s - e.a[0] * i, e.b[1] * s - e.a[1] * i],
    u = `${qt(Math.hypot(a[0], a[1]) * Math.abs(n))} ${qt(Math.hypot(c[0], c[1]) * Math.abs(n))}`,
    l =
      Math.round(Math.atan2(-a[1] * n, a[0] * n) * (180 / Math.PI) * 1e3) / 1e3,
    d = e.a[0] * e.b[1] - e.a[1] * e.b[0] > 0 ? 0 : 1,
    f = Math.ceil((e.to - e.from) / _h);
  let h = `M${t(r(e.from))}`;
  for (let p = 1; p <= f; p++)
    h += `A${u} ${l} 0 ${d} ${t(r(e.from + ((e.to - e.from) * p) / f))}`;
  return h;
}
function PT(e, t, n, r) {
  const [o, s] = e.axisX,
    [i, a] = e.axisY,
    c = [o * t[0] * r, -s * t[1] * r, i * t[0] * r, -a * t[1] * r],
    u = n([e.origin[0] * t[0], e.origin[1] * t[1]]);
  return `matrix(${c.map((l) => Math.round(l * 1e4) / 1e4).join(" ")} ${u})`;
}
function hd(e, t, n) {
  return [
    e[0] + (t[0] - e[0]) * n,
    e[1] + (t[1] - e[1]) * n,
    e[2] + (t[2] - e[2]) * n,
  ];
}
function xi(e, t) {
  return e[0] * t[0] + e[1] * t[1];
}
function AT(e, t, n) {
  const r = ma(0.12, t, n),
    o = ma(t, 0.93, n),
    s = 0.9 + 0.1 * Math.max(0, 1 - n * n) ** 0.225,
    i = (a) => {
      const c = e.inner[a] + (e.mid[a] - e.inner[a]) * r;
      return (c + (e.rim[a] - c) * o) * s;
    };
  return [i(0), i(1), i(2)];
}
function pd(e, t, n) {
  return `matrix(${qt(e[0] * n)} 0 0 ${qt(e[1] * n)} ${t([0, 0])})`;
}
function vi(e, t) {
  return re(
    "radialGradient",
    {
      id: e,
      gradientUnits: "userSpaceOnUse",
      cx: 0,
      cy: 0,
      r: 1,
      fx: t.focus,
      fy: 0,
      gradientTransform: t.transform,
    },
    t.stops.map((n) =>
      re("stop", {
        offset: n.offset,
        "stop-color": n.color,
        "stop-opacity": n.opacity,
      }),
    ),
  );
}
function ma(e, t, n) {
  const r = Math.min(1, Math.max(0, (n - e) / (t - e)));
  return r * r * (3 - 2 * r);
}
function qt(e) {
  return String(Math.round(e * 100) / 100);
}
const IT = -15 + 259 / 2;
const _T = 0.62;
const md = 96;
const CT = Math.PI * 2;
const Si = {
    dots: 22,
    orbit: 19,
    radar: 19,
    progress: 19,
    gather: 19,
    wave: 16,
    send: 20,
    receive: 20,
    dock: 20,
    ball: 18,
    pencil: 17,
    bang: 13,
    standby: 13,
  };
const gd = {
    dots: 1.5,
    orbit: 1.14,
    radar: 1.14,
    progress: 1.32,
    gather: 1.15,
    wave: 1.42,
    send: 1.12,
    receive: 1.12,
    dock: 1.3,
    ball: 1.22,
    pencil: 1.18,
    bang: 1.28,
    standby: 1.75,
  };
const RT = 22;
const yd = 62;
const $T = 0.84;
const OT = 0.22;
const LT = 1.02;
const NT = 9;
const FT = 1400;
const Rh = 1500;
const ga = 1700;
const ds = 2500;
const Mr = 0.68;
const Co = ds * Mr;
const zT = 2.4;
const DT = 120;
const jT = nc("progress") * 1e3;
const qT = nc("spawning") * 1e3;
const BT = [-2, -1, 1, 2];
const Bt = (e) => ((e % 1) + 1) % 1;
const HT = (e, t) => {
    const n = e.length,
      r = (t / n) * Math.PI * 2,
      o = Math.cos(r),
      s = Math.sin(r);
    return Array.from({ length: n }, (i, a) => {
      const [c, u] = e[(((a - t) % n) + n) % n],
        l = c - x,
        d = u - x;
      return [x + l * o - d * s, x + l * s + d * o];
    });
  };
const $h = Array.from({ length: md }, (e, t) => {
    const n = (t / md) * CT;
    return [x + Math.cos(n) * x, x + Math.sin(n) * x];
  });
const kd = nh(88, 18).ring;
const VT = HT(kd, kd.length / 2);
const Mi = (e) => (e === "pencil" ? VT : $h);
const GT = (e, t) => {
    const n = e / 2,
      r = x - t / 2 + n,
      o = x + t / 2 - n;
    return `M${x - n} ${r}A${n} ${n} 0 0 1 ${x + n} ${r}L${x + n} ${o}A${n} ${n} 0 0 1 ${x - n} ${o}Z`;
  };
const WT = (e, t, n) => {
    const r = e / 2,
      o = t / 2,
      s = x - n / 2,
      i = x + n / 2;
    return `M${x - r} ${s + r}A${r} ${r} 0 0 1 ${x + r} ${s + r}L${x + o} ${i - o}A${o} ${o} 0 0 1 ${x - o} ${i - o}Z`;
  };
const UT = GT(30, 88);
const KT = WT(30, 17, 96);
const Ht = (e, t, n, r, o) => ({
    type: "disc",
    key: e,
    cx: t,
    cy: n,
    r,
    opacity: o,
  });
const _s = (e, t, n, r) => ({
    type: "ring",
    key: e,
    cx: x,
    cy: x,
    r: t,
    width: n,
    opacity: r,
  });
const Oh = (e, t, n, r) => ({
    type: "shape",
    key: e,
    d: t,
    transform: n,
    opacity: r,
  });
const XT = (e, t, n, r) => ({ type: "stroke", key: e, d: t, width: n, opacity: r });
const YT = { lift: 0, pop: 1, tone: 1 };
const Lh = (e, t, n, r) => {
    const o = Bt((e.stateTime * 1e3) / FT + 0.119),
      s = Math.abs(o - t / 3),
      i = Math.min(s, 1 - s),
      a = r ? 1 : Math.exp(-(i * i) / (2 * 0.15 * 0.15)),
      c = r ? 0 : 1;
    return {
      lift: a * NT * n * c,
      pop: 1 + c * ($T + OT * a - 1),
      tone: 1 - c * 0.5 * (1 - a),
    };
  };
const ZT = (e) =>
    0.42 +
    0.29 * Math.sin(e * 0.0021) * Math.sin(e * 0.0034) +
    0.29 * Math.sin(e * 0.0013 + 1.7);
const QT = (e, t) =>
    ZT(e) * (0.55 + 0.45 * Math.sin(e * 0.012 - Math.abs(t) * 1.05));
const JT = (e) => -Math.PI * 1.25 + tc(e)() * Math.PI * 1.5;
const eE = (e) => {
    const r = 1082.2060353798126,
      o = 40,
      s = Math.sqrt((2 * o) / r);
    if (e < s) return 0.5 * r * e * e;
    const i = Bt((e - s) / 0.62);
    return o - 208 * i * (1 - i);
  };
const pc = (e) => {
    const t = Bt(e / ds);
    if (t < Mr) {
      const r = t / Mr,
        o = r * r * (3 - 2 * r),
        s = le(r / 0.08, 0, 1) * le((1 - r) / 0.08, 0, 1);
      return {
        x: -54 + 118 * o,
        y: 26,
        wig: Math.sin(r * 24) * 3.2 * s,
        rot: 17 + Math.sin(e * 6e-4) * 1,
      };
    }
    const n = Qo((t - Mr) / (1 - Mr));
    return {
      x: 64 - 118 * n,
      y: 26 - 20 * Math.sin(n * Math.PI),
      wig: 0,
      rot: 17 - 2 * Math.sin(n * Math.PI) + Math.sin(e * 6e-4) * 1,
    };
  };
const Nh = (e) => {
    const t = pc(e);
    return [x + t.x, x + t.y + t.wig + 19];
  };
const tE = (() => {
    const e = [];
    for (let t = 0; t < Co; t++) {
      const n = Nh(t),
        r = e[e.length - 1];
      (r === void 0 || Math.hypot(n[0] - r.point[0], n[1] - r.point[1]) > zT) &&
        e.push({ at: t, point: n });
    }
    return e;
  })();
const nE = (e) => {
    const t = Bt(e / ds) * ds,
      n = Math.min(t, Co),
      r = tE.filter((a) => a.at <= n),
      o = r.length > 0 ? r[r.length - 1].at : n,
      s = n > o ? [Nh(n)] : [],
      i = [...r.map((a) => a.point), ...s].slice(-64);
    return t < Co ? i : i.slice(Math.floor(((t - Co) / 1e3) * DT));
  };
const rE = (e) => {
    const t = e.length;
    let n = `M${e[0][0].toFixed(1)} ${e[0][1].toFixed(1)}`;
    if (t === 2) return n + `L${e[1][0].toFixed(1)} ${e[1][1].toFixed(1)}`;
    for (let r = 0; r < t - 1; r++) {
      const o = e[Math.max(r - 1, 0)],
        s = e[r],
        i = e[r + 1],
        a = e[Math.min(r + 2, t - 1)],
        c = s[0] + (i[0] - o[0]) / 6,
        u = s[1] + (i[1] - o[1]) / 6,
        l = i[0] - (a[0] - s[0]) / 6,
        d = i[1] - (a[1] - s[1]) / 6;
      n += `C${c.toFixed(1)} ${u.toFixed(1)} ${l.toFixed(1)} ${d.toFixed(1)} ${i[0].toFixed(1)} ${i[1].toFixed(1)}`;
    }
    return n;
  };
const oE = (e, t, n) => {
    const r = [x - yd, x + yd],
      o = [];
    for (let s = 0; s < 2; s++) {
      const i = le((e - s * 0.12) / (1 - s * 0.12), 0, 1);
      if (i <= 0.004) continue;
      const a = Ye(i),
        c = Es(i),
        u = Lh(t, s === 0 ? 0 : 2, e, n);
      o.push(
        Ht(
          `dots.${s}`,
          x + (r[s] - x) * c,
          x - u.lift,
          RT * a * u.pop * LT,
          a * u.tone,
        ),
      );
    }
    return o;
  };
const sE = (e, t) => {
    const n = Ye(e),
      r = 52 * Es(e),
      o = 12,
      s = t.stateTime * 1e3 * 0.0017;
    return Array.from({ length: 5 }, (i, a) => {
      const c = s + (a * Math.PI * 2) / 5,
        u = Math.cos(c),
        l = 0.5 + 0.5 * le(u, 0, 1);
      return Ht(
        `orbit.${a}`,
        x + r * Math.sin(c),
        x - r * 0.42 * Math.cos(c),
        Math.max(o * l * n, 0.3),
        le((u + 0.4) / 0.6, 0.18, 1) * n,
      );
    });
  };
const iE = (e, t, n) => {
    const r = Ye(e),
      o = 1300,
      s = 104;
    return Array.from({ length: 3 }, (i, a) => {
      const c = Bt((t.stateTime * 1e3) / o + a / 3);
      return _s(
        `radar.${a}`,
        n + (s - n) * c,
        3.4 * (1 - c * 0.55),
        r * (1 - c) * 0.9,
      );
    });
  };
const aE = (e, t) => {
    const n = Ye(e),
      r = 62 * Es(e),
      o = le((t.shotTime * 1e3) / jT, 0, 1),
      s = le(o / 0.85, 0, 1),
      i = _s("progress.track", r, 5, n * 0.16);
    return s <= 0
      ? [i]
      : [
          i,
          {
            type: "ring",
            key: "progress.arc",
            cx: x,
            cy: x,
            r,
            width: 5,
            opacity: n,
            arc: { fraction: s, startDeg: -90 },
          },
        ];
  };
const cE = (e, t) => {
    const n = Ye(e),
      r = [];
    for (let o = 0; o < 5; o++) {
      const s = le(((t.shotTime * 1e3) / qT - o * 0.09) / 0.62, 0, 1);
      if (s >= 1) continue;
      const i = 1 - Math.pow(1 - s, 3),
        a = o * 2.4 + s * 2.2,
        c = 96 * (1 - i);
      r.push(
        Ht(
          `gather.${o}`,
          x + c * Math.cos(a),
          x + c * Math.sin(a) * 0.8,
          9 * (0.5 + 0.5 * i) * n,
          n * le(s * 5, 0, 1) * (1 - i * 0.25),
        ),
      );
    }
    return r;
  };
const uE = (e, t) => {
    const n = t.stateTime * 1e3,
      r = 44,
      o = [];
    for (const s of BT) {
      const i = le((e - Math.abs(s) * 0.1) / (1 - Math.abs(s) * 0.1), 0, 1);
      if (i <= 0.004) continue;
      const a = Es(i),
        c = QT(n, s),
        u = (7 + 9 * le(c, 0.08, 1)) * Ye(i),
        l = 6 * le(c, 0, 1) * i;
      o.push(Ht(`wave.${s}`, x + s * r * a, x - l, u, i));
    }
    return o;
  };
const lE = (e, t) => {
    const n = Ye(e),
      r = Bt((t.stateTime * 1e3) / Rh),
      o = le((r - 0.18) / 0.55, 0, 1),
      s = o * o * (0.4 + 0.6 * o),
      i = 0.74,
      a = -0.62,
      c = [];
    if (o > 0 && o < 1) {
      const f = 108 * s;
      c.push(
        Ht(
          "send.packet",
          x + i * f,
          x + a * f,
          10 * (1 - s * 0.55) * n,
          n * (1 - s * s),
        ),
      );
    }
    const u = le((r - 0.26) / 0.55, 0, 1),
      l = u * u * (0.4 + 0.6 * u);
    if (o > 0 && u > 0 && u < 1) {
      const f = 108 * l;
      c.push(
        Ht(
          "send.streak",
          x + i * f,
          x + a * f,
          5 * (1 - l * 0.6) * n,
          n * 0.3 * (1 - l),
        ),
      );
    }
    const d = le((r - 0.18) / 0.3, 0, 1);
    return (
      d > 0 &&
        d < 1 &&
        c.push(
          _s("send.launch", 20 + 34 * Ye(d), 2.8 * (1 - d), n * (1 - d) * 0.8),
        ),
      c
    );
  };
const dE = (e, t) => {
    const n = Ye(e),
      r = t.stateTime * 1e3,
      o = JT(Math.floor(r / ga)),
      s = Bt(r / ga),
      i = le(s / 0.6, 0, 1),
      a = 1 - Math.pow(1 - i, 3),
      c = Math.cos(o),
      u = Math.sin(o),
      l = 108 * (1 - a),
      d = [];
    if (i < 1) {
      const h = 18 * Math.sin(i * Math.PI) * (1 - a * 0.7);
      d.push(
        Ht(
          "receive.packet",
          x + c * l - u * h,
          x + u * l + c * h,
          3.5 + 6.5 * a,
          n * le(i * 3.5, 0, 1) * (0.3 + 0.7 * a),
        ),
      );
    }
    const f = le((s - 0.58) / 0.32, 0, 1);
    return (
      f > 0 &&
        f < 1 &&
        d.push(
          _s(
            "receive.absorb",
            20 + 26 * Ye(f),
            2.8 * (1 - f),
            n * (1 - f) * 0.8,
          ),
        ),
      d
    );
  };
const fE = (e, t) => {
    const n = Ye(e),
      r = t.stateTime * 1e3,
      o = 42,
      s = 1.1,
      i = [];
    for (let a = 0; a < 2; a++) {
      const c = le((t.stateTime - (0.2 + a * 1.3)) / 0.9, 0, 1);
      if (c <= 0) continue;
      const u = 1 - Math.pow(1 - c, 3),
        l = r * 0.001 * s + a * Math.PI,
        d = x + o * Math.sin(l),
        f = x + o * 0.5 * Math.cos(l) + Math.sin(r * 0.003 + a) * 2,
        h = x - 120 + a * 30,
        p = x + 95;
      i.push(
        Ht(
          `dock.${a}`,
          h + (d - h) * u,
          p + (f - p) * u,
          (7 + 3 * u) * n,
          n * le(c * 4, 0, 1),
        ),
      );
    }
    return i;
  };
const hE = (e, t) => {
    const n = t.stateTime * 1e3,
      r = pc(n),
      o = ((r.rot - 90) * Math.PI) / 180,
      s = 68,
      i = Math.cos(o) * s,
      a = Math.sin(o) * s,
      c = x + (r.x + i) * e,
      u = x + (r.y + r.wig * 0.15 + a) * e,
      l = [
        Oh(
          "pencil.shaft",
          UT,
          `translate(${c.toFixed(1)} ${u.toFixed(1)}) rotate(${(r.rot * e).toFixed(1)}) scale(${Ye(e).toFixed(3)}) translate(${-x} ${-x})`,
          le(e * 1.6 - 0.3, 0, 1),
        ),
      ],
      d = nE(n);
    return (
      d.length >= 2 && l.push(XT("pencil.ink", rE(d), 6, le(e * 1.2, 0, 1))),
      l
    );
  };
const pE = (e, t) => {
    const n = t.stateTime,
      r = Ye(le(e * 1.1, 0, 1)),
      o = Math.exp(-(n % 2.2) * 5.5),
      s = Math.sin(n * 42) * 2.2 * o;
    return [
      Oh(
        "bang.bar",
        KT,
        `translate(0 ${(-26 - (1 - r) * 70).toFixed(1)}) rotate(${s.toFixed(2)} ${x} ${(x - 74).toFixed(1)}) translate(${x} ${x}) scale(${le(e * 1.2, 0, 1).toFixed(3)}) translate(${-x} ${-x})`,
        le(e * 1.5 - 0.2, 0, 1),
      ),
    ];
  };
const mE = (e, t) => {
    const n = 0.5 + 0.5 * Math.sin(t.stateTime * 1e3 * 0.0016);
    return [Ht("standby.halo", x, x, 26 + 7 * n, Ye(e) * (0.06 + 0.1 * n))];
  };
const gE = (e, t, n, r, o) => {
    switch (e) {
      case "dots":
        return oE(t, n, o);
      case "orbit":
        return sE(t, n);
      case "radar":
        return iE(t, n, r);
      case "progress":
        return aE(t, n);
      case "gather":
        return cE(t, n);
      case "wave":
        return uE(t, n);
      case "send":
        return lE(t, n);
      case "receive":
        return dE(t, n);
      case "dock":
        return fE(t, n);
      case "ball":
        return [];
      case "pencil":
        return hE(t, n);
      case "bang":
        return pE(t, n);
      case "standby":
        return mE(t, n);
    }
  };
function yE(e, t) {
  const { kind: n, isReducedMotion: r } = e,
    o = le(e.amount, 0, 1),
    s = le(e.swap, 0, 1),
    i = s < 0.999 ? e.outgoing : null,
    a = (j) => (j === n ? o * s : j === i ? o * (1 - s) : 0),
    c = (j) => (j === n ? e.clock : e.outgoingClock),
    u = le(o / _T, 0, 1),
    d =
      n === "pencil" || i === "pencil"
        ? s >= 0.999
          ? Mi(n)
          : Kx(Mi(i), Mi(n), Qo(s))
        : $h,
    f = n ? Si[n] * s + (i ? Si[i] : Si[n]) * (1 - s) : 19,
    h = a("dots"),
    p = n === "dots" || i === "dots",
    g = p ? Lh(c("dots"), 1, o, r) : YT;
  let m = p ? 1 + (g.pop - 1) * (h / Math.max(o, 0.001)) : 1;
  const y = a("receive");
  if (y > 0.004) {
    const j = Bt((c("receive").stateTime * 1e3) / ga),
      J = le((j - 0.58) / 0.34, 0, 1);
    m *= 1 + 0.11 * Math.sin(J * Math.PI) * y;
  }
  const w = a("send");
  if (w > 0.004) {
    const j = Bt((c("send").stateTime * 1e3) / Rh),
      J = j < 0.18 ? -0.06 * Math.sin((j / 0.18) * Math.PI) : 0,
      fe =
        j >= 0.18 && j < 0.42
          ? 0.05 * Math.sin(((j - 0.18) / 0.24) * Math.PI)
          : 0;
    m *= 1 + (J + fe) * w;
  }
  const S = a("bang");
  S > 0.004 &&
    (m *= 1 + 0.04 * Math.exp(-(c("bang").stateTime % 2.2) * 5.5) * S);
  let b = 0,
    v = 0,
    T = 0;
  const A = a("pencil");
  if (A > 0.004) {
    const j = pc(c("pencil").stateTime * 1e3);
    ((b += j.x * A), (v += (j.y + j.wig * 0.5) * A), (T += j.rot * A));
  }
  S > 0.004 && (v += 58 * S);
  const F = a("ball");
  F > 0.004 && (v += eE(c("ball").stateTime) * F);
  const N = (f / x) * m,
    R = a("standby"),
    B =
      R > 0
        ? (0.28 + 0.2 * Math.sin(c("standby").stateTime * 1e3 * 0.0016)) * R
        : 0,
    E = {
      scale: 1 - o + N * o,
      dx: b * o,
      dy: -g.lift * h + v * o,
      rotation: T * o,
      opacity: (1 - (1 - g.tone) * h) * (1 - B),
      round: Qo(u),
      ring: d,
    },
    I = 1 - eb(le((t - 44) / 90, 0, 1)),
    _ = n == null ? 1 : gd[n],
    O = i ? gd[i] : _,
    H = 1 + (_ * s + O * (1 - s) - 1) * o * I,
    L = [];
  for (const j of [i, n]) {
    if (j == null) continue;
    const J = a(j);
    J > 0.004 && L.push(...gE(j, J, c(j), f, r));
  }
  return {
    core: E,
    isFaceVisible: o < 0.5,
    zoom: H,
    parts: L.filter((j) => j.opacity > 0),
  };
}
const kE = hM(192);
const wE = xM(96);
const bE = 0.6;
function mc(e, t, n) {
  return t === "sphere" ? bT({ ...e }, n) : iM({ ...e, body: t }, n);
}
function xE(e, t, n = t) {
  const r = e.bodies
      .map(({ body: l, weight: d }) => ({ shape: mc(e, l, t), weight: d }))
      .sort((l, d) => d.weight - l.weight),
    o = r[0]?.shape.center ?? [t / 2, t / 2],
    s = r[0]?.shape.radius ?? 0,
    i = mM([kE, ...r.map(({ shape: l }) => pM(l.body, l.center))]),
    a = Th(
      r.map(({ shape: l, weight: d }) => ({
        outline: gM(l.body, l.center, i),
        weight: d,
      })),
    ),
    c = e.morph == null ? null : yE(e.morph, n),
    u = ($n * t) / 2 / x;
  return {
    size: t,
    center: o,
    body:
      c == null || c.core.round === 0 ? a : SM(a, ME(c, o, s, i), c.core.round),
    eyes: r.length === 1 ? (r[0]?.shape.eyes ?? []) : PE(r),
    head:
      c == null || e.morph == null ? null : TE(c, e.morph.amount, e.zoom, u),
    parts: c?.parts ?? [],
    markScale: u,
    zoom: c?.zoom ?? 1,
  };
}
function vE(e, t, n, r, o = n, s = n) {
  return SE(xE(e, n, o), t, r, s);
}
function SE(e, t, n, r = e.size) {
  const { size: o, center: s } = e,
    i = rc(t),
    a = da(e.body),
    c = e.eyes.map(da).join(""),
    u = [],
    l = [re("path", { d: a, fill: i })];
  c !== "" && t.cutout
    ? (u.push(
        re(
          "mask",
          {
            id: `${n}-holes`,
            maskUnits: "userSpaceOnUse",
            x: 0,
            y: 0,
            width: o,
            height: o,
          },
          [
            re("rect", { width: o, height: o, fill: "#fff" }),
            re("path", { d: c, fill: "#000" }),
          ],
        ),
      ),
      (l[0] = re("path", { d: a, fill: i, mask: `url(#${n}-holes)` })))
    : c !== "" &&
      (u.push(re("clipPath", { id: `${n}-body` }, [re("path", { d: a })])),
      l.push(
        re("path", { d: c, fill: oc(t), "clip-path": `url(#${n}-body)` }),
      ));
  const d = e.head,
    f =
      d == null
        ? l
        : [
            re(
              "g",
              {
                transform: `translate(${Se(s[0] + d.translate[0])} ${Se(s[1] + d.translate[1])}) rotate(${Se(d.rotation)}) scale(${Se(d.scale, 5)}) translate(${Se(-s[0])} ${Se(-s[1])})`,
                ...(d.opacity < 1 ? { opacity: Se(d.opacity, 3) } : {}),
              },
              l,
            ),
          ],
    h =
      e.parts.length === 0
        ? []
        : [
            re(
              "g",
              {
                transform: `translate(${o / 2} ${o / 2}) scale(${Se(e.markScale, 5)}) translate(${-x} ${-x})`,
              },
              e.parts.map((m) => EE(m, i)),
            ),
          ],
    p = o / 2 + (IT - x) * e.markScale,
    g =
      e.zoom === 1
        ? [...h, ...f]
        : [
            re(
              "g",
              {
                transform: `translate(${Se(p)} ${Se(p)}) scale(${Se(e.zoom, 5)}) translate(${Se(-p)} ${Se(-p)})`,
              },
              [...h, ...f],
            ),
          ];
  return hc(o, n, r, [...(u.length === 0 ? [] : [re("defs", {}, u)]), ...g]);
}
function ME(e, t, n, r) {
  const o = n / x,
    s = e.core.ring.map(([i, a]) => [t[0] + (i - x) * o, t[1] + (a - x) * o]);
  return kM(s, t, r);
}
function TE(e, t, n, r) {
  const { core: o } = e,
    s = 1 - t,
    i = t > 0 ? (o.scale - s) / t : 0;
  return {
    translate: [o.dx * r, o.dy * r],
    rotation: o.rotation,
    scale: s + i * ($n / n) * t,
    opacity: o.opacity,
  };
}
function EE(e, t) {
  const n = e.opacity < 1 ? { opacity: Se(e.opacity, 3) } : {};
  switch (e.type) {
    case "disc":
      return re("circle", {
        cx: Se(e.cx),
        cy: Se(e.cy),
        r: Se(e.r),
        fill: t,
        ...n,
      });
    case "ring": {
      const r = 2 * Math.PI * e.r,
        o =
          e.arc == null
            ? {}
            : {
                "stroke-dasharray": `${Se(r * e.arc.fraction)} ${Se(r)}`,
                transform: `rotate(${Se(e.arc.startDeg)} ${Se(e.cx)} ${Se(e.cy)})`,
              };
      return re("circle", {
        cx: Se(e.cx),
        cy: Se(e.cy),
        r: Se(e.r),
        fill: "none",
        stroke: t,
        "stroke-width": Se(e.width),
        ...o,
        ...n,
      });
    }
    case "shape":
      return re("path", { d: e.d, transform: e.transform, fill: t, ...n });
    case "stroke":
      return re("path", {
        d: e.d,
        fill: "none",
        stroke: t,
        "stroke-width": Se(e.width),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        ...n,
      });
  }
}
function PE(e) {
  const t = (e[0]?.shape.radius ?? 0) * bE,
    n = [];
  return (
    e.forEach(({ shape: r }, o) => {
      for (const s of r.eyes) {
        const i = Eh(s),
          a = AE(n, o, i, t);
        if (a != null) {
          a.loops[o] = s;
          continue;
        }
        const c = e.map(() => null);
        ((c[o] = s), n.push({ anchor: i, loops: c }));
      }
    }),
    n.map((r) => {
      const o = r.loops.map((i) => (i == null ? null : wM(i))),
        s = vM([wE, ...o.map((i) => i?.stations ?? [])]);
      return Th(
        e.map(({ weight: i }, a) => {
          const c = o[a];
          return {
            outline: c == null ? MM(r.anchor, s.length) : bM(c, s),
            weight: i,
          };
        }),
      );
    })
  );
}
function AE(e, t, n, r) {
  let o = null,
    s = r;
  for (const i of e) {
    if (i.loops[t] != null) continue;
    const a = Math.hypot(i.anchor[0] - n[0], i.anchor[1] - n[1]);
    a < s && ((o = i), (s = a));
  }
  return o;
}
function Se(e, t = 2) {
  const n = 10 ** t;
  return String(Math.round(e * n) / n);
}
function Fh(e, t, n, r, o = {}) {
  const [s, ...i] = e.bodies;
  return s == null || i.length > 0 || e.morph != null
    ? vE(e, t, n, r, o.displaySize ?? n, o.extent)
    : s.body === "sphere"
      ? vT(wT({ ...e, body: s.body }, t, n, o), t, r, o.extent)
      : aM(sM({ ...e, body: s.body }, t, n, o), r, o.extent);
}
const wd = new WeakMap();
const _E = "http://www.w3.org/2000/svg";
const CE = "/";
function RE(e, t) {
  const n = [],
    r = [];
  zh(t, n, r);
  const o = wd.get(e);
  if (o != null && e.firstChild === o.root && $E(o.names, n)) {
    for (let a = 0; a < r.length; a++)
      r[a] !== o.values[a] && (o.slots[a].value = r[a]);
    o.values = r;
    return;
  }
  const s = Dh(e.ownerDocument, t);
  e.replaceChildren(s);
  const i = [s, ...s.querySelectorAll("*")].flatMap((a) => [...a.attributes]);
  wd.set(e, { root: s, names: n, slots: i, values: r });
}
function zh(e, t, n) {
  t.push(e.tag);
  for (const [r, o] of Object.entries(e.attrs)) (t.push(r), n.push(String(o)));
  for (const r of e.children) zh(r, t, n);
  t.push(CE);
}
function Dh(e, t) {
  const n = e.createElementNS(_E, t.tag);
  for (const [r, o] of Object.entries(t.attrs)) n.setAttribute(r, String(o));
  for (const r of t.children) n.append(Dh(e, r));
  return n;
}
function $E(e, t) {
  return e.length === t.length && e.every((n, r) => n === t[r]);
}
function wN(e) {
  switch (e) {
    case "blob":
      return "sphere";
    case "flower":
      return "starFlower";
    case "heart":
      return "heartChubby";
    case "star":
      return "star6";
    default:
      return e;
  }
}
const wo = [0, 0, 0];
function zE(e, t) {
  return t == null
    ? { ink: wo, spot: wo, cutout: !0, inkPaint: e }
    : { ink: wo, spot: wo, cutout: !1, inkPaint: e, spotPaint: t };
}
export { Yf as createMotion, Nx as createStateDriver, Fh as renderFrame, RE as updateSvg, zE as avatarPaint };
