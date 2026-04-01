import { useCallback, useEffect, useState } from "react";
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
const SENSOR_URL = `${API_BASE}/sensor_profile`;
const POLL_MS = 1000;
const HISTORY_MAX = 30;

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
  };
}

export default function EdgeDashboard() {
  const [series, setSeries] = useState([]);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [metricsError, setMetricsError] = useState(null);
  const [strategyError, setStrategyError] = useState(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [activeProfile, setActiveProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [resStrat, resSensor] = await Promise.all([
          fetch(STRATEGY_URL, { headers: { Accept: "application/json" } }),
          fetch(SENSOR_URL, { headers: { Accept: "application/json" } })
        ]);

        if (resStrat.ok) {
          const body = await resStrat.json();
          if (!cancelled && body.strategy) setActiveStrategy(body.strategy);
        }
        if (resSensor.ok) {
          const body = await resSensor.json();
          if (!cancelled && body.profile) setActiveProfile(body.profile);
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

        setSeries((prev) => {
          const next = [
            ...prev,
            {
              t: label,
              cpu: m.cpuPercent,
              latency: m.latencyMs,
              throughput: m.throughput,
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
    if (key === "polling") {
      return activeStrategy === "polling" ? `${base} slot-active-polling` : `${base} hover:border-red-500/50 hover:text-red-400`;
    }
    if (key === "interrupt") {
      return activeStrategy === "interrupt" ? `${base} slot-active-interrupt` : `${base} hover:border-blue-500/50 hover:text-blue-400`;
    }
    if (key === "dma") {
      return activeStrategy === "dma" ? `${base} slot-active-dma` : `${base} hover:border-purple-500/50 hover:text-purple-400`;
    }
    return base;
  };

  const getProfileClass = (key) => {
    const base = "slot-base w-full";
    if (key === "temperature") {
      return activeProfile === "temperature" ? `${base} slot-active-polling` : `${base} hover:border-orange-500/50 hover:text-orange-400`;
    }
    if (key === "camera") {
      return activeProfile === "camera" ? `${base} slot-active-interrupt` : `${base} hover:border-cyan-500/50 hover:text-cyan-400`;
    }
    return base;
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
            <strong>STRATEGY ERROR:</strong> {strategyError}
          </div>
        )}

        {metricsError && (
          <div className="rounded bg-yellow-950/40 border border-yellow-900/50 px-4 py-3 text-xs text-yellow-400 flex items-center gap-3">
            <div className="terminal-dot bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.8)]"></div>
            <strong>METRICS UNAVAILABLE:</strong> {metricsError} — Charts show last known data.
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
                  Control Panel
                </span>
                <span className="ml-auto text-[10px] tracking-widest text-gray-600">
                  {activeStrategy ? "ONLINE" : "IDLE"}
                </span>
              </div>
              <div className="p-4 flex flex-col gap-6 flex-1">
                <div>
                  <span className="text-[10px] text-gray-500 mb-3 tracking-widest block font-bold">I/O STRATEGY</span>
                  <div className="grid grid-cols-1 gap-3">
                    <button
                      type="button"
                      disabled={strategyLoading}
                      className={getBtnClass("polling")}
                      onClick={() => postStrategy("polling")}
                    >
                      POLLING
                    </button>
                    <button
                      type="button"
                      disabled={strategyLoading}
                      className={getBtnClass("interrupt")}
                      onClick={() => postStrategy("interrupt")}
                    >
                      INTERRUPTS
                    </button>
                    <button
                      type="button"
                      disabled={strategyLoading}
                      className={getBtnClass("dma")}
                      onClick={() => postStrategy("dma")}
                    >
                      DMA
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-800/80">
                  <span className="text-[10px] text-gray-500 mb-3 tracking-widest block font-bold">HARDWARE / SENSOR</span>
                  <div className="grid grid-cols-1 gap-3">
                    <button
                      type="button"
                      disabled={profileLoading}
                      className={getProfileClass("temperature")}
                      onClick={() => postProfile("temperature")}
                    >
                      [TEMP] LOW-FREQ
                    </button>
                    <button
                      type="button"
                      disabled={profileLoading}
                      className={getProfileClass("camera")}
                      onClick={() => postProfile("camera")}
                    >
                      [CAM] HIGH-BW
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-800/80">
                  <span className="text-[10px] text-gray-500 mb-3 block tracking-widest font-bold">ACTIVE PROCESS</span>
                  <div className="bg-[#0a0f18]/50 border border-gray-800 rounded p-4 text-[11px] text-gray-400 leading-relaxed shadow-inner min-h-[6rem] flex flex-col justify-center">
                    {activeStrategy === 'polling' && <p className="text-red-400 font-medium neon-text-red">{'>>'} Continuous checking of registers. High CPU usage. Blocking paradigm.</p>}
                    {activeStrategy === 'interrupt' && <p className="text-blue-400 font-medium neon-text-blue">{'>>'} Event-driven. CPU sleeps/freed until hardware sensor triggers an IRQ line.</p>}
                    {activeStrategy === 'dma' && <p className="text-purple-400 font-medium neon-text-purple">{'>>'} Direct Memory Access. Hardware controller handles transfer. Zero CPU overhead.</p>}
                    {!activeStrategy && <p className="opacity-50 text-center uppercase tracking-widest">Awaiting strategy<span className="animate-pulse">...</span></p>}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Graphs */}
          <div className="lg:col-span-9 flex flex-col gap-6">
             <div className="w-full">
                <DashboardPanel title="SYSTEM RESOURCES - CPU" dotColor={activeStrategy === 'polling' ? 'red' : 'green'}>
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">CPU USAGE (%)</span>
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

             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <DashboardPanel title="NETWORK.LATENCY" dotColor="blue">
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">LATENCY (ms)</span>
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
                        formatter={(v) => [`${Number(v).toFixed(2)} ms`, "Latency"]}
                      />
                      <Line type="stepAfter" dataKey="latency" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </DashboardPanel>

                <DashboardPanel title="DB.THROUGHPUT" dotColor="purple">
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] text-gray-500 tracking-widest font-bold">THROUGHPUT (rows/s)</span>
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
                        formatter={(v) => [`${Number(v).toFixed(2)} /s`, "Throughput"]}
                      />
                      <Bar dataKey="throughput" fill="#a855f7" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                    </BarChart>
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
