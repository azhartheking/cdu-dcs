/* =====================================================================
   CDU (CRUDE DISTILLATION UNIT 11) DCS TRAINING SIMULATOR — PROCESS MODEL
   Training-grade dynamic model built from public training material (Unit 11 CDU training module,
   textbook CDU theory). Lumped first-order lags, mass and energy balances. NOT design data.
   Sections: 1 crudes, TBP curves & operating cases · 2 controller / equipment catalogue
             3 state factory · 4 PID · 5 process step (100 preheat & desalting · 200 heater
             · 300 fractionator · 400 overhead & stabilizer · 500 rundown & dryers)
             · 6 noise · 7 relief & flare · 8 product quality · 9 SIS · 10 recipe solver
   Units: flow t/h · temperature °C · pressure kg/cm²g · duty MW · level %
   ===================================================================== */
(function (G) {
'use strict';
const CDU = G.CDU = G.CDU || {};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lag = (y, u, tau, dt) => y + (u - y) * (1 - Math.exp(-dt / Math.max(tau, 1e-6)));
const pos = (x) => Math.max(0, x);
CDU.clamp = clamp; CDU.lag = lag;

/* ---------------- 1. CRUDES, TBP CURVES, OPERATING CASES ----------------
   TBP: cumulative wt% distilled (dry crude) vs true boiling point °C. The 165/205/330/370 °C points
   are the design cut points of the book (yields LPG/naphtha/kero/LGO/HGO/residue); the rest is
   interpolated from typical curves for a light paraffinic (Bach Ho) and a medium sour (Dubai) crude. */
CDU.CRUDES = {
  BH: { name: 'Bach Ho', api: 39.2, S: 0.03, salt: 14, water: 0.61, gas: 0.0005, fz0: -47.2, p0: -7, cet0: 56, smk0: 26, den0: 0.785,
    tbp: [[-50, 0], [30, 0.272], [80, 3.2], [120, 7.6], [165, 13.65], [205, 19.97], [260, 29.6], [330, 41.06], [370, 49.68], [450, 63.0], [550, 77.0], [700, 91.0], [900, 100]] },
  DB: { name: 'Dubai', api: 31.2, S: 2.1, salt: 56, water: 0.44, gas: 0.0012, fz0: -65, p0: -15, cet0: 49, smk0: 21, den0: 0.805,
    tbp: [[-50, 0], [30, 0.864], [80, 4.6], [120, 9.9], [165, 16.94], [205, 22.97], [260, 31.6], [330, 42.11], [370, 50.14], [450, 60.0], [550, 72.0], [700, 86.0], [900, 100]] },
  FL: { name: 'SR flushing oil (gas oil)', tbp: [[240, 0], [270, 3], [300, 12], [330, 30], [360, 60], [390, 85], [420, 96], [460, 100]] }
};
function interp(c, T) {
  if (T <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) if (T <= c[i][0]) { const a = c[i - 1], b = c[i]; return a[1] + (b[1] - a[1]) * (T - a[0]) / (b[0] - a[0]); }
  return c[c.length - 1][1];
}
// cumulative wt% of a mixture: x = Bach Ho fraction of the crude, w = crude fraction of the inventory (rest flushing oil), dT = noise shift
CDU.cum = (x, w, T, dT, fo) => { const t = T - (dT || 0); return w * (x * interp(CDU.CRUDES.BH.tbp, t) + (1 - x) * interp(CDU.CRUDES.DB.tbp, t)) + (1 - w) * interp(CDU.CRUDES.FL.tbp, t - (fo || 0)); };
CDU.icum = (x, w, y, dT) => { let lo = -50, hi = 900; for (let i = 0; i < 44; i++) { const m = (lo + hi) / 2; if (CDU.cum(x, w, m, dT) < y) lo = m; else hi = m; } return (lo + hi) / 2; };
CDU.crudeProps = function (x) {
  const B = CDU.CRUDES.BH, D = CDU.CRUDES.DB, m = (k) => x * B[k] + (1 - x) * D[k];
  return { api: m('api'), S: m('S'), salt: m('salt'), water: m('water'), gas: m('gas'), fz0: m('fz0'), p0: m('p0'), cet0: m('cet0'), smk0: m('smk0'), den0: m('den0'), lpg: CDU.cum(x, 1, 30) };
};

/* Operating cases (the "grades" of this plant). cuts = TBP cut points naphtha/kero, kero/LGO, LGO/HGO, HGO/residue */
CDU.GRADES = {
  'BACH HO':     { fam: 'SWEET', desc: '100 % Bach Ho crude (sweet, 39.2 API) — design case', bh: 100, cuts: [165, 205, 330, 370], jet: false, feed: 810 },
  'DUBAI':       { fam: 'SOUR', desc: '100 % Dubai crude (sour, 31.2 API, 2.1 wt% S)', bh: 0, cuts: [165, 205, 330, 370], jet: false, feed: 810 },
  'BLEND':       { fam: 'JET A-1', desc: '84.6 wt% Bach Ho + 15.4 wt% Dubai — kerosene meets Jet A-1 freeze point', bh: 84.6, cuts: [165, 205, 330, 370], jet: true, feed: 810 },
  'MAX NAPHTHA': { fam: 'FLEX', desc: 'Bach Ho, naphtha/kero cut raised to 170 °C (maximum naphtha to NHT)', bh: 100, cuts: [170, 205, 330, 370], jet: false, feed: 810 },
  'MAX KERO':    { fam: 'FLEX', desc: 'Bach Ho, kerosene widened to 163–228 °C (maximum kerosene to KTU)', bh: 100, cuts: [163, 228, 330, 370], jet: false, feed: 810 }
};
// product specifications (book §1.2.3; HGO CCR and LGO water are assumed for the downstream units)
CDU.PROPS = {
  C5:   { label: 'LPG C5+', unit: 'mol%', dec: 2, prod: 'LPG', spec: [0, 1.5] },
  C4N:  { label: 'Naphtha C4', unit: 'wt%', dec: 2, prod: 'NAP', spec: [0, 0.3] },
  N95:  { label: 'Naphtha 95 % D86', unit: '°C', dec: 0, prod: 'NAP' },
  GNK:  { label: 'Gap kero 5 % − naphtha 95 %', unit: '°C', dec: 1, prod: 'KERO', spec: [0, 999] },
  KFL:  { label: 'Kero flash point', unit: '°C', dec: 1, prod: 'KERO', spec: [40, 999] },
  FRZ:  { label: 'Kero freeze point', unit: '°C', dec: 1, prod: 'KERO', jet: [-999, -47] },
  SMK:  { label: 'Kero smoke point', unit: 'mm', dec: 1, prod: 'KERO', spec: [20, 999] },
  DEN:  { label: 'Kero density @15 °C', unit: 'kg/l', dec: 3, prod: 'KERO', spec: [0, 0.83] },
  GKL:  { label: 'Gap LGO 5 % − kero 95 %', unit: '°C', dec: 1, prod: 'LGO', spec: [0, 999] },
  LFL:  { label: 'LGO flash point', unit: '°C', dec: 1, prod: 'LGO', spec: [65, 999] },
  POUR: { label: 'LGO pour point', unit: '°C', dec: 1, prod: 'LGO', spec: [-999, 0] },
  CET:  { label: 'LGO cetane index', unit: '', dec: 1, prod: 'LGO', spec: [45, 999] },
  H2O:  { label: 'LGO water (after dryer)', unit: 'ppm', dec: 0, prod: 'LGO', spec: [0, 200] },
  OLH:  { label: 'Overlap LGO 95 % − HGO 5 %', unit: '°C', dec: 1, prod: 'HGO', spec: [-999, 20] },
  HFL:  { label: 'HGO flash point', unit: '°C', dec: 0, prod: 'HGO', spec: [65, 999] },
  CCR:  { label: 'HGO carbon residue', unit: 'wt%', dec: 2, prod: 'HGO', spec: [0, 0.3] },
  R360: { label: 'Residue vaporising < 360 °C', unit: 'vol%', dec: 1, prod: 'RES', spec: [0, 10] }
};
CDU.PRODUCTS = { LPG: 'LPG', NAP: 'Full-range naphtha', KERO: 'Kerosene', LGO: 'Light gas oil', HGO: 'Heavy gas oil', RES: 'Atmospheric residue' };
for (const g in CDU.GRADES) {
  const s = CDU.GRADES[g].spec = {};
  for (const k in CDU.PROPS) { const P = CDU.PROPS[k]; if (P.spec) s[k] = P.spec; if (P.jet && CDU.GRADES[g].jet) s[k] = P.jet; }
}

/* ---------------- 2. CONTROLLERS, FINAL ELEMENTS, EQUIPMENT ----------------
   act: +1 = OP rises when PV > SP (direct), −1 = reverse. ppv: P and D on PV, I on error.
   Tag numbers follow the Unit 11 control narrative (prefix 011- dropped); loops marked (a) in the
   description are numbers assumed by this simulator where the source gives none.                    */
CDU.CTL = {
  // ---- 100 crude preheat & desalting
  'FIC-069': { d: 'CDU charge to heater H-1101 (total of 8 passes; pass balancing FY-093)', u: 't/h', lo: 0, hi: 1200, act: -1, kc: 0.4, ti: 6, page: 'preheat', dec: 0 },
  'PIC-011': { d: 'Desalter A-1101-D-01 pressure → crude feed from tankage (P-6001)', u: 'kg/cm²g', lo: 0, hi: 20, act: -1, kc: 2.0, ti: 40, page: 'preheat', dec: 2 },
  'HIC-002': { d: 'Crude blend ratio — % Bach Ho in the charge (rest Dubai); sets 060-FIC-005 / 012 at tankage', u: '%', lo: 0, hi: 100, act: 0, hand: true, page: 'preheat', dec: 1 },
  'TDIC-007': { d: 'Cold preheat train: branch A − branch B outlet ΔT', u: '°C', lo: -30, hi: 30, act: 1, kc: 0.6, ti: 240, page: 'preheat', dec: 1 },
  'TDIC-015': { d: 'Hot preheat train: branch A − branch B outlet ΔT', u: '°C', lo: -30, hi: 30, act: 1, kc: 0.6, ti: 240, page: 'preheat', dec: 1 },
  'PDIC-503': { d: 'First-stage mixing valve PDV-503 ΔP (emulsion degree)', u: 'kg/cm²', lo: 0, hi: 3, act: 1, kc: 0.25, ti: 12, page: 'preheat', dec: 2 },
  'PDIC-506': { d: 'Second-stage mixing valve PDV-506 ΔP (emulsion degree)', u: 'kg/cm²', lo: 0, hi: 3, act: 1, kc: 0.25, ti: 12, page: 'preheat', dec: 2 },
  'LIC-003': { d: 'Desalter D-01 water/oil interface → effluent (brine) LV-003', u: '%', lo: 0, hi: 100, act: 1, kc: 1.5, ti: 400, page: 'preheat', dec: 1 },
  'LIC-006': { d: 'Desalter D-02 water/oil interface → recycle water P-1118 (LV-006)', u: '%', lo: 0, hi: 100, act: 1, kc: 1.5, ti: 400, page: 'preheat', dec: 1 },
  'FIC-004': { d: 'Fresh wash water to 2nd stage (P-1119 from D-1109) (a)', u: 't/h', lo: 0, hi: 80, act: -1, kc: 0.5, ti: 8, page: 'preheat', dec: 1 },
  // ---- 200 crude charge heater
  'TIC-066': { d: 'H-1101 combined coil outlet temperature (COT) → fuel gas PV-120. Min stop 3 % while burners are lit (one burner)', u: '°C', lo: 0, hi: 450, act: -1, kc: 2.2, ti: 140, td: 15, ppv: true, page: 'heater', dec: 1 },
  'AIC-063': { d: 'Flue-gas excess O2 → FD fan B-1101 inlet vanes (a)', u: '% O2', lo: 0, hi: 10, act: -1, kc: 2, ti: 60, page: 'heater', dec: 2 },
  // ---- 300 main fractionator
  'TIC-076': { d: 'T-1101 overhead temperature → top pumparound duty E-1112 (UV-079 / UV-080)', u: '°C', lo: 50, hi: 200, act: 1, kc: 3, ti: 240, td: 20, ppv: true, page: 'fract', dec: 1 },
  'UIC-029': { d: 'Kerosene pumparound duty → UV-083/084 (E-1102 / bypass)', u: 'MW', lo: 0, hi: 25, act: -1, kc: 1.5, ti: 60, page: 'fract', dec: 2 },
  'UIC-032': { d: 'LGO pumparound duty → UV-087/088 (E-1106 A-F / bypass)', u: 'MW', lo: 0, hi: 70, act: -1, kc: 1.5, ti: 60, page: 'fract', dec: 2 },
  'UIC-031': { d: 'HGO pumparound duty → E-1109 / bypass', u: 'MW', lo: 0, hi: 10, act: -1, kc: 1.5, ti: 60, page: 'fract', dec: 2 },
  'UIC-033': { d: 'Kerosene stripper reboiler E-1110 duty (HGO PA hot side)', u: 'MW', lo: 0, hi: 8, act: -1, kc: 1.5, ti: 60, page: 'fract', dec: 2 },
  'FQIC-033': { d: 'Kerosene rundown to KTU (P-1107) — sets the kero/LGO cut', u: 't/h', lo: 0, hi: 150, act: -1, kc: 0.4, ti: 6, page: 'fract', dec: 1 },
  'FQIC-020': { d: 'LGO product to LCO HDT / storage (P-1112) — sets the LGO/HGO cut', u: 't/h', lo: 0, hi: 350, act: -1, kc: 0.4, ti: 6, page: 'rundown', dec: 1 },
  'FQIC-024': { d: 'HGO product to LCO HDT / storage (P-1113) — sets the HGO/residue cut (a)', u: 't/h', lo: 0, hi: 150, act: -1, kc: 0.4, ti: 6, page: 'rundown', dec: 1 },
  'LIC-007': { d: 'T-1101 bottoms level → split range: FV-026 to RFCC (0-50 %) / FV-027 to storage (50-100 %)', u: '%', lo: 0, hi: 100, act: 1, kc: 1.5, ti: 600, page: 'fract', dec: 1 },
  'FIC-051': { d: 'T-1101 bottom stripping steam (superheated LP) (a)', u: 't/h', lo: 0, hi: 30, act: -1, kc: 0.4, ti: 8, page: 'fract', dec: 2 },
  'FIC-052': { d: 'T-1103 LGO stripper steam (a)', u: 't/h', lo: 0, hi: 10, act: -1, kc: 0.4, ti: 8, page: 'fract', dec: 2 },
  'FIC-053': { d: 'T-1104 HGO stripper steam (a)', u: 't/h', lo: 0, hi: 5, act: -1, kc: 0.4, ti: 8, page: 'fract', dec: 2 },
  'LIC-011': { d: 'T-1102 kerosene stripper level → LV-011 draw from tray 15', u: '%', lo: 0, hi: 100, act: -1, kc: 2, ti: 240, page: 'fract', dec: 1 },
  'LIC-013': { d: 'T-1103 LGO stripper level → LV-013 draw from tray 26', u: '%', lo: 0, hi: 100, act: -1, kc: 2, ti: 240, page: 'fract', dec: 1 },
  'LIC-016': { d: 'T-1104 HGO stripper level → LV-016 draw from tray 38', u: '%', lo: 0, hi: 100, act: -1, kc: 2, ti: 240, page: 'fract', dec: 1 },
  // ---- 400 overhead & naphtha stabilizer
  'PIC-064': { d: 'D-1103 pressure → 3-way split range: fuel gas make-up PV-064A (0-33 %) / off gas to RFCC PV-064B (33-67 %) / flare PV-064C (67-100 %)', u: 'kg/cm²g', lo: 0, hi: 5, act: 1, kc: 6, ti: 120, page: 'overhead', dec: 2 },
  'LIC-038': { d: 'D-1103 naphtha level → FV-032 stabilizer feed (P-1110)', u: '%', lo: 0, hi: 100, act: 1, kc: 1.2, ti: 600, page: 'overhead', dec: 1 },
  'LIC-040': { d: 'D-1103 water boot interface → LV-040 sour water to D-1106', u: '%', lo: 0, hi: 100, act: 1, kc: 1.5, ti: 300, page: 'overhead', dec: 1 },
  'TIC-060': { d: 'T-1107 bottom temperature → HP steam to reboiler E-1121 (FV-060) (a)', u: '°C', lo: 0, hi: 250, act: -1, kc: 2.5, ti: 300, td: 20, ppv: true, page: 'overhead', dec: 1 },
  'LIC-047': { d: 'D-1104 reflux drum level → FV-036 reflux to T-1107 (P-1114)', u: '%', lo: 0, hi: 100, act: 1, kc: 1.5, ti: 300, page: 'overhead', dec: 1 },
  'FQIC-037': { d: 'LPG product (P-1115) to gas recovery in RFCC — equal-% valve FV-037', u: 't/h', lo: 0, hi: 15, act: -1, kc: 0.4, ti: 8, page: 'overhead', dec: 2 },
  'PIC-068': { d: 'D-1104 pressure → split range: padding gas (0-33 %) / off gas to RFCC PV-068B (33-67 %) / flare PV-068C (67-100 %)', u: 'kg/cm²g', lo: 0, hi: 12, act: 1, kc: 5, ti: 120, page: 'overhead', dec: 2 },
  'LIC-042': { d: 'T-1107 bottoms level → split range: FV-040 naphtha to NHT (0-50 %) / LV-045 to storage (50-100 %)', u: '%', lo: 0, hi: 100, act: 1, kc: 1.2, ti: 600, page: 'overhead', dec: 1 },
  // ---- 500 product rundown & dryers
  'LIC-019': { d: 'T-1105 LGO dryer level → LV-019 (T-1103 bottoms to dryer)', u: '%', lo: 0, hi: 100, act: -1, kc: 2, ti: 240, page: 'rundown', dec: 1 },
  'LIC-022': { d: 'T-1106 HGO dryer level → LV-022 (T-1104 bottoms to dryer)', u: '%', lo: 0, hi: 100, act: -1, kc: 2, ti: 240, page: 'rundown', dec: 1 },
  'PIC-049': { d: 'Ejector package A-1102 inlet (dryer) pressure → recycle PV-546', u: 'kg/cm²g', lo: -1.03, hi: 0.5, act: -1, kc: 1.5, ti: 60, page: 'rundown', dec: 3 },
  'TIC-111': { d: 'Residue to storage after E-1120 → tempered water TV-111', u: '°C', lo: 0, hi: 200, act: 1, kc: 1.5, ti: 120, page: 'rundown', dec: 1 }
};
// valve capacities at 100 % OP (t/h, or MW for duty valves); 'eq' = equal-percentage characteristic (rangeability 60)
const SPAN = CDU.SPAN = {
  FV092: 1500, PASS: 200, FV004: 80, LV003: 80, LV006: 80, PV120: 14, AIR: 236,
  TPA: 45, KPA: 20, LPA: 62, HPA: 4.4, REB: 5.8, FV033: 145, FV020: 350, FV024: 150,
  FV026: 340, FV027: 400, FV051: 30, FV052: 10, FV053: 5, LV011: 145, LV013: 400, LV016: 160,
  FV032: 250, LV040: 60, FV060: 39, FV036: 36, FV037: 33, FV040: 165, LV045: 200, LV019: 400, LV022: 160,
  PV064A: 3, PV064B: 4, PV064C: 60, PV068A: 0.6, PV068B: 1.6, PV068C: 30
};
CDU.eqpct = (op, cap) => op <= 0.2 ? 0 : cap * Math.pow(60, op / 100 - 1);
/* final control elements: the valve or drive each controller moves */
CDU.FCE = {
  'FIC-069': 'FCV-071…078 (8 pass valves)', 'PIC-011': 'FV-092', 'TDIC-007': 'TV-007A/B', 'TDIC-015': 'TV-015A/B', 'PDIC-503': 'PDV-503', 'PDIC-506': 'PDV-506',
  'LIC-003': 'LV-003', 'LIC-006': 'LV-006', 'FIC-004': 'FV-004', 'HIC-002': 'HY-002 (ratio station)', 'TIC-066': 'PV-120 (fuel gas)', 'AIC-063': 'SC-063 (FD fan vanes)',
  'TIC-076': 'UV-079/080', 'UIC-029': 'UV-083/084', 'UIC-032': 'UV-087/088', 'UIC-031': 'UV-085/086', 'UIC-033': 'UV-089',
  'FQIC-033': 'FV-033', 'FQIC-020': 'FV-020', 'FQIC-024': 'FV-024', 'LIC-007': 'FV-026 / FV-027', 'FIC-051': 'FV-051', 'FIC-052': 'FV-052', 'FIC-053': 'FV-053',
  'LIC-011': 'LV-011', 'LIC-013': 'LV-013', 'LIC-016': 'LV-016', 'PIC-064': 'PV-064A/B/C', 'LIC-038': 'FV-032', 'LIC-040': 'LV-040',
  'TIC-060': 'FV-060', 'LIC-047': 'FV-036', 'FQIC-037': 'FV-037', 'PIC-068': 'PV-068A/B/C', 'LIC-042': 'FV-040 / LV-045',
  'LIC-019': 'LV-019', 'LIC-022': 'LV-022', 'PIC-049': 'PV-546', 'TIC-111': 'TV-111'
};
/* motors, drives and hand switches. spare: a standby pump B exists (START after a trip starts the spare) */
CDU.EQ = {
  P6001: { d: 'Crude charge pumps P-6001 A/B/C (tankage)', page: 'preheat', tag: 'P-6001', spare: true },
  P1101: { d: 'Crude booster pumps P-1101 A/B (desalter outlet → hot train)', page: 'preheat', tag: 'P-1101', spare: true },
  P1118: { d: 'Desalter recycle water pumps P-1118 A/B (D-02 → D-01)', page: 'preheat', tag: 'P-1118', spare: true },
  P1119: { d: 'Desalter wash water charge pumps P-1119 A/B (D-1109 → E-1128)', page: 'preheat', tag: 'P-1119', spare: true },
  XFMR: { d: 'Desalter transformers TR-01A/B, TR-02A/B (electrostatic grids)', page: 'preheat', tag: 'TR-01/02' },
  DSAL: { d: 'HS-001 desalters IN SERVICE (stopped = both desalters BYPASSED)', page: 'preheat', tag: 'HS-001' },
  DEMUL: { d: 'Demulsifier injection A-1104-P-23 A/B', page: 'preheat', tag: 'A-1104-P-23' },
  B1101: { d: 'Heater forced-draft fans B-1101 A/B', page: 'heater', tag: 'B-1101', spare: true },
  SHSTM: { d: 'LP steam through the H-1101 superheater coil (to T-1101 or vent SL-1101)', page: 'heater', tag: 'SL-1101' },
  PILOT: { d: 'H-1101 pilot burners (pilot gas XV-007/011)', page: 'heater', tag: 'PILOTS' },
  BURN: { d: 'H-1101 main fuel-gas burners (XV-006 / XV-010, 16 burners)', page: 'heater', tag: 'BURNERS' },
  P1106: { d: 'Atmospheric residue pumps P-1106 A/B', page: 'fract', tag: 'P-1106', spare: true },
  P1102: { d: 'Top pumparound pumps P-1102 A/B (tray 4 → E-1112 → tray 1)', page: 'fract', tag: 'P-1102', spare: true },
  E1112: { d: 'Top pumparound air cooler E-1112 fans', page: 'fract', tag: 'E-1112' },
  P1103: { d: 'Kerosene pumparound pumps P-1103 A/B', page: 'fract', tag: 'P-1103', spare: true },
  P1104: { d: 'LGO pumparound pumps P-1104 A/B', page: 'fract', tag: 'P-1104', spare: true },
  P1105: { d: 'HGO pumparound pumps P-1105 A/B', page: 'fract', tag: 'P-1105', spare: true },
  P1107: { d: 'Kerosene product pumps P-1107 A/B', page: 'fract', tag: 'P-1107', spare: true },
  E1111: { d: 'Main fractionator overhead air condenser E-1111 fans', page: 'overhead', tag: 'E-1111' },
  NEUT: { d: 'Neutralizer + corrosion inhibitor injection to T-1101 overhead (A-1104-P-25/26)', page: 'overhead', tag: 'A-1104-P-25' },
  P1110: { d: 'Stabilizer feed pumps P-1110 A/B', page: 'overhead', tag: 'P-1110', spare: true },
  P1114: { d: 'Stabilizer reflux pumps P-1114 A/B', page: 'overhead', tag: 'P-1114', spare: true },
  P1115: { d: 'Stabilizer LPG pumps P-1115 A/B', page: 'overhead', tag: 'P-1115', spare: true },
  P1112: { d: 'LGO product pumps P-1112 A/B', page: 'rundown', tag: 'P-1112', spare: true },
  P1113: { d: 'HGO product pumps P-1113 A/B', page: 'rundown', tag: 'P-1113', spare: true },
  EJ: { d: 'Ejector package A-1102 motive MP steam (dryer vacuum)', page: 'rundown', tag: 'A-1102' },
  P1122: { d: 'Tempered water pumps P-1122 A/B (residue cooler E-1120)', page: 'rundown', tag: 'P-1122', spare: true }
};
CDU.EQTAG = {}; for (const k in CDU.EQ) CDU.EQTAG[k] = CDU.EQ[k].tag;
CDU.ROUTES = { NAP: ['Naphtha', 'NHT / storage'], KERO: ['Kerosene', 'KTU'], LGO: ['LGO', 'LCO HDT / storage'], HGO: ['HGO', 'LCO HDT / storage'], RES: ['Residue', 'RFCC / storage'] };
// plant "down" states (alarm suppression)
CDU.isIdle = (S) => S.p.F < 50 && !S.eq.BURN;
CDU.isLow = (S) => S.p.F < 600 || S.circ !== 'NORMAL' || S.p.COT < 330;

/* ---------------- 3. STATE FACTORY ---------------- */
function mkCtl(tag, sp, op, mode) { return { pv: sp, sp: sp, op: op, mode: mode || 'AUTO', e1: 0, e2: 0 }; }
CDU.mkCtl = mkCtl;
CDU.upgradeState = function (S) {
  if (!S || !S.ctl) return S;
  for (const tag in CDU.CTL) if (!S.ctl[tag]) S.ctl[tag] = mkCtl(tag, 0, 0, 'MAN');
  for (const k in CDU.EQ) if (S.eq[k] == null) S.eq[k] = false;
  return S;
};
CDU.newState = function (grade) {
  const S = {
    v: 1, t: 0, speed: 1, frozen: false, grade, target: grade,
    circ: 'NORMAL', feedSrc: 'CRUDE', route: { NAP: 'PRODUCT', KERO: 'PRODUCT', LGO: 'PRODUCT', HGO: 'PRODUCT', RES: 'PRODUCT' },
    ctl: {}, p: {}, eq: {}, fail: {}, sis: { bypass: false, htrTrip: false, purge: 0, esd: false, lastTrip: '', cut: {} },
    alarms: [], journal: [], lab: [], nextSample: 1800, sampleNo: 0, hist: { t: [], d: {} }, histNext: 0,
    tons: { on: 0, off: 0, slop: 0 }, prodTons: {}, sched: [], exercise: null
  };
  for (const tag in CDU.CTL) S.ctl[tag] = mkCtl(tag, 0, 0, 'AUTO');
  S.ctl['HIC-002'].mode = 'MAN';
  for (const k in CDU.EQ) S.eq[k] = true;
  for (const k in CDU.FAILS) S.fail[k] = false;
  for (const k in CDU.PRODUCTS) S.prodTons[k] = { on: 0, off: 0, slop: 0 };
  return S;
};

/* ---------------- 4. CONTROLLERS (velocity-form PID, bumpless) ---------------- */
function pidStep(c, def, pv, dt) {
  if (CDU.mnoise && !def.hand) { c.mn = (c.mn || 0) + (CDU.gauss() * 0.0012 * (def.hi - def.lo) - (c.mn || 0)) * Math.min(1, dt / 4); pv += c.mn; }
  if (c.frozenPV != null) pv = c.frozenPV;               // transmitter failure (instructor)
  c.pv = pv;
  if (def.hand) { c.mode = 'MAN'; return; }
  const span = def.hi - def.lo;
  const e = (pv - c.sp) / span * 100 * def.act;
  const y = pv / span * 100 * def.act;
  if (c.y1 == null) c.y1 = y;
  if (c.mode === 'AUTO') {
    const ti = def.ti || 1e9, td = def.td || 0;
    const tf = Math.max(4, td / 4), ds = def.ppv ? y : e;
    c.ef = c.ef == null ? ds : c.ef + (ds - c.ef) * Math.min(1, dt / tf);
    const f1 = c.f1 == null ? c.ef : c.f1, f2 = c.f2 == null ? f1 : c.f2;
    const dP = def.ppv ? y - c.y1 : e - c.e1;
    const dOP = def.kc * (dP + dt / ti * e + td / dt * (c.ef - 2 * f1 + f2));
    c.op = clamp(c.op + dOP, c.opMin || 0, 100);
    c.f2 = f1; c.f1 = c.ef;
  } else {
    c.sp = pv;
    c.ef = c.f1 = c.f2 = null;
  }
  c.e2 = c.e1; c.e1 = e; c.y1 = y;
}
CDU.pidStep = pidStep;

// water saturation temperature (°C) at pressure P (bar abs), Antoine fit 1–3 bar
CDU.tsatW = (Pbar) => 3816.44 / (18.3036 - Math.log(Math.max(Pbar, 0.02) * 750.06)) - 227.02;
const KGA = 1.0332;   // kg/cm² atmosphere

/* ---------------- 5. PROCESS STEP ---------------- */
CDU.step = function (S, dt) {
  const p = S.p, C = S.ctl, E = S.eq, F = S.fail, D = CDU.CTL;
  S.t += dt;
  CDU.noise(S, dt); const N = S.nz;
  for (const ev of S.sched) if (!ev.done && S.t >= ev.t) { ev.done = true; CDU.applyFail(S, ev.fail, ev.on !== false, 'SCHEDULE'); }
  for (const k in S.failUntil || {}) if (S.fail[k] && S.t >= S.failUntil[k]) { delete S.failUntil[k]; CDU.applyFail(S, k, false, 'SCHEDULE'); }
  if (F.power) for (const k of ['P6001', 'P1101', 'P1106', 'P1102', 'P1103', 'P1104', 'P1105', 'P1107', 'P1110', 'P1114', 'P1115', 'P1112', 'P1113', 'P1118', 'P1119', 'P1122', 'B1101', 'E1111', 'E1112', 'XFMR'])
    if (E[k]) CDU.tripEq(S, k, 'Power failure (MCC bus lost).');
  const util = { lp: F.lpFail ? 0 : 1, mp: F.mpFail ? 0 : 1, hp: F.hpFail ? 0 : 1, cw: F.cwFail ? 0 : 1 };
  p.Tair = 30 + N.air + N.aird;
  p.lpP = lag(p.lpP == null ? 3.5 : p.lpP, util.lp ? 3.5 : 0.2, 60, dt);
  p.mpP = lag(p.mpP == null ? 10 : p.mpP, util.mp ? 10 : 0.3, 60, dt);
  p.hpP = lag(p.hpP == null ? 40 : p.hpP, util.hp ? 40 : 1, 60, dt);
  p.cwS = lag(p.cwS == null ? 32 : p.cwS, util.cw ? 32 + 0.3 * N.air : 45, 120, dt);
  p.fgH = lag(p.fgH == null ? 4.5 : p.fgH, F.fgFail ? 0.1 : 4.5 * (1 + N.fg), 40, dt);
  const lpOK = clamp(p.lpP / 3.5, 0, 1), mpOK = clamp(p.mpP / 10, 0, 1), hpOK = clamp(p.hpP / 40, 0, 1), cwOK = p.cwS < 40 ? 1 : 0.15;

  // ===== crude supply: blend station HY-002 and feed source
  const src = S.feedSrc;
  p.xBH = lag(p.xBH, C['HIC-002'].op / 100, 1200, dt);                  // crude arriving at the unit
  const freshW = src === 'CRUDE' ? 1 : 0;
  const cp0 = CDU.crudeProps(p.xBH);
  p.crude = cp0;

  /* ===== AREA 100 — preheat & desalting ===== */
  const run6001 = E.P6001, run1101 = E.P1101, normal = S.circ === 'NORMAL';
  const dsal = E.DSAL;
  // mixing valves ΔP and the flow into the desalters
  // instructor 'fails in AUTO': the output ramps regardless of the PV (operator must take the loop to MAN)
  const failAuto = (tag, f, rate) => { if (f && C[tag].mode === 'AUTO') { C[tag].pv = tag === 'PIC-011' ? p.Pd : tag === 'LIC-003' ? p.L1 : p.P1103; C[tag].op = clamp(C[tag].op + rate * dt, 0, 100); return true; } return false; };
  if (!failAuto('PIC-011', F.pic011Fail, 0.05)) pidStep(C['PIC-011'], D['PIC-011'], p.Pd, dt);
  const head = clamp((19 - p.Pd) / 7, 0, 2);
  p.Fin = lag(p.Fin, run6001 ? C['PIC-011'].op / 100 * SPAN.FV092 * Math.sqrt(head) * (1 + N.ff) : 0, 4, dt);
  // pass flows (FCV-071…078) — pumps: P-1101 in NORMAL, P-1106 in SHORT / LONG circulation
  const suctP = p.Pd - (dsal ? p.dp1 + p.dp2 : 0.4) - 0.5;
  const npsh = normal ? (run1101 ? clamp((suctP - 0.5) / 2.5, 0, 1) : 0) : (E.P1106 ? clamp((p.Lbot - 2) / 8, 0, 1) : 0);
  pidStep(C['FIC-069'], D['FIC-069'], p.F, dt);
  let Ftot = 0; p.pass = p.pass || [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) {
    let op = C['FIC-069'].op;
    if (F.passStuck && i === 4) { if (p.stuckOP == null) p.stuckOP = op; op = Math.min(op, p.stuckOP * 0.55); } else if (i === 4) p.stuckOP = null;
    p.pass[i] = lag(p.pass[i], op / 100 * SPAN.PASS * npsh * (1 + 0.004 * (i - 3.5)), 3, dt);
    Ftot += p.pass[i];
  }
  p.F = Ftot;
  // desalter pressure (liquid full: stiff integrator). Desalter PSVs relieve into T-1101.
  const Fout = normal ? p.F : 0;
  p.Pd = clamp(p.Pd + (p.Fin - Fout) * 0.0005 * dt, 0, 18);
  if (!run6001 && p.Fin < 1 && Fout > 1) p.Pd = Math.max(0, p.Pd - 0.01 * dt);
  // wash water, interfaces, mixing valves
  pidStep(C['FIC-004'], D['FIC-004'], p.Fww, dt);
  p.Fww = lag(p.Fww, E.P1119 && dsal ? C['FIC-004'].op / 100 * SPAN.FV004 : 0, 5, dt);
  pidStep(C['PDIC-503'], D['PDIC-503'], p.dp1, dt); pidStep(C['PDIC-506'], D['PDIC-506'], p.dp2, dt);
  const fr = p.Fin / 810;
  p.dp1 = lag(p.dp1, dsal ? clamp(1.2 * fr * fr * Math.pow(50 / Math.max(C['PDIC-503'].op, 3), 2), 0, 3.5) : 0, 4, dt);
  p.dp2 = lag(p.dp2, dsal ? clamp(1.2 * fr * fr * Math.pow(50 / Math.max(C['PDIC-506'].op, 3), 2), 0, 3.5) : 0, 4, dt);
  if (!failAuto('LIC-003', F.lic003Fail, -0.5)) pidStep(C['LIC-003'], D['LIC-003'], p.L1, dt);
  pidStep(C['LIC-006'], D['LIC-006'], p.L2, dt);
  const freeW = p.Fin * (cp0.water / 100) * (1 + N.wat) * freshW;
  const rec = E.P1118 && dsal ? C['LIC-006'].op / 100 * SPAN.LV006 * clamp(p.L2 / 5, 0, 1) : 0;
  const brine = dsal ? C['LIC-003'].op / 100 * SPAN.LV003 * clamp(p.L1 / 5, 0, 1) : 0;
  const carry = dsal ? p.Fin * (p.bsw || 0.05) / 100 : 0;
  p.Frec = rec; p.Fbrine = brine;
  if (dsal) {
    p.L1 = clamp(p.L1 + (rec + freeW - brine - carry) / 40 * 100 * dt / 3600, 0, 100);
    p.L2 = clamp(p.L2 + (p.Fww - rec - carry * 0.5) / 40 * 100 * dt / 3600, 0, 100);
  }
  // transformer trips on interface high (emulsion bridging the grids)
  if (E.XFMR && (p.L1 >= 90 || p.L2 >= 90)) { CDU.tripEq(S, 'XFMR', 'Desalter interface ≥ 90 %: emulsion shorted the electrodes and the transformer tripped on high current. Bring LIC-003 / LIC-006 back to 50 % before re-energising.'); CDU.log(S, 'SIS', 'Desalter transformer tripped on high interface level'); }
  // desalting efficiency
  const eff = (dp, L, wash) => {
    const fm = clamp(1 - 0.6 * Math.pow((dp - 1.2) / 0.9, 2), 0.3, 1);
    const fT = clamp(1 - 0.012 * pos(118 - p.Tdes) - 0.012 * pos(p.Tdes - 152), 0.3, 1);
    const fL = L > 80 ? clamp(1 - 0.05 * (L - 80), 0.2, 1) : 1;
    const fW = clamp((1 - Math.exp(-wash / 1.5)) / (1 - Math.exp(-4 / 1.5)), 0.15, 1.05);
    return clamp(0.92 * fm * fT * fL * fW * (E.XFMR ? 1 : 0.45) * (E.DEMUL ? 1 : 0.85), 0, 0.97);
  };
  const wash = p.Fin > 50 ? p.Fww / p.Fin * 100 : 0;
  p.wash = wash;
  const e1 = dsal ? eff(p.dp1, p.L1, p.Frec / Math.max(p.Fin, 50) * 100) : 0, e2 = dsal ? eff(p.dp2, p.L2, wash) : 0;
  p.eff1 = e1; p.eff2 = e2;
  const saltIn = cp0.salt * (1 + N.salt) * freshW;
  p.saltIn = saltIn;
  p.salt = lag(p.salt, saltIn * (1 - e1) * (1 - e2), 600, dt);
  const bswT = dsal ? 0.05 + 0.25 * pos(p.dp2 - 1.6) / 0.6 + 0.05 * pos(p.L2 - 75) / 5 + (E.XFMR ? 0 : 0.25) + (E.DEMUL ? 0 : 0.05) : cp0.water * freshW;
  p.bsw = lag(p.bsw, bswT, 300, dt);
  p.effOil = dsal ? 40 + 400 * pos(20 - p.L1) / 20 + 150 * pos(p.dp1 - 1.8) : 0;   // oil in effluent ppm

  // ===== preheat trains (lumped exchanger duties scaled from the design heat balance)
  const fRes = pos(p.FresProd) / 407, fL = pos(p.Flgo) / 170.8, fH = pos(p.Fhgo) / 69.8;
  const ffin = clamp(p.Fin / 810, 0, 1.4), ffH = clamp(p.F / 810, 0, 1.4);
  const bal7 = 1 - 0.0006 * Math.pow(C['TDIC-007'].pv, 2), bal15 = 1 - 0.0006 * Math.pow(C['TDIC-015'].pv, 2);
  const foulT = 1 - (p.foulPre || 0) / 100;
  // pumparound duties (MW): fraction through the exchanger × available driving force
  const pumpOn = (k) => E[k] ? 1 : 0;
  const tCold = (50 + p.Tcold) / 2, tHot = (p.Tdes + p.Thot) / 2;
  const csK = normal ? ffin : 0, csL = normal ? ffH : 0;
  pidStep(C['UIC-029'], D['UIC-029'], p.QkPA, dt); pidStep(C['UIC-032'], D['UIC-032'], p.QlPA, dt);
  pidStep(C['UIC-031'], D['UIC-031'], p.QhPA, dt); pidStep(C['UIC-033'], D['UIC-033'], p.Qreb, dt);
  p.QkPA = lag(p.QkPA, pumpOn('P1103') * C['UIC-029'].op / 100 * SPAN.KPA * pos(p.Tk - tCold) / 98 * Math.min(1, csK / 0.25) * foulT, 20, dt);
  p.QlPA = lag(p.QlPA, pumpOn('P1104') * C['UIC-032'].op / 100 * SPAN.LPA * pos(p.Tl - tHot) / 45.5 * Math.min(1, csL / 0.25) * foulT, 20, dt);
  p.QhPA = lag(p.QhPA, pumpOn('P1105') * C['UIC-031'].op / 100 * SPAN.HPA * pos(p.Th - (p.Thot - 20)) / 70 * Math.min(1, csL / 0.25) * foulT, 20, dt);
  p.Qreb = lag(p.Qreb, pumpOn('P1105') * C['UIC-033'].op / 100 * SPAN.REB * pos(p.Th - (p.Tk + 30)) / 112 * (p.Lk > 3 ? 1 : 0.2), 20, dt);
  // hot train (crude from booster, at desalter temperature)
  const cH = Math.max(p.F, 30) * 0.000756;
  const Qres_hot = normal ? 55.4 * Math.pow(fRes, 0.8) * pos(p.Tbot - p.Tdes) / 216 * bal15 * foulT * Math.min(1, csL / 0.2) : 0;
  const Q1107 = normal ? 4.0 * Math.pow(fH, 0.8) * pos(p.ThP - p.Tdes) / 187 * bal15 * foulT : 0;
  p.Qhot = Qres_hot + p.QlPA + p.QhPA + Q1107;
  const Cres = Math.max(p.FresProd, 20) * 2.9 / 3600;
  p.TresA = p.Tbot - Qres_hot / Cres;
  // cold train (crude from tankage at 50 °C)
  const cC = Math.max(p.Fin, 30) * 0.000639;
  const Q1101 = normal ? 20.3 * Math.pow(fRes, 0.8) * pos(p.TresA - 50) / 130 * bal7 * foulT * Math.min(1, csK / 0.2) : 0;
  const ThE = p.ThP - Q1107 / (Math.max(p.Fhgo, 5) * 2.6 / 3600);
  const Q1103 = normal ? 11.9 * Math.pow(fL, 0.8) * pos(p.TlP - 50) / 189 * bal7 * foulT : 0;
  const Q1104 = normal ? 4.2 * Math.pow(fH, 0.8) * pos(ThE - 50) / 190 * bal7 * foulT : 0;
  p.Qcold = Q1101 + p.QkPA + Q1103 + Q1104;
  p.TresB = p.TresA - Q1101 / Cres;
  const Ttank = 50 + N.tf;
  p.Tcold = lag(p.Tcold, p.Fin > 20 ? Math.min(Ttank + p.Qcold / cC, p.Tbot) : lag(p.Tcold, p.Tair, 3600, dt), 600, dt);
  p.Tdes = lag(p.Tdes, p.Fin > 20 ? p.Tcold - 0.6 : p.Tdes, 900, dt);
  if (p.Fin <= 20) p.Tdes = lag(p.Tdes, p.Tair, 14400, dt);
  // branch ΔT (TDIC): imbalance from the branch split, drifting with fouling noise
  const dT7 = (C['TDIC-007'].op - 50) * 0.5 + 3 * N.br7, dT15 = (C['TDIC-015'].op - 50) * 0.6 + 3.5 * N.br15;
  pidStep(C['TDIC-007'], D['TDIC-007'], normal && p.Fin > 100 ? -dT7 : 0, dt);
  pidStep(C['TDIC-015'], D['TDIC-015'], normal && p.F > 100 ? -dT15 : 0, dt);
  // heater inlet temperature by circulation mode
  p.Ttrain = lag(p.Ttrain, S.circ === 'LONG' ? p.Tbot - 1 : (normal && p.F > 50 ? (p.Tdes + p.Thot) / 2 : p.Ttrain), S.circ === 'LONG' ? 1500 : 600, dt);
  if (!normal && S.circ !== 'LONG' && p.F < 50) p.Ttrain = lag(p.Ttrain, p.Tair, 14400, dt);
  let Tin;
  if (normal) { p.Thot = lag(p.Thot, p.F > 20 ? Math.min(p.Tdes + p.Qhot / cH, p.Tbot - 2) : p.Thot, 600, dt); Tin = p.Thot; }
  else if (S.circ === 'LONG') { Tin = p.Tbot - 0.6 * pos(p.Tbot - p.Ttrain); p.Thot = lag(p.Thot, Tin, 300, dt); }
  else { Tin = p.Tbot; p.Thot = lag(p.Thot, Tin, 300, dt); }
  // circulation: heat removed overhead / by the top PA and the column heat losses cool the circulating oil
  if (!normal && p.F > 15) Tin -= ((p.Qtpa || 0) + (p.Qovh || 0) + 0.012 * pos(p.Tbot - p.Tair)) * 1000 / (p.F / 3.6 * 2.9);
  else if (normal && p.F > 15) Tin -= 0.006 * pos(p.Tbot - p.Tair) * 1000 / (p.F / 3.6 * 2.9);
  if (p.F < 20 && normal) p.Thot = lag(p.Thot, p.Tair, 14400, dt);
  p.Tin = Tin;

  /* ===== AREA 200 — crude charge heater H-1101 ===== */
  const fgAvail = clamp(p.fgH / 4.5, 0, 1.2);
  const burnOn = E.BURN && E.PILOT && E.B1101;
  if (E.BURN && !burnOn) { E.BURN = false; }
  C['TIC-066'].opMin = burnOn ? 3 : 0;
  pidStep(C['TIC-066'], D['TIC-066'], p.COT, dt);
  if (!burnOn && C['TIC-066'].mode === 'AUTO') C['TIC-066'].op = Math.min(C['TIC-066'].op, 10);
  const fgOP = burnOn ? Math.max(3, C['TIC-066'].op) : 0;
  p.FG = lag(p.FG, fgOP / 100 * SPAN.PV120 * Math.sqrt(fgAvail), 6, dt);
  p.Pburn = burnOn ? (0.12 + 1.5 * p.FG / SPAN.PV120) * Math.min(1, fgAvail) : 0;
  p.pilotP = E.PILOT ? (F.pilotFail ? 0.05 : 1.0 * fgAvail) : 0;
  const offgas = burnOn && E.EJ ? 0.3 : 0;
  const fuel = p.FG + offgas + (E.PILOT ? 0.1 : 0);
  pidStep(C['AIC-063'], D['AIC-063'], p.O2, dt);
  p.air = lag(p.air, E.B1101 ? C['AIC-063'].op / 100 * SPAN.AIR : 0.05 * SPAN.AIR, 10, dt);
  const stoich = 16 * Math.max(fuel, 0.01), EA = p.air / stoich - 1;
  p.O2 = lag(p.O2, clamp(21 * EA / (1 + EA) * 0.9, 0, 20.5), 20, dt);
  const burnt = Math.min(fuel, p.air / 16);
  p.Qfired = burnt * 12.78 * (1 + N.lhv);
  p.eta = clamp(0.905 - 0.0035 * pos(p.O2 - 3) - (p.O2 < 1 ? 0.06 * (1 - p.O2) : 0), 0.6, 0.92);
  p.CO = p.O2 < 1.5 && burnt > 0.2 ? 50 + 3000 * (1.5 - p.O2) : (burnt > 0.2 ? 30 : 0);
  p.Qabs = lag(p.Qabs, p.eta * p.Qfired, 90, dt);
  p.Tstack = lag(p.Tstack, burnt > 0.05 ? 165 + 1.2 * (p.Qfired - 88) + 2 * pos(p.O2 - 3) : p.Tair + 10, 300, dt);
  p.Tbw = lag(p.Tbw, burnt > 0.05 ? 760 + 3 * (p.Qfired - 88) : p.Tair + 20, 300, dt);
  // superheater coil (stripping steam is superheated in the convection section)
  p.Fsh = E.SHSTM ? 25 * lpOK : 0;
  p.Tsh = lag(p.Tsh, p.Fsh > 1 ? 160 + 220 * clamp(p.Qabs / 80, 0, 1.4) * (25 / Math.max(p.Fsh, 5)) ** 0.3 : (burnOn ? 600 : p.Tair), 180, dt);
  // coil outlet temperature: solve h(COT) − h(Tin) = Qabs / m   (cp 2.9 kJ/kg K, 250 kJ/kg on the vaporised fraction)
  const Pfz = p.Pfz != null ? p.Pfz : 1.86;
  const vapAt = (T) => clamp(CDU.cum(p.xCol, p.wC, T - 6 + 33 - 28 * Math.log((Pfz + KGA) / 2.89), N.tbp, 18) / 100, 0, 1);   // narrow-cut flushing oil: EFV ≈ TBP − 18
  const m = p.F / 3.6;   // kg/s
  let COTss;
  if (p.F > 15) {
    const tgt = p.Qabs * 1000 / m;
    let lo = Tin - 20, hi = 700;
    for (let i = 0; i < 34; i++) { const mid = (lo + hi) / 2; const dh = 2.9 * (mid - Tin) + 250 * vapAt(mid); if (dh < tgt) lo = mid; else hi = mid; }
    COTss = (lo + hi) / 2;
  } else COTss = burnOn ? Math.min(800, (p.COT || 25) + p.Qabs * 2) : lag(p.COT || 25, p.Tair, 3600, dt);
  p.COT = lag(p.COT, COTss, p.F > 15 ? 45 : 120, dt);
  // pass outlet and tube-skin temperatures, coking (Arrhenius)
  p.passT = p.passT || []; p.skin = p.skin || [];
  let skinMax = 0;
  for (let i = 0; i < 8; i++) {
    const fi = Math.max(p.pass[i], 1), fa = Math.max(p.F / 8, 1);
    const Ti = p.F > 15 ? Tin + (p.COT - Tin) * Math.pow(fa / fi, 0.85) : p.COT;
    p.passT[i] = clamp(Ti, -50, 900);
    p.skin[i] = lag(p.skin[i] == null ? p.passT[i] : p.skin[i], p.passT[i] + 55 * clamp(p.Qabs / 79.4, 0, 2) * Math.pow(101 / Math.max(fi, 8), 0.8) + 40 * (p.coke || 0), 60, dt);   // tube metal lag
    skinMax = Math.max(skinMax, p.skin[i]);
  }
  p.skinMax = skinMax;
  const kc = 2e-6 * Math.exp(14000 * (1 / 688 - 1 / (skinMax + 273.15))) * (p.F > 15 ? Math.pow(101 / Math.max(Math.min(...p.pass), 8), 1.5) : 4);
  if (burnOn) p.coke = (p.coke || 0) + kc * dt;
  p.Tfz = p.F > 15 ? p.COT - 6 * clamp((p.yv || 0) / 0.5, 0, 1.2) : lag(p.Tfz, p.Tbot, 600, dt);

  /* ===== AREA 300 — main fractionator T-1101 ===== */
  // column inventory composition (crude vs flushing oil) and crude mix in the column
  const Finv = 380;   // t inventory column + heater + piping
  if (normal && p.F > 20) { p.wC = clamp(p.wC + (freshW - p.wC) * p.F / Finv * dt / 3600, 0, 1); p.xCol = lag(p.xCol, p.xBH, 900, dt); }
  const Fc = p.Fc = lag(p.Fc, p.F, 180, dt);           // column throughput (smoothed)
  const yv = p.yv = vapAt(p.COT);                          // vapour fraction at the flash zone
  // stripping steam
  pidStep(C['FIC-051'], D['FIC-051'], p.St1, dt); pidStep(C['FIC-052'], D['FIC-052'], p.St2, dt); pidStep(C['FIC-053'], D['FIC-053'], p.St3, dt);
  p.St1 = lag(p.St1, C['FIC-051'].op / 100 * SPAN.FV051 * lpOK * (S.sis.esd ? 0 : 1), 6, dt);
  p.St2 = lag(p.St2, C['FIC-052'].op / 100 * SPAN.FV052 * lpOK * (S.sis.esd ? 0 : 1), 6, dt);
  p.St3 = lag(p.St3, C['FIC-053'].op / 100 * SPAN.FV053 * lpOK * (S.sis.esd ? 0 : 1), 6, dt);
  const steam = p.St1 + p.St2 + p.St3;
  // steam into a cold tower condenses: water slug → pressure surge (start-up trap)
  p.wet = lag(p.wet || 0, steam > 1 && p.Tbot < 150 ? steam : 0, 120, dt);
  // overhead cut (naphtha / kero) is set by the top temperature
  p.Ptop = (p.P1103 || 0) + 0.2 * clamp((p.HCov + steam + 10) / 144, 0.3, 1.6) + 0.004 * p.wet;
  p.Pfz = p.Ptop + 0.36 * clamp(p.F / 810, 0.2, 1.4);
  const PtopA = p.Ptop + KGA;
  p.cutNK = 165 + 0.833 * (p.Ttop - 123.6) - 22 * Math.log(PtopA / 2.533) + 6 * Math.log((steam + 2) / 25.7);
  const yOv = p.Ttop > 55 ? Math.min(CDU.cum(p.xCol, p.wC, p.cutNK, N.tbp, 18) / 100, yv) : 0;
  const lpgCum = CDU.cum(p.xCol, p.wC, 30, N.tbp) / 100;
  p.LPGmake = Math.min(lpgCum, yOv) * Fc;
  p.HCov = lag(p.HCov, yOv * Fc, 60, dt);
  // side draws: liquid available at each draw tray, drawn on stripper level control
  pidStep(C['LIC-011'], D['LIC-011'], p.Lk, dt); pidStep(C['LIC-013'], D['LIC-013'], p.Ll, dt); pidStep(C['LIC-016'], D['LIC-016'], p.Lh, dt);
  const availK = pos(yv - yOv) * Fc;
  const dK = Math.min(C['LIC-011'].op / 100 * SPAN.LV011, availK * 0.98);
  const availL = availK - dK, dL = Math.min(C['LIC-013'].op / 100 * SPAN.LV013, availL * 0.98);
  const availH = availL - dL, dH = Math.min(C['LIC-016'].op / 100 * SPAN.LV016, availH * 0.98);
  p.dK = lag(p.dK, dK, 20, dt); p.dL = lag(p.dL, dL, 20, dt); p.dH = lag(p.dH, dH, 20, dt);
  p.OF = Fc > 50 ? (availH - dH) / Fc * 100 : 0;          // overflash, % of feed
  const Fq = Math.max(Fc, 50);
  if (Fc > 50) {
    const y1 = yOv * 100, y2 = y1 + p.dK / Fq * 100, y3 = y2 + p.dL / Fq * 100, y4 = y3 + p.dH / Fq * 100;
    p.cutKL = CDU.icum(p.xCol, p.wC, y2, N.tbp); p.cutLH = CDU.icum(p.xCol, p.wC, y3, N.tbp); p.cutHR = CDU.icum(p.xCol, p.wC, y4, N.tbp);
  }
  // top section heat balance: heat carried up by the vapour, minus pumparounds below the top
  // steam that reaches the top as vapour carries its own heat to the condenser (neutral for the top balance);
  // steam into a column below the water dew point condenses on the trays instead
  const stV = p.Ttop > (p.Tdew || 100) + 2 ? steam : 0;
  const Qup = 80.8 * (Fc / 810) * (yv / 0.52) * (1 + 0.004 * (p.Tfz - 352)) + 16 * stV / 23.7;
  const Qtop = Qup - p.QkPA - p.QlPA - p.QhPA - p.Qreb;
  pidStep(C['TIC-076'], D['TIC-076'], p.Ttop, dt);
  const tpaOn = E.P1102 ? 1 : 0;
  p.Qtpa = lag(p.Qtpa, tpaOn * C['TIC-076'].op / 100 * SPAN.TPA * pos(p.Ttop + 23 - p.Tair) / 112 * (E.E1112 ? 1 : 0.15), 30, dt);
  p.Qovh = 14.4 * p.HCov / 110.6 * (1 + 0.008 * (p.Ttop - 123.6)) + 16 * stV / 23.7;
  p.Ttop = clamp(p.Ttop + (Qtop - p.Qtpa - p.Qovh - 0.03 * (p.Ttop - p.Tair)) / 80 * dt, p.Tair - 5, 400);
  if (Qup < 1 && p.Ttop > p.Tbot) p.Ttop = lag(p.Ttop, p.Tbot, 1800, dt);
  // fractionation: internal reflux in each section comes from the heat removed above it
  const fF = Math.max(Fc, 100) / 810;   // reflux relative to the column feed
  const r1 = (p.Qtpa + 0.05) / (21.9 * fF), r2 = (p.Qtpa + p.QkPA + 0.05) / (30.9 * fF), r3 = (p.Qtpa + p.QkPA + p.QlPA + 0.05) / (61.9 * fF);
  p.r1 = r1; p.r2 = r2; p.r3 = r3;
  // column temperature profile (draw trays)
  const prof = (f) => p.Ttop + f * (p.Tfz - p.Ttop);
  p.Tk = lag(p.Tk, prof(0.298) + (Fc > 50 ? 0.4 * ((p.cutNK + p.cutKL) / 2 - 185) : 0), 240, dt);
  p.Tl = lag(p.Tl, prof(0.570) + (Fc > 50 ? 0.4 * ((p.cutKL + p.cutLH) / 2 - 267.5) : 0), 240, dt);
  p.Th = lag(p.Th, prof(0.921) + (Fc > 50 ? 0.4 * ((p.cutLH + p.cutHR) / 2 - 350) : 0), 240, dt);
  p.TlP = lag(p.TlP, p.Tl - 15 + 4 * (p.St2 / 5.07 - 1), 300, dt);   // LGO stripper bottom
  p.ThP = lag(p.ThP, p.Th - 14, 300, dt);
  p.TkP = lag(p.TkP, p.Tk + 30 * clamp(p.Qreb / 2.9, 0, 1.5), 300, dt);
  // strippers T-1102/3/4 (levels; product flows are pulled by the product controllers / dryer levels)
  pidStep(C['FQIC-033'], D['FQIC-033'], p.Fkero, dt);
  p.Fkero = lag(p.Fkero, E.P1107 ? C['FQIC-033'].op / 100 * SPAN.FV033 * clamp(p.Lk / 4, 0, 1) : 0, 5, dt);
  p.Lk = clamp(p.Lk + (p.dK - p.Fkero) / 12 * 100 * dt / 3600, 0, 100);
  pidStep(C['LIC-019'], D['LIC-019'], p.Ld1, dt); pidStep(C['LIC-022'], D['LIC-022'], p.Ld2, dt);
  const toD1 = C['LIC-019'].op / 100 * SPAN.LV019 * clamp(p.Ll / 4, 0, 1), toD2 = C['LIC-022'].op / 100 * SPAN.LV022 * clamp(p.Lh / 4, 0, 1);
  p.Ll = clamp(p.Ll + (p.dL - toD1) / 25 * 100 * dt / 3600, 0, 100);
  p.Lh = clamp(p.Lh + (p.dH - toD2) / 12 * 100 * dt / 3600, 0, 100);
  pidStep(C['FQIC-020'], D['FQIC-020'], p.Flgo, dt); pidStep(C['FQIC-024'], D['FQIC-024'], p.Fhgo, dt);
  p.Flgo = lag(p.Flgo, E.P1112 ? C['FQIC-020'].op / 100 * SPAN.FV020 * clamp(p.Ld1 / 4, 0, 1) : 0, 5, dt);
  p.Fhgo = lag(p.Fhgo, E.P1113 ? C['FQIC-024'].op / 100 * SPAN.FV024 * clamp(p.Ld2 / 4, 0, 1) : 0, 5, dt);
  p.Ld1 = clamp(p.Ld1 + (toD1 - p.Flgo) / 20 * 100 * dt / 3600, 0, 100);
  p.Ld2 = clamp(p.Ld2 + (toD2 - p.Fhgo) / 10 * 100 * dt / 3600, 0, 100);
  // bottoms: temperature and level; residue routing (LIC-007 split range)
  p.Tbot = lag(p.Tbot, p.F > 15 ? p.Tfz - 3 * (p.St1 / 16) * clamp(yv / 0.5, 0, 1) - (p.wet > 1 ? 3 : 0) : p.Tbot, p.F > 15 ? Math.max(120, 60 * 60 / Math.max(p.F, 30) * 3) : 600, dt);
  if (p.F <= 15) p.Tbot = lag(p.Tbot, p.Tair, 21600, dt);
  pidStep(C['LIC-007'], D['LIC-007'], p.Lbot, dt);
  const opL = C['LIC-007'].op, resPump = E.P1106 && p.Lbot > 2 ? 1 : 0;
  let toRFCC = 0, toSto = 0;
  if (normal) {
    toRFCC = resPump * Math.min(opL, 50) / 50 * SPAN.FV026 * (F.rfccTrip ? 0 : 1);
    toSto = resPump * pos(opL - 50) / 50 * SPAN.FV027;
  }
  p.FresProd = lag(p.FresProd, toRFCC + toSto, 8, dt);
  p.toRFCC = toRFCC; p.toSto = toSto;
  const circOut = normal ? 0 : p.F;                         // in circulation P-1106 feeds the heater
  const psvIn = p.psvD || 0;
  p.Lbot = clamp(p.Lbot + ((normal ? p.F : p.F) + psvIn - p.HCov - p.dK - p.dL - p.dH - p.FresProd - circOut) / 60 * 100 * dt / 3600, 0, 100);
  // residue cooling: E-1120 tempered water to storage
  pidStep(C['TIC-111'], D['TIC-111'], p.TresSto, dt);
  p.Ttw = lag(p.Ttw, E.P1122 ? 55 + 0.3 * (p.Tair - 30) : p.TresB, 300, dt);
  p.TresSto = lag(p.TresSto, p.FresProd > 1 ? p.TresB - (E.P1122 ? 0.98 * pos(p.TresB - p.Ttw) * C['TIC-111'].op / 100 : 0) : p.TresSto, 120, dt);

  /* ===== AREA 400 — overhead system and naphtha stabilizer ===== */
  // E-1111 air condenser: capacity vs load
  const fans = E.E1111 ? (F.e1111Half ? 0.5 : 1) : 0.12;
  p.Qcap = 36 * fans * (1 - 0.012 * (p.Tair - 30)) * (1 - (p.foulOvh || 0) / 100);
  const unc = pos(p.Qovh - p.Qcap) / 0.224;                 // t/h uncondensed
  p.unc = unc;
  p.T1103 = lag(p.T1103, p.Qovh > 0.5 ? p.Tair + 24 * clamp(p.Qovh / Math.max(p.Qcap, 1), 0, 1.4) : p.Tair, 120, dt);
  const flashF = clamp(0.05 + 0.012 * (p.T1103 - 50) - 0.2 * ((p.P1103 || 0) - 1.3), 0, 1);
  const gas = p.HCov > 1 ? (cp0.gas * Fc * p.wC + p.LPGmake * flashF) : 0;
  if (!failAuto('PIC-064', F.pic064Fail, -0.08)) pidStep(C['PIC-064'], D['PIC-064'], p.P1103, dt);
  const o64 = C['PIC-064'].op;
  p.fgMk = pos(33 - o64) / 33 * SPAN.PV064A * fgAvail;
  p.ogRFCC = clamp((o64 - 33) / 34, 0, 1) * SPAN.PV064B * Math.sqrt(pos(p.P1103 + 0.2) / 1.5) * (F.rfccTrip ? 0 : 1);
  p.og64F = pos(o64 - 67) / 33 * SPAN.PV064C * Math.sqrt(pos(p.P1103 + 0.1) / 1.4);
  p.P1103 = clamp(p.P1103 + (gas + unc + p.fgMk - p.ogRFCC - p.og64F) * 0.0008 * dt, -0.5, 6);
  // D-1103 liquids: naphtha (+ dissolved LPG) and sour water
  pidStep(C['LIC-038'], D['LIC-038'], p.L1103, dt);
  pidStep(C['LIC-040'], D['LIC-040'], p.Lw, dt);
  const hcIn = pos(p.HCov - p.LPGmake * flashF - unc * p.HCov / Math.max(p.HCov + steam, 1));
  p.Fsf = lag(p.Fsf, E.P1110 ? C['LIC-038'].op / 100 * SPAN.FV032 * clamp(p.L1103 / 4, 0, 1) : 0, 5, dt);
  p.L1103 = clamp(p.L1103 + (hcIn - p.Fsf) / 40 * 100 * dt / 3600, 0, 100);
  const wIn = steam * clamp(1 - unc / Math.max(p.HCov + steam, 1), 0, 1) + p.Fin * p.bsw / 100 + (normal && freshW && p.F > 100 ? 1.2 : 0);
  p.Fsw = C['LIC-040'].op / 100 * SPAN.LV040 * clamp(p.Lw / 4, 0, 1);
  p.Lw = clamp(p.Lw + (wIn - p.Fsw) / 6 * 100 * dt / 3600, 0, 100);
  p.zLPG = lag(p.zLPG, p.Fsf > 1 ? clamp(p.LPGmake * (1 - flashF) / Math.max(hcIn, 1), 0, 0.2) : p.zLPG, 600, dt);
  // overhead water dew point and corrosion
  const kmolHC = p.HCov / 0.105 + 1, kmolW = steam / 0.018;
  const yw = kmolW / (kmolW + kmolHC);
  p.Tdew = steam > 0.5 ? CDU.tsatW(PtopA * 0.981 * yw) : 0;
  p.dewM = steam > 0.5 ? p.Ttop - p.Tdew : 99;
  const hcl = p.salt * p.F * 0.12 / 1000 * (S.feedSrc === 'CRUDE' ? 1 : 0);   // kg/h HCl from hydrolysed MgCl2/CaCl2
  p.Cl = lag(p.Cl, p.Fsw > 1 ? hcl / p.Fsw * 1000 : 0, 600, dt);         // ppm chloride in boot water
  p.pH = lag(p.pH, p.Fsw > 1 ? clamp(6.2 + (E.NEUT ? 0.4 : -1.2) - 0.6 * Math.log10(Math.max(p.Cl, 1) / 5), 3, 9) : 7, 600, dt);
  p.corr = lag(p.corr, (p.Cl / 10) * (E.NEUT ? 0.3 : 1.5) * (1 + 3 * (p.dewM < 8 ? (8 - p.dewM) / 8 : 0)), 900, dt);

  // ---- stabilizer T-1107
  const lpgF = p.Fsf * p.zLPG;
  pidStep(C['TIC-060'], D['TIC-060'], p.Tst, dt);
  p.Fhp = lag(p.Fhp, C['TIC-060'].op / 100 * SPAN.FV060 * hpOK * (S.sis.cut.reb ? 0 : 1), 10, dt);
  const Qrs = p.Fhp * 0.53;
  const Rneed = (9 + 1.2 * lpgF) * clamp(p.Fsf / 110, 0, 1.5);
  const Qneed = Math.max(0.3, (2.5 + 0.033 * p.Fsf + 0.38 * lpgF) * (p.Fsf > 5 ? 1 : 0.2));
  const sS = Qrs / Qneed;
  p.sS = sS;
  p.Vst = lag(p.Vst, sS * (Rneed + lpgF + (p.Fsf > 5 ? 0 : 2)), 60, dt);   // boil-up: at sS = 1 exactly the reflux + LPG needed
  const capV = 40 * (util.cw ? 1 : 0.1) * cwOK;
  const Vc = Math.min(p.Vst, capV), uncS = p.Vst - Vc;
  pidStep(C['LIC-047'], D['LIC-047'], p.L1104, dt);
  pidStep(C['FQIC-037'], D['FQIC-037'], p.Flpg, dt);
  p.Rst = lag(p.Rst, E.P1114 ? C['LIC-047'].op / 100 * SPAN.FV036 * clamp(p.L1104 / 4, 0, 1) : 0, 5, dt);
  p.Flpg = lag(p.Flpg, E.P1115 ? CDU.eqpct(C['FQIC-037'].op, SPAN.FV037) * clamp(p.L1104 / 4, 0, 1) : 0, 5, dt);
  p.L1104 = clamp(p.L1104 + (Vc - p.Rst - p.Flpg) / 10 * 100 * dt / 3600, 0, 100);
  // stabilizer pressure (D-1104, 3-way split range)
  pidStep(C['PIC-068'], D['PIC-068'], p.P1104, dt);
  const o68 = C['PIC-068'].op, nc = p.Fsf > 1 ? 0.06 + 0.06 * lpgF : 0;
  p.pad68 = pos(33 - o68) / 33 * SPAN.PV068A;
  p.og68R = clamp((o68 - 33) / 34, 0, 1) * SPAN.PV068B * (F.rfccTrip ? 0 : 1);
  p.og68F = pos(o68 - 67) / 33 * SPAN.PV068C;
  p.P1104 = clamp(p.P1104 + (nc + uncS + p.pad68 - p.og68R - p.og68F) * 0.004 * dt, 0, 14);
  p.Pst = p.P1104 + 0.3;
  // bottom temperature, top temperature and product quality of the stabilizer
  const Tbs = p.Fsf > 5 ? 188 + 14 * Math.log(clamp(sS, 0.05, 5)) + 4 * (p.Pst - 7.9) : (Qrs > 0.2 ? 245 : p.Tst);
  p.Tst = lag(p.Tst, Math.min(Tbs, 248), 600, dt);
  if (p.Fsf <= 5 && Qrs <= 0.2) p.Tst = lag(p.Tst, p.Tair, 14400, dt);
  p.Ttst = lag(p.Ttst, p.Vst > 1 ? 66 + 15 * clamp(1 - p.Rst / Math.max(Rneed, 3), -0.4, 2.5) + 3 * (p.Pst - 7.9) : p.Tair, 300, dt);
  const strip = 1 - 0.5 * Math.exp(-3 * sS);
  p.lpgAvail = lpgF * strip;
  // bottoms level and naphtha rundown (LIC-042 split range)
  pidStep(C['LIC-042'], D['LIC-042'], p.Lst, dt);
  const o42 = C['LIC-042'].op;
  p.Fnap = Math.min(o42, 50) / 50 * SPAN.FV040 * clamp(p.Lst / 4, 0, 1);
  p.FnapSto = pos(o42 - 50) / 50 * SPAN.LV045 * clamp(p.Lst / 4, 0, 1);
  p.Lst = clamp(p.Lst + (p.Fsf - (p.Vst - p.Rst) + 0 - p.Fnap - p.FnapSto) / 18 * 100 * dt / 3600, 0, 100);

  /* ===== AREA 500 — dryers / vacuum, product coolers ===== */
  pidStep(C['PIC-049'], D['PIC-049'], p.Pdry, dt);
  p.Pdry = lag(p.Pdry, E.EJ && mpOK > 0.5 ? -0.98 + 0.16 * C['PIC-049'].op / 100 : 0.02, 60, dt);
  p.ppmW = 40 * Math.exp(12 * (p.Pdry + 0.9)) * (p.Fin > 50 ? 1 : 0.3);
  p.Tkero = lag(p.Tkero, p.Fkero > 1 ? 40 + 0.5 * (p.Tair - 30) + (util.cw ? 0 : 25) : p.Tair, 300, dt);
  p.Tlgo = lag(p.Tlgo, p.Flgo > 1 ? 55 + 0.6 * (p.Tair - 30) : p.Tair, 300, dt);
  p.Thgo = lag(p.Thgo, p.Fhgo > 1 ? 55 + 0.4 * (p.Tair - 30) + (util.cw ? 0 : 30) : p.Tair, 300, dt);
  p.Tnap = lag(p.Tnap, p.Fnap + p.FnapSto > 1 ? 40 + 0.5 * (p.Tair - 30) + (util.cw ? 0 : 20) : p.Tair, 300, dt);

  // fouling of the preheat train (antifoulant / desalting) and overhead (salts)
  p.foulPre = clamp((p.foulPre || 0) + (p.salt > 3 ? 0.02 * (p.salt - 3) : 0) * dt / 3600, 0, 30);

  CDU.relief(S, dt);
  CDU.props(S, dt);
  CDU.sis(S, dt);
};

/* ---------------- 6. PROCESS NOISE (Ornstein-Uhlenbeck drifts) ----------------
   [sigma, tau s]: tbp °C shift of the crude curve, air °C, fuel-gas heating value, salt, free water,
   feed-pump flow, tank temperature °C, branch ΔT drift, fuel-gas header.                             */
CDU.gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
const NZ = { tbp: [0.8, 1800], air: [0.8, 1800], lhv: [0.008, 600], salt: [0.08, 1200], wat: [0.08, 900], ff: [0.002, 60], tf: [0.6, 1800], br7: [0.5, 1500], br15: [0.5, 1500], fg: [0.008, 300] };
CDU.noise = function (S, dt) {
  const on = S.noiseOn !== false; CDU.mnoise = on;
  const n = S.nz || (S.nz = {});
  for (const k in NZ) {
    const [sig, tau] = NZ[k], x = n[k] || 0;
    n[k] = on ? x - x * dt / tau + sig * Math.sqrt(2 * dt / tau) * CDU.gauss() : x * (1 - Math.min(1, dt / 60));
  }
  n.aird = on ? 3.5 * Math.sin(S.t * 2 * Math.PI / 86400) : 0;   // ±3.5 °C day / night ambient
};

/* ---------------- 7. PRESSURE RELIEF & FLARE ----------------
   Live PSVs: p = pressure checked, st = pressure state reduced by the relief, to = flare or T-1101.   */
CDU.PSV = {
  'PSV-005': { d: 'Desalter A-1101-D-01 relief (pilot) — relieves to T-1101', p: 'Pd', set: 13.8, reseat: 12.9, cap: 300, k: 0.0016, to: 'T1101', page: 'preheat' },
  'PSV-161': { d: 'T-1101 overhead vapour relief valves PSV-161/162/163/165/166 (5 × spring)', p: 'Ptop', st: 'P1103', set: 3.5, reseat: 3.15, cap: 160, k: 0.0008, to: 'flare', page: 'fract' },
  'PSV-237': { d: 'T-1107 stabilizer overhead relief PSV-237/238', p: 'Pst', st: 'P1104', set: 9.6, reseat: 8.9, cap: 40, k: 0.004, to: 'flare', page: 'overhead' }
};
CDU.PSV_STATIC = {
  'PSV-172': ['Desalter A-1101-D-02 relief (pilot) to T-1101', 'preheat', '13.8 kg/cm²g'],
  'PSV-085': ['H-1101 superheated steam coil relief PSV-085/086', 'heater', '6.3 kg/cm²g'],
  'PSV-170': ['D-1106 sour-water / oil separator relief PSV-170/171 to flare', 'overhead', '11 kg/cm²g'],
  'PSV-021': ['T-1105 LGO dryer relief to flare', 'rundown', '3.5 kg/cm²g'],
  'PSV-106': ['T-1106 HGO dryer relief PSV-106/107 to flare', 'rundown', '3.5 kg/cm²g'],
  'PSV-131': ['D-1114 fuel-gas drum relief PSV-131/132 to flare', 'utilities', '6.7 kg/cm²g'],
  'PSV-175': ['HP steam relief PSV-175/176 (stabilizer reboiler supply)', 'utilities', '27.2 kg/cm²g'],
  'PSV-239': ['D-1109 desalter water surge drum relief', 'preheat', '2.7 kg/cm²g'],
  'TSV-310': ['Thermal reliefs on the preheat exchangers (TSV-308…315)', 'preheat', '37.7–37.9 kg/cm²g'],
  'TSV-319': ['Tempered water thermal relief E-1120 C/D', 'utilities', '22.7 kg/cm²g']
};
CDU.relief = function (S, dt) {
  const p = S.p; S.psv = S.psv || {};
  let load = 0; p.psvD = 0;
  for (const tag in CDU.PSV) {
    const v = CDU.PSV[tag], st = S.psv[tag] || (S.psv[tag] = { open: false, n: 0, f: 0 }), P = p[v.p];
    if (!st.open && P >= v.set) {
      st.open = true; st.n++; st.t = S.t;
      CDU.log(S, 'SIS', tag + ' LIFTED at ' + P.toFixed(2) + ' kg/cm²g (set ' + v.set + ') — relieving to ' + (v.to === 'flare' ? 'flare' : 'T-1101'));
      CDU.alert(S, 'psv', tag, tag + ' LIFTED — relieving to ' + (v.to === 'flare' ? 'the flare' : 'T-1101'), v.d + ' opened at ' + P.toFixed(2) + ' kg/cm²g (set pressure ' + v.set + '). Find and remove the cause of the overpressure.');
    } else if (st.open && P <= v.reseat) { st.open = false; CDU.log(S, 'SIS', tag + ' reseated at ' + P.toFixed(2) + ' kg/cm²g'); }
    st.f = st.open ? v.cap * clamp(0.35 + 0.65 * (P - v.reseat) / (v.set - v.reseat), 0.2, 1) : 0;
    if (st.f > 0) { const k = v.st || v.p; p[k] = Math.max(0, p[k] - st.f * v.k * dt); }
    if (v.to === 'flare') load += st.f; else p.psvD += st.f;
  }
  p.flareRelief = load;
  p.fb = Math.max(0, (p.fb || 0) * (1 - dt / 300)); if (p.fb < 0.05) p.fb = 0;
  p.flareCtl = (p.og64F || 0) + (p.og68F || 0) + (p.F > 50 && S.route.NAP === 'SLOPS' ? 0 : 0);
  p.flare = lag(p.flare || 0.5, 0.5 + load + p.flareCtl + p.fb, 8, dt);   // 0.5 t/h purge + sweep gas
  p.flareCap = 250;
  p.koLvl = clamp(lag(p.koLvl == null ? 10 : p.koLvl, 10 + Math.min(load + p.flareCtl, 80) * 0.6, 900, dt), 0, 100);
};
CDU.flareBurst = function (S, tph) { S.p.fb = Math.min(120, (S.p.fb || 0) + tph); };
CDU.alert = function (S, kind, tag, title, msg) {
  S.alerts = S.alerts || []; S.alertSeq = (S.alertSeq || 0) + 1;
  S.alerts.unshift({ id: S.alertSeq, t: S.t, kind, tag, title, msg, closed: false });
  if (S.alerts.length > 30) S.alerts.length = 30;
};
CDU.tripEq = function (S, eq, why) {
  if (!S.eq[eq] && S.trip && S.trip[eq]) return;
  S.eq[eq] = false; S.trip = S.trip || {}; S.trip[eq] = { t: S.t, why };
  const nm = (CDU.EQ[eq] && CDU.EQ[eq].d) || eq;
  CDU.alert(S, 'trip', eq, 'TRIP — ' + nm, why);
};

/* ---------------- 8. PRODUCT QUALITY ---------------- */
CDU.props = function (S, dt) {
  const p = S.p, cr = p.crude, E = S.eq;
  p.inst = p.inst || {}; p.lab = p.lab || {};
  const I = p.inst;
  if (p.Fc > 100 && p.wC > 0.5) {
    const gNK = 6 + 20 * Math.log(Math.max(p.r1, 0.05)), gKL = 4 + 18 * Math.log(Math.max(p.r2, 0.05));
    const oLH = 12 - 15 * Math.log(Math.max(p.r3, 0.05)) + 8 * pos(1.5 - p.OF);
    const liftK = 10 * (1 - Math.exp(-1.2 * p.Qreb / 2.9)) / (1 - Math.exp(-1.2));
    const liftL = 20 * (1 - Math.exp(-1.5 * p.St2 / Math.max(5.07 * p.Flgo / 170.8, 0.3))) / (1 - Math.exp(-1.5));
    const liftH = 12 * (1 - Math.exp(-1.5 * p.St3 / Math.max(2.6 * p.Fhgo / 69.8, 0.2))) / (1 - Math.exp(-1.5));
    const nap95 = p.cutNK - 4 - gNK / 2, kero5 = p.cutNK - 4 + gNK / 2 + liftK;
    const kero95 = p.cutKL - 3 - gKL / 2, lgo5 = p.cutKL - 3 + gKL / 2 + liftL;
    const lgo95 = p.cutLH - 3 + oLH / 2, hgo5 = p.cutLH - 3 - oLH / 2 + liftH;
    I.N95 = nap95; I.GNK = gNK + 0.3 * liftK; I.GKL = gKL + 0.3 * liftL; I.OLH = oLH;
    I.KFL = 0.72 * kero5 - 79; I.LFL = 0.72 * lgo5 - 85; I.HFL = 0.72 * hgo5 - 85;
    I.FRZ = cr.fz0 + 0.55 * (kero95 - 197);
    I.SMK = cr.smk0 - 0.15 * (kero95 - 199) + 0.1 * (p.cutNK - 165);
    I.DEN = cr.den0 + 0.0006 * ((p.cutNK + p.cutKL) / 2 - 185);
    I.POUR = cr.p0 + 0.45 * (lgo95 - 320);
    I.CET = cr.cet0 + 0.08 * ((p.cutKL + p.cutLH) / 2 - 267.5);
    I.H2O = p.ppmW;
    I.CCR = 0.08 + 0.35 * Math.pow(pos(2 - p.OF), 2) + 0.02 * pos(p.cutHR - 380);
    I.R360 = 6 * Math.exp(-clamp((p.cutHR - 370) / 15, -3, 2.5)) * Math.pow(16 / Math.max(p.St1, 0.8), 0.35) * (1 + 0.5 * pos(1.5 - p.OF));
  } else if (p.Fc > 50) {     // flushing oil in the column: products are not representative (all to slops)
    Object.assign(I, { GNK: -10, KFL: 30, LFL: 50, POUR: 15, R360: 25, CCR: 0.5, OLH: 30 });
  }
  // stabilizer
  if (p.Fsf > 5) {
    I.C5 = 0.8 * Math.exp(clamp((p.Ttst - 66) / 5, -3, 4)) + 5 * pos(p.Flpg - p.lpgAvail) / Math.max(p.Flpg, 0.2);
    I.C4N = 0.12 * Math.exp(-clamp((p.Tst - 188) / 6, -4, 4)) * Math.pow(Math.max(p.zLPG, 0.002) / 0.02, 0.3) + 20 * pos(p.lpgAvail - p.Flpg) / Math.max(p.Fnap + p.FnapSto, 20);
  } else if (p.Fc > 50) { I.C5 = 3; I.C4N = 1.0; }
  for (const k in CDU.PROPS) {
    if (I[k] == null) continue;
    if (p.lab[k] == null) p.lab[k] = I[k];
    p.lab[k] = lag(p.lab[k], I[k], 600, dt);     // product tank / sample point lag
  }
  // product-by-product spec check and tonnage accounting
  const g = CDU.GRADES[S.target], ok = {};
  for (const pr in CDU.PRODUCTS) ok[pr] = true;
  for (const k in g.spec) { const v = p.lab[k], [lo, hi] = g.spec[k]; if (v == null || v < lo || v > hi) ok[CDU.PROPS[k].prod] = false; }
  p.ok = ok;
  const flows = { LPG: p.Flpg, NAP: p.Fnap + p.FnapSto, KERO: p.Fkero, LGO: p.Flgo, HGO: p.Fhgo, RES: p.FresProd };
  const rmap = { LPG: 'NAP', NAP: 'NAP', KERO: 'KERO', LGO: 'LGO', HGO: 'HGO', RES: 'RES' };
  let all = true;
  for (const pr in flows) {
    const t = pos(flows[pr]) * dt / 3600, slop = S.route[rmap[pr]] === 'SLOPS';
    const rec = S.prodTons[pr] || (S.prodTons[pr] = { on: 0, off: 0, slop: 0 });
    if (slop) { rec.slop += t; S.tons.slop += t; } else if (ok[pr]) { rec.on += t; S.tons.on += t; } else { rec.off += t; S.tons.off += t; }
    if (!ok[pr]) all = false;
  }
  p.allOk = all && p.Fc > 100;
  p.pelOk = p.allOk;
};
CDU.inSpec = function (props, grade) {
  const g = CDU.GRADES[grade], r = { all: true };
  if (!g) return r;
  for (const k in g.spec) { const [lo, hi] = g.spec[k]; const v = props[k]; const ok = v != null && v >= lo && v <= hi; r[k] = ok; if (!ok) r.all = false; }
  return r;
};

/* ---------------- 9. SAFETY INSTRUMENTED SYSTEM ----------------
   UX-007 CDU emergency shutdown (manual) · UX-001 desalter protection · UX-005A heater trip ·
   UX-005B fuel-gas trip · UX-005E pilot-gas trip · UX-020 / 002 / 022 / 024 inventory protections.  */
CDU.SIS_DESC = {
  'UX-007': 'CDU emergency shutdown (manual push button): stops P-6001 and P-1101, trips H-1101, cuts stripping steam, de-energises the desalters',
  'UX-001': 'Desalter protection: PZHH-011 desalter pressure ≥ 13.5 kg/cm²g or LZLL desalter level (pressure < 1.0): transformers off, P-1118/P-1119 stop, initiates UX-005B',
  'UX-005A': 'Heater trip: both FD fans B-1101 A/B stopped or UX-007: all fuel and pilots isolated',
  'UX-005B': 'Fuel-gas trip: FZLL-010 A/B/C charge < 30 % (243 t/h) 2oo3, PZLL burner pressure < 0.15 kg/cm²g, TZHH-066 COT ≥ 390 °C, UX-005A, UX-001',
  'UX-005E': 'Pilot-gas trip: PZLL-112 pilot gas pressure low-low: pilots and main burners isolated',
  'UX-020': 'P-1106 residue pump protection: LZLL-007 T-1101 bottoms ≤ 5 %',
  'UX-002': 'T-1101 inventory protection: LZHH-007 bottoms ≥ 95 % stops P-6001 and P-1101 (charge cut) (a)',
  'UX-022': 'P-1110 protection: LZLL-038 D-1103 naphtha ≤ 5 % (a)',
  'UX-024': 'D-1104 LZHH-047 ≥ 90 %: stabilizer reboiler steam FV-060 closed (a)'
};
CDU.heaterTrip = function (S, ux, why) {
  const s = S.sis, E = S.eq;
  if (!E.BURN && !E.PILOT && s.htrTrip) return;
  if (s.bypass && ux !== 'UX-007') { if (s.lastTrip !== why) { s.lastTrip = why; CDU.log(S, 'SIS', 'BYPASSED trip demand ' + ux + ': ' + why); } return; }
  const wasLit = E.BURN || E.PILOT;
  if (ux !== 'UX-005B' || true) { E.BURN = false; if (ux !== 'UX-005B') E.PILOT = false; }
  s.htrTrip = true; s.purge = 0; s.lastTrip = why;
  S.ctl['TIC-066'].mode = 'MAN'; S.ctl['TIC-066'].op = 0;
  CDU.log(S, 'SIS', ux + ' H-1101 TRIP — ' + why);
  if (wasLit) CDU.alert(S, 'sis', 'H-1101', 'SIS TRIP ' + ux + ' — HEATER H-1101 FUEL ISOLATED', why + '. COT falls; reduce charge (FIC-069) and check T-1101 temperatures. Remove the cause, RESET on the heater faceplate (UHSR-005), purge 5 min with B-1101 running, relight pilots then burners.');
};
CDU.sis = function (S, dt) {
  const p = S.p, s = S.sis, E = S.eq;
  const demand = (key, why, act) => {
    if (s.cut[key]) return;
    if (s.bypass) { if (s.lastTrip !== why) { s.lastTrip = why; CDU.log(S, 'SIS', 'BYPASSED trip demand: ' + why); } return; }
    s.cut[key] = true; s.lastTrip = why; act(); CDU.log(S, 'SIS', why);
  };
  // UX-001 desalter protection
  if (E.DSAL && (p.Pd >= 13.5 || (p.Pd < 1.0 && S.circ === 'NORMAL' && p.F > 100))) demand('ux001', 'UX-001 desalter protection: ' + (p.Pd >= 13.5 ? 'PZHH-011 pressure ' + p.Pd.toFixed(2) + ' kg/cm²g' : 'LZLL desalter level (pressure lost)'), () => {
    E.XFMR = false; E.P1118 = false; E.P1119 = false; CDU.heaterTrip(S, 'UX-005B', 'UX-001 desalter protection');
    CDU.alert(S, 'sis', 'UX-001', 'SIS TRIP UX-001 — DESALTER PROTECTION', 'Desalter ' + (p.Pd >= 13.5 ? 'pressure high-high' : 'level low-low') + '. Transformers, wash and recycle water stopped and H-1101 fuel tripped. Stabilise PIC-011 / charge, then reset on the instructor or desalter faceplate.');
  });
  if (s.cut.ux001 && p.Pd < 13.0 && p.Pd > 2) { /* waits for manual reset */ }
  // heater
  if (E.BURN || E.PILOT) {
    if (!E.B1101) CDU.heaterTrip(S, 'UX-005A', 'FD fans B-1101 A/B stopped');
    else if (E.BURN && S.circ === 'NORMAL' && p.F < 243 && S.t - (s.lightT || 0) > 30) CDU.heaterTrip(S, 'UX-005B', 'FZLL-010 charge flow < 243 t/h (low pass flow)');
    else if (E.BURN && S.circ !== 'NORMAL' && p.F < 243 && S.t - (s.lightT || 0) > 30) CDU.heaterTrip(S, 'UX-005B', 'FZLL-010 circulation flow < 243 t/h (low pass flow)');
    else if (E.BURN && p.Pburn < 0.15 && S.t - (s.lightT || 0) > 20) CDU.heaterTrip(S, 'UX-005B', 'PZLL burner fuel-gas pressure < 0.15 kg/cm²g');
    else if (E.BURN && p.COT >= 390) CDU.heaterTrip(S, 'UX-005B', 'TZHH-066 coil outlet ≥ 390 °C');
    else if (E.PILOT && p.pilotP < 0.3) CDU.heaterTrip(S, 'UX-005E', 'PZLL-112 pilot gas pressure low-low');
  }
  // purge timer: FD fan running, all fuel off
  if (E.B1101 && !E.BURN && !E.PILOT && p.air > 0.25 * CDU.SPAN.AIR) s.purge = Math.min(600, (s.purge || 0) + dt); else if (!E.B1101) s.purge = 0;
  // inventory protections
  if (E.P1106 && p.Lbot <= 5) demand('ux020', 'UX-020 LZLL-007 T-1101 bottoms ≤ 5 % — P-1106 stopped', () => { CDU.tripEq(S, 'P1106', 'UX-020: T-1101 bottoms level low-low (≤ 5 %) — pump protection. Restore the level (reduce draws / residue rundown) before restart.'); });
  if (s.cut.ux020 && p.Lbot > 8) s.cut.ux020 = false;
  if (E.P1101 && p.Lbot >= 95) demand('ux002', 'UX-002 LZHH-007 T-1101 bottoms ≥ 95 % — charge pumps P-6001 and P-1101 stopped (charge cut)', () => { E.P6001 = false; CDU.tripEq(S, 'P1101', 'UX-002: T-1101 bottoms level high-high (≥ 95 %). Charge cut to protect the flash zone and stripping section. Lower the level (residue pump / LIC-007) before restart.'); });
  if (s.cut.ux002 && p.Lbot < 85) s.cut.ux002 = false;
  if (E.P1110 && p.L1103 <= 5) demand('ux022', 'UX-022 LZLL-038 D-1103 naphtha ≤ 5 % — P-1110 stopped', () => { CDU.tripEq(S, 'P1110', 'UX-022: D-1103 naphtha level low-low. Restart P-1110 when the level is back above 20 %.'); });
  if (s.cut.ux022 && p.L1103 > 10) s.cut.ux022 = false;
  if (p.L1104 >= 90) demand('reb', 'UX-024 LZHH-047 D-1104 ≥ 90 % — stabilizer reboiler steam FV-060 closed', () => {
    CDU.alert(S, 'sis', 'TIC-060', 'SIS TRIP UX-024 — STABILIZER REBOILER STEAM CUT', 'D-1104 reflux drum level high-high: HP steam to E-1121 closed. Check reflux pump P-1114 and LIC-047, lower the level, then reset on the TIC-060 faceplate.');
  });
};

/* ---------------- 10. RECIPE SOLVER ----------------
   Computes the SPs for an operating case: the top temperature for the naphtha/kero cut, product draws
   for the side cuts, COT for 2.5 % overflash, stripping steam in proportion to the product flows.      */
CDU.solveRecipe = function (grade) {
  const g = CDU.GRADES[grade], x = g.bh / 100, F = g.feed, [c1, c2, c3, c4] = g.cuts;
  const y = (T) => CDU.cum(x, 1, T);
  const lpg = y(30) / 100 * F, nap = (y(c1) - y(30)) / 100 * F;
  const kero = (y(c2) - y(c1)) / 100 * F, lgo = (y(c3) - y(c2)) / 100 * F, hgo = (y(c4) - y(c3)) / 100 * F, res = F - lpg - nap - kero - lgo - hgo;
  const Teff = CDU.icum(x, 1, y(c4) + 2.5);
  const COT = Teff - 33 + 6;
  const Ttop = 123.6 + (c1 - 165) / 0.833;
  const steamL = 5.07 * lgo / 170.8, steamH = 2.6 * hgo / 69.8;
  const lpgAv = lpg * 0.94;
  return { grade, x, F, lpg, nap, kero, lgo, hgo, res, COT, Ttop, steamL, steamH, steamB: 16, lpgSP: lpg * 0.87, bh: g.bh, wash: 0.04 * F };
};
CDU.recipeItems = function (grade) {
  const r = CDU.solveRecipe(grade);
  return [
    ['Crude blend HIC-002 (% Bach Ho)', 'HIC-002', r.bh, '%'],
    ['Charge FIC-069', 'FIC-069', r.F, 't/h'],
    ['Coil outlet TIC-066', 'TIC-066', r.COT, '°C'],
    ['T-1101 top TIC-076', 'TIC-076', r.Ttop, '°C'],
    ['Kerosene FQIC-033', 'FQIC-033', r.kero, 't/h'],
    ['LGO FQIC-020', 'FQIC-020', r.lgo, 't/h'],
    ['HGO FQIC-024', 'FQIC-024', r.hgo, 't/h'],
    ['LGO strip steam FIC-052', 'FIC-052', r.steamL, 't/h'],
    ['HGO strip steam FIC-053', 'FIC-053', r.steamH, 't/h'],
    ['LPG product FQIC-037', 'FQIC-037', r.lpgSP, 't/h'],
    ['Wash water FIC-004', 'FIC-004', r.wash, 't/h']
  ];
};
// normal operating SPs that do not change with the case
CDU.NORMAL_SP = {
  'PIC-011': 12.0, 'TDIC-007': 0, 'TDIC-015': 0, 'PDIC-503': 1.2, 'PDIC-506': 1.2, 'LIC-003': 50, 'LIC-006': 50, 'AIC-063': 3.0,
  'UIC-029': 9.0, 'UIC-032': 31.0, 'UIC-031': 2.0, 'UIC-033': 2.9, 'LIC-007': 50, 'FIC-051': 16, 'LIC-011': 50, 'LIC-013': 50, 'LIC-016': 50,
  'PIC-064': 1.3, 'LIC-038': 50, 'LIC-040': 50, 'TIC-060': 188, 'LIC-047': 50, 'PIC-068': 7.6, 'LIC-042': 40,
  'LIC-019': 50, 'LIC-022': 50, 'PIC-049': -0.90, 'TIC-111': 85
};
})(window);
