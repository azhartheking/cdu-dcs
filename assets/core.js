/* =====================================================================
   CDU DCS SIMULATOR — RUNTIME CORE
   Sections: 1 journal & alarms · 2 lab sampling & history · 3 operator / instructor
             command execution · 4 instructor logic (failures, exercises, init, procedures)
             · 5 shared-state runtime (one simulation shared by every page)
   ===================================================================== */
(function (G) {
'use strict';
const CDU = G.CDU;
const fmtT = CDU.fmtT = (t) => { t = Math.max(0, Math.floor(t)); const d = Math.floor(t / 86400), h = Math.floor(t / 3600) % 24, m = Math.floor(t / 60) % 60, s = t % 60;
  return (d ? 'D' + (d + 1) + ' ' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); };

/* ---------------- 1. JOURNAL & ALARMS ---------------- */
CDU.log = function (S, src, msg) { S.journal.unshift({ t: S.t, src, msg }); if (S.journal.length > 400) S.journal.length = 400; };
const dev = (S, t, f) => S.ctl[t].mode === 'AUTO' && Math.abs(S.ctl[t].pv - S.ctl[t].sp) > f;
const run = (S) => S.p.F > 300 && S.circ === 'NORMAL';
const lab = (S, k) => S.p.lab && S.p.lab[k];
const offs = (S, k) => { const g = CDU.GRADES[S.target], v = lab(S, k); if (!g.spec[k] || v == null) return false; return v < g.spec[k][0] || v > g.spec[k][1]; };
// [id, tag, priority, message, page, condition]
const ALM = [
  // 100 preheat & desalting
  ['PAHH011', 'PIC-011', 1, 'Desalter pressure HH ≥ 13.5 kg/cm²g (UX-001)', 'preheat', (S) => S.p.Pd >= 13.5],
  ['PAH011', 'PIC-011', 2, 'Desalter pressure high ≥ 13.0 kg/cm²g', 'preheat', (S) => S.p.Pd >= 13.0 && S.p.Pd < 13.5],
  ['PAL011', 'PIC-011', 2, 'Desalter pressure low ≤ 9 kg/cm²g (booster NPSH)', 'preheat', (S) => S.p.Pd <= 9 && (S.eq.P1101 || S.eq.P6001)],
  ['FAL069', 'FIC-069', 2, 'Charge to heater low < 400 t/h', 'preheat', (S) => S.p.F < 400 && (S.eq.BURN)],
  ['FALL069', 'FIC-069', 1, 'Charge / pass flow low-low < 243 t/h (UX-005B)', 'heater', (S) => S.p.F < 243 && S.eq.BURN],
  ['LAH003', 'LIC-003', 2, 'Desalter D-01 interface high ≥ 75 %', 'preheat', (S) => S.eq.DSAL && S.p.L1 >= 75],
  ['LAL003', 'LIC-003', 2, 'Desalter D-01 interface low ≤ 20 % (oil in brine)', 'preheat', (S) => S.eq.DSAL && S.p.L1 <= 20],
  ['LAH006', 'LIC-006', 2, 'Desalter D-02 interface high ≥ 75 %', 'preheat', (S) => S.eq.DSAL && S.p.L2 >= 75],
  ['LAL006', 'LIC-006', 3, 'Desalter D-02 interface low ≤ 20 %', 'preheat', (S) => S.eq.DSAL && S.p.L2 <= 20],
  ['SALT', 'AI-SALT', 2, 'Desalted crude salt > 2 ppm wt', 'preheat', (S) => S.p.salt > 2 && S.feedSrc === 'CRUDE' && run(S)],
  ['BSW', 'AI-BSW', 3, 'Desalted crude BS&W > 0.2 vol%', 'preheat', (S) => S.p.bsw > 0.2 && S.feedSrc === 'CRUDE' && run(S)],
  ['TDES', 'TI-DES', 3, 'Desalter temperature outside 120–150 °C', 'preheat', (S) => S.eq.DSAL && run(S) && (S.p.Tdes < 120 || S.p.Tdes > 152)],
  ['XFMR', 'TR-01/02', 2, 'Desalter transformers OFF (desalters in service)', 'preheat', (S) => S.eq.DSAL && !S.eq.XFMR],
  ['DSALBY', 'HS-001', 3, 'Desalters BYPASSED with crude in the unit', 'preheat', (S) => !S.eq.DSAL && S.feedSrc === 'CRUDE' && run(S)],
  ['DP506', 'PDIC-506', 3, 'Mixing valve ΔP outside 0.8–1.8 kg/cm²', 'preheat', (S) => S.eq.DSAL && run(S) && (S.p.dp2 < 0.8 || S.p.dp2 > 1.8 || S.p.dp1 < 0.8 || S.p.dp1 > 1.8)],
  ['TDI007', 'TDIC-007', 3, 'Cold train branch ΔT > 8 °C', 'preheat', (S) => run(S) && Math.abs(S.ctl['TDIC-007'].pv) > 8],
  ['TDI015', 'TDIC-015', 3, 'Hot train branch ΔT > 8 °C', 'preheat', (S) => run(S) && Math.abs(S.ctl['TDIC-015'].pv) > 8],
  ['P6001', 'P-6001', 1, 'Crude charge pumps P-6001 STOPPED', 'preheat', (S) => !S.eq.P6001 && S.circ === 'NORMAL' && S.eq.BURN],
  ['P1101', 'P-1101', 1, 'Crude booster pumps P-1101 STOPPED', 'preheat', (S) => !S.eq.P1101 && S.circ === 'NORMAL' && S.eq.BURN],
  // 200 heater
  ['TAH066', 'TIC-066', 2, 'Coil outlet temperature high ≥ 372 °C', 'heater', (S) => S.p.COT >= 372 && S.p.COT < 385],
  ['TAHH066', 'TIC-066', 1, 'Coil outlet temperature HH ≥ 385 °C (trip 390)', 'heater', (S) => S.p.COT >= 385],
  ['TDV066', 'TIC-066', 3, 'COT deviation > 5 °C from SP', 'heater', (S) => dev(S, 'TIC-066', 5) && S.eq.BURN],
  ['SKIN', 'TI-SKIN', 2, 'Tube skin temperature high ≥ 500 °C', 'heater', (S) => S.p.skinMax >= 500 && S.p.skinMax < 540],
  ['SKINHH', 'TI-SKIN', 1, 'Tube skin temperature HH ≥ 540 °C — coking / tube damage', 'heater', (S) => S.p.skinMax >= 540],
  ['PASSL', 'FI-PASS', 2, 'Pass flow imbalance > 15 % (one pass low)', 'heater', (S) => S.p.F > 200 && Math.min(...S.p.pass) < 0.85 * S.p.F / 8],
  ['O2L', 'AIC-063', 2, 'Flue gas O2 low < 1.5 % (CO, afterburning)', 'heater', (S) => S.eq.BURN && S.p.O2 < 1.5],
  ['O2H', 'AIC-063', 3, 'Flue gas O2 high > 6 % (efficiency loss)', 'heater', (S) => S.eq.BURN && S.p.O2 > 6],
  ['PBL', 'PI-123', 2, 'Burner fuel-gas pressure low < 0.3 kg/cm²g', 'heater', (S) => S.eq.BURN && S.p.Pburn < 0.3],
  ['FGH', 'PI-FG', 2, 'Fuel-gas header pressure low < 3.5 kg/cm²g', 'utilities', (S) => S.p.fgH < 3.5],
  ['TSH', 'TI-SH', 2, 'Superheater coil outlet high > 420 °C (no steam flow?)', 'heater', (S) => S.p.Tsh > 420],
  ['B1101', 'B-1101', 1, 'FD fans B-1101 STOPPED with fire in the heater', 'heater', (S) => !S.eq.B1101 && (S.eq.BURN || S.eq.PILOT)],
  ['HTRIP', 'H-1101', 1, 'H-1101 tripped — reset, purge and relight required', 'heater', (S) => S.sis.htrTrip],
  // 300 fractionator
  ['TAH076', 'TIC-076', 2, 'T-1101 top temperature high ≥ 135 °C', 'fract', (S) => S.p.Ttop >= 135 && run(S)],
  ['TAL076', 'TIC-076', 2, 'T-1101 top temperature low ≤ 115 °C', 'fract', (S) => S.p.Ttop <= 115 && run(S)],
  ['DEW', 'TIC-076', 2, 'Overhead water dew-point margin < 10 °C (top corrosion)', 'fract', (S) => S.p.dewM < 10 && S.p.dewM >= 5 && run(S)],
  ['DEWLL', 'TIC-076', 1, 'Overhead water dew-point margin < 5 °C — water condensing on top trays', 'fract', (S) => S.p.dewM < 5 && run(S)],
  ['LAH007', 'LIC-007', 2, 'T-1101 bottoms level high ≥ 80 %', 'fract', (S) => S.p.Lbot >= 80 && S.p.Lbot < 95],
  ['LAHH007', 'LIC-007', 1, 'T-1101 bottoms level HH ≥ 95 % (UX-002)', 'fract', (S) => S.p.Lbot >= 95],
  ['LAL007', 'LIC-007', 2, 'T-1101 bottoms level low ≤ 20 %', 'fract', (S) => S.p.Lbot <= 20 && S.p.Lbot > 5 && S.p.F > 100],
  ['LALL007', 'LIC-007', 1, 'T-1101 bottoms level LL ≤ 5 % (UX-020)', 'fract', (S) => S.p.Lbot <= 5 && S.eq.P1106],
  ['OFL', 'FI-OF', 2, 'Overflash low < 1.0 % — wash zone drying, HGO dirty', 'fract', (S) => run(S) && S.p.OF < 1.0],
  ['PAH064T', 'PI-TOP', 2, 'T-1101 top pressure high ≥ 2.5 kg/cm²g', 'fract', (S) => S.p.Ptop >= 2.5],
  ['LAL011', 'LIC-011', 3, 'Kero stripper T-1102 level low ≤ 15 %', 'fract', (S) => run(S) && S.p.Lk <= 15],
  ['LAL013', 'LIC-013', 3, 'LGO stripper T-1103 level low ≤ 15 %', 'fract', (S) => run(S) && S.p.Ll <= 15],
  ['LAL016', 'LIC-016', 2, 'HGO stripper T-1104 level low ≤ 15 % (HGO draw tray drying)', 'fract', (S) => run(S) && S.p.Lh <= 15],
  ['WET', 'FIC-051', 1, 'Stripping steam into a cold tower (< 150 °C): water slug / pressure surge', 'fract', (S) => S.p.wet > 1],
  ['P1102', 'P-1102', 1, 'Top pumparound P-1102 STOPPED', 'fract', (S) => !S.eq.P1102 && run(S)],
  ['P1106', 'P-1106', 1, 'Residue pumps P-1106 STOPPED', 'fract', (S) => !S.eq.P1106 && S.p.F > 100],
  ['PADV', 'UIC-032', 3, 'Pumparound duty deviation > 15 %', 'fract', (S) => run(S) && (dev(S, 'UIC-029', 1.5) || dev(S, 'UIC-032', 4.5))],
  // 400 overhead & stabilizer
  ['PAH064', 'PIC-064', 2, 'D-1103 pressure high ≥ 2.0 kg/cm²g', 'overhead', (S) => S.p.P1103 >= 2.0],
  ['PAL064', 'PIC-064', 3, 'D-1103 pressure low ≤ 0.8 kg/cm²g', 'overhead', (S) => S.p.P1103 <= 0.8 && run(S)],
  ['FLR064', 'PIC-064', 2, 'D-1103 off gas to flare (PV-064C open)', 'overhead', (S) => (S.p.og64F || 0) > 0.5],
  ['UNC', 'E-1111', 2, 'E-1111 condenser overloaded — uncondensed vapour', 'overhead', (S) => S.p.unc > 1],
  ['E1111', 'E-1111', 1, 'Overhead condenser E-1111 fans STOPPED', 'overhead', (S) => !S.eq.E1111 && S.p.HCov > 5],
  ['LAH038', 'LIC-038', 2, 'D-1103 naphtha level high ≥ 80 %', 'overhead', (S) => S.p.L1103 >= 80],
  ['LAL038', 'LIC-038', 2, 'D-1103 naphtha level low ≤ 15 %', 'overhead', (S) => S.p.L1103 <= 15 && run(S)],
  ['LAH040', 'LIC-040', 2, 'D-1103 water boot high ≥ 80 % (water carry-over to stabilizer)', 'overhead', (S) => S.p.Lw >= 80],
  ['CL', 'AI-CL', 3, 'Overhead water chloride > 30 ppm', 'overhead', (S) => S.p.Cl > 30 && run(S)],
  ['PHL', 'AI-PH', 3, 'Overhead water pH < 5.5 (acid corrosion)', 'overhead', (S) => S.p.pH < 5.5 && run(S)],
  ['TAL060', 'TIC-060', 2, 'Stabilizer bottom temperature low ≤ 180 °C', 'overhead', (S) => S.p.Tst <= 180 && S.p.Fsf > 50],
  ['PAH068', 'PIC-068', 2, 'Stabilizer D-1104 pressure high ≥ 8.6 kg/cm²g', 'overhead', (S) => S.p.P1104 >= 8.6],
  ['LAH047', 'LIC-047', 2, 'D-1104 reflux drum level high ≥ 80 %', 'overhead', (S) => S.p.L1104 >= 80 && S.p.L1104 < 90],
  ['LAHH047', 'LIC-047', 1, 'D-1104 level HH ≥ 90 % (UX-024 reboiler cut)', 'overhead', (S) => S.p.L1104 >= 90],
  ['LAL042', 'LIC-042', 3, 'Stabilizer bottoms level low ≤ 15 %', 'overhead', (S) => S.p.Lst <= 15 && S.p.Fsf > 50],
  ['P1114', 'P-1114', 1, 'Stabilizer reflux pump P-1114 STOPPED', 'overhead', (S) => !S.eq.P1114 && S.p.Fsf > 50],
  ['REBCUT', 'TIC-060', 1, 'SIS: stabilizer reboiler steam cut (UX-024) — reset required', 'overhead', (S) => !!S.sis.cut.reb],
  // 500 rundown & dryers
  ['PAH049', 'PIC-049', 2, 'Dryer vacuum lost (pressure > −0.75 kg/cm²g)', 'rundown', (S) => S.p.Pdry > -0.75 && S.p.Flgo > 50],
  ['TAH111', 'TIC-111', 2, 'Residue to storage hot ≥ 95 °C (tank boil-over risk)', 'rundown', (S) => S.p.TresSto >= 95 && S.p.toSto > 5],
  ['RFCC', 'FV-026', 2, 'RFCC not taking residue / off gas (downstream trip)', 'rundown', (S) => S.fail.rfccTrip],
  ['LAL019', 'LIC-019', 3, 'LGO dryer T-1105 level low ≤ 15 %', 'rundown', (S) => run(S) && S.p.Ld1 <= 15],
  ['LAL022', 'LIC-022', 3, 'HGO dryer T-1106 level low ≤ 15 %', 'rundown', (S) => run(S) && S.p.Ld2 <= 15],
  // quality (lab)
  ['QLPG', 'LAB', 3, 'LPG off-spec (C5+ > 1.5 mol%)', 'quality', (S) => run(S) && offs(S, 'C5')],
  ['QNAP', 'LAB', 3, 'Naphtha off-spec (C4 > 0.3 wt%)', 'quality', (S) => run(S) && offs(S, 'C4N')],
  ['QKERO', 'LAB', 3, 'Kerosene off-spec', 'quality', (S) => run(S) && !S.p.ok.KERO],
  ['QLGO', 'LAB', 3, 'LGO off-spec', 'quality', (S) => run(S) && !S.p.ok.LGO],
  ['QHGO', 'LAB', 3, 'HGO off-spec', 'quality', (S) => run(S) && !S.p.ok.HGO],
  ['QRES', 'LAB', 3, 'Residue off-spec (> 10 vol% boiling < 360 °C)', 'quality', (S) => run(S) && !S.p.ok.RES],
  ['GRADE', 'LAB', 3, 'Current SPs differ from the target-case recipe', 'quality', (S) => S.recipeDiff > 0 && S.level !== 'hard'],
  // safety & flare
  ['SISBYP', 'SIS', 1, 'SIS BYPASSED by instructor', 'instructor', (S) => S.sis.bypass],
  ['ESD', 'UX-007', 1, 'UX-007 CDU emergency shutdown ACTIVE', 'preheat', (S) => S.sis.esd],
  ['UX001', 'UX-001', 1, 'UX-001 desalter protection tripped — reset required', 'preheat', (S) => !!S.sis.cut.ux001],
  ['PSV005', 'PSV-005', 1, 'PSV-005 LIFTED — desalter relieving to T-1101', 'preheat', (S) => !!(S.psv && S.psv['PSV-005'] && S.psv['PSV-005'].open)],
  ['PSV161', 'PSV-161', 1, 'PSV-161 LIFTED — T-1101 overhead relieving to flare', 'fract', (S) => !!(S.psv && S.psv['PSV-161'] && S.psv['PSV-161'].open)],
  ['PSV237', 'PSV-237', 1, 'PSV-237 LIFTED — stabilizer relieving to flare', 'overhead', (S) => !!(S.psv && S.psv['PSV-237'] && S.psv['PSV-237'].open)],
  ['FLARE', 'FL-901', 2, 'Flare load high > 10 t/h', 'utilities', (S) => (S.p.flare || 0) > 10],
  ['KO', 'D-901', 2, 'Flare knock-out drum level high ≥ 60 %', 'utilities', (S) => (S.p.koLvl || 0) >= 60],
  ['LPS', 'PI-LPS', 1, 'LP steam header pressure low < 2.5 kg/cm²g', 'utilities', (S) => S.p.lpP < 2.5],
  ['MPS', 'PI-MPS', 2, 'MP steam header pressure low < 7 kg/cm²g', 'utilities', (S) => S.p.mpP < 7],
  ['HPS', 'PI-HPS', 2, 'HP steam header pressure low < 30 kg/cm²g', 'utilities', (S) => S.p.hpP < 30],
  ['CWS', 'TI-CW', 2, 'Cooling water supply failure / hot > 40 °C', 'utilities', (S) => S.p.cwS > 40]
];
CDU.ALM = ALM;
const SUP_IDLE = new Set(['B1101', 'P6001', 'P1101', 'P1106', 'XFMR', 'PAL011', 'FGH']);
const SUP_LOW = new Set(['PBL', 'TAL076', 'TDI007', 'TDI015', 'LAL038', 'LAL042', 'TAL060', 'LAL011', 'LAL013', 'LAL016', 'LAL019', 'LAL022', 'QLPG', 'QNAP', 'QKERO', 'QLGO', 'QHGO', 'QRES', 'GRADE', 'PADV', 'TDV066', 'DP506', 'SALT', 'BSW', 'TDES', 'OFL', 'FAL069', 'PAL064', 'XFMR', 'DSALBY', 'CL', 'PHL', 'P1114', 'PAH049']);
CDU.evalAlarms = function (S) {
  S.recipeDiff = CDU.recipeDiffCount(S);
  const idle = CDU.isIdle(S), low = CDU.isLow(S);
  for (const [id, tag, prio, msg, page, cond] of ALM) {
    let on = false; try { on = !!cond(S); } catch (e) { on = false; }
    if ((idle && SUP_IDLE.has(id)) || (low && SUP_LOW.has(id))) on = false;
    let a = S.alarms.find(x => x.id === id);
    if (on && !a) { S.alarms.unshift({ id, tag, prio, msg, page, t: S.t, active: true, acked: false }); CDU.log(S, 'ALARM', 'P' + prio + ' ' + tag + ' ' + msg); }
    else if (on && a && !a.active) { a.active = true; a.acked = false; a.t = S.t; CDU.log(S, 'ALARM', 'P' + prio + ' ' + tag + ' ' + msg); }
    else if (!on && a && a.active) { a.active = false; a.rtn = S.t; CDU.log(S, 'RTN', tag + ' ' + msg); if (a.acked) S.alarms.splice(S.alarms.indexOf(a), 1); }
  }
};
CDU.ackAlarm = function (S, id) {
  for (const a of S.alarms.slice()) if (id === 'ALL' || a.id === id) { a.acked = true; if (!a.active) S.alarms.splice(S.alarms.indexOf(a), 1); }
};

/* ---------------- 2. LAB SAMPLING & HISTORY ---------------- */
function takeSample(S, kind) {
  S.sampleNo++;
  S.lab.unshift({ no: S.sampleNo, kind, t: S.t, due: S.t + 900, grade: S.target, props: Object.assign({}, S.p.lab), salt: S.p.salt, bsw: S.p.bsw, route: Object.assign({}, S.route) });
  if (S.lab.length > 40) S.lab.length = 40;
}
CDU.HV = {
  COT: ['COT TIC-066', '°C', S => S.p.COT], COTsp: ['TIC-066 SP', '°C', S => S.ctl['TIC-066'].sp], Tfz: ['Flash zone TI', '°C', S => S.p.Tfz], Tbot: ['T-1101 bottom', '°C', S => S.p.Tbot],
  Ttop: ['T-1101 top TIC-076', '°C', S => S.p.Ttop], Tdew: ['Water dew point', '°C', S => S.p.Tdew], Tk: ['Kero draw tray 15', '°C', S => S.p.Tk], Tl: ['LGO draw tray 26', '°C', S => S.p.Tl], Th: ['HGO draw tray 38', '°C', S => S.p.Th],
  Tcold: ['Cold train outlet', '°C', S => S.p.Tcold], Tdes: ['Desalter temperature', '°C', S => S.p.Tdes], Thot: ['Hot train outlet (heater in)', '°C', S => S.p.Thot],
  F: ['Charge FIC-069', 't/h', S => S.p.F], Fin: ['Crude from tankage FV-092', 't/h', S => S.p.Fin], Fnap: ['Naphtha product', 't/h', S => S.p.Fnap + S.p.FnapSto], Fkero: ['Kerosene FQIC-033', 't/h', S => S.p.Fkero],
  Flgo: ['LGO FQIC-020', 't/h', S => S.p.Flgo], Fhgo: ['HGO FQIC-024', 't/h', S => S.p.Fhgo], Fres: ['Residue rundown', 't/h', S => S.p.FresProd], Flpg: ['LPG FQIC-037', 't/h', S => S.p.Flpg],
  OF: ['Overflash', '% feed', S => S.p.OF], Qabs: ['Heater absorbed duty', 'MW', S => S.p.Qabs], FG: ['Fuel gas', 't/h', S => S.p.FG], O2: ['Flue gas O2', '%', S => S.p.O2], skin: ['Max tube skin', '°C', S => S.p.skinMax],
  Qtpa: ['Top PA duty E-1112', 'MW', S => S.p.Qtpa], QkPA: ['Kero PA UIC-029', 'MW', S => S.p.QkPA], QlPA: ['LGO PA UIC-032', 'MW', S => S.p.QlPA], QhPA: ['HGO PA UIC-031', 'MW', S => S.p.QhPA],
  Ptop: ['T-1101 top pressure', 'kg/cm²g', S => S.p.Ptop], P1103: ['D-1103 PIC-064', 'kg/cm²g', S => S.p.P1103], Pd: ['Desalter PIC-011', 'kg/cm²g', S => S.p.Pd], P1104: ['D-1104 PIC-068', 'kg/cm²g', S => S.p.P1104],
  Lbot: ['T-1101 bottoms LIC-007', '%', S => S.p.Lbot], L1103: ['D-1103 naphtha LIC-038', '%', S => S.p.L1103], L1: ['D-01 interface LIC-003', '%', S => S.p.L1], L2: ['D-02 interface LIC-006', '%', S => S.p.L2],
  salt: ['Desalted salt', 'ppm', S => S.p.salt], bsw: ['Desalted BS&W', 'vol%', S => S.p.bsw],
  KFL: ['Kero flash', '°C', S => S.p.lab.KFL], LFL: ['LGO flash', '°C', S => S.p.lab.LFL], FRZ: ['Kero freeze', '°C', S => S.p.lab.FRZ], POUR: ['LGO pour', '°C', S => S.p.lab.POUR],
  R360: ['Residue < 360 °C', 'vol%', S => S.p.lab.R360], C5: ['LPG C5+', 'mol%', S => S.p.lab.C5], C4N: ['Naphtha C4', 'wt%', S => S.p.lab.C4N], GNK: ['Gap kero/naphtha', '°C', S => S.p.lab.GNK], OLH: ['Overlap LGO/HGO', '°C', S => S.p.lab.OLH],
  Tst: ['Stabilizer bottom TIC-060', '°C', S => S.p.Tst], Ttst: ['Stabilizer top', '°C', S => S.p.Ttst], Rst: ['Stabilizer reflux', 't/h', S => S.p.Rst],
  flare: ['Flare load', 't/h', S => S.p.flare || 0.5], xBH: ['Bach Ho in charge', '%', S => S.p.xBH * 100], bhCol: ['Bach Ho in column', '%', S => S.p.xCol * 100]
};
CDU.TRENDS = {
  temps: ['Heater & column temperatures', ['COT', 'COTsp', 'Tfz', 'Tbot']],
  top: ['Column top & dew point', ['Ttop', 'Tdew', 'Ptop', 'P1103']],
  profile: ['Draw tray temperatures', ['Tk', 'Tl', 'Th', 'Ttop']],
  preheat: ['Preheat train', ['Tcold', 'Tdes', 'Thot', 'F']],
  prod: ['Production', ['Fnap', 'Fkero', 'Flgo', 'Fhgo', 'Fres']],
  quality: ['Quality (lab)', ['KFL', 'LFL', 'R360', 'POUR']],
  cuts: ['Fractionation', ['GNK', 'OLH', 'OF', 'FRZ']],
  heater: ['Heater', ['Qabs', 'FG', 'O2', 'skin']],
  duty: ['Pumparound duties', ['Qtpa', 'QkPA', 'QlPA', 'QhPA']],
  press: ['Pressures', ['Pd', 'Ptop', 'P1103', 'P1104']],
  levels: ['Levels', ['Lbot', 'L1103', 'L1', 'L2']],
  desalter: ['Desalting', ['salt', 'bsw', 'L1', 'L2']],
  stab: ['Stabilizer', ['Tst', 'Ttst', 'C5', 'C4N']],
  crude: ['Crude switch', ['xBH', 'bhCol', 'F', 'flare']]
};
function sampleHist(S) {
  const h = S.hist; h.t.push(Math.round(S.t));
  for (const k in CDU.HV) { let v = CDU.HV[k][2](S); if (v == null || !isFinite(v)) v = 0; if (!h.d[k]) h.d[k] = new Array(h.t.length - 1).fill(+(+v).toPrecision(4)); h.d[k].push(+(+v).toPrecision(4)); }
  if (h.t.length > 720) { h.t.shift(); for (const k in h.d) h.d[k].shift(); }
}
CDU.advance = function (S, secs) {
  let rem = secs;
  while (rem > 1e-6) {
    const dt = Math.min(1, rem); rem -= dt;
    CDU.step(S, dt);
    CDU.evalAlarms(S);
    CDU.procEval(S);
    if (S.t >= S.nextSample) { takeSample(S, 'ROUTINE'); S.nextSample += 3600; }
    if (S.t >= S.histNext) { sampleHist(S); S.histNext = S.t + 30; }
  }
};

/* ---------------- 3. COMMANDS (operator + instructor) ---------------- */
const MOTOR_FAIL = { P6001: 'p6001Trip', P1101: 'p1101Trip', P1106: 'p1106Trip', P1102: 'p1102Trip', P1114: 'p1114Trip', B1101: 'fdTrip', E1111: 'e1111Trip' };
CDU.MOTOR_FAIL = MOTOR_FAIL;
const LOCK = new Set(['fdTrip', 'e1111Trip', 'p1101Trip']);       // these stay locked out until the instructor clears the failure
const n = (v, d) => (+v).toFixed(d == null ? 2 : d);
CDU.recipeDiffCount = function (S) {
  let c = 0;
  for (const [, key, val] of CDU.recipeItems(S.target)) { const cur = CDU.currentValue(S, key); if (!CDU.sameVal(cur, val)) c++; }
  return c;
};
CDU.currentValue = function (S, key) { const d = CDU.CTL[key]; if (d && d.hand) return S.ctl[key].op; return S.ctl[key] ? S.ctl[key].sp : null; };
CDU.sameVal = function (a, b) { if (typeof b === 'string') return a === b; return Math.abs(a - b) <= Math.max(0.02 * Math.abs(b), 0.3); };
CDU.applyRecipe = function (S, grade) {
  for (const [, key, val] of CDU.recipeItems(grade)) {
    if (CDU.CTL[key].hand) S.ctl[key].op = val;
    else { S.ctl[key].sp = val; if (S.ctl[key].mode === 'MAN') S.ctl[key].mode = 'AUTO'; }
  }
  S.target = grade; S.grade = grade;
};
const REFUSE = (S, L, m) => { L(m); return false; };
CDU.permit = function (S, eq, on) {
  const p = S.p, E = S.eq, s = S.sis;
  if (!on) return '';
  const f = MOTOR_FAIL[eq];
  if (f && S.fail[f] && LOCK.has(f)) return 'motor tripped — MCC lock-out until the fault is cleared';
  if (S.fail.power && eq !== 'DSAL' && eq !== 'SHSTM' && eq !== 'DEMUL' && eq !== 'NEUT' && eq !== 'EJ' && eq !== 'PILOT' && eq !== 'BURN') return 'no power on the MCC bus';
  if (s.esd && ['P6001', 'P1101', 'PILOT', 'BURN', 'XFMR'].includes(eq)) return 'UX-007 ESD active — reset it first';
  switch (eq) {
    case 'PILOT': if (!E.B1101) return 'FD fan B-1101 not running';
      if (s.htrTrip) return 'heater trip not reset (UHSR-005 on the heater faceplate)';
      if ((s.purge || 0) < 300) return 'firebox purge not complete (' + Math.floor(s.purge || 0) + ' / 300 s with B-1101 running and fuel off)';
      if (p.fgH < 1.5 || S.fail.pilotFail) return 'pilot gas pressure low'; return '';
    case 'BURN': if (!E.PILOT) return 'pilots not lit';
      if (s.htrTrip) return 'heater trip not reset';
      if (!E.SHSTM) return 'no steam in the superheater coil (start SL-1101 first — coil would overheat)';
      if (p.F < 250) return 'pass flow not established (FIC-069 ≥ 250 t/h needed for light-off)';
      if (S.ctl['TIC-066'].op > 12) return 'TIC-066 output above light-off position (MAN, OP ≤ 10 %)';
      if (p.fgH < 2.5) return 'fuel-gas header pressure low'; return '';
    case 'P1106': if (p.Lbot < 10) return 'T-1101 bottoms level < 10 % (no suction)'; return '';
    case 'P1101': if (p.Pd < 3) return 'suction pressure < 3 kg/cm²g — pressurise the desalter line with P-6001 / PIC-011 first'; return '';
    case 'XFMR': if (!E.DSAL) return 'desalters bypassed (HS-001)'; if (s.cut.ux001) return 'UX-001 not reset'; if (p.L1 >= 85 || p.L2 >= 85) return 'interface too high (≥ 85 %)'; return '';
    case 'P1118': case 'P1119': if (!E.DSAL) return 'desalters bypassed (HS-001)'; if (s.cut.ux001) return 'UX-001 not reset'; return '';
    case 'P1110': if (p.L1103 < 10) return 'D-1103 naphtha level < 10 %'; return '';
    case 'P1114': case 'P1115': if (p.L1104 < 8) return 'D-1104 level < 8 %'; return '';
    case 'DSAL': if (p.Pd < 5 && S.circ === 'NORMAL' && p.F > 100) return 'desalter line pressure < 5 kg/cm²g'; return '';
  }
  return '';
};
CDU.exec = function (S, c) {
  const src = c.src || 'OPERATOR', C = S.ctl, def = CDU.CTL[c.tag];
  const L = (m) => CDU.log(S, src, m);
  switch (c.type) {
    case 'sp': { if (!C[c.tag] || def.hand) return; const o = C[c.tag].sp; C[c.tag].sp = CDU.clamp(+c.v, def.lo, def.hi); L(c.tag + ' SP ' + n(o, def.dec) + ' → ' + n(C[c.tag].sp, def.dec)); break; }
    case 'op': { if (!C[c.tag]) return; if (C[c.tag].mode !== 'MAN') { L(c.tag + ' OP entry refused (not MAN)'); return; } const o = C[c.tag].op; C[c.tag].op = CDU.clamp(+c.v, def.hand ? def.lo : 0, def.hand ? def.hi : 100); L(c.tag + ' OP ' + n(o, 1) + ' → ' + n(C[c.tag].op, 1) + (def.hand ? ' ' + def.u : ' %')); break; }
    case 'mode': { if (!C[c.tag] || def.hand) return; if (c.tag === 'TIC-060' && S.sis.cut.reb && c.m === 'AUTO') { L('TIC-060 AUTO refused — UX-024 reboiler cut active'); return; }
      C[c.tag].mode = c.m; C[c.tag].e1 = C[c.tag].e2 = 0; L(c.tag + ' mode → ' + c.m); break; }
    case 'nudge': { const x = C[c.tag]; if (!x) return; if (x.mode === 'AUTO' && !def.hand) { x.sp = CDU.clamp(x.sp + c.dir * (def.hi - def.lo) * 0.005, def.lo, def.hi); L(c.tag + ' SP nudge → ' + n(x.sp, def.dec)); }
      else { x.op = CDU.clamp(x.op + c.dir, def.hand ? def.lo : 0, def.hand ? def.hi : 100); L(c.tag + ' OP nudge → ' + n(x.op, 1)); } break; }
    case 'motor': { const nm = CDU.EQ[c.eq].d, why = CDU.permit(S, c.eq, c.on);
      if (why) { L(nm + ' START refused — ' + why); return; }
      const f = MOTOR_FAIL[c.eq];
      if (c.on && f && S.fail[f]) { L(nm + ': standby pump / spare started (the tripped unit stays out for repair)'); S.fail[f] = false; }
      S.eq[c.eq] = !!c.on; if (S.trip) delete S.trip[c.eq];
      if (c.eq === 'BURN' && c.on) S.sis.lightT = S.t;
      if (c.eq === 'DSAL') { L('HS-001 desalters → ' + (c.on ? 'IN SERVICE' : 'BYPASSED')); if (!c.on) S.eq.XFMR = false; break; }
      L(nm + (c.on ? ' START' : ' STOP')); break; }
    case 'circ': { const v = c.v; if (!['NORMAL', 'SHORT', 'LONG'].includes(v)) return;
      if (v === 'NORMAL' && S.circ !== 'NORMAL' && !S.eq.P1101) { L('HS-100 to NORMAL refused — start booster P-1101 first (heater suction would be lost)'); return; }
      if (v !== 'NORMAL' && !S.eq.P1106) { L('HS-100 to ' + v + ' refused — start residue pump P-1106 first'); return; }
      S.circ = v; L('HS-100 heater suction / circulation → ' + (v === 'NORMAL' ? 'NORMAL (once-through crude)' : v + ' PATH circulation')); break; }
    case 'src': S.feedSrc = c.v === 'FLUSH' ? 'FLUSH' : 'CRUDE'; L('HS-003 charge source → ' + (S.feedSrc === 'FLUSH' ? 'SR FLUSHING OIL' : 'CRUDE OIL')); break;
    case 'route': { if (!S.route[c.k]) return; S.route[c.k] = c.v === 'SLOPS' ? 'SLOPS' : 'PRODUCT'; L(CDU.ROUTES[c.k][0] + ' routed to ' + (S.route[c.k] === 'SLOPS' ? 'SLOPS (rerun via crude tankage)' : CDU.ROUTES[c.k][1])); break; }
    case 'esd': { if (c.on) { S.sis.esd = true; CDU.log(S, 'SIS', 'UX-007 CDU EMERGENCY SHUTDOWN initiated by ' + src);
        for (const k of ['P6001', 'P1101', 'XFMR', 'P1118', 'P1119']) S.eq[k] = false;
        CDU.heaterTrip(S, 'UX-007', 'UX-007 CDU emergency shutdown');
        for (const t of ['FIC-051', 'FIC-052', 'FIC-053']) { C[t].mode = 'MAN'; C[t].op = 0; }
        CDU.alert(S, 'sis', 'UX-007', 'UX-007 — CDU EMERGENCY SHUTDOWN', 'Charge pumps, booster pumps and desalters stopped, heater fuel isolated, stripping steam closed. Secure levels and pressures; keep the overhead and stabilizer pressures with PIC-064 / PIC-068.');
      } else { S.sis.esd = false; CDU.log(S, 'SIS', 'UX-007 ESD reset by ' + src); } break; }
    case 'sisReset': { const k = c.k || 'htr';
      if (k === 'htr') { if (S.eq.BURN || S.eq.PILOT) { L('Heater reset not needed'); return; } if (!S.sis.htrTrip) return; S.sis.htrTrip = false; S.sis.purge = 0; L('UHSR-005 heater trip RESET — purge 5 min with B-1101 running before relighting'); }
      else if (k === 'ux001') { if (S.p.Pd >= 13.0 || S.p.Pd < 2) { L('UX-001 reset refused — desalter pressure not normal'); return; } S.sis.cut.ux001 = false; L('UX-001 desalter protection RESET'); }
      else if (k === 'reb') { if (S.p.L1104 >= 80) { L('UX-024 reset refused — D-1104 level ≥ 80 %'); return; } S.sis.cut.reb = false; L('UX-024 reboiler cut RESET'); }
      break; }
    case 'recipe': if (S.level === 'hard' && src !== 'INSTRUCTOR') { L('Apply recipe refused — HARD mode (enter SPs from the manual)'); return; } CDU.applyRecipe(S, c.grade); L('Recipe SPs applied for case ' + c.grade); break;
    case 'target': S.target = c.grade; L('Target operating case set to ' + c.grade); break;
    case 'speed': S.speed = +c.v; L('Simulation speed ' + c.v + '×'); break;
    case 'freeze': S.frozen = !!c.on; L(c.on ? 'Simulation FROZEN' : 'Simulation RUN'); break;
    case 'ack': CDU.ackAlarm(S, c.id || 'ALL'); if (c.id === 'ALL' || !c.id) L('Alarms acknowledged (all)'); break;
    case 'noise': S.noiseOn = !!c.on; L('Process noise / disturbances ' + (c.on ? 'ON' : 'OFF')); break;
    case 'alertClose': { for (const a of (S.alerts || [])) if (c.id === 'ALL' || a.id === c.id) { a.closed = true; if (c.ack) CDU.ackAlarm(S, 'ALL'); } return; }
    case 'spot': takeSample(S, 'SPOT'); L('Spot samples taken (all products)'); break;
    case 'level': { const v = c.v === 'hard' ? 'hard' : 'easy'; if (S.level === v) return; S.level = v; L('Difficulty set to ' + v.toUpperCase() + (v === 'hard' ? ' — recipe hints hidden' : ' — recipe hints shown')); if (S.proc && S.proc.complete == null && v === 'easy') S.proc.easyUsed = true; break; }
    // ---- instructor
    case 'fail': CDU.applyFail(S, c.name, c.on, 'INSTRUCTOR'); break;
    case 'schedFail': { if (!CDU.FAILS[c.name]) return; const t = S.t + Math.max(0, +c.delay || 0); S.sched.push({ t, fail: c.name }); if (c.dur > 0) S.sched.push({ t: t + +c.dur, fail: c.name, on: false }); L('Failure scheduled at ' + CDU.fmtT(t) + ': ' + CDU.FAILS[c.name] + (c.dur > 0 ? ' (clears after ' + Math.round(c.dur / 60) + ' min)' : '')); break; }
    case 'clearFails': for (const f in S.fail) if (S.fail[f]) CDU.applyFail(S, f, false, 'INSTRUCTOR'); S.sched = []; S.failUntil = {}; break;
    case 'sisBypass': S.sis.bypass = !!c.on; L('SIS bypass ' + (c.on ? 'ON' : 'OFF')); break;
    case 'resetFoul': S.p.coke = 0; S.p.foulPre = 0; L('Heater decoked / exchangers cleaned (coke and fouling indices reset)'); break;
  }
};

/* ---------------- 4. INSTRUCTOR LOGIC ---------------- */
CDU.FAILS = {
  p6001Trip: 'Crude charge pump P-6001 trip', p1101Trip: 'Crude booster pumps P-1101 A/B trip (locked out)', p1106Trip: 'Residue pump P-1106 trip',
  p1102Trip: 'Top pumparound pump P-1102 trip', p1114Trip: 'Stabilizer reflux pump P-1114 trip', fdTrip: 'Both FD fans B-1101 A/B trip (locked out)',
  e1111Half: 'E-1111 overhead condenser: one fan bay trips (50 % duty)', e1111Trip: 'E-1111 overhead condenser: all fans trip (locked out)',
  fgFail: 'Fuel-gas header pressure loss', pilotFail: 'Pilot gas pressure loss', passStuck: 'Heater pass 5 valve FCV-075 sticks partly closed',
  lic003Fail: 'LIC-003 fails in AUTO (output drifts to 0 %)', pic064Fail: 'PIC-064 fails in AUTO (output ramps into the fuel-gas make-up range)',
  pic011Fail: 'PIC-011 fails in AUTO (feed valve FV-092 ramps open)', rfccTrip: 'RFCC unit trip (no residue / off gas accepted)',
  lpFail: 'LP steam header failure', mpFail: 'MP steam failure (ejectors)', hpFail: 'HP steam failure (stabilizer reboiler)', cwFail: 'Cooling water failure',
  power: 'Electrical power failure (all motors trip)', tic076Frozen: 'TIC-076 top temperature transmitter frozen', lic038Frozen: 'LIC-038 D-1103 level transmitter frozen'
};
const FAIL_EQ = { p6001Trip: 'P6001', p1101Trip: 'P1101', p1106Trip: 'P1106', p1102Trip: 'P1102', p1114Trip: 'P1114', fdTrip: 'B1101', e1111Trip: 'E1111' };
CDU.applyFail = function (S, name, on, src) {
  S.fail[name] = !!on;
  if (on && FAIL_EQ[name]) CDU.tripEq(S, FAIL_EQ[name], CDU.FAILS[name] + (LOCK.has(name) ? '. Start is locked out until the fault is cleared.' : '. Start the standby pump from the faceplate (START).'));
  if (name === 'tic076Frozen') S.ctl['TIC-076'].frozenPV = on ? S.ctl['TIC-076'].pv : null;
  if (name === 'lic038Frozen') S.ctl['LIC-038'].frozenPV = on ? S.ctl['LIC-038'].pv : null;
  if (name === 'passStuck' && !on) S.p.stuckOP = null;
  if (!(S.exercise && S.exercise.hidden && src === 'SCHEDULE')) CDU.log(S, src, 'FAILURE ' + (on ? 'ACTIVATED: ' : 'cleared: ') + CDU.FAILS[name]);
  else CDU.log(S, 'INSTRUCTOR', on ? 'Hidden failure activated' : 'Hidden failure cleared');
};
CDU.EXERCISES = [
  { id: 'gc-dubai', title: 'Crude switch Bach Ho → Dubai (sour)', start: 'BACH HO', target: 'DUBAI', brief: 'Change HIC-002 to 0 % Bach Ho. Dubai has more naphtha and LPG, more salt and needs a hotter COT. Re-set COT, draws, stripping steam and the LPG rate from the recipe; the new crude reaches the column over ~30 min. Track off-spec tonnes.' },
  { id: 'gc-blend', title: 'Crude switch Bach Ho → Blend (Jet A-1 kero)', start: 'BACH HO', target: 'BLEND', brief: 'Bring 15.4 % Dubai into the charge so the kerosene meets the Jet A-1 freeze point (≤ −47 °C). Watch the kero freeze trend while the blend arrives.' },
  { id: 'gc-maxnap', title: 'Flexibility case: design → MAX NAPHTHA', start: 'BACH HO', target: 'MAX NAPHTHA', brief: 'Raise the naphtha/kero cut to 170 °C: higher TIC-076, less kerosene. More overhead load on E-1111 and the stabilizer.' },
  { id: 'gc-maxkero', title: 'Flexibility case: design → MAX KERO', start: 'BACH HO', target: 'MAX KERO', brief: 'Widen the kerosene to 162–230 °C: lower top temperature (watch the water dew-point margin!) and more kero draw.' },
  { id: 'p1106', title: 'Residue pump P-1106 trip', start: 'BACH HO', fail: 'p1106Trip', delay: 120, brief: 'P-1106 trips: the residue stops, T-1101 bottoms level rises and the hot preheat loses its largest heat source. Start the spare before LZHH-007 (95 %) cuts the charge.' },
  { id: 'p1102', title: 'Top pumparound P-1102 trip', start: 'BACH HO', fail: 'p1102Trip', delay: 120, brief: 'Top PA lost: the top temperature runs away, naphtha gets heavy and E-1111 overloads. Start the spare P-1102; if slow, cut COT / charge.' },
  { id: 'e1111', title: 'Overhead condenser E-1111 half fans trip', start: 'BACH HO', fail: 'e1111Half', delay: 120, duration: 2400, brief: 'One fan bay of E-1111 trips. Vapour is not condensed and PIC-064 sends off gas to the flare. Reduce the overhead load (top PA, COT, charge) so the flare stops and PSV-161 does not lift.' },
  { id: 'fg', title: 'Fuel-gas pressure loss → heater trip', start: 'BACH HO', fail: 'fgFail', delay: 120, duration: 600, brief: 'The fuel-gas header collapses and H-1101 trips (UX-005B). Reduce charge, route off-spec products to slops, and when the gas returns: reset, purge, relight and bring the COT back.' },
  { id: 'pass', title: 'Heater pass valve sticks (low pass flow)', start: 'BACH HO', fail: 'passStuck', delay: 180, brief: 'One pass control valve sticks partly closed. Find the pass with the high outlet / skin temperature and reduce firing and charge before coking.' },
  { id: 'lic003', title: 'Desalter interface controller LIC-003 fails', start: 'BACH HO', fail: 'lic003Fail', delay: 120, brief: 'LIC-003 drives the brine valve shut in AUTO. The D-01 interface rises towards the grids (transformer trip at 90 %). Take LIC-003 to MAN and open LV-003.' },
  { id: 'pic011', title: 'PIC-011 fails — desalter PSV-005 lifts', start: 'BACH HO', fail: 'pic011Fail', delay: 120, brief: 'The feed valve FV-092 ramps open in AUTO. Desalter pressure climbs past 13 kg/cm²g; PSV-005 (13.8) relieves to T-1101 and UX-001 (13.5) trips the desalters. Spot it early: PIC-011 to MAN and close FV-092.' },
  { id: 'pic064', title: 'PIC-064 fails — overhead PSV-161 lifts', start: 'BACH HO', fail: 'pic064Fail', delay: 120, brief: 'PIC-064 output ramps down: off gas to RFCC closes and fuel gas flows into D-1103. Pressure rises to the PSV-161 set (3.5 kg/cm²g at the top). Put PIC-064 in MAN at ≈ 40 %.' },
  { id: 'rfcc', title: 'RFCC trip — residue to storage', start: 'BACH HO', fail: 'rfccTrip', delay: 120, duration: 3600, brief: 'The RFCC stops taking residue and off gas. LIC-007 swings to storage through E-1120; residue to tank gets hot. Keep TIC-111 below 95 °C, reduce charge if needed.' },
  { id: 'steam', title: 'LP steam failure (stripping lost)', start: 'BACH HO', fail: 'lpFail', delay: 120, duration: 900, brief: 'No stripping steam: kero/LGO flash points and residue <360 °C go off-spec. Route products to slops, reduce charge, and put them back once on-spec.' },
  { id: 'p1114', title: 'Stabilizer reflux pump P-1114 trip', start: 'BACH HO', fail: 'p1114Trip', delay: 120, brief: 'No reflux: T-1107 top heats up, C5 in LPG rises and D-1104 fills (UX-024 at 90 % cuts the reboiler). Start the spare pump.' },
  { id: 'hidden', title: 'Diagnose a hidden failure', start: 'BACH HO', hidden: true, delay: 300, brief: 'Something will go wrong within 5 minutes. No announcement. Use trends, KPIs and balances to find it.' }
];
const P0 = { lpP: 3.5, mpP: 10, hpP: 40, cwS: 32, fgH: 4.5 };
function baseP(r) {
  const F = r.F;
  return Object.assign({}, P0, {
    xBH: r.x, xCol: r.x, wC: 1, Fin: F, F, Fc: F, pass: new Array(8).fill(F / 8), Pd: 12, dp1: 1.2, dp2: 1.2, L1: 50, L2: 50, Fww: r.wash, Frec: r.wash, Fbrine: r.wash + 5,
    salt: 0.1, bsw: 0.06, Tcold: 137.7, Tdes: 137, Thot: 283, Ttrain: 210, Tin: 283, FG: 6.6, air: 130, O2: 2.8, Qabs: 79.4, Qfired: 88, eta: 0.9, COT: r.COT, Tfz: r.COT - 6,
    Tbot: r.COT - 9, Ttop: r.Ttop, P1103: 1.3, Ptop: 1.5, Pfz: 1.86, HCov: r.lpg + r.nap, dK: r.kero, dL: r.lgo, dH: r.hgo, Fkero: r.kero, Flgo: r.lgo, Fhgo: r.hgo,
    Lk: 50, Ll: 50, Lh: 50, Ld1: 50, Ld2: 50, Lbot: 50, FresProd: r.res, QkPA: 9, QlPA: 31, QhPA: 2, Qreb: 2.9, Qtpa: 21.9, Tk: 192, Tl: 254, Th: 334, TlP: 239, ThP: 320, TkP: 222,
    St1: 16, St2: r.steamL, St3: r.steamH, L1103: 50, Lw: 50, Fsf: r.nap + r.lpg * 0.9, zLPG: r.lpg / (r.nap + r.lpg), T1103: 50, Tst: 188, Ttst: 66, Fhp: 12, Vst: 17, Rst: 15, Flpg: r.lpgSP,
    L1104: 50, P1104: 7.6, Pst: 7.9, Lst: 40, Fnap: r.nap, FnapSto: 0, Pdry: -0.9, TresSto: 85, Ttw: 55, Tstack: 165, Tbw: 760, Tsh: 380, Fsh: 25, coke: 0, foulPre: 0,
    cutNK: r.grade ? CDU.GRADES[r.grade].cuts[0] : 165, cutKL: 205, cutLH: 330, cutHR: 370, OF: 2.5, Tair: 30, TresA: 180, TresB: 111, Qhot: 92, Qcold: 45, Cl: 5, pH: 6.2, corr: 0.2, wet: 0,
    Tkero: 40, Tlgo: 55, Thgo: 55, Tnap: 40, ppmW: 40, Pburn: 0.85, pilotP: 1, lab: {}, inst: {}, ok: {}, crude: CDU.crudeProps(r.x), psvD: 0, unc: 0, Qcap: 36
  });
}
CDU.initSteady = function (grade, keep) {
  const S = CDU.newState(grade), r = CDU.solveRecipe(grade), C = S.ctl;
  if (keep) S.speed = keep.speed;
  S.p = baseP(r);
  for (const t in CDU.NORMAL_SP) { C[t].sp = CDU.NORMAL_SP[t]; C[t].mode = 'AUTO'; }
  CDU.applyRecipe(S, grade);
  const OP = { 'FIC-069': 50.6, 'PIC-011': 54, 'FIC-004': 40.5, 'LIC-003': 46, 'LIC-006': 40, 'PDIC-503': 50, 'PDIC-506': 50, 'TDIC-007': 50, 'TDIC-015': 50, 'TIC-066': 47, 'AIC-063': 55,
    'TIC-076': 48, 'UIC-029': 45, 'UIC-032': 50, 'UIC-031': 45, 'UIC-033': 50, 'FQIC-033': 43, 'FQIC-020': 49, 'FQIC-024': 47, 'LIC-007': 58, 'FIC-051': 53, 'FIC-052': 51, 'FIC-053': 52,
    'LIC-011': 34, 'LIC-013': 43, 'LIC-016': 44, 'PIC-064': 38, 'LIC-038': 44, 'LIC-040': 45, 'TIC-060': 31, 'LIC-047': 30, 'FQIC-037': 31, 'PIC-068': 43, 'LIC-042': 33,
    'LIC-019': 43, 'LIC-022': 44, 'PIC-049': 50, 'TIC-111': 50 };
  for (const t in OP) C[t].op = OP[t];
  C['HIC-002'].op = r.bh;
  for (const t in C) C[t].pv = C[t].sp;
  CDU.advance(S, 4 * 3600);
  S.t = 0; S.alarms = []; S.journal = []; S.lab = []; S.hist = { t: [], d: {} }; S.histNext = 0; S.nextSample = 3600; S.sampleNo = 0; S.tons = { on: 0, off: 0, slop: 0 };
  for (const k in S.prodTons) S.prodTons[k] = { on: 0, off: 0, slop: 0 };
  S.alerts = []; S.psv = {}; S.trip = {};
  CDU.evalAlarms(S); S.alarms.forEach(a => a.acked = true);
  CDU.log(S, 'INSTRUCTOR', 'Initialised at steady state — case ' + grade);
  return S;
};
CDU.startExercise = function (ex, prev) {
  const S = CDU.initSteady(ex.start, prev);
  S.exercise = { id: ex.id, title: ex.title, hidden: !!ex.hidden, t0: 0 };
  if (ex.fail) { S.sched.push({ t: ex.delay || 120, fail: ex.fail }); if (ex.duration) S.sched.push({ t: (ex.delay || 120) + ex.duration, fail: ex.fail, on: false }); }
  if (ex.hidden) { const opts = ['passStuck', 'lic038Frozen', 'tic076Frozen', 'lic003Fail']; S.sched.push({ t: ex.delay, fail: opts[Math.floor(Math.random() * opts.length)] }); }
  if (ex.target) S.target = ex.target;
  S.session = { mode: ex.fail || ex.hidden ? 'drill' : 'exercise', title: ex.title, brief: ex.brief };
  CDU.log(S, 'INSTRUCTOR', 'Exercise started: ' + ex.title);
  return S;
};

/* ---- cold plant: unit empty, inerted, all equipment stopped, ambient temperature ---- */
CDU.initCold = function (grade, keep) {
  const S = CDU.newState(grade), C = S.ctl, r = CDU.solveRecipe(grade);
  if (keep) S.speed = keep.speed;
  S.p = baseP(r);
  for (const k in S.eq) S.eq[k] = false;
  for (const t in C) { C[t].mode = 'MAN'; C[t].op = 0; C[t].sp = 0; C[t].e1 = C[t].e2 = 0; }
  C['HIC-002'].op = r.bh;
  C['PIC-064'].op = 40; C['PIC-068'].op = 40;
  S.circ = 'NORMAL'; S.feedSrc = 'FLUSH';
  for (const k in S.route) S.route[k] = 'SLOPS';
  const T = 25;
  Object.assign(S.p, { wC: 0, Fin: 0, F: 0, Fc: 0, pass: new Array(8).fill(0), Pd: 0, dp1: 0, dp2: 0, L1: 50, L2: 50, Fww: 0, Frec: 0, Fbrine: 0, salt: 0, bsw: 0,
    Tcold: T, Tdes: T, Thot: T, Ttrain: T, Tin: T, FG: 0, air: 0, O2: 20.9, Qabs: 0, Qfired: 0, COT: T, Tfz: T, Tbot: T, Ttop: T, P1103: 0.1, Ptop: 0.1, Pfz: 0.1,
    HCov: 0, dK: 0, dL: 0, dH: 0, Fkero: 0, Flgo: 0, Fhgo: 0, Lk: 0, Ll: 0, Lh: 0, Ld1: 0, Ld2: 0, Lbot: 0, FresProd: 0, QkPA: 0, QlPA: 0, QhPA: 0, Qreb: 0, Qtpa: 0,
    Tk: T, Tl: T, Th: T, TlP: T, ThP: T, TkP: T, St1: 0, St2: 0, St3: 0, L1103: 0, Lw: 0, Fsf: 0, zLPG: 0.02, T1103: T, Tst: T, Ttst: T, Fhp: 0, Vst: 0, Rst: 0, Flpg: 0,
    L1104: 0, P1104: 0.5, Pst: 0.8, Lst: 0, Fnap: 0, FnapSto: 0, Pdry: 0, TresSto: T, Ttw: T, Tstack: T, Tbw: T, Tsh: T, Fsh: 0, OF: 0, TresA: T, TresB: T, Qhot: 0, Qcold: 0,
    Cl: 0, pH: 7, corr: 0, Tkero: T, Tlgo: T, Thgo: T, Tnap: T, Pburn: 0, pilotP: 0, cutNK: 0, lab: {}, inst: {} });
  CDU.advance(S, 5);
  S.t = 0; S.alarms = []; S.journal = []; S.lab = []; S.hist = { t: [], d: {} }; S.histNext = 0; S.nextSample = 3600; S.sampleNo = 0; S.tons = { on: 0, off: 0, slop: 0 };
  for (const k in S.prodTons) S.prodTons[k] = { on: 0, off: 0, slop: 0 };
  S.alerts = []; S.psv = {}; S.trip = {};
  CDU.evalAlarms(S); S.alarms.forEach(a => a.acked = true);
  CDU.log(S, 'INSTRUCTOR', 'Initialised COLD — unit purged and inerted, empty, all equipment stopped at 25 °C (target ' + grade + ')');
  return S;
};

/* ---- start-up / shutdown procedure tracker (book §8.2 / §8.3, Fig. p.250-254) ----
   Steps latch in order: a step is ticked the first time its check is true after the previous step. */
const RC = (S) => CDU.solveRecipe(S.target), auto = (S, t) => S.ctl[t].mode === 'AUTO';
const allRoutes = (S, v) => Object.values(S.route).every(x => x === v);
CDU.PROCS = {
  startup: { title: 'Full unit start-up from cold', steps: [
    ['Line up: desalters BYPASSED (HS-001), all products to SLOPS, charge source SR FLUSHING OIL (HS-003)', 'preheat', S => !S.eq.DSAL && allRoutes(S, 'SLOPS') && S.feedSrc === 'FLUSH'],
    ['Charge T-1101: start P-6001, PIC-011 AUTO 12 kg/cm²g, start P-1101, open FIC-069 — fill T-1101 bottoms to ≥ 50 %', 'preheat', S => S.p.Lbot >= 50],
    ['Short-path circulation: start P-1106, HS-100 → SHORT, stop P-1101 and P-6001; FIC-069 AUTO ≈ 400 t/h', 'heater', S => S.circ === 'SHORT' && S.eq.P1106 && !S.eq.P1101 && !S.eq.P6001 && auto(S, 'FIC-069') && S.p.F >= 350],
    ['LP steam through the superheater coil SL-1101; start FD fan B-1101 and purge the firebox for 5 min', 'heater', S => S.eq.SHSTM && S.eq.B1101 && (S.sis.purge >= 300 || S.eq.PILOT)],
    ['Light the pilots, then the main burners (TIC-066 MAN, OP ≤ 10 %); AIC-063 AUTO 3 % O2; heat the COT to 100 °C', 'heater', S => S.eq.BURN && S.p.COT >= 100 && auto(S, 'AIC-063')],
    ['Long-path circulation (HS-100 LONG) until the preheat train is at ≈ 100 °C, then back to SHORT path', 'heater', S => S.p.Ttrain >= 90 && S.circ === 'SHORT'],
    ['TIC-066 AUTO; raise the COT to 250–270 °C (never above 270 °C before crude)', 'heater', S => auto(S, 'TIC-066') && S.p.COT >= 250 && S.p.COT <= 275],
    ['Start tempered water P-1122 (TIC-111 AUTO 85 °C) and the pumparounds P-1102, P-1103, P-1104, P-1105 (+ E-1112 fans)', 'fract', S => S.eq.P1122 && auto(S, 'TIC-111') && S.eq.P1102 && S.eq.P1103 && S.eq.P1104 && S.eq.P1105 && S.eq.E1112],
    ['Before crude: start E-1111 fans, PIC-064 AUTO 1.3 kg/cm²g (fuel-gas padding), LIC-038 and LIC-040 AUTO, TIC-076 AUTO', 'overhead', S => S.eq.E1111 && auto(S, 'PIC-064') && auto(S, 'LIC-038') && auto(S, 'LIC-040') && auto(S, 'TIC-076')],
    ['Crude in at minimum rate: HS-003 CRUDE, start P-6001 (PIC-011 AUTO 12), start P-1101, HS-100 → NORMAL; FIC-069 400–500 t/h; LIC-007 AUTO; branch balancing TDIC-007 / TDIC-015 AUTO 0 °C', 'preheat', S => S.circ === 'NORMAL' && S.feedSrc === 'CRUDE' && S.p.F >= 380 && auto(S, 'PIC-011') && auto(S, 'LIC-007') && auto(S, 'TDIC-007') && auto(S, 'TDIC-015')],
    ['Commission the desalters: HS-001 IN SERVICE, transformers ON, P-1119 + FIC-004, P-1118, LIC-003/006 AUTO, demulsifier and neutralizer ON', 'preheat', S => S.eq.DSAL && S.eq.XFMR && S.eq.P1119 && S.eq.P1118 && S.eq.DEMUL && S.eq.NEUT && auto(S, 'LIC-003') && auto(S, 'LIC-006') && auto(S, 'FIC-004')],
    ['Raise the COT to the recipe (± 4 °C); stripping steam FIC-051/052/053 AUTO once T-1101 bottom is above 300 °C', 'heater', S => Math.abs(S.p.COT - RC(S).COT) <= 4 && auto(S, 'FIC-051') && auto(S, 'FIC-052') && auto(S, 'FIC-053') && S.p.St1 > 8],
    ['Side draws: P-1107, P-1112, P-1113 on; FQIC-033/020/024 AUTO; LIC-011/013/016 and LIC-019/022 AUTO; ejectors A-1102 ON, PIC-049 AUTO', 'fract', S => S.eq.P1107 && S.eq.P1112 && S.eq.P1113 && ['FQIC-033', 'FQIC-020', 'FQIC-024', 'LIC-011', 'LIC-013', 'LIC-016', 'LIC-019', 'LIC-022', 'PIC-049'].every(t => auto(S, t)) && S.eq.EJ],
    ['Stabilizer: P-1110 feed on D-1103 level; TIC-060 AUTO 188 °C; P-1114 + LIC-047 AUTO; P-1115 + FQIC-037; PIC-068 AUTO 7.6; LIC-042 AUTO', 'overhead', S => S.eq.P1110 && S.eq.P1114 && S.eq.P1115 && ['TIC-060', 'LIC-047', 'FQIC-037', 'PIC-068', 'LIC-042'].every(t => auto(S, t)) && S.p.Tst > 175],
    ['All products on spec → route naphtha, kero, LGO, HGO and residue to PRODUCT', 'quality', S => allRoutes(S, 'PRODUCT') && S.p.allOk],
    ['Ramp the charge to design (≥ 790 t/h) with all products on spec', 'preheat', S => S.p.F >= 790 && S.p.allOk && allRoutes(S, 'PRODUCT')]
  ] },
  shutdown: { title: 'Controlled unit shutdown', steps: [
    ['Reduce the crude rate to ≈ 60 % (FIC-069 ≤ 500 t/h)', 'preheat', S => S.p.F <= 510],
    ['Reduce the heater firing: COT ≤ 300 °C', 'heater', S => S.p.COT <= 300],
    ['Route all product streams back to SLOPS / crude tankage', 'quality', S => allRoutes(S, 'SLOPS')],
    ['Shut down the heater H-1101: main burners and pilots OFF', 'heater', S => !S.eq.BURN && !S.eq.PILOT],
    ['Stop stripping steam to T-1101 / T-1103 / T-1104 (FIC-051/052/053 OP 0 %) and the ejector steam', 'fract', S => S.p.St1 + S.p.St2 + S.p.St3 < 0.3 && !S.eq.EJ],
    ['Stop the desalter wash water P-1119, recycle P-1118 and transformers; chemicals OFF', 'preheat', S => !S.eq.P1119 && !S.eq.P1118 && !S.eq.XFMR && !S.eq.DEMUL && !S.eq.NEUT],
    ['Stop HP steam to the stabilizer reboiler (TIC-060 MAN, OP 0 %)', 'overhead', S => S.p.Fhp < 0.3],
    ['Hold the unit pressure with fuel gas while cooling: PIC-064 AUTO, D-1103 ≥ 1.0 kg/cm²g', 'overhead', S => auto(S, 'PIC-064') && S.p.P1103 >= 1.0],
    ['Cut the crude feed: stop P-6001 and P-1101', 'preheat', S => !S.eq.P6001 && !S.eq.P1101],
    ['Stop the pumparounds P-1102…P-1105 and the stabilizer reflux P-1114', 'fract', S => !S.eq.P1102 && !S.eq.P1103 && !S.eq.P1104 && !S.eq.P1105 && !S.eq.P1114],
    ['Pump out the liquid inventories to slops: T-1101 bottoms, D-1103 and T-1107 below 10 %', 'fract', S => S.p.Lbot < 10 && S.p.L1103 < 10 && S.p.Lst < 10],
    ['Stop all remaining pumps, FD fan B-1101 and the air coolers — unit shut down', 'fract', S => ['P1106', 'P1107', 'P1110', 'P1112', 'P1113', 'P1115', 'P1122', 'B1101', 'E1111', 'E1112'].every(k => !S.eq[k])]
  ] }
};
CDU.procEval = function (S) {
  const pr = S.proc; if (!pr || pr.complete != null) return;
  const steps = CDU.PROCS[pr.id].steps;
  while (pr.i < steps.length) {
    let ok = false; try { ok = !!steps[pr.i][2](S); } catch (e) { ok = false; }
    if (!ok) break;
    pr.done[pr.i] = S.t; CDU.log(S, 'PROCEDURE', 'Step ' + (pr.i + 1) + ' done: ' + steps[pr.i][0]); pr.i++;
  }
  if (pr.i >= steps.length) {
    pr.complete = S.t; pr.trips = S.journal.filter(j => j.src === 'SIS' && /TRIP|LIFTED|UX-0/.test(j.msg) && !/BYPASSED|RESET|reseated/.test(j.msg)).length;
    CDU.log(S, 'PROCEDURE', CDU.PROCS[pr.id].title + ' COMPLETE in ' + fmtT(S.t - pr.t0) + ' · off-spec ' + S.tons.off.toFixed(0) + ' t · slops ' + S.tons.slop.toFixed(0) + ' t · SIS events ' + pr.trips + ' · ' + (pr.easyUsed || S.level !== 'hard' ? 'EASY (recipe hints used)' : 'HARD mode'));
  }
};
CDU.startSession = function (c, prev) {
  let S;
  if (c.mode === 'steady') { S = CDU.initSteady(c.grade, prev); S.session = { mode: 'steady', title: 'Normal operation — steady state ' + c.grade, brief: 'Unit lined out at design charge (810 t/h). Free practice — no upset planned.' }; }
  else if (c.mode === 'startup') {
    S = CDU.initCold(c.grade, prev);
    S.session = { mode: 'startup', title: 'Full unit start-up from cold — ' + c.grade, brief: 'Unit empty, inerted, all equipment stopped at 25 °C. Charge flushing oil, circulate, fire the heater, introduce crude and bring the unit to design rate and on-spec. Follow the step tracker (manual §8).' };
    S.proc = { id: 'startup', i: 0, done: [], t0: 0, complete: null };
  } else if (c.mode === 'shutdown') {
    S = CDU.initSteady(c.grade, prev);
    S.session = { mode: 'shutdown', title: 'Controlled unit shutdown — ' + c.grade, brief: 'Unit at steady state. Bring it down safely to an empty, cold, pressurised condition. Follow the step tracker (manual §9).' };
    S.proc = { id: 'shutdown', i: 0, done: [], t0: 0, complete: null };
  } else return prev;
  CDU.log(S, 'INSTRUCTOR', 'Session started: ' + S.session.title);
  return S;
};

/* ---------------- 5. SHARED-STATE RUNTIME ----------------
   Every page runs the same simulation. One page (the "leader") integrates the model and
   saves state to localStorage (+ window.name as same-tab fallback); other open pages follow
   and send their operator actions through a command queue.                           */
const KEY = 'cdusim.state', LKEY = 'cdusim.leader', QKEY = 'cdusim.cmdq', SNAP = 'cdusim.snap';
const rt = CDU.rt = { id: Math.random().toString(36).slice(2), leader: false, S: null, last: Date.now(), lastSave: 0, lastLoad: 0, ls: true, listeners: [] };
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { rt.ls = false; return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { rt.ls = false; return false; } }
function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function loadState() {
  let a = parse(lsGet(KEY)), b = null;
  if (typeof window.name === 'string' && window.name.startsWith('CDUSIM:')) b = parse(window.name.slice(7));
  let S = a; if (b && (!a || (b.savedAt || 0) > (a.savedAt || 0))) S = b;
  if (S && S.v === 1 && S.p && S.p.pass) return CDU.upgradeState(S);
  return null;
}
function saveState() {
  const S = rt.S; if (!S) return; S.savedAt = Date.now();
  const j = JSON.stringify(S); lsSet(KEY, j);
  try { window.name = 'CDUSIM:' + j; } catch (e) { }
  rt.lastSave = Date.now();
}
CDU.save = saveState;
function becomeLeader() {
  rt.leader = true;
  let S = loadState();
  if (!S) { S = CDU.initSteady('BACH HO'); }
  else if (!S.frozen && S.savedAt) { const real = Math.max(0, (Date.now() - S.savedAt) / 1000); CDU.advance(S, Math.min(real * S.speed, 7200)); }
  rt.S = S; rt.last = Date.now(); saveState();
}
// code version: a tab running newer simulator code always takes over from a tab with older code
CDU.CODE_VER = 100;
function heartbeat() { lsSet(LKEY, JSON.stringify({ id: rt.id, ts: Date.now(), ver: CDU.CODE_VER })); }
function drainQueue() {
  const q = parse(lsGet(QKEY)); if (!q || !q.length) return; lsSet(QKEY, '[]');
  for (const c of q) runCmd(c);
}
function runCmd(c) {
  const S = rt.S, lvl = c.level || (S && S.level) || 'easy';
  runCmd0(c, S);
  // a new plant (session, exercise, re-init, snapshot) keeps the chosen difficulty
  if (rt.S && rt.S !== S) {
    rt.S.level = lvl === 'hard' ? 'hard' : 'easy';
    if (rt.S.proc) rt.S.proc.easyUsed = rt.S.level !== 'hard';
    if (c.level) CDU.log(rt.S, 'INSTRUCTOR', 'Difficulty: ' + rt.S.level.toUpperCase());
  }
}
function runCmd0(c, S) {
  if (c.type === 'reinit') { rt.S = CDU.initSteady(c.grade, S); rt.S.session = { mode: 'steady', title: 'Normal operation — steady state ' + c.grade, brief: '' }; CDU.log(rt.S, 'INSTRUCTOR', 'Re-initialised (grade ' + c.grade + ')'); return; }
  if (c.type === 'session') { rt.S = CDU.startSession(c, S); return; }
  if (c.type === 'exercise') { const ex = CDU.EXERCISES.find(e => e.id === c.id); if (ex) rt.S = CDU.startExercise(ex, S); return; }
  if (c.type === 'snapSave') { const j = JSON.stringify(S); lsSet(SNAP, j); CDU.log(S, 'INSTRUCTOR', 'Snapshot saved at ' + fmtT(S.t)); return; }
  if (c.type === 'snapRestore') { const s = parse(lsGet(SNAP)); if (s) { rt.S = s; CDU.log(s, 'INSTRUCTOR', 'Snapshot restored'); } return; }
  CDU.exec(S, c);
}
CDU.cmd = function (c) {
  if (rt.leader || !rt.ls) { runCmd(c); saveState(); CDU.render(); }
  else { const q = parse(lsGet(QKEY)) || []; q.push(c); lsSet(QKEY, JSON.stringify(q)); }
};
function tick() {
  const now = Date.now();
  if (!rt.leader) {
    const L = parse(lsGet(LKEY));
    rt.outdated = !!(L && (L.ver || 0) > CDU.CODE_VER);   // another tab runs newer code → this one should be reloaded
    if (!rt.ls || !L || now - L.ts > 1500 || L.id === rt.id || (L.ver || 0) < CDU.CODE_VER) becomeLeader();
  }
  if (rt.leader) {
    const L = parse(lsGet(LKEY));
    if (rt.ls && L && L.id !== rt.id && now - L.ts < 1500 && L.ts > rt.lastBeat && (L.ver || 0) >= CDU.CODE_VER) { rt.leader = false; }   // another tab took over
  }
  if (rt.leader) {
    heartbeat(); rt.lastBeat = Date.now(); rt.outdated = false; drainQueue();
    const S = rt.S, real = Math.min(1, (now - rt.last) / 1000);
    if (!S.frozen) {
      CDU.advance(S, real * S.speed);
    }
    if (now - rt.lastSave > 1000) saveState();
  } else if (now - rt.lastLoad > 500) { const S = loadState(); if (S) rt.S = S; rt.lastLoad = now; }
  rt.last = now;
  CDU.render();
}
CDU.render = function () { for (const f of rt.listeners) { try { f(rt.S); } catch (e) { console.error(e); } } };
CDU.onRender = (f) => rt.listeners.push(f);
CDU.start = function () {
  becomeLeaderOrFollow();
  setInterval(tick, 250);
  window.addEventListener('pagehide', () => { if (rt.leader) { saveState(); lsSet(LKEY, JSON.stringify({ id: '', ts: 0 })); } });
};
function becomeLeaderOrFollow() {
  const L = parse(lsGet(LKEY));
  if (!rt.ls || !L || Date.now() - L.ts > 1500) becomeLeader();
  else { rt.S = loadState() || CDU.initSteady('BACH HO'); }
  if (rt.leader) heartbeat();
  rt.lastBeat = Date.now();
  CDU.render();
}
})(window);
