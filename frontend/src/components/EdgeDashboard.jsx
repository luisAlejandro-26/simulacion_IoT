import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_BASE = "http://localhost:8000";
const METRICS_URL = `${API_BASE}/metrics`;
const STRATEGY_URL = `${API_BASE}/strategy`;
const STRATEGIES_URL = `${API_BASE}/strategies`;
const SENSOR_URL = `${API_BASE}/sensor_profile`;
const SENSOR_PROFILES_URL = `${API_BASE}/sensor_profiles`;
const POLL_MS = 1000;
const HISTORY_MAX = 30;

/**
 * Paletas de colores para estrategias y sensores.
 * Si se agrega una nueva en el backend, se asigna un color cíclicamente.
 */
const STRATEGY_COLORS = ["red", "blue", "purple", "emerald", "amber", "cyan"];
const PROFILE_COLORS = ["orange", "cyan", "emerald", "amber", "rose", "indigo"];

const STRATEGY_LABELS = {
  polling: "POLLING",
  interrupt: "INTERRUPCIONES",
  dma: "DMA",
};

const PROFILE_LABELS = {
  temperature: "[TEMP] BAJA FREC.",
  camera: "[CAM] ALTO ANCHO DE BANDA",
};

const STRATEGY_DESCRIPTIONS = {
  polling: { color: "text-red-400 neon-text-red", text: ">> Consulta continua de registros. Alto uso de CPU. Paradigma bloqueante." },
  interrupt: { color: "text-blue-400 neon-text-blue", text: ">> Basado en eventos. El CPU duerme/queda libre hasta que el sensor dispara una línea IRQ." },
  dma: { color: "text-purple-400 neon-text-purple", text: ">> Acceso Directo a Memoria. El controlador de hardware gestiona la transferencia. Cero carga en CPU." },
};

/** Mapeo color nombre → clases Tailwind para botones dinámicos */
const COLOR_CLASSES = {
  red:     { active: "slot-active-polling",   hover: "hover:border-red-500/50 hover:text-red-400" },
  blue:    { active: "slot-active-interrupt",  hover: "hover:border-blue-500/50 hover:text-blue-400" },
  purple:  { active: "slot-active-dma",        hover: "hover:border-purple-500/50 hover:text-purple-400" },
  emerald: { active: "slot-active-interrupt",  hover: "hover:border-emerald-500/50 hover:text-emerald-400" },
  amber:   { active: "slot-active-polling",    hover: "hover:border-amber-500/50 hover:text-amber-400" },
  cyan:    { active: "slot-active-interrupt",  hover: "hover:border-cyan-500/50 hover:text-cyan-400" },
  orange:  { active: "slot-active-polling",    hover: "hover:border-orange-500/50 hover:text-orange-400" },
  rose:    { active: "slot-active-polling",    hover: "hover:border-rose-500/50 hover:text-rose-400" },
  indigo:  { active: "slot-active-interrupt",  hover: "hover:border-indigo-500/50 hover:text-indigo-400" },
};

/**
 * Normaliza la respuesta del backend (claves en español o inglés).
 */
function normalizeMetrics(raw) {
  return {
    cpuPercent: Number(raw.uso_cpu_porcentaje ?? raw.cpu_percent ?? 0),
    latencyMs: Number(raw.latencia_ms ?? raw.latency_ms ?? 0),
    throughput: Number(
      raw.throughput_por_segundo ?? raw.throughput_per_second ?? raw.throughput ?? 0
    ),
    interruptsTotal: Number(raw.interrupts_received ?? 0),
    dmaInterruptsTotal: Number(raw.dma_interrupts_received ?? 0),
    lostPackets: Number(raw.paquetes_perdidos ?? 0),
  };
}

export default function EdgeDashboard() {
  const [series, setSeries] = useState([]);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [metricsError, setMetricsError] = useState(null);
  const [strategyError, setStrategyError] = useState(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [activeProfile, setActiveProfile] = useState(null);
  const [availableProfiles, setAvailableProfiles] = useState([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const prevIrqRef = useRef({ interrupts: 0, dmaInterrupts: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [resStrat, resSensor, resStrategies, resProfiles] = await Promise.all([
          fetch(STRATEGY_URL, { headers: { Accept: "application/json" } }),
          fetch(SENSOR_URL, { headers: { Accept: "application/json" } }),
          fetch(STRATEGIES_URL, { headers: { Accept: "application/json" } }),
          fetch(SENSOR_PROFILES_URL, { headers: { Accept: "application/json" } }),
        ]);

        if (resStrat.ok) {
          const body = await resStrat.json();
          if (!cancelled && body.strategy) setActiveStrategy(body.strategy);
        }
        if (resSensor.ok) {
          const body = await resSensor.json();
          if (!cancelled && body.profile) setActiveProfile(body.profile);
        }
        if (resStrategies.ok) {
          const body = await resStrategies.json();
          if (!cancelled && body.strategies) setAvailableStrategies(body.strategies);
        }
        if (resProfiles.ok) {
          const body = await resProfiles.json();
          if (!cancelled && body.profiles) setAvailableProfiles(body.profiles);
        }
      } catch {
        /* backend down: leave null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchMetrics = async () => {
      try {
        const res = await fetch(METRICS_URL, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`Metrics HTTP ${res.status}`);
        }
        const raw = await res.json();
        if (cancelled) return;

        const m = normalizeMetrics(raw);
        const label = new Date().toLocaleTimeString();

        const prev = prevIrqRef.current;
        const irqDelta = Math.max(0, m.interruptsTotal - prev.interrupts);
        const dmaIrqDelta = Math.max(0, m.dmaInterruptsTotal - prev.dmaInterrupts);
        prevIrqRef.current = { interrupts: m.interruptsTotal, dmaInterrupts: m.dmaInterruptsTotal };

        setSeries((prev) => {
          const next = [
            ...prev,
            {
              t: label,
              cpu: m.cpuPercent,
              latency: m.latencyMs,
              throughput: m.throughput,
              irq: irqDelta,
              dmaIrq: dmaIrqDelta,
              lostPackets: m.lostPackets,
            },
          ];
          return next.length > HISTORY_MAX ? next.slice(-HISTORY_MAX) : next;
        });
        setMetricsError(null);
      } catch (e) {
        if (!cancelled) {
          setMetricsError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    fetchMetrics();
    const id = window.setInterval(fetchMetrics, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const postStrategy = useCallback(async (strategy) => {
    setStrategyError(null);
    setStrategyLoading(true);
    try {
      const res = await fetch(STRATEGY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ strategy }),
      });
      if (!res.ok) {
        throw new Error(`Strategy HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => ({}));
      setActiveStrategy(body.strategy ?? strategy);
    } catch (e) {
      setStrategyError(e instanceof Error ? e.message : String(e));
    } finally {
      setStrategyLoading(false);
    }
  }, []);

  const getBtnClass = (key) => {
    const base = "slot-base w-full";
    const idx = availableStrategies.indexOf(key);
    const colorName = STRATEGY_COLORS[idx % STRATEGY_COLORS.length] ?? "red";
    const classes = COLOR_CLASSES[colorName] ?? COLOR_CLASSES.red;
    return activeStrategy === key ? `${base} ${classes.active}` : `${base} ${classes.hover}`;
  };

  const getProfileClass = (key) => {
    const base = "slot-base w-full";
    const idx = availableProfiles.indexOf(key);
    const colorName = PROFILE_COLORS[idx % PROFILE_COLORS.length] ?? "orange";
    const classes = COLOR_CLASSES[colorName] ?? COLOR_CLASSES.orange;
    return activeProfile === key ? `${base} ${classes.active}` : `${base} ${classes.hover}`;
  };

  const postProfile = useCallback(async (profile) => {
    setStrategyError(null);
    setProfileLoading(true);
    try {
      const res = await fetch(SENSOR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) throw new Error(`Profile HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      setActiveProfile(body.profile ?? profile);
    } catch (e) {
      setStrategyError(e instanceof Error ? e.message : String(e));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const getThemeColor = () => {
    if (activeStrategy === 'polling') return '#ef4444'; // red-500
    if (activeStrategy === 'interrupt') return '#3b82f6'; // blue-500
    if (activeStrategy === 'dma') return '#a855f7'; // purple-500
    return '#6b7280'; // gray-500
  };

  const themeColor = getThemeColor();

  return (
    <div className="w-full flex flex-col gap-6">

        {strategyError && (
          <div className="rounded bg-red-950/40 border border-red-900/50 px-4 py-3 text-xs text-red-400 flex items-center gap-3">
            <div className="terminal-dot bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></div>
            <strong>ERROR DE ESTRATEGIA:</strong> {strategyError}
          </div>
        )}

        {metricsError && (
          <div className="rounded bg-yellow-950/40 border border-yellow-900/50 px-4 py-3 text-xs text-yellow-400 flex items-center gap-3">
            <div className="terminal-dot bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.8)]"></div>
            <strong>MÉTRICAS NO DISPONIBLES:</strong> {metricsError} — Se muestran los últimos datos conocidos.
          </div>
        )}

        {/* Dashboard Grid Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Column: Control Panel */}
          <div className="lg:col-span-3 flex flex-col gap-6">
            <div className="terminal-panel flex flex-col h-full">
              <div className="terminal-header rounded-t-lg">
                <div className="terminal-dot bg-red-500" />
                <div className="terminal-dot bg-yellow-500" />
                <div className="terminal-dot bg-green-500" />
                <span className="ml-2 text-xs text-gray-500 tracking-widest uppercase flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${activeStrategy ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-gray-500'}`}></div>
                  Panel de Control
                </span>
                <span className="ml-auto text-[10px] tracking-widest text-gray-600">
                  {activeStrategy ? "EN LÍNEA" : "INACTIVO"}
                </span>
              </div>
              <div className="p-4 flex flex-col gap-6 flex-1">
                <div>
                  <span className="text-[10px] text-gray-500 mb-3 tracking-widest block font-bold">ESTRATEGIA DE E/S</span>
                  <div className="grid grid-cols-1 gap-3">
                    {availableStrategies.map((key) => (
                      <button
                        key={key}
                        type="button"
                        disabled={strategyLoading}
                        className={getBtnClass(key)}
                        onClick={() => postStrategy(key)}
                      >
                        {STRATEGY_LABELS[key] ?? key.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-800/80">
                  <span className="text-[10px] text-gray-500 mb-3 tracking-widest block font-bold">HARDWARE / SENSOR</span>
                  <div className="grid grid-cols-1 gap-3">
                    {availableProfiles.map((key) => (
                      <button
                        key={key}
                        type="button"
                        disabled={profileLoading}
                        className={getProfileClass(key)}
                        onClick={() => postProfile(key)}
                      >
                        {PROFILE_LABELS[key] ?? key.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-800/80">
                  <span className="text-[10px] text-gray-500 mb-3 block tracking-widest font-bold">PROCESO ACTIVO</span>
                  <div className="bg-[#0a0f18]/50 border border-gray-800 rounded p-4 text-[11px] text-gray-400 leading-relaxed shadow-inner min-h-[6rem] flex flex-col justify-center">
                    {activeStrategy && STRATEGY_DESCRIPTIONS[activeStrategy] ? (
                      <p className={`${STRATEGY_DESCRIPTIONS[activeStrategy].color} font-medium`}>{STRATEGY_DESCRIPTIONS[activeStrategy].text}</p>
                    ) : activeStrategy ? (
                      <p className="text-gray-300 font-medium">{'>>'} Estrategia activa: {activeStrategy.toUpperCase()}</p>
                    ) : (
                      <p className="opacity-50 text-center uppercase tracking-widest">Esperando estrategia<span className="animate-pulse">...</span></p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Graphs */}
          <div className="lg:col-span-9 flex flex-col gap-6">
             <div className="w-full">
                <DashboardPanel title="RECURSOS DEL SISTEMA - CPU" dotColor={activeStrategy === 'polling' ? 'red' : 'green'}>
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">USO DE CPU (%)</span>
                    <span className={`text-2xl font-black ${activeStrategy === 'polling' ? 'neon-text-red text-red-500' : 'neon-text-green text-green-500'}`}>
                      {series.length ? Number(series[series.length-1].cpu).toFixed(1) : 0}%
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={series} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={themeColor} stopOpacity={0.6} />
                          <stop offset="100%" stopColor="#0a0f18" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 2" stroke="#1f2937" vertical={false} />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#4b5563" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#4b5563" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#02040a", border: "1px solid #1f2937", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace" }}
                        itemStyle={{ color: themeColor, fontWeight: "bold" }}
                        formatter={(v) => [`${Number(v).toFixed(2)}%`, "CPU"]}
                      />
                      <Area type="stepAfter" dataKey="cpu" stroke={themeColor} strokeWidth={2} fill="url(#cpuFill)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </DashboardPanel>
             </div>

             {activeStrategy && activeStrategy !== "polling" && (
               <div className="w-full">
                 <DashboardPanel title="LÍNEA DE TIEMPO IRQ" dotColor={activeStrategy === 'dma' ? 'purple' : 'blue'}>
                   <div className="flex items-center gap-4 mb-2">
                     <span className="text-[10px] text-gray-500 tracking-widest font-bold">SOLICITUDES DE INTERRUPCIÓN</span>
                     <span className="text-[10px] text-gray-600 tracking-wide">cada marca = IRQ disparada</span>
                   </div>
                   <div className="w-full overflow-hidden" style={{ height: 48 }}>
                     <div className="flex items-end h-full gap-[2px]">
                       {series.map((point, i) => {
                         const hasIrq = point.irq > 0;
                         const hasDmaIrq = point.dmaIrq > 0;
                         const active = hasIrq || hasDmaIrq;
                         const color = hasDmaIrq ? "#a855f7" : "#3b82f6";
                         return (
                           <div
                             key={i}
                             className="flex-1 flex flex-col items-center justify-end h-full"
                             title={active ? `${point.t} — IRQ` : point.t}
                           >
                             {active ? (
                               <div
                                 className="w-full rounded-sm"
                                 style={{
                                   height: 28,
                                   backgroundColor: color,
                                   boxShadow: `0 0 8px ${color}80`,
                                   opacity: 0.9,
                                 }}
                               />
                             ) : (
                               <div
                                 className="w-full rounded-sm"
                                 style={{ height: 4, backgroundColor: "#1f2937" }}
                               />
                             )}
                           </div>
                         );
                       })}
                     </div>
                   </div>
                 </DashboardPanel>
               </div>
             )}

             <div className="grid grid-cols-1 xl:grid-cols-3 lg:grid-cols-2 gap-6">
                <DashboardPanel title="RED.LATENCIA" dotColor="blue">
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">LATENCIA (ms)</span>
                    <span className="text-xl font-black text-blue-400 neon-text-blue">
                      {series.length ? Number(series[series.length-1].latency).toFixed(1) : 0}ms
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={series} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="2 2" stroke="#1f2937" vertical={false} />
                      <XAxis dataKey="t" tick={false} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "#4b5563" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#02040a", border: "1px solid #1f2937", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace" }}
                        itemStyle={{ color: "#3b82f6", fontWeight: "bold" }}
                        formatter={(v) => [`${Number(v).toFixed(2)} ms`, "Latencia"]}
                      />
                      <Line type="stepAfter" dataKey="latency" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </DashboardPanel>

                <DashboardPanel title="BD.RENDIMIENTO" dotColor="purple">
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">RENDIMIENTO (filas/s)</span>
                    <span className="text-xl font-black text-purple-400 neon-text-purple">
                      {series.length ? Number(series[series.length-1].throughput).toFixed(1) : 0}/s
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={series} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="2 2" stroke="#1f2937" vertical={false} />
                      <XAxis dataKey="t" tick={false} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "#4b5563" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#02040a", border: "1px solid #1f2937", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace" }}
                        itemStyle={{ color: "#a855f7", fontWeight: "bold" }}
                        cursor={{ fill: '#1f2937', opacity: 0.4 }}
                        formatter={(v) => [`${Number(v).toFixed(2)} /s`, "Rendimiento"]}
                      />
                      <Bar dataKey="throughput" fill="#a855f7" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </DashboardPanel>

                <DashboardPanel title="BUFFER.PAQUETES PERDIDOS" dotColor="red">
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">SOBREESCRITOS (Total)</span>
                    <span className="text-xl font-black text-red-500 neon-text-red">
                      {series.length ? Number(series[series.length-1].lostPackets) : 0}
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={series} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="lostFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#ef4444" stopOpacity={0.6} />
                          <stop offset="100%" stopColor="#0a0f18" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 2" stroke="#1f2937" vertical={false} />
                      <XAxis dataKey="t" tick={false} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "#4b5563" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#02040a", border: "1px solid #1f2937", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace" }}
                        itemStyle={{ color: "#ef4444", fontWeight: "bold" }}
                        formatter={(v) => [`${v} perdidos`, "Backpressure"]}
                      />
                      <Area type="stepAfter" dataKey="lostPackets" stroke="#ef4444" strokeWidth={2} fill="url(#lostFill)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </DashboardPanel>
             </div>
          </div>

        </div>
    </div>
  );
}

// Custom Panel Component wrapping the charts using global.css layers
function DashboardPanel({ title, dotColor = 'gray', children }) {
  const getDotClass = () => {
    switch(dotColor) {
      case 'red': return 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,1)]';
      case 'green': return 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,1)]';
      case 'yellow': return 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,1)]';
      case 'blue': return 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,1)]';
      case 'purple': return 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,1)]';
      default: return 'bg-gray-600 shadow-none';
    }
  };

  return (
    <div className="terminal-panel flex flex-col h-full">
      <div className="terminal-header rounded-t-lg">
        <div className="terminal-dot bg-red-500" />
        <div className="terminal-dot bg-yellow-500" />
        <div className="terminal-dot bg-green-500" />
        <span className="ml-2 text-xs text-gray-500 tracking-widest uppercase flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${getDotClass()}`}></div>
          {title}
        </span>
      </div>
      <div className="p-5 lg:p-6 flex-1 relative">
        {children}
      </div>
    </div>
  );
}
