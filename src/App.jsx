import { useState, useEffect } from "react";

// =============================================================================
// CONFIGURACION — cambia el numero de telefono del fisio aqui
// =============================================================================
const FISIO_PHONE = "34600000000"; // Sin + ni espacios. Ejemplo: 34612345678

// =============================================================================
// CONSTANTES
// =============================================================================
const APT_TYPES = {
  fisio: {
    label: "Fisio",
    color: "#2563eb",
    light: "#dbeafe",
    emoji: "💆",
    desc: "Sesión de fisioterapia · 50 min",
  },
  nesa: {
    label: "Nesa",
    color: "#16a34a",
    light: "#dcfce7",
    emoji: "⚡",
    desc: "Sesión con máquina Nesa · 50 min",
  },
  combinada: {
    label: "Combinada",
    color: "#7c3aed",
    light: "#ede9fe",
    emoji: "✨",
    desc: "30 min Fisio + 20 min Nesa",
  },
};

const DAYS_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DAYS_LONG  = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MONTHS     = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const SLOT_H     = 28; // px por cada bloque de 10 min en la línea de tiempo

// =============================================================================
// UTILIDADES
// =============================================================================
function toMin(t) {
  if (!t || typeof t !== "string" || !t.includes(":")) return 0;
  var parts = t.split(":");
  var h = parseInt(parts[0], 10) || 0;
  var m = parseInt(parts[1], 10) || 0;
  return h * 60 + m;
}

function toTime(m) {
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function dateKey(d) {
  if (d instanceof Date) {
    // Usar fecha local, no UTC, para evitar desfases de zona horaria
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  return d;
}

function todayKey() {
  return dateKey(new Date());
}

function parseD(dk) {
  return new Date(dk + "T12:00:00");
}

// crypto.randomUUID() garantiza unicidad entre pestanas y sesiones.
// Fallback para entornos sin crypto (HTTP no seguro, tests).
function uid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random suficientemente largo
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function fmtDate(dk) {
  if (!dk) return "";
  const d = parseD(dk);
  if (isNaN(d.getTime())) return dk;
  return DAYS_LONG[d.getDay()] + " " + d.getDate() + " de " + MONTHS[d.getMonth()];
}

// =============================================================================
// DURACIONES — valores por defecto y lectura desde configuracion
// =============================================================================
var DEFAULT_DURATIONS = { fisio: 50, nesa: 50, combinadaFisio: 30, combinadaNesa: 20 };

function getDurations(durations) {
  var d = durations || {};
  return {
    fisio:          parseInt(d.fisio, 10)          || DEFAULT_DURATIONS.fisio,
    nesa:           parseInt(d.nesa, 10)           || DEFAULT_DURATIONS.nesa,
    combinadaFisio: parseInt(d.combinadaFisio, 10) || DEFAULT_DURATIONS.combinadaFisio,
    combinadaNesa:  parseInt(d.combinadaNesa, 10)  || DEFAULT_DURATIONS.combinadaNesa,
  };
}

// =============================================================================
// LIMPIEZA DE DUPLICADOS
// =============================================================================
function deduplicateApts(apts) {
  var seen = {};
  return apts.filter(function(a) {
    // Clave de unicidad: fecha + hora + tipo + nombre normalizado
    var key = (a.date || "") + "|" + (a.time || "") + "|" + (a.type || "") + "|" + (a.patient || "").toLowerCase().trim();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

// =============================================================================
// LOGICA DE CONFLICTOS
// =============================================================================
function hasConflict(dayApts, timeStr, type) {
  const s = toMin(timeStr);

  function fisioBusy(a, b) {
    return dayApts.some(function(x) {
      if (x.status === "cancelled") return false;
      if (x.type === "fisio") {
        const s2 = toMin(x.time);
        return a < s2 + 50 && b > s2;
      }
      if (x.type === "combinada") {
        const s2 = toMin(x.time);
        return a < s2 + 30 && b > s2;
      }
      return false;
    });
  }

  function nesaBusy(a, b) {
    return dayApts.some(function(x) {
      if (x.status === "cancelled") return false;
      if (x.type === "nesa") {
        const s2 = toMin(x.time);
        return a < s2 + 50 && b > s2;
      }
      if (x.type === "combinada") {
        const s2 = toMin(x.time) + 30;
        return a < s2 + 20 && b > s2;
      }
      return false;
    });
  }

  if (type === "fisio") {
    return fisioBusy(s, s + 50) ? "El fisio no está disponible a esa hora." : null;
  }
  if (type === "nesa") {
    return nesaBusy(s, s + 50) ? "La Nesa no está disponible a esa hora." : null;
  }
  if (type === "combinada") {
    if (fisioBusy(s, s + 30)) return "El fisio no está libre los primeros 30 min.";
    if (nesaBusy(s + 30, s + 50)) return "La Nesa no está libre los últimos 20 min.";
  }
  return null;
}

// =============================================================================
// SLOTS DISPONIBLES - intervalos de 50 en 50 minutos
// Dentro de cada hueco libre ofrece: inicio del hueco, fin del hueco - 50,
// y todos los multiplos de 50 entre medias. Asi nunca se pierde ningun slot.
// Cache ligero: la clave combina dk+tipo+nCitas para invalidar cuando cambia el estado
// =============================================================================
var _slotsCache = {};
var _slotsCacheKey = "";

function getSlots(dk, schedule, appointments, type) {
  // Clave de cache: dk + type + fingerprint de citas activas (time+type) + nFranjas
  // Usar time+type evita falsos hits cuando una cita cambia de hora pero el count no varía
  var activeDayApts = appointments.filter(function(a) {
    return a.date === dk && a.status !== "cancelled";
  });
  var aptFingerprint = activeDayApts
    .map(function(a) { return a.time + ":" + a.type; })
    .sort()
    .join(",");
  var schedFingerprint = (schedule[dk] || [])
    .map(function(s) { return s.start + "-" + s.end; })
    .join(",");
  var cacheKey = dk + "|" + type + "|" + aptFingerprint + "|" + schedFingerprint;
  if (_slotsCache[cacheKey] !== undefined) return _slotsCache[cacheKey];
  // Normalizar franjas: eliminar inicio>=fin y fusionar solapamientos antes de calcular
  var rawSlots = schedule[dk] || [];
  var slots    = normalizeScheduleDay(rawSlots);
  var dayApts  = appointments.filter(function(a) { return a.date === dk; });

  // Construir bloques de ocupacion por recurso
  var fisioBlocks = [];
  var nesaBlocks  = [];
  dayApts.forEach(function(a) {
    if (a.status === "cancelled") return;
    var t = toMin(a.time);
    if (a.type === "fisio")     { fisioBlocks.push({ start: t,      end: t + 50 }); }
    if (a.type === "nesa")      { nesaBlocks.push({  start: t,      end: t + 50 }); }
    if (a.type === "combinada") {
      fisioBlocks.push({ start: t,      end: t + 30 });
      nesaBlocks.push({  start: t + 30, end: t + 50 });
    }
  });

  // Dado un array de bloques ocupados y el horario, devuelve los huecos libres
  // como array de {start, end} en minutos
  function getFreeGaps(blocks, slotStart, slotEnd) {
    // Ordenar bloques por inicio
    var sorted = blocks.filter(function(b) {
      return b.end > slotStart && b.start < slotEnd;
    }).map(function(b) {
      return { start: Math.max(b.start, slotStart), end: Math.min(b.end, slotEnd) };
    });
    sorted.sort(function(a, b) { return a.start - b.start; });

    var gaps = [];
    var cursor = slotStart;
    sorted.forEach(function(b) {
      if (b.start > cursor) gaps.push({ start: cursor, end: b.start });
      if (b.end > cursor) cursor = b.end;
    });
    if (cursor < slotEnd) gaps.push({ start: cursor, end: slotEnd });
    return gaps;
  }

  // Para un conjunto de bloques ocupados, devuelve todos los starts validos
  // de citas de duracion=dur dentro del horario
  function validStarts(blocks, dur) {
    var out = [];
    var seen = {};
    slots.forEach(function(slot) {
      var slotStart = toMin(slot.start);
      var slotEnd   = toMin(slot.end);
      var gaps = getFreeGaps(blocks, slotStart, slotEnd);
      gaps.forEach(function(gap) {
        if (gap.end - gap.start < dur) return; // hueco demasiado pequeno
        // Opcion 1: empezar al inicio del hueco
        // Opcion 2: terminar al final del hueco (inicio = gap.end - dur)
        // Opcion 3: todos los multiplos de 50 entre medias
        var candidates = [];
        var t = gap.start;
        while (t + dur <= gap.end) {
          candidates.push(t);
          t += 50;
        }
        // Tambien el inicio del hueco y final - dur si no estan ya
        candidates.push(gap.start);
        if (gap.end - dur >= gap.start) candidates.push(gap.end - dur);

        candidates.forEach(function(c) {
          if (c >= gap.start && c + dur <= gap.end && !seen[c]) {
            seen[c] = true;
            out.push(c);
          }
        });
      });
    });
    out.sort(function(a,b){return a-b;});
    return out;
  }

  var out = [];

  if (type === "fisio") {
    validStarts(fisioBlocks, 50).forEach(function(m) { out.push(toTime(m)); });
  }

  if (type === "nesa") {
    validStarts(nesaBlocks, 50).forEach(function(m) { out.push(toTime(m)); });
  }

  if (type === "combinada") {
    // Necesita fisio libre t->t+30 Y nesa libre t+30->t+50
    var candidates = [];
    slots.forEach(function(slot) {
      var slotStart = toMin(slot.start);
      var slotEnd   = toMin(slot.end);

      // Candidatos: cada 50 min desde el inicio de la franja
      var cur = slotStart;
      while (cur + 50 <= slotEnd) {
        candidates.push(cur);
        cur += 50;
      }

      // Tambien desde el fin de cada bloque (para aprovechar huecos intermedios)
      fisioBlocks.concat(nesaBlocks).forEach(function(b) {
        if (b.end > slotStart && b.end < slotEnd) candidates.push(b.end);
        var alt = b.end - 30;
        if (alt > slotStart && alt < slotEnd) candidates.push(alt);
        // Tambien el final del hueco menos 50
        if (slotEnd - 50 > slotStart) candidates.push(slotEnd - 50);
      });
    });

    // Filtrar: fisio libre t->t+30, nesa libre t+30->t+50, cabe en horario
    var seen2 = {};
    candidates.forEach(function(t) {
      if (seen2[t]) return;
      seen2[t] = true;
      // Verificar que cabe en alguna franja del horario
      var fitsInSchedule = slots.some(function(slot) {
        return t >= toMin(slot.start) && t + 50 <= toMin(slot.end);
      });
      if (!fitsInSchedule) return;
      var fisioOk = !fisioBlocks.some(function(b){ return t < b.end && t+30 > b.start; });
      var nesaOk  = !nesaBlocks.some( function(b){ return t+30 < b.end && t+50 > b.start; });
      if (fisioOk && nesaOk) out.push(toTime(t));
    });
    out.sort();
  }

  _slotsCache[cacheKey] = out;
  // Limpiar cache si crece demasiado (mas de 200 entradas)
  if (Object.keys(_slotsCache).length > 200) { _slotsCache = {}; }
  return out;
}

function nextAvailable(fromDk, type, schedule, appointments) {
  for (let i = 0; i < 30; i++) {
    const d = parseD(fromDk);
    d.setDate(d.getDate() + i);
    const dk = dateKey(d);
    const s  = getSlots(dk, schedule, appointments, type);
    if (s.length > 0) return { dk: dk, time: s[0] };
  }
  return null;
}

// =============================================================================
// ALMACENAMIENTO LOCAL
// =============================================================================
const LS = {
  get: function(k, fb) {
    try {
      var v = localStorage.getItem(k);
      if (!v) return fb;
      var parsed = JSON.parse(v);
      // Validacion basica de tipo: si el fallback es array, el valor debe ser array
      if (Array.isArray(fb) && !Array.isArray(parsed)) return fb;
      if (!Array.isArray(fb) && typeof fb === "object" && (typeof parsed !== "object" || Array.isArray(parsed))) return fb;
      return parsed;
    } catch(e) {
      return fb;
    }
  },
  set: function(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {}
  },
};

// =============================================================================
// NORMALIZACION DE HORARIO — evita franjas invalidas y solapamientos
// =============================================================================
function normalizeScheduleDay(slots) {
  if (!Array.isArray(slots)) return [];
  // 1. Filtrar franjas donde inicio >= fin
  var valid = slots.filter(function(s) {
    return s && s.start && s.end && toMin(s.start) < toMin(s.end);
  });
  if (valid.length === 0) return [];
  // 2. Ordenar por inicio
  valid.sort(function(a, b) { return toMin(a.start) - toMin(b.start); });
  // 3. Fusionar solapamientos
  var merged = [Object.assign({}, valid[0])];
  for (var i = 1; i < valid.length; i++) {
    var last = merged[merged.length - 1];
    var cur  = valid[i];
    if (toMin(cur.start) < toMin(last.end)) {
      // Solape: extender el fin si el actual termina despues
      if (toMin(cur.end) > toMin(last.end)) {
        last.end = cur.end;
      }
      // Si termina antes, se absorbe — no añadir
    } else {
      merged.push(Object.assign({}, cur));
    }
  }
  return merged;
}

// =============================================================================
// WHATSAPP
// =============================================================================
// Prefijos de paises mas comunes
var COUNTRY_PREFIXES = [
  { code: "ES", prefix: "34",  flag: "🇪🇸", name: "España" },
  { code: "AD", prefix: "376", flag: "🇦🇩", name: "Andorra" },
  { code: "FR", prefix: "33",  flag: "🇫🇷", name: "Francia" },
  { code: "PT", prefix: "351", flag: "🇵🇹", name: "Portugal" },
  { code: "DE", prefix: "49",  flag: "🇩🇪", name: "Alemania" },
  { code: "IT", prefix: "39",  flag: "🇮🇹", name: "Italia" },
  { code: "GB", prefix: "44",  flag: "🇬🇧", name: "Reino Unido" },
  { code: "BE", prefix: "32",  flag: "🇧🇪", name: "Bélgica" },
  { code: "NL", prefix: "31",  flag: "🇳🇱", name: "Países Bajos" },
  { code: "CH", prefix: "41",  flag: "🇨🇭", name: "Suiza" },
  { code: "AR", prefix: "54",  flag: "🇦🇷", name: "Argentina" },
  { code: "MX", prefix: "52",  flag: "🇲🇽", name: "México" },
  { code: "CO", prefix: "57",  flag: "🇨🇴", name: "Colombia" },
  { code: "VE", prefix: "58",  flag: "🇻🇪", name: "Venezuela" },
  { code: "US", prefix: "1",   flag: "🇺🇸", name: "EEUU/Canadá" },
  { code: "MA", prefix: "212", flag: "🇲🇦", name: "Marruecos" },
  { code: "DZ", prefix: "213", flag: "🇩🇿", name: "Argelia" },
  { code: "RO", prefix: "40",  flag: "🇷🇴", name: "Rumanía" },
  { code: "UA", prefix: "380", flag: "🇺🇦", name: "Ucrania" },
  { code: "RU", prefix: "7",   flag: "🇷🇺", name: "Rusia" },
  { code: "CN", prefix: "86",  flag: "🇨🇳", name: "China" },
];

function isValidPhone(phone) {
  var digits = phone.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 15;
}

// Componente selector de telefono con prefijo de pais
function PhoneInput({ prefix, setPrefix, number, setNumber, label }) {
  return (
    <div>
      {label && <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</label>}
      <div style={{ display: "flex", gap: 8 }}>
        <select
          value={prefix}
          onChange={function(e) { setPrefix(e.target.value); }}
          style={{ background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 12, padding: "11px 8px", fontSize: 14, color: "#1e293b", flexShrink: 0, maxWidth: 120 }}>
          {COUNTRY_PREFIXES.map(function(c) {
            return <option key={c.code} value={c.prefix}>{c.flag} +{c.prefix}</option>;
          })}
        </select>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 12, padding: "11px 14px" }}>
          <input
            type="tel"
            placeholder="600000000"
            value={number}
            onChange={function(e) { setNumber(e.target.value.replace(/[^0-9]/g, "")); }}
            style={{ border: "none", background: "transparent", flex: 1, fontSize: 16, color: "#1e293b", width: "100%" }} />
        </div>
      </div>
      {number && !isValidPhone(number) && (
        <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>Introduce un número válido</div>
      )}
    </div>
  );
}

function buildPhone(prefix, number) {
  return prefix + number.replace(/[^0-9]/g, "");
}

function waLink(phone, msg) {
  const clean = phone.replace(/\D/g, "");
  return "https://wa.me/" + clean + "?text=" + encodeURIComponent(msg);
}

// =============================================================================
// ICONOS SVG
// =============================================================================
function Ic({ n, s, c }) {
  s = s || 20;
  c = c || "currentColor";

  const paths = {
    plus:    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />,
    x:       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />,
    left:    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />,
    right:   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />,
    cal:     <>
               <rect x="3" y="4" width="18" height="18" rx="2" strokeWidth={2} />
               <line x1="16" y1="2" x2="16" y2="6" strokeWidth={2} strokeLinecap="round" />
               <line x1="8" y1="2" x2="8" y2="6" strokeWidth={2} strokeLinecap="round" />
               <line x1="3" y1="10" x2="21" y2="10" strokeWidth={2} strokeLinecap="round" />
             </>,
    clock:   <>
               <circle cx="12" cy="12" r="10" strokeWidth={2} />
               <polyline points="12 6 12 12 16 14" strokeWidth={2} strokeLinecap="round" />
             </>,
    cog:     <>
               <circle cx="12" cy="12" r="3" strokeWidth={2} />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l-.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
             </>,
    trash:   <>
               <polyline points="3 6 5 6 21 6" strokeWidth={2} strokeLinecap="round" />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 6l-1 14H6L5 6" />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 11v6M14 11v6M9 6V4h6v2" />
             </>,
    user:    <>
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
               <circle cx="12" cy="7" r="4" strokeWidth={2} />
             </>,
    warn:    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />,
    check:   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />,
    edit:    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />,
    wa:      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />,
    share:   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 1 1 0-2.684m0 2.684 6.632 3.316m-6.632-6 6.632-3.316m0 0a3 3 0 1 0 5.367-2.684 3 3 0 0 0-5.367 2.684Zm0 9.316a3 3 0 1 0 5.368 2.684 3 3 0 0 0-5.368-2.684Z" />,
    people:  <>
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
               <circle cx="9" cy="7" r="4" strokeWidth={2} />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M23 21v-2a4 4 0 0 0-3-3.87" />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3.13a4 4 0 0 1 0 7.75" />
             </>,
  };

  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c}>
      {paths[n]}
    </svg>
  );
}

// =============================================================================
// COMPONENTES PEQUEÑOS
// =============================================================================
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function InputRow({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 12, padding: "11px 14px" }}>
      {children}
    </div>
  );
}

function WarnBox({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#fef3c7", border: "1px solid #fbbf24", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#92400e", fontWeight: 500, flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

// =============================================================================
// APP RAIZ — detecta modo (fisio / portal / accion)
// =============================================================================
export default function App() {
  const params   = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const isPortal = params.get("portal") === "1";
  const action   = params.get("action");
  const aptId    = params.get("id");
  const propId   = params.get("prop");

  const [appointments, setApts]  = useState(function() {
    var raw = LS.get("apts", []);
    // Paso 1: filtrar registros con campos minimos requeridos
    var valid = raw.filter(function(a) {
      return a && typeof a === "object" && a.id && a.date && a.time && a.type && a.patient;
    });
    // Paso 2: eliminar duplicados reales al arrancar
    return deduplicateApts(valid);
  });
  const [schedule,     setSched]    = useState(function() { return LS.get("sched", {}); });
  const [durations,    setDurations] = useState(function() { return LS.get("durations", DEFAULT_DURATIONS); });

  useEffect(function() {
    LS.set("apts", appointments);
    _slotsCache = {}; // Invalidar cache al cambiar citas
  }, [appointments]);
  useEffect(function() {
    LS.set("sched", schedule);
    _slotsCache = {}; // Invalidar cache al cambiar horario
  }, [schedule]);
  useEffect(function() { LS.set("durations", durations); }, [durations]);

  // Sincronizacion entre pestanas: si otra pestana escribe en localStorage,
  // actualizamos el estado de esta pestana automaticamente.
  useEffect(function() {
    function onStorage(e) {
      if (e.key === "apts" && e.newValue) {
        try {
          var parsed = JSON.parse(e.newValue);
          if (Array.isArray(parsed)) {
            var valid = parsed.filter(function(a) {
              return a && typeof a === "object" && a.id && a.date && a.time && a.type && a.patient;
            });
            setApts(deduplicateApts(valid));
            _slotsCache = {};
          }
        } catch(err) { /* datos corruptos — ignorar */ }
      }
    }
    window.addEventListener("storage", onStorage);
    return function() { window.removeEventListener("storage", onStorage); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (action === "cancel" && aptId) {
    var cancelToken = params.get("token") || "";
    return <CancelPage aptId={aptId} cancelToken={cancelToken} appointments={appointments} setApts={setApts} />;
  }
  if (action === "confirm-change" && aptId && propId) {
    return <ConfirmChangePage aptId={aptId} propId={propId} appointments={appointments} setApts={setApts} />;
  }
  if (isPortal) {
    return <PatientPortal appointments={appointments} setApts={setApts} schedule={schedule} />;
  }
  return <FisioApp appointments={appointments} setApts={setApts} schedule={schedule} setSched={setSched} durations={durations} setDurations={setDurations} />;
}

// =============================================================================
// PANEL DEL FISIO
// =============================================================================
function FisioApp({ appointments, setApts, schedule, setSched, durations, setDurations }) {
  const [view,        setView]       = useState("agenda");
  const [selDate,     setSelDate]    = useState(todayKey());
  const [calMonth,    setCalMonth]   = useState(new Date().getMonth());
  const [calYear,     setCalYear]    = useState(new Date().getFullYear());
  const [newApt,      setNewApt]     = useState({ patient: "", type: "fisio", date: todayKey(), time: "", phone: "" });
  const [newAptPrefix, setNewAptPrefix] = useState("34");
  const [newAptNumber, setNewAptNumber] = useState("");
  const [conflict,    setConflict]   = useState(null);
  const [suggestion,  setSugg]       = useState(null);
  const [toast,       setToast]      = useState(null);
  const [modal,       setModal]      = useState(null);
  const [changeForm,  setChangeForm] = useState({ date: "", time: "" });
  const [editForm,    setEditForm]   = useState(null); // {patient, phone, phonePrefix, phoneNumber}
  const [saving,      setSaving]      = useState(false);

  function showToast(msg, ok) {
    if (ok === undefined) ok = true;
    setToast({ msg: msg, ok: ok });
    setTimeout(function() { setToast(null); }, 2500);
  }

  // Calendario mensual
  var calFirstDay = new Date(calYear, calMonth, 1);
  var calLastDay  = new Date(calYear, calMonth + 1, 0);
  var calStartDow = (calFirstDay.getDay() + 6) % 7; // lunes=0
  var calCells = [];
  for (var ci = 0; ci < calStartDow; ci++) calCells.push(null);
  for (var cd = 1; cd <= calLastDay.getDate(); cd++) calCells.push(new Date(calYear, calMonth, cd));

  // Timeline del día seleccionado
  const dayApts   = appointments.filter(function(a) { return a.date === selDate; });
  const daySlots  = schedule[selDate] || [];
  const activeApts = dayApts.filter(function(a) { return a.status !== "cancelled"; });

  let tlMin = null, tlMax = null;
  if (daySlots.length > 0) {
    tlMin = Math.min.apply(null, daySlots.map(function(s) { return toMin(s.start); }));
    tlMax = Math.max.apply(null, daySlots.map(function(s) { return toMin(s.end); }));
  }
  const tlArr = [];
  if (tlMin !== null) {
    for (let t = tlMin; t < tlMax; t += 10) tlArr.push(t);
  }

  function aptBlocks(col) {
    return activeApts.map(function(a) {
      const show = col === "fisio"
        ? (a.type === "fisio" || a.type === "combinada")
        : (a.type === "nesa"  || a.type === "combinada");
      if (!show) return null;

      let sMin = toMin(a.time);
      let dur  = 50;
      if (a.type === "combinada") {
        if (col === "fisio") { dur = 30; }
        else { sMin += 30; dur = 20; }
      }
      const topIdx = tlArr.indexOf(sMin);
      if (topIdx < 0) return null;

      const cfg = a.type === "combinada"
        ? APT_TYPES.combinada
        : APT_TYPES[col === "fisio" ? "fisio" : "nesa"];

      return Object.assign({}, a, { sMin: sMin, dur: dur, topIdx: topIdx, cfg: cfg });
    }).filter(Boolean);
  }

  function handleSave() {
    if (saving) return;
    if (!newApt.patient.trim() || !newApt.time) return;
    if (!newAptNumber || !isValidPhone(newAptNumber)) { setConflict("El WhatsApp del paciente es obligatorio."); return; }
    const dk = newApt.date;
    if (!(schedule[dk] || []).length) { setConflict("Este día no tiene horario configurado."); return; }

    const inSched = (schedule[dk] || []).some(function(s) {
      return toMin(newApt.time) >= toMin(s.start) && toMin(newApt.time) + 50 <= toMin(s.end);
    });
    if (!inSched) { setConflict("Esa hora está fuera del horario del día."); return; }

    const err = hasConflict(appointments.filter(function(a) { return a.date === dk; }), newApt.time, newApt.type);
    if (err) {
      setConflict(err);
      setSugg(nextAvailable(dk, newApt.type, schedule, appointments));
      return;
    }

    setSaving(true);
    // Capturar valores antes de la llamada asincrona
    var aptToSave = {
      id: uid(),
      patient: newApt.patient,
      type: newApt.type,
      date: newApt.date,
      time: newApt.time,
      phone: buildPhone(newAptPrefix, newAptNumber),
      status: "confirmed",
      source: "fisio",
      cancelToken: uid(),
      cancelTokenExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000, // expira en 7 dias
      propToken: uid(),
    };
    var savedDate = newApt.date;
    var conflictFound = false;

    setApts(function(prev) {
      // SEGUNDA VALIDACION ATOMICA: re-verificar con el estado mas reciente
      // Esto captura race conditions entre dos usuarios reservando a la vez
      var freshDayApts = prev.filter(function(a) { return a.date === aptToSave.date; });
      var freshConflict = hasConflict(freshDayApts, aptToSave.time, aptToSave.type);
      if (freshConflict) {
        conflictFound = true;
        return prev; // No anadir — slot ya ocupado
      }
      return deduplicateApts(prev.concat([aptToSave]));
    });

    setSaving(false);

    if (conflictFound) {
      setConflict("Este horario acaba de ser ocupado. Por favor elige otra hora.");
      return;
    }

    setNewApt({ patient: "", type: "fisio", date: todayKey(), time: "", phone: "" });
    setConflict(null);
    setSugg(null);
    showToast("Cita guardada");
    setSelDate(savedDate);
    setView("agenda");
  }

  function handleProposeChange() {
    if (!modal || !modal.apt) return;
    const apt = modal.apt;
    if (!changeForm.date || !changeForm.time) return;
    const dk = changeForm.date;
    const otherApts = appointments.filter(function(a) { return a.date === dk && a.id !== apt.id; });
    const err = hasConflict(otherApts, changeForm.time, apt.type);
    if (err) { showToast(err, false); return; }

    const newPropToken = uid();
    var propChangeDate = changeForm.date;
    var propChangeTime = changeForm.time;
    var aptId2 = apt.id;
    var aptType2 = apt.type;

    setApts(function(prev) {
      // Re-verificar que el nuevo slot sigue libre (estado fresco)
      var freshOther = prev.filter(function(a) { return a.date === propChangeDate && a.id !== aptId2; });
      var freshErr = hasConflict(freshOther, propChangeTime, aptType2);
      if (freshErr) return prev; // Si ya no esta libre, no guardar el cambio
      return prev.map(function(a) {
        if (a.id !== aptId2) return a;
        return Object.assign({}, a, { pendingChange: { date: propChangeDate, time: propChangeTime, propToken: newPropToken } });
      });
    });

    const phone   = apt.phone || FISIO_PHONE;
    const baseUrl = window.location.origin + window.location.pathname;
    const link    = baseUrl + "?action=confirm-change&id=" + apt.id + "&prop=" + newPropToken;
    const msg     = "Hola " + apt.patient + ", necesito cambiar tu cita de " + APT_TYPES[apt.type].label +
                    " del " + fmtDate(apt.date) + " a las " + apt.time + ".\n\n" +
                    "Te propongo el " + fmtDate(changeForm.date) + " a las " + changeForm.time + ".\n\n" +
                    "¿Te va bien? Confirma aquí:\n" + link;

    window.open(waLink(phone, msg), "_blank");
    setModal(null);
    setChangeForm({ date: "", time: "" });
    showToast("Propuesta enviada por WhatsApp");
  }

  function handleDelete(apt) {
    setApts(function(prev) { return prev.filter(function(a) { return a.id !== apt.id; }); });
    setModal(null);
    showToast("Cita eliminada");
  }

  function handleEditSave() {
    if (!editForm) return;
    if (!editForm.patient.trim()) return;
    if (!editForm.phoneNumber || !isValidPhone(editForm.phoneNumber)) return;
    var fullPhone = buildPhone(editForm.phonePrefix, editForm.phoneNumber);
    setApts(function(prev) {
      return prev.map(function(a) {
        if (a.id !== editForm.id) return a;
        return Object.assign({}, a, { patient: editForm.patient, phone: fullPhone });
      });
    });
    setEditForm(null);
    setModal(null);
    showToast("Cita actualizada");
  }

  const portalUrl = (typeof window !== "undefined"
    ? window.location.origin + window.location.pathname
    : "") + "?portal=1";

  return (
    <div style={S.root}>
      <style>{globalCss}</style>

      {/* CABECERA */}
      <div style={S.hdr}>
        <div style={S.hdrRow}>
          <div>
            <div style={S.hdrTitle}>Agenda</div>
            <div style={S.hdrSub}>Panel del fisio</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="tap" onClick={function() { setView("portal"); }} style={S.iconBtn}>
              <Ic n="people" s={21} c="#475569" />
            </button>
            <button className="tap" onClick={function() { setView("settings"); }} style={S.iconBtn}>
              <Ic n="cog" s={21} c="#475569" />
            </button>
            <button className="tap"
              onClick={function() { setConflict(null); setSugg(null); setNewApt(function(p) { return Object.assign({}, p, { date: selDate, time: "" }); }); setView("new"); }}
              style={Object.assign({}, S.iconBtn, { background: "#1e3a5f", borderColor: "#1e3a5f" })}>
              <Ic n="plus" s={21} c="#fff" />
            </button>
          </div>
        </div>
      </div>

      {toast && (
        <div style={Object.assign({}, S.toast, { background: toast.ok ? "#16a34a" : "#dc2626" })}>
          {toast.msg}
        </div>
      )}

      {/* AGENDA */}
      {view === "agenda" && (
        <>
          {/* Calendario mensual */}
          <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "10px 14px 12px" }}>
            {/* Nav mes */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <button className="tap" style={S.wkBtn} onClick={function() {
                var m=calMonth-1, y=calYear; if(m<0){m=11;y--;} setCalMonth(m); setCalYear(y);
              }}><Ic n="left" s={18} c="#64748b" /></button>
              <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>
                {MONTHS[calMonth]} {calYear}
              </div>
              <button className="tap" style={S.wkBtn} onClick={function() {
                var m=calMonth+1, y=calYear; if(m>11){m=0;y++;} setCalMonth(m); setCalYear(y);
              }}><Ic n="right" s={18} c="#64748b" /></button>
            </div>
            {/* Cabecera dias */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 }}>
              {["L","M","X","J","V","S","D"].map(function(d) {
                return <div key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 600, color: "#94a3b8" }}>{d}</div>;
              })}
            </div>
            {/* Celulas */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
              {calCells.map(function(d, idx) {
                if (!d) return <div key={"e"+idx} />;
                var dk     = dateKey(d);
                var isTod  = dk === todayKey();
                var isSel  = dk === selDate;
                var hasApt = appointments.some(function(a) { return a.date === dk && a.status !== "cancelled"; });
                var hasSch = (schedule[dk] || []).length > 0;
                // colores de puntos por tipo
                var aptTypes = {};
                appointments.filter(function(a){ return a.date===dk&&a.status!=="cancelled"; }).forEach(function(a){ aptTypes[a.type]=true; });
                return (
                  <div key={dk} className="tap" onClick={function() { setSelDate(dk); }}
                    style={{
                      borderRadius: 8, padding: "5px 2px",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                      background: isSel ? "#1e3a5f" : isTod ? "#dbeafe" : "transparent",
                      border: "2px solid " + (isSel ? "#1e3a5f" : isTod ? "#93c5fd" : "transparent"),
                      cursor: "pointer", minHeight: 44,
                    }}>
                    <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2,
                      color: isSel ? "#fff" : isTod ? "#1e40af" : hasSch ? "#1e293b" : "#94a3b8" }}>
                      {d.getDate()}
                    </span>
                    {/* Puntos de colores por tipo de cita */}
                    <div style={{ display: "flex", gap: 2, height: 6, alignItems: "center" }}>
                      {aptTypes.fisio     && <div style={{ width: 5, height: 5, borderRadius: "50%", background: isSel ? "#fff" : "#2563eb" }} />}
                      {aptTypes.nesa      && <div style={{ width: 5, height: 5, borderRadius: "50%", background: isSel ? "#fff" : "#16a34a" }} />}
                      {aptTypes.combinada && <div style={{ width: 5, height: 5, borderRadius: "50%", background: isSel ? "#fff" : "#7c3aed" }} />}
                      {!hasApt && hasSch  && <div style={{ width: 4, height: 4, borderRadius: "50%", background: isSel ? "rgba(255,255,255,.3)" : "#e2e8f0" }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={S.content}>
            {/* Etiqueta del día */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>
                {DAYS_LONG[parseD(selDate).getDay()]}, {parseD(selDate).getDate()} {MONTHS[parseD(selDate).getMonth()]}
              </div>
              <button className="tap" onClick={function() { setView("settings"); }}
                style={{ fontSize: 12, color: "#2563eb", background: "#dbeafe", border: "none", borderRadius: 8, padding: "5px 10px", fontWeight: 600, cursor: "pointer" }}>
                {daySlots.length ? daySlots.length + " franja" + (daySlots.length > 1 ? "s" : "") : "Sin horario"}
              </button>
            </div>

            {/* Aviso de citas anuladas */}
            {dayApts.some(function(a) { return a.status === "cancelled"; }) && (
              <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "8px 12px", marginBottom: 10, fontSize: 13, color: "#b91c1c", fontWeight: 500 }}>
                ⚠️ Cita anulada por el paciente: {dayApts.filter(function(a) { return a.status === "cancelled"; }).map(function(a) { return a.patient; }).join(", ")}
              </div>
            )}

            {daySlots.length === 0 ? (
              <div style={S.empty}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>😴</div>
                <div style={{ fontWeight: 600, color: "#475569", marginBottom: 4 }}>Sin horario este día</div>
                <button className="tap" onClick={function() { setView("settings"); }}
                  style={{ marginTop: 8, background: "#1e3a5f", color: "#fff", border: "none", borderRadius: 12, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
                  Configurar horario
                </button>
              </div>
            ) : (
              <div style={S.gridWrap}>
                <div style={S.colHdrs}>
                  <div style={S.timeGutter} />
                  <div style={Object.assign({}, S.colHdr, { background: "#dbeafe", color: "#1e40af" })}>💆 Fisio</div>
                  <div style={Object.assign({}, S.colHdr, { background: "#dcfce7", color: "#15803d" })}>⚡ Nesa</div>
                </div>
                <div style={S.gridScroll}>
                  <div style={{ position: "relative", height: tlArr.length * SLOT_H + 4 }}>
                    {tlArr.map(function(mins, idx) {
                      return (
                        <div key={mins} style={{ position: "absolute", top: idx * SLOT_H, left: 0, right: 0, display: "flex", height: SLOT_H }}>
                          <div style={{ width: 48, display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 6 }}>
                            {mins % 60 === 0 && <span style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8" }}>{toTime(mins)}</span>}
                          </div>
                          <div style={{ flex: 1, borderTop: mins % 60 === 0 ? "1px solid #e2e8f0" : "1px solid #f8fafc" }} />
                          <div style={{ flex: 1, borderTop: mins % 60 === 0 ? "1px solid #e2e8f0" : "1px solid #f8fafc" }} />
                        </div>
                      );
                    })}

                    {["fisio", "nesa"].map(function(col) {
                      return aptBlocks(col).map(function(b) {
                        const posStyle = col === "fisio"
                          ? { left: 48, width: "calc(50% - 52px)" }
                          : { right: 4, width: "calc(50% - 52px)" };
                        return (
                          <div key={b.id + col} className="tap"
                            onClick={function() { setModal({ type: "options", apt: b }); setChangeForm({ date: "", time: "" }); }}
                            style={Object.assign({}, S.aptBlock, posStyle, {
                              top: b.topIdx * SLOT_H + 2,
                              height: (b.dur / 10) * SLOT_H - 3,
                              background: b.cfg.light,
                              borderLeft: "3px solid " + b.cfg.color,
                              outline: b.pendingChange ? "2px dashed " + b.cfg.color : "none",
                            })}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: b.cfg.color, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {b.patient}
                            </div>
                            <div style={{ fontSize: 10, color: b.cfg.color, opacity: 0.7, marginTop: 1 }}>
                              {b.type === "combinada" ? (col === "fisio" ? "Comb·F" : "Comb·N") : b.type === "fisio" ? "Fisio" : "Nesa"} {toTime(b.sMin)}
                              {b.pendingChange ? " 🔄" : ""}
                            </div>
                          </div>
                        );
                      });
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* NUEVA CITA */}
      {view === "new" && (
        <div style={S.content}>
          <div style={S.card}>
            <div style={S.cardTitle}>Nueva cita</div>

            <Field label="Paciente">
              <InputRow>
                <Ic n="user" s={18} c="#94a3b8" />
                <input style={S.inp} placeholder="Nombre del paciente"
                  value={newApt.patient}
                  onChange={function(e) { setNewApt(function(p) { return Object.assign({}, p, { patient: e.target.value }); }); }} />
              </InputRow>
            </Field>

            <PhoneInput
              label="WhatsApp paciente"
              prefix={newAptPrefix} setPrefix={setNewAptPrefix}
              number={newAptNumber} setNumber={setNewAptNumber} />

            <Field label="Tipo de cita">
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(APT_TYPES).map(function(entry) {
                  const k = entry[0], v = entry[1];
                  return (
                    <button key={k} className="tap"
                      onClick={function() { setNewApt(function(p) { return Object.assign({}, p, { type: k, time: "" }); }); }}
                      style={Object.assign({}, S.typeBtn, newApt.type === k ? { background: v.color, color: "#fff", borderColor: v.color } : {})}>
                      {v.emoji} {v.label}
                    </button>
                  );
                })}
              </div>
              <div style={Object.assign({}, S.typeInfo, { borderLeftColor: APT_TYPES[newApt.type].color })}>
                {APT_TYPES[newApt.type].desc}
              </div>
            </Field>

            <Field label="Fecha">
              <InputRow>
                <Ic n="cal" s={18} c="#94a3b8" />
                <input type="date" style={S.inp} value={newApt.date}
                  onChange={function(e) {
                    setNewApt(function(p) { return Object.assign({}, p, { date: e.target.value, time: "" }); });
                    setConflict(null); setSugg(null);
                  }} />
              </InputRow>
            </Field>

            <Field label="Hora">
              {(function() {
                const avail = getSlots(newApt.date, schedule, appointments, newApt.type);
                if (!(schedule[newApt.date] || []).length) {
                  return (
                    <WarnBox>
                      <Ic n="warn" s={15} c="#92400e" />
                      <span>Sin horario este día.{" "}
                        <span onClick={function() { setView("settings"); }} style={{ textDecoration: "underline", cursor: "pointer" }}>Configurar →</span>
                      </span>
                    </WarnBox>
                  );
                }
                if (!avail.length) {
                  return <WarnBox><Ic n="warn" s={15} c="#92400e" /> Sin disponibilidad para este tipo de cita.</WarnBox>;
                }
                return (
                  <InputRow>
                    <Ic n="clock" s={18} c="#94a3b8" />
                    <select style={S.inp} value={newApt.time}
                      onChange={function(e) { setNewApt(function(p) { return Object.assign({}, p, { time: e.target.value }); }); setConflict(null); }}>
                      <option value="">Seleccionar hora...</option>
                      {avail.map(function(t) { return <option key={t} value={t}>{t}</option>; })}
                    </select>
                  </InputRow>
                );
              })()}
            </Field>

            {conflict && (
              <div style={S.conflictBox}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <Ic n="warn" s={15} c="#b91c1c" />
                  <span style={{ fontWeight: 700, color: "#b91c1c", fontSize: 14 }}>Conflicto</span>
                </div>
                <p style={{ color: "#7f1d1d", fontSize: 13 }}>{conflict}</p>
                {suggestion && (
                  <>
                    <p style={{ color: "#7f1d1d", fontSize: 13, marginTop: 6 }}>
                      Próxima disponibilidad: <strong>{fmtDate(suggestion.dk)}</strong> a las <strong>{suggestion.time}</strong>
                    </p>
                    <button className="tap"
                      onClick={function() { setNewApt(function(p) { return Object.assign({}, p, { date: suggestion.dk, time: suggestion.time }); }); setConflict(null); setSugg(null); }}
                      style={{ marginTop: 8, background: "#1e3a5f", color: "#fff", border: "none", borderRadius: 10, padding: "8px", fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%" }}>
                      Usar esta hora
                    </button>
                  </>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="tap" onClick={function() { setView("agenda"); setConflict(null); }} style={S.cancelBtn}>
                Cancelar
              </button>
              <button className="tap" onClick={handleSave}
                style={Object.assign({}, S.saveBtn, { opacity: (!newApt.patient.trim() || !newApt.time || !newAptNumber || !isValidPhone(newAptNumber)) ? 0.5 : 1 })}>
                Guardar cita
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AJUSTES */}
      {view === "settings" && (
        <SettingsView schedule={schedule} setSched={setSched} durations={durations} setDurations={setDurations} onBack={function() { setView("agenda"); }} initialDate={selDate} />
      )}

      {/* PORTAL — info para el fisio */}
      {view === "portal" && (
        <div style={S.content}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <button onClick={function() { setView("agenda"); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              <Ic n="left" s={22} c="#334155" />
            </button>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1e293b" }}>Portal pacientes</div>
          </div>
          <div style={S.card}>
            <div style={{ fontSize: 14, color: "#475569", marginBottom: 16, lineHeight: 1.6 }}>
              Comparte este enlace con tus pacientes para que reserven citas desde su móvil.
            </div>
            <div style={{ background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", fontSize: 12, color: "#1e293b", wordBreak: "break-all", fontFamily: "monospace", marginBottom: 14 }}>
              {portalUrl}
            </div>
            <button className="tap"
              onClick={function() { if (navigator.clipboard) navigator.clipboard.writeText(portalUrl); showToast("Enlace copiado"); }}
              style={Object.assign({}, S.saveBtn, { gap: 8, marginBottom: 10 })}>
              <Ic n="share" s={18} c="#fff" /> Copiar enlace
            </button>
            <button className="tap" onClick={function() { window.open(portalUrl, "_blank"); }}
              style={Object.assign({}, S.cancelBtn, { width: "100%", textAlign: "center" })}>
              Ver portal (preview)
            </button>
          </div>

          {/* Cambios pendientes */}
          {appointments.filter(function(a) { return a.pendingChange; }).length > 0 && (
            <div style={Object.assign({}, S.card, { marginTop: 14 })}>
              <div style={{ fontWeight: 700, color: "#1e293b", marginBottom: 10 }}>🔄 Cambios pendientes de confirmar</div>
              {appointments.filter(function(a) { return a.pendingChange; }).map(function(a) {
                return (
                  <div key={a.id} style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", marginBottom: 8, fontSize: 13 }}>
                    <div style={{ fontWeight: 600, color: "#92400e" }}>{a.patient}</div>
                    <div style={{ color: "#78350f", marginTop: 2 }}>
                      {fmtDate(a.date)} {a.time} → {fmtDate(a.pendingChange.date)} {a.pendingChange.time}
                    </div>
                    <div style={{ color: "#92400e", marginTop: 2, fontStyle: "italic" }}>Esperando confirmación del paciente...</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* TODOS LOS PACIENTES con numero de contacto */}
          {(function() {
            var withPhone = appointments.filter(function(a) { return a.status !== "cancelled" && a.phone; });
            if (withPhone.length === 0) return null;
            // Ordenar por fecha mas reciente
            var sorted = withPhone.slice().sort(function(a, b) {
              if (a.date > b.date) return -1;
              if (a.date < b.date) return 1;
              return a.time > b.time ? -1 : 1;
            });
            return (
              <div style={Object.assign({}, S.card, { marginTop: 14 })}>
                <div style={{ fontWeight: 700, color: "#1e293b", marginBottom: 10 }}>📋 Pacientes ({sorted.length})</div>
                {sorted.map(function(a) {
                  return (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
                      <div>
                        <div style={{ fontWeight: 600, color: "#1e293b", fontSize: 14 }}>{a.patient}</div>
                        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                          {APT_TYPES[a.type] ? APT_TYPES[a.type].emoji + " " + APT_TYPES[a.type].label : a.type} · {fmtDate(a.date)} · {a.time}
                        </div>
                      </div>
                      <a href={"https://wa.me/" + a.phone.replace(/\D/g, "")}
                        target="_blank"
                        rel="noreferrer"
                        style={{ background: "#dcfce7", border: "none", borderRadius: 10, padding: "8px 12px", fontSize: 13, color: "#15803d", fontWeight: 600, textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                        <Ic n="wa" s={14} c="#15803d" /> {a.phone}
                      </a>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* MODAL: opciones de cita */}
      {modal && modal.type === "options" && (
        <div style={S.overlay} onClick={function() { setModal(null); }}>
          <div style={S.modal} onClick={function(e) { e.stopPropagation(); }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <div>
                <div style={S.modalTitle}>{modal.apt.patient}</div>
                <div style={{ fontSize: 13, color: "#64748b" }}>
                  {APT_TYPES[modal.apt.type].emoji} {APT_TYPES[modal.apt.type].label} · {fmtDate(modal.apt.date)} · {modal.apt.time}
                </div>
                {modal.apt.pendingChange && (
                  <div style={{ fontSize: 12, color: "#b45309", marginTop: 4, fontWeight: 600 }}>
                    🔄 Propuesto: {fmtDate(modal.apt.pendingChange.date)} {modal.apt.pendingChange.time}
                  </div>
                )}
              </div>
              <button onClick={function() { setModal(null); }} style={{ background: "none", border: "none", cursor: "pointer" }}>
                <Ic n="x" s={20} c="#94a3b8" />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button className="tap" onClick={function() {
                var apt = modal.apt;
                var existingPrefix = "34";
                var existingNumber = apt.phone || "";
                // Intentar detectar el prefijo del telefono guardado
                COUNTRY_PREFIXES.forEach(function(c) {
                  if (existingNumber.startsWith(c.prefix)) {
                    existingPrefix = c.prefix;
                    existingNumber = existingNumber.slice(c.prefix.length);
                  }
                });
                setEditForm({ id: apt.id, patient: apt.patient, phonePrefix: existingPrefix, phoneNumber: existingNumber });
                setModal({ type: "edit", apt: apt });
              }}
                style={Object.assign({}, S.saveBtn, { background: "#0891b2" })}>
                <Ic n="edit" s={18} c="#fff" /> Editar datos
              </button>
              <button className="tap" onClick={function() { setModal({ type: "change", apt: modal.apt }); }}
                style={Object.assign({}, S.saveBtn, { background: "#7c3aed" })}>
                <Ic n="edit" s={18} c="#fff" /> Proponer cambio de hora
              </button>
              <button className="tap" onClick={function() { handleDelete(modal.apt); }}
                style={Object.assign({}, S.saveBtn, { background: "#dc2626" })}>
                <Ic n="trash" s={18} c="#fff" /> Eliminar cita
              </button>
              <button className="tap" onClick={function() { setModal(null); }} style={S.cancelBtn}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: editar datos cita */}
      {modal && modal.type === "edit" && editForm && (
        <div style={S.overlay} onClick={function() { setModal(null); setEditForm(null); }}>
          <div style={S.modal} onClick={function(e) { e.stopPropagation(); }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={S.modalTitle}>Editar cita</div>
              <button onClick={function() { setModal(null); setEditForm(null); }} style={{ background: "none", border: "none", cursor: "pointer" }}>
                <Ic n="x" s={20} c="#94a3b8" />
              </button>
            </div>
            <Field label="Nombre del paciente">
              <InputRow>
                <Ic n="user" s={18} c="#94a3b8" />
                <input style={S.inp} placeholder="Nombre del paciente"
                  value={editForm.patient}
                  onChange={function(e) { setEditForm(function(p) { return Object.assign({}, p, { patient: e.target.value }); }); }} />
              </InputRow>
            </Field>
            <PhoneInput
              label="WhatsApp paciente"
              prefix={editForm.phonePrefix}
              setPrefix={function(v) { setEditForm(function(p) { return Object.assign({}, p, { phonePrefix: v }); }); }}
              number={editForm.phoneNumber}
              setNumber={function(v) { setEditForm(function(p) { return Object.assign({}, p, { phoneNumber: v }); }); }} />
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="tap" onClick={function() { setModal(null); setEditForm(null); }} style={S.cancelBtn}>Cancelar</button>
              <button className="tap" onClick={handleEditSave}
                style={Object.assign({}, S.saveBtn, { opacity: (!editForm.patient.trim() || !editForm.phoneNumber || !isValidPhone(editForm.phoneNumber)) ? 0.5 : 1 })}>
                Guardar cambios
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: proponer cambio */}
      {modal && modal.type === "change" && (
        <div style={S.overlay} onClick={function() { setModal(null); }}>
          <div style={S.modal} onClick={function(e) { e.stopPropagation(); }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={S.modalTitle}>Proponer nuevo horario</div>
              <button onClick={function() { setModal(null); }} style={{ background: "none", border: "none", cursor: "pointer" }}>
                <Ic n="x" s={20} c="#94a3b8" />
              </button>
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
              Paciente: <strong>{modal.apt.patient}</strong><br />
              Cita actual: {fmtDate(modal.apt.date)} · {modal.apt.time}
            </div>

            <Field label="Nueva fecha">
              <InputRow>
                <Ic n="cal" s={18} c="#94a3b8" />
                <input type="date" style={S.inp} value={changeForm.date}
                  onChange={function(e) { setChangeForm(function(p) { return Object.assign({}, p, { date: e.target.value, time: "" }); }); }} />
              </InputRow>
            </Field>

            {changeForm.date && (function() {
              const avail = getSlots(changeForm.date, schedule, appointments.filter(function(a) { return a.id !== modal.apt.id; }), modal.apt.type);
              if (!(schedule[changeForm.date] || []).length) return <WarnBox>Sin horario ese día.</WarnBox>;
              if (!avail.length) return <WarnBox>Sin disponibilidad ese día.</WarnBox>;
              return (
                <Field label="Nueva hora">
                  <InputRow>
                    <Ic n="clock" s={18} c="#94a3b8" />
                    <select style={S.inp} value={changeForm.time}
                      onChange={function(e) { setChangeForm(function(p) { return Object.assign({}, p, { time: e.target.value }); }); }}>
                      <option value="">Seleccionar hora...</option>
                      {avail.map(function(t) { return <option key={t} value={t}>{t}</option>; })}
                    </select>
                  </InputRow>
                </Field>
              );
            })()}

            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button className="tap" onClick={function() { setModal(null); }} style={S.cancelBtn}>Cancelar</button>
              <button className="tap" onClick={handleProposeChange}
                style={Object.assign({}, S.saveBtn, { background: "#16a34a", gap: 8, opacity: (!changeForm.date || !changeForm.time) ? 0.5 : 1 })}>
                <Ic n="wa" s={18} c="#fff" /> Enviar WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BARRA NAVEGACION */}
      <div style={S.nav}>
        {[["agenda","cal","Agenda"],["new","plus","Nueva"],["portal","people","Pacientes"],["settings","cog","Ajustes"]].map(function(item) {
          const v = item[0], ic = item[1], lbl = item[2];
          return (
            <button key={v} className="tap"
              onClick={function() {
                if (v === "new") { setConflict(null); setSugg(null); setNewApt(function(p) { return Object.assign({}, p, { date: selDate, time: "" }); }); }
                setView(v);
              }}
              style={S.navBtn}>
              <Ic n={ic} s={21} c={view === v ? "#1e3a5f" : "#94a3b8"} />
              <span style={{ fontSize: 9, marginTop: 2, color: view === v ? "#1e3a5f" : "#94a3b8", fontWeight: view === v ? 700 : 400 }}>
                {lbl}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// PORTAL DEL PACIENTE
// =============================================================================
function PatientPortal({ appointments, setApts, schedule }) {
  const [step,     setStep]    = useState(1);
  const [type,     setType]    = useState("fisio");
  const [selDate,  setSelDate] = useState(null);
  const [time,     setTime]    = useState("");
  const [form,     setForm]    = useState({ name: "", phone: "" });
  const [phonePrefix, setPhonePrefix] = useState("34");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [calMonth, setCalMonth]= useState(new Date().getMonth());
  const [calYear,  setCalYear] = useState(new Date().getFullYear());
  const [savedApt, setSavedApt]= useState(null);

  var nowKey  = todayKey();
  var nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  var avail = selDate ? getSlots(selDate, schedule, appointments, type).filter(function(t) {
    // Si es hoy, filtrar horas que ya han pasado (con 10 min de margen)
    if (selDate === nowKey) return toMin(t) > nowMins + 10;
    return true;
  }) : [];

  // Calcular días con disponibilidad este mes
  const daysWithSlots = {};
  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay  = new Date(calYear, calMonth + 1, 0);
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dk = dateKey(new Date(calYear, calMonth, d));
    if (getSlots(dk, schedule, appointments, type).length > 0) {
      daysWithSlots[dk] = true;
    }
  }

  const startDow = (firstDay.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(calYear, calMonth, d));

  const [booking, setBooking] = useState(false);

  function handleBook() {
    if (booking) return;
    if (!form.name.trim() || !phoneNumber.trim()) return;
    if (!isValidPhone(phoneNumber)) return;
    if (!selDate || !time || !type) return;

    var aptToBook = {
      id: uid(),
      date: selDate,
      time: time,
      type: type,
      patient: form.name.trim(),
      phone: buildPhone(phonePrefix, phoneNumber),
      status: "confirmed",
      source: "patient",
      cancelToken: uid(),
      cancelTokenExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000, // expira en 7 dias
      propToken: uid(),
    };

    setBooking(true);
    var conflictFound = false;

    setApts(function(prev) {
      // SEGUNDA VALIDACION ATOMICA en el portal
      var freshDayApts = prev.filter(function(a) { return a.date === aptToBook.date; });
      var freshConflict = hasConflict(freshDayApts, aptToBook.time, aptToBook.type);
      if (freshConflict) {
        conflictFound = true;
        return prev;
      }
      return deduplicateApts(prev.concat([aptToBook]));
    });

    setBooking(false);

    if (conflictFound) {
      // Volver a seleccion de hora con aviso
      setTime("");
      setStep(3);
      return;
    }

    setSavedApt(aptToBook);
    setStep(5);
  }

  const cancelUrl = savedApt
    ? (window.location.origin + window.location.pathname + "?action=cancel&id=" + savedApt.id + "&token=" + (savedApt.cancelToken || ""))
    : "";

  const steps = ["Tipo", "Fecha", "Hora", "Datos", "✓"];

  return (
    <div style={Object.assign({}, S.root, { background: "#f8fafc" })}>
      <style>{globalCss}</style>

      {/* CABECERA */}
      <div style={Object.assign({}, S.hdr, { background: "#1e3a5f", borderBottom: "none" })}>
        <div style={{ textAlign: "center", padding: "4px 0" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>Reservar cita</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginTop: 2 }}>Fisioterapia &amp; Nesa</div>
        </div>
      </div>

      {/* PASOS */}
      <div style={{ display: "flex", padding: "12px 16px 8px", gap: 4, justifyContent: "center" }}>
        {steps.map(function(lbl, i) {
          const active = i + 1 === step;
          const done   = i + 1 < step;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, background: done ? "#16a34a" : active ? "#1e3a5f" : "#e2e8f0", color: (done || active) ? "#fff" : "#94a3b8" }}>
                {done ? <Ic n="check" s={14} c="#fff" /> : i + 1}
              </div>
              {i < steps.length - 1 && <div style={{ width: 20, height: 2, background: done ? "#16a34a" : "#e2e8f0", borderRadius: 1 }} />}
            </div>
          );
        })}
      </div>

      <div style={S.content}>

        {/* PASO 1: TIPO */}
        {step === 1 && (
          <div style={S.card}>
            <div style={S.cardTitle}>¿Qué necesitas?</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(APT_TYPES).map(function(entry) {
                const k = entry[0], v = entry[1];
                return (
                  <button key={k} className="tap"
                    onClick={function() { setType(k); setSelDate(null); setTime(""); setStep(2); }}
                    style={{ background: type === k ? v.light : "#f8fafc", border: "2px solid " + (type === k ? v.color : "#e2e8f0"), borderRadius: 14, padding: "14px 16px", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 28 }}>{v.emoji}</span>
                    <div>
                      <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>{v.label}</div>
                      <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{v.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* PASO 2: FECHA */}
        {step === 2 && (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <button onClick={function() { setStep(1); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                <Ic n="left" s={20} c="#334155" />
              </button>
              <div style={S.cardTitle}>Elige un día</div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <button className="tap" onClick={function() { let m = calMonth - 1, y = calYear; if (m < 0) { m = 11; y--; } setCalMonth(m); setCalYear(y); }} style={S.wkBtn}>
                <Ic n="left" s={18} c="#64748b" />
              </button>
              <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>{MONTHS[calMonth]} {calYear}</div>
              <button className="tap" onClick={function() { let m = calMonth + 1, y = calYear; if (m > 11) { m = 0; y++; } setCalMonth(m); setCalYear(y); }} style={S.wkBtn}>
                <Ic n="right" s={18} c="#64748b" />
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 }}>
              {["L","M","X","J","V","S","D"].map(function(d) {
                return <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "#94a3b8", padding: "2px 0" }}>{d}</div>;
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
              {cells.map(function(d, idx) {
                if (!d) return <div key={"e" + idx} />;
                const dk      = dateKey(d);
                const avail   = !!daysWithSlots[dk];
                const isTod   = dk === todayKey();
                const isSel   = dk === selDate;
                const isPast  = dateKey(d) < todayKey();
                return (
                  <div key={dk} className={avail && !isPast ? "tap" : ""}
                    onClick={function() { if (avail && !isPast) { setSelDate(dk); setTime(""); setStep(3); } }}
                    style={{ borderRadius: 10, padding: "8px 2px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: isSel ? "#1e3a5f" : (isTod && avail) ? "#dbeafe" : (avail && !isPast) ? "#f0fdf4" : "#f8fafc", border: "2px solid " + (isSel ? "#1e3a5f" : (isTod && avail) ? "#93c5fd" : (avail && !isPast) ? "#86efac" : "transparent"), cursor: (avail && !isPast) ? "pointer" : "default", opacity: isPast ? 0.4 : 1, minHeight: 50 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: isSel ? "#fff" : isTod ? "#1e40af" : (avail && !isPast) ? "#15803d" : "#94a3b8" }}>{d.getDate()}</span>
                    {avail && !isPast && <div style={{ width: 5, height: 5, borderRadius: "50%", background: isSel ? "#fff" : "#16a34a" }} />}
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#64748b", textAlign: "center" }}>🟢 Días disponibles</div>
          </div>
        )}

        {/* PASO 3: HORA */}
        {step === 3 && selDate && (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <button onClick={function() { setStep(2); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                <Ic n="left" s={20} c="#334155" />
              </button>
              <div>
                <div style={S.cardTitle}>Elige una hora</div>
                <div style={{ fontSize: 13, color: "#64748b" }}>{fmtDate(selDate)}</div>
              </div>
            </div>
            {avail.length === 0 ? (
              <WarnBox>No hay horas disponibles este día para este tipo de cita.</WarnBox>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {avail.map(function(t) {
                  return (
                    <button key={t} className="tap"
                      onClick={function() { setTime(t); setStep(4); }}
                      style={{ background: time === t ? "#1e3a5f" : "#f8fafc", border: "2px solid " + (time === t ? "#1e3a5f" : "#e2e8f0"), borderRadius: 12, padding: "14px 8px", cursor: "pointer", fontSize: 20, fontWeight: 700, color: time === t ? "#fff" : "#334155", fontFamily: "monospace" }}>
                      {t}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* PASO 4: DATOS */}
        {step === 4 && (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <button onClick={function() { setStep(3); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                <Ic n="left" s={20} c="#334155" />
              </button>
              <div style={S.cardTitle}>Tus datos</div>
            </div>

            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 12, padding: "12px 14px", marginBottom: 16, fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: "#15803d", marginBottom: 4 }}>{APT_TYPES[type].emoji} {APT_TYPES[type].label}</div>
              <div style={{ color: "#166534" }}>{fmtDate(selDate)} · {time}</div>
            </div>

            <Field label="Tu nombre completo">
              <InputRow>
                <Ic n="user" s={18} c="#94a3b8" />
                <input style={S.inp} placeholder="Nombre y apellido"
                  value={form.name}
                  onChange={function(e) { setForm(function(p) { return Object.assign({}, p, { name: e.target.value }); }); }} />
              </InputRow>
            </Field>

            <PhoneInput
              label="Tu WhatsApp"
              prefix={phonePrefix} setPrefix={setPhonePrefix}
              number={phoneNumber} setNumber={setPhoneNumber} />

            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14, marginTop: 8, lineHeight: 1.5 }}>
              Tu número solo se usará para avisos sobre tu cita.
            </div>

            <button className="tap" onClick={handleBook}
              style={Object.assign({}, S.saveBtn, { opacity: (!form.name.trim() || !phoneNumber.trim() || !isValidPhone(phoneNumber)) ? 0.5 : 1, gap: 8 })}>
              <Ic n="check" s={18} c="#fff" /> Confirmar reserva
            </button>
          </div>
        )}

        {/* PASO 5: CONFIRMACION */}
        {step === 5 && savedApt && (
          <div style={S.card}>
            <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
              <div style={{ fontSize: 56, marginBottom: 8 }}>✅</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>¡Cita confirmada!</div>
              <div style={{ fontSize: 14, color: "#64748b" }}>Te esperamos pronto</div>
            </div>

            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, color: "#15803d", fontSize: 15, marginBottom: 6 }}>{APT_TYPES[savedApt.type].emoji} {APT_TYPES[savedApt.type].label}</div>
              <div style={{ color: "#166534", fontSize: 14, lineHeight: 1.8 }}>
                📅 {fmtDate(savedApt.date)}<br />
                🕐 {savedApt.time}<br />
                👤 {savedApt.patient}
              </div>
            </div>

            <div style={{ fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.6 }}>
              ¿Necesitas anular? Guarda esta página o pulsa el botón de abajo.
            </div>

            <button className="tap"
              onClick={function() {
                const msg = "Hola, quiero anular mi cita de " + APT_TYPES[savedApt.type].label + " del " + fmtDate(savedApt.date) + " a las " + savedApt.time + ".\nEnlace de anulación: " + cancelUrl;
                window.open(waLink(FISIO_PHONE, msg), "_blank");
              }}
              style={Object.assign({}, S.saveBtn, { background: "#dc2626", marginBottom: 10, gap: 8 })}>
              <Ic n="wa" s={18} c="#fff" /> Anular cita por WhatsApp
            </button>

            <button className="tap"
              onClick={function() {
                const ics = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:" + savedApt.date.replace(/-/g, "") + "T" + (savedApt.time.replace(":", "") + "00") + "\nDURATION:PT50M\nSUMMARY:" + APT_TYPES[savedApt.type].label + " - Fisioterapia\nEND:VEVENT\nEND:VCALENDAR";
                window.open("data:text/calendar;charset=utf-8," + encodeURIComponent(ics), "_blank");
              }}
              style={Object.assign({}, S.cancelBtn, { width: "100%", textAlign: "center" })}>
              📅 Añadir al calendario
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// PAGINA DE CANCELACION
// =============================================================================
function CancelPage({ aptId, cancelToken, appointments, setApts }) {
  const apt  = appointments.find(function(a) { return a.id === aptId; });
  const [done, setDone] = useState(false);

  // Verificar token: debe coincidir con cancelToken de la cita
  // Compatibilidad con enlaces antiguos: si la cita no tiene cancelTokenExpiry, siempre valido
  var tokenMatch  = !cancelToken || !apt || apt.cancelToken === cancelToken;
  var tokenExpired = apt && apt.cancelTokenExpiry && Date.now() > apt.cancelTokenExpiry;
  // tokenOk: sin token en URL = compatible con links viejos; con token = debe coincidir y no expirar
  var tokenOk = tokenMatch && !tokenExpired;

  if (!tokenOk) {
    return (
      <div style={S.root}><style>{globalCss}</style>
        <div style={Object.assign({}, S.content, { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh", textAlign: "center" })}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>{tokenExpired ? "⏰" : "🔒"}</div>
          <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 18 }}>
            {tokenExpired ? "Enlace caducado" : "Enlace no válido"}
          </div>
          {tokenExpired && (
            <div style={{ color: "#64748b", fontSize: 14, marginTop: 8 }}>
              Este enlace de cancelación ha expirado (7 días).<br />Contacta con la clínica.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!apt || apt.status === "cancelled") {
    return (
      <div style={S.root}><style>{globalCss}</style>
        <div style={Object.assign({}, S.content, { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh", textAlign: "center" })}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 18 }}>Esta cita ya está cancelada</div>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div style={S.root}><style>{globalCss}</style>
        <div style={Object.assign({}, S.content, { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh", textAlign: "center" })}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 18, marginBottom: 8 }}>Cita anulada</div>
          <div style={{ color: "#64748b", fontSize: 14 }}>El fisio ha sido notificado.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.root}><style>{globalCss}</style>
      <div style={S.content}>
        <div style={Object.assign({}, S.card, { marginTop: 32 })}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>Anular cita</div>
          </div>
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
            <div style={{ fontWeight: 600, color: "#b91c1c", marginBottom: 4 }}>{APT_TYPES[apt.type].emoji} {APT_TYPES[apt.type].label}</div>
            <div style={{ color: "#7f1d1d", fontSize: 14, lineHeight: 1.8 }}>
              📅 {fmtDate(apt.date)}<br />
              🕐 {apt.time}<br />
              👤 {apt.patient}
            </div>
          </div>
          <p style={{ color: "#475569", fontSize: 14, marginBottom: 20, textAlign: "center" }}>
            ¿Seguro que quieres anular esta cita?
          </p>
          <button className="tap"
            onClick={function() {
              setApts(function(prev) {
                // Idempotente: si ya esta cancelada o no existe, no tocar el estado
                var apt2 = prev.find(function(a) { return a.id === aptId; });
                if (!apt2 || apt2.status === "cancelled") return prev; // ya cancelada — no modificar
                return prev.map(function(a) {
                  if (a.id !== aptId) return a;
                  return Object.assign({}, a, { status: "cancelled" });
                });
              });
              setDone(true);
            }}
            style={Object.assign({}, S.saveBtn, { background: "#dc2626", marginBottom: 10 })}>
            Sí, anular mi cita
          </button>
          <button className="tap" onClick={function() { window.history.back(); }} style={S.cancelBtn}>
            Mantener cita
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// PAGINA DE CONFIRMACION DE CAMBIO
// =============================================================================
function ConfirmChangePage({ aptId, propId, appointments, setApts }) {
  const apt    = appointments.find(function(a) { return a.id === aptId; });
  const [result, setResult] = useState(null);

  if (!apt || !apt.pendingChange || apt.pendingChange.propToken !== propId) {
    return (
      <div style={S.root}><style>{globalCss}</style>
        <div style={Object.assign({}, S.content, { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "80vh", textAlign: "center" })}>
          <div>
            <div style={{ fontSize: 48, marginBottom: 12 }}>❌</div>
            <div style={{ fontWeight: 700, color: "#1e293b" }}>Enlace no válido o ya procesado</div>
          </div>
        </div>
      </div>
    );
  }

  if (result === "accepted") {
    return (
      <div style={S.root}><style>{globalCss}</style>
        <div style={Object.assign({}, S.content, { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh", textAlign: "center" })}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 18, marginBottom: 8 }}>Cambio confirmado</div>
          <div style={{ color: "#64748b", fontSize: 14 }}>Nueva cita: {fmtDate(apt.pendingChange.date)} a las {apt.pendingChange.time}</div>
        </div>
      </div>
    );
  }

  if (result === "rejected") {
    return (
      <div style={S.root}><style>{globalCss}</style>
        <div style={Object.assign({}, S.content, { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh", textAlign: "center" })}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 18, marginBottom: 8 }}>Cita cancelada</div>
          <div style={{ color: "#64748b", fontSize: 14 }}>Hemos notificado al fisio.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.root}><style>{globalCss}</style>
      <div style={S.content}>
        <div style={Object.assign({}, S.card, { marginTop: 32 })}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🔄</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>Propuesta de cambio</div>
            <div style={{ color: "#64748b", fontSize: 14 }}>El fisio quiere cambiar tu cita</div>
          </div>

          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#b91c1c", fontWeight: 600, marginBottom: 4 }}>CITA ACTUAL</div>
            <div style={{ color: "#7f1d1d", fontSize: 14 }}>{fmtDate(apt.date)} · {apt.time}</div>
          </div>

          <div style={{ display: "flex", justifyContent: "center", fontSize: 20, margin: "4px 0" }}>⬇️</div>

          <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 12, padding: "12px 14px", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: "#15803d", fontWeight: 600, marginBottom: 4 }}>NUEVA PROPUESTA</div>
            <div style={{ color: "#166534", fontSize: 15, fontWeight: 700 }}>{fmtDate(apt.pendingChange.date)} · {apt.pendingChange.time}</div>
          </div>

          <button className="tap"
            onClick={function() {
              var newDate = apt.pendingChange.date;
              var newTime = apt.pendingChange.time;
              setApts(function(prev) {
                return prev.map(function(a) {
                  if (a.id !== aptId) return a;
                  return Object.assign({}, a, { date: newDate, time: newTime, pendingChange: null });
                });
              });
              setResult("accepted");
            }}
            style={Object.assign({}, S.saveBtn, { background: "#16a34a", marginBottom: 10, gap: 8 })}>
            <Ic n="check" s={18} c="#fff" /> Acepto el cambio
          </button>

          <button className="tap"
            onClick={function() {
              setApts(function(prev) {
                return prev.map(function(a) {
                  if (a.id !== aptId) return a;
                  return Object.assign({}, a, { status: "cancelled", pendingChange: null });
                });
              });
              setResult("rejected");
            }}
            style={Object.assign({}, S.saveBtn, { background: "#dc2626", gap: 8 })}>
            <Ic n="x" s={18} c="#fff" /> Prefiero anular la cita
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// EDITOR DE DURACIONES — estado local para permitir borrar y reescribir
// =============================================================================
function DurationEditor({ durations, setDurations }) {
  var durConfig = getDurations(durations);
  var initVals = {
    fisio:          String(durConfig.fisio),
    nesa:           String(durConfig.nesa),
    combinadaFisio: String(durConfig.combinadaFisio),
    combinadaNesa:  String(durConfig.combinadaNesa),
  };
  var [localVals, setLocalVals] = useState(initVals);
  var items = [
    { key: "fisio",          label: "Fisio",             emoji: "💆" },
    { key: "nesa",           label: "Nesa",              emoji: "⚡" },
    { key: "combinadaFisio", label: "Combinada (Fisio)", emoji: "✨" },
    { key: "combinadaNesa",  label: "Combinada (Nesa)",  emoji: "✨" },
  ];
  return (
    <div style={Object.assign({}, S.card, { marginBottom: 14 })}>
      <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15, marginBottom: 14 }}>⏱ Duración de las citas</div>
      {items.map(function(item) {
        return (
          <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 14, color: "#334155", fontWeight: 500 }}>{item.emoji} {item.label}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                value={localVals[item.key]}
                onChange={function(e) {
                  var raw = e.target.value.replace(/[^0-9]/g, "");
                  setLocalVals(function(p) { var n=Object.assign({},p); n[item.key]=raw; return n; });
                }}
                onBlur={function() {
                  var val = parseInt(localVals[item.key], 10);
                  if (!val || val < 5) val = DEFAULT_DURATIONS[item.key] || 50;
                  if (val > 180) val = 180;
                  setLocalVals(function(p) { var n=Object.assign({},p); n[item.key]=String(val); return n; });
                  setDurations(function(p) { var n=Object.assign({},p); n[item.key]=val; _slotsCache={}; return n; });
                }}
                style={{ width: 64, background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "8px 10px", fontSize: 15, color: "#1e293b", textAlign: "center" }} />
              <span style={{ fontSize: 13, color: "#94a3b8" }}>min</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// AJUSTES — horario por dia
// =============================================================================
function SettingsView({ schedule, setSched, durations, setDurations, onBack, initialDate }) {
  const init = parseD(initialDate);
  const [calYear,  setCalYear]  = useState(init.getFullYear());
  const [calMonth, setCalMonth] = useState(init.getMonth());
  const [editDk,   setEditDk]   = useState(initialDate);

  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay  = new Date(calYear, calMonth + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;
  const cells    = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(calYear, calMonth, d));

  function slotCount(dk) { return (schedule[dk] || []).length; }

  function addSlot(dk) {
    setSched(function(p) {
      var existing = p[dk] || [];
      // Calcular hora de inicio de la nueva franja: justo despues del fin de la ultima
      var newStart = "09:00";
      var newEnd   = "13:00";
      if (existing.length > 0) {
        var lastEnd = existing[existing.length - 1].end || "13:00";
        var lastEndMin = toMin(lastEnd);
        // Nueva franja empieza 1 hora despues del fin de la ultima
        var startMin = lastEndMin + 60;
        var endMin   = startMin + 180; // 3 horas por defecto
        if (startMin >= 24 * 60) startMin = lastEndMin + 30;
        if (endMin   >= 24 * 60) endMin   = Math.min(startMin + 60, 23 * 60);
        newStart = toTime(startMin);
        newEnd   = toTime(endMin);
      }
      // Añadir sin normalizar para que el usuario pueda editarla
      var result = Object.assign({}, p);
      result[dk] = existing.concat([{ start: newStart, end: newEnd }]);
      return result;
    });
  }
  function removeSlot(dk, i) {
    setSched(function(p) {
      var filtered = (p[dk] || []).filter(function(_, j) { return j !== i; });
      var normalized = normalizeScheduleDay(filtered);
      var n = Object.assign({}, p);
      if (normalized.length === 0) {
        delete n[dk]; // si no quedan franjas validas, borrar el dia
      } else {
        n[dk] = normalized;
      }
      return n;
    });
  }
  function updateSlot(dk, i, field, val) {
    setSched(function(p) {
      var arr = (p[dk] || []).slice();
      arr[i] = Object.assign({}, arr[i]);
      arr[i][field] = val;
      // Guardar sin normalizar para que el usuario pueda seguir editando la hora,
      // pero la normalizacion se aplica al leer en getSlots.
      // Nota: NO normalizamos aqui para no confundir al usuario mientras edita.
      var result = Object.assign({}, p);
      result[dk] = arr;
      return result;
    });
  }
  function clearDay(dk) {
    setSched(function(p) { const n = Object.assign({}, p); delete n[dk]; return n; });
  }

  const selSlots  = schedule[editDk] || [];
  const durConfig = getDurations(durations);

  return (
    <div style={S.content}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <Ic n="left" s={22} c="#334155" />
        </button>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#1e293b" }}>Horario por día</div>
      </div>

      <div style={Object.assign({}, S.card, { marginBottom: 14 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <button className="tap" onClick={function() { let m = calMonth - 1, y = calYear; if (m < 0) { m = 11; y--; } setCalMonth(m); setCalYear(y); }} style={S.wkBtn}>
            <Ic n="left" s={18} c="#64748b" />
          </button>
          <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>{MONTHS[calMonth]} {calYear}</div>
          <button className="tap" onClick={function() { let m = calMonth + 1, y = calYear; if (m > 11) { m = 0; y++; } setCalMonth(m); setCalYear(y); }} style={S.wkBtn}>
            <Ic n="right" s={18} c="#64748b" />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 }}>
          {["L","M","X","J","V","S","D"].map(function(d) {
            return <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "#94a3b8", padding: "2px 0" }}>{d}</div>;
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
          {cells.map(function(d, idx) {
            if (!d) return <div key={"e" + idx} />;
            const dk = dateKey(d), isTod = dk === todayKey(), isSel = dk === editDk, n = slotCount(dk);
            return (
              <div key={dk} className="tap" onClick={function() { setEditDk(dk); }}
                style={{ borderRadius: 8, padding: "5px 2px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: isSel ? "#1e3a5f" : isTod ? "#dbeafe" : "#f8fafc", border: "2px solid " + (isSel ? "#1e3a5f" : isTod ? "#93c5fd" : "transparent"), cursor: "pointer", minHeight: 46 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: isSel ? "#fff" : isTod ? "#1e40af" : "#334155", lineHeight: 1.2 }}>{d.getDate()}</span>
                {n > 0
                  ? <span style={{ fontSize: 9, fontWeight: 700, color: isSel ? "rgba(255,255,255,.9)" : "#2563eb", lineHeight: 1 }}>{n}fr</span>
                  : <span style={{ fontSize: 9, color: isSel ? "rgba(255,255,255,.4)" : "#cbd5e1", lineHeight: 1 }}>–</span>
                }
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#94a3b8", textAlign: "center" }}>Toca un día para editar su horario</div>
      </div>

      {/* CONFIGURACION DE DURACIONES */}
      <DurationEditor durations={durations} setDurations={setDurations} />

      <div style={Object.assign({}, S.card, { marginBottom: 90 })}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>
              {DAYS_LONG[parseD(editDk).getDay()]} {parseD(editDk).getDate()} {MONTHS[parseD(editDk).getMonth()]}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
              {selSlots.length === 0 ? "Día libre" : selSlots.length + " franja" + (selSlots.length > 1 ? "s" : "") + " · slots cada 50 min"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {selSlots.length > 0 && (
              <button className="tap" onClick={function() { clearDay(editDk); }}
                style={{ background: "#fee2e2", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, color: "#dc2626", fontWeight: 600 }}>
                Limpiar
              </button>
            )}
            <button className="tap" onClick={function() { addSlot(editDk); }}
              style={{ background: "#dbeafe", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, color: "#1e40af", fontWeight: 600 }}>
              + Franja
            </button>
          </div>
        </div>

        {selSlots.length === 0 && (
          <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 14, padding: "16px 0", fontStyle: "italic" }}>
            Día libre · pulsa "+ Franja" para añadir horario
          </div>
        )}

        {selSlots.map(function(slot, i) {
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 10, display: "flex", alignItems: "center", padding: "9px 12px", gap: 8 }}>
                <Ic n="clock" s={15} c="#94a3b8" />
                <input type="time" value={slot.start}
                  onChange={function(e) { updateSlot(editDk, i, "start", e.target.value); }}
                  style={{ border: "none", background: "transparent", fontSize: 15, color: "#1e293b", width: 76 }} />
                <span style={{ color: "#94a3b8", fontWeight: 700, fontSize: 16 }}>–</span>
                <input type="time" value={slot.end}
                  onChange={function(e) { updateSlot(editDk, i, "end", e.target.value); }}
                  style={{ border: "none", background: "transparent", fontSize: 15, color: "#1e293b", width: 76 }} />
              </div>
              <button className="tap" onClick={function() { removeSlot(editDk, i); }}
                style={{ background: "#fee2e2", border: "none", borderRadius: 10, padding: "11px", cursor: "pointer" }}>
                <Ic n="x" s={14} c="#dc2626" />
              </button>
            </div>
          );
        })}

        {selSlots.length > 0 && (
          <div style={{ marginTop: 10, padding: "10px 12px", background: "#f0fdf4", borderRadius: 10, fontSize: 13, color: "#15803d", display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700 }}>🕐 Franjas:</span>
            {selSlots.map(function(s, i) {
              return <span key={i} style={{ background: "#dcfce7", borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>{s.start}–{s.end}</span>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// ESTILOS GLOBALES
// =============================================================================
const globalCss = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { font-family: 'DM Sans', sans-serif; background: #f0f4f8; }
  input, select, button { font-family: inherit; }
  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
  .tap { cursor: pointer; transition: transform 0.1s; }
  .tap:active { transform: scale(0.95); }
  input:focus, select:focus { outline: none; }
`;

// =============================================================================
// OBJETO DE ESTILOS
// =============================================================================
const S = {
  root:       { maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#f0f4f8", display: "flex", flexDirection: "column", fontFamily: "'DM Sans', sans-serif", paddingBottom: 80 },
  hdr:        { background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "12px 16px", position: "sticky", top: 0, zIndex: 100 },
  hdrRow:     { display: "flex", justifyContent: "space-between", alignItems: "center" },
  hdrTitle:   { fontSize: 22, fontWeight: 700, color: "#1e293b", lineHeight: 1.1 },
  hdrSub:     { fontSize: 12, color: "#94a3b8", fontWeight: 500 },
  iconBtn:    { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  toast:      { position: "fixed", top: 78, left: "50%", transform: "translateX(-50%)", color: "#fff", borderRadius: 20, padding: "8px 18px", fontSize: 14, fontWeight: 600, zIndex: 200, boxShadow: "0 4px 16px rgba(0,0,0,.2)", whiteSpace: "nowrap" },
  weekRow:    { display: "flex", alignItems: "center", gap: 4, padding: "10px 12px 6px", background: "#fff", borderBottom: "1px solid #f1f5f9" },
  wkBtn:      { background: "none", border: "none", padding: 6, cursor: "pointer", borderRadius: 8 },
  dayPill:    { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 2px", borderRadius: 12, flex: 1, cursor: "pointer" },
  dayPillSel: { background: "#1e3a5f" },
  dayPillTod: { background: "#dbeafe" },
  content:    { padding: 16, flex: 1, overflowY: "auto" },
  card:       { background: "#fff", borderRadius: 18, padding: 18, boxShadow: "0 1px 6px rgba(0,0,0,.07)" },
  cardTitle:  { fontSize: 20, fontWeight: 700, color: "#1e293b", marginBottom: 18 },
  empty:      { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 0" },
  gridWrap:   { background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,.06)" },
  colHdrs:    { display: "flex", borderBottom: "2px solid #e2e8f0" },
  timeGutter: { width: 48, flexShrink: 0 },
  colHdr:     { flex: 1, textAlign: "center", padding: "8px 4px", fontSize: 13, fontWeight: 700 },
  gridScroll: { overflowY: "auto", maxHeight: "calc(100vh - 310px)", position: "relative", padding: "2px 4px 8px 0" },
  aptBlock:   { position: "absolute", borderRadius: 8, padding: "3px 6px", cursor: "pointer", overflow: "hidden", zIndex: 2 },
  inp:        { border: "none", background: "transparent", flex: 1, fontSize: 16, color: "#1e293b", width: "100%" },
  typeBtn:    { flex: 1, padding: "10px 4px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#475569", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  typeInfo:   { marginTop: 8, padding: "8px 12px", background: "#f8fafc", borderRadius: 10, borderLeft: "3px solid #2563eb", fontSize: 13, color: "#475569" },
  conflictBox:{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: 14, marginBottom: 8 },
  saveBtn:    { flex: 2, background: "#1e3a5f", color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 16, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%" },
  cancelBtn:  { flex: 1, background: "#f1f5f9", color: "#475569", border: "none", borderRadius: 12, padding: 14, fontSize: 15, fontWeight: 600, cursor: "pointer", width: "100%" },
  overlay:    { position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  modal:      { background: "#fff", borderRadius: "20px 20px 0 0", padding: 24, width: "100%", maxWidth: 430, boxShadow: "0 -4px 20px rgba(0,0,0,.15)" },
  modalTitle: { fontSize: 18, fontWeight: 700, color: "#1e293b", marginBottom: 6 },
  nav:        { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "#fff", borderTop: "1px solid #e2e8f0", display: "flex", padding: "8px 0 12px", zIndex: 100 },
  navBtn:     { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: "4px 0" },
};
