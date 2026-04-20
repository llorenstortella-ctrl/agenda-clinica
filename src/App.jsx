// ==========================
// 🔥 VERSION ESTABLE FIXED
// ==========================

import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

// ==========================
// CONFIG
// ==========================
const FISIO_PHONE = "34600000000";

// ==========================
// HELPERS BASE
// ==========================
function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function toMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function dateKey(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10);
}

function todayKey() {
  return dateKey(new Date());
}

// ==========================
// APP
// ==========================
export default function App() {
  const [appointments, setApts] = useState([]);
  const [loading, setLoading] = useState(true);

  // ==========================
  // LOAD
  // ==========================
  useEffect(() => {
    async function load() {
      try {
        const { data } = await supabase.from("appointments").select("*");
        setApts(data || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ==========================
  // CRUD SAFE
  // ==========================

  async function addAppointment(apt) {
    try {
      await supabase.from("appointments").insert([apt]);

      setApts(prev => {
        const exists = prev.find(a => a.id === apt.id);
        if (exists) return prev;
        return [...prev, apt];
      });

    } catch (e) {
      console.error(e);
    }
  }

  async function updateAppointment(apt) {
    try {
      await supabase.from("appointments")
        .update(apt)
        .eq("id", apt.id);

      setApts(prev =>
        prev.map(a => (a.id === apt.id ? apt : a))
      );

    } catch (e) {
      console.error(e);
    }
  }

  async function deleteAppointment(id) {
    try {
      await supabase.from("appointments")
        .delete()
        .eq("id", id);

      setApts(prev => prev.filter(a => a.id !== id));

    } catch (e) {
      console.error(e);
    }
  }

  // ==========================
  // UI SIMPLE (base tuya)
  // ==========================
  if (loading) {
    return <div>Cargando...</div>;
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Agenda</h1>

      <button
        onClick={() => {
          const apt = {
            id: uid(),
            patient: "Test",
            date: todayKey(),
            time: "10:00",
            type: "fisio",
          };
          addAppointment(apt);
        }}
      >
        Añadir cita
      </button>

      <div style={{ marginTop: 20 }}>
        {appointments.map(a => (
          <div key={a.id} style={{ marginBottom: 10 }}>
            {a.patient} - {a.date} {a.time}

            <button onClick={() => deleteAppointment(a.id)}>
              ❌
            </button>

            <button
              onClick={() =>
                updateAppointment({ ...a, patient: "Editado" })
              }
            >
              ✏️
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}