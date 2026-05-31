import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { 
  ArrowLeft, 
  MousePointerClick, 
  Users, 
  TrendingUp, 
  Calendar, 
  MapPin, 
  Smartphone, 
  Globe,
  Loader2
} from 'lucide-react';
import { Line, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ArcElement
} from 'chart.js';
import type { ChartOptions } from 'chart.js';

// Register ChartJS modules
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ArcElement
);

interface LinkDetails {
  id: string;
  short_code: string;
  original_url: string;
  campaign_name: string;
  created_at: string;
}

interface ClickTimelineItem {
  timestamp: string;
  count: number;
}

interface CountryStats {
  country: string;
  count: number;
}

interface DeviceStats {
  device_type: string;
  count: number;
}

interface ReferrerStats {
  referrer: string;
  count: number;
}

interface StatsPayload {
  total_clicks: number;
  unique_clicks: number;
  clicks_over_time: ClickTimelineItem[];
  by_country: CountryStats[];
  by_device: DeviceStats[];
  by_referrer: ReferrerStats[];
}

interface StatsDashboardProps {
  linkId: string;
  onBack: () => void;
}

export const StatsDashboard: React.FC<StatsDashboardProps> = ({ linkId, onBack }) => {
  const { fetchWithAuth } = useAuth();
  
  // States
  const [link, setLink] = useState<LinkDetails | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters State
  const [period, setPeriod] = useState<'hour' | 'day' | 'week'>('day');
  const [rangeType, setRangeType] = useState<'7d' | '30d' | 'custom'>('7d');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    fetchLinkDetails();
  }, [linkId]);

  useEffect(() => {
    fetchStats();
  }, [linkId, period, rangeType, dateFrom, dateTo]);

  const fetchLinkDetails = async () => {
    try {
      const res = await fetchWithAuth(`/api/links/${linkId}`);
      if (res.ok) {
        const data = await res.json();
        setLink(data);
      }
    } catch (e) {
      console.error('Failed to load link details', e);
    }
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    setError(null);
    try {
      let query = `?period=${period}`;
      
      // Calculate date parameters
      if (rangeType === '7d') {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        query += `&date_from=${d.toISOString()}`;
      } else if (rangeType === '30d') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        query += `&date_from=${d.toISOString()}`;
      } else if (rangeType === 'custom') {
        if (dateFrom) {
          const fromDate = new Date(dateFrom);
          fromDate.setHours(0, 0, 0, 0);
          query += `&date_from=${fromDate.toISOString()}`;
        }
        if (dateTo) {
          const toDate = new Date(dateTo);
          toDate.setHours(23, 59, 59, 999);
          query += `&date_to=${toDate.toISOString()}`;
        }
      }

      const res = await fetchWithAuth(`/api/links/${linkId}/stats${query}`);
      
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to fetch statistics.');
      }

      const data = await res.json();
      setStats(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load statistical summaries.');
    } finally {
      setStatsLoading(false);
      setLoading(false);
    }
  };

  const getTimelineChartData = () => {
    if (!stats || !stats.clicks_over_time) return { labels: [], datasets: [] };

    // Format timestamps for label rendering depending on period
    const labels = stats.clicks_over_time.map(item => {
      const date = new Date(item.timestamp);
      if (period === 'hour') {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (period === 'week') {
        return `W${date.getMonth() + 1}/${date.getDate()}`;
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    });

    const datasetValues = stats.clicks_over_time.map(item => item.count);

    return {
      labels,
      datasets: [
        {
          label: 'Clicks',
          data: datasetValues,
          fill: true,
          borderColor: 'rgb(139, 92, 246)',
          backgroundColor: 'rgba(139, 92, 246, 0.15)',
          tension: 0.35,
          pointBackgroundColor: 'rgb(139, 92, 246)',
          pointBorderColor: '#0f172a',
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#fff',
          borderWidth: 2.5
        }
      ]
    };
  };

  const getDeviceChartData = () => {
    if (!stats || !stats.by_device) return { labels: [], datasets: [] };

    const labels = stats.by_device.map(d => d.device_type.toUpperCase());
    const data = stats.by_device.map(d => d.count);

    return {
      labels,
      datasets: [
        {
          data,
          backgroundColor: [
            'rgba(139, 92, 246, 0.8)',
            'rgba(59, 130, 246, 0.8)',
            'rgba(16, 185, 129, 0.8)'
          ],
          borderColor: '#0f172a',
          borderWidth: 2,
          hoverOffset: 4
        }
      ]
    };
  };

  // Timeline area options config
  const lineOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        titleFont: { family: 'Inter', weight: 'bold' },
        bodyFont: { family: 'Inter' },
        borderColor: 'rgba(255, 255, 255, 0.08)',
        borderWidth: 1,
        padding: 10,
        displayColors: false
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: 'hsl(215.4, 16.3%, 56.9%)', font: { family: 'Inter', size: 11 } }
      },
      y: {
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        border: { dash: [4, 4] },
        ticks: { 
          color: 'hsl(215.4, 16.3%, 56.9%)', 
          font: { family: 'Inter', size: 11 },
          stepSize: 1
        }
      }
    }
  };

  const doughnutOptions: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '70%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: 'hsl(215.4, 16.3%, 56.9%)',
          font: { family: 'Inter', size: 12 },
          padding: 15,
          usePointStyle: true
        }
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        borderColor: 'rgba(255, 255, 255, 0.08)',
        borderWidth: 1
      }
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '400px' }}>
        <Loader2 className="spinner" size={32} />
      </div>
    );
  }

  // Calculate unique clicks percentage ratio
  const engagementRatio = stats && stats.total_clicks > 0
    ? Math.round((stats.unique_clicks / stats.total_clicks) * 100)
    : 0;

  return (
    <div>
      {/* Back button and campaign details header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <button 
          onClick={onBack}
          className="btn btn-secondary"
          style={{ padding: '0.5rem 1rem' }}
        >
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>

        {link && (
          <div style={{ flex: 1, minWidth: '240px' }}>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, fontFamily: 'var(--font-heading)' }}>
              {link.campaign_name}
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
              Short code: <strong style={{ color: 'var(--color-primary-light)' }}>{link.short_code}</strong> &bull; Destination: {link.original_url}
            </p>
          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: '#f87171',
          borderRadius: 'var(--radius-md)',
          padding: '1rem',
          marginBottom: '1.5rem'
        }}>
          {error}
        </div>
      )}

      {/* Control panel filters: date range picker and time periodicity */}
      <div className="glass-panel" style={{
        padding: '1.25rem',
        marginBottom: '1.5rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1rem'
      }}>
        {/* Date Filters */}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Calendar size={16} color="var(--text-secondary)" />
          <button
            onClick={() => setRangeType('7d')}
            className={`btn ${rangeType === '7d' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
          >
            Last 7 Days
          </button>
          <button
            onClick={() => setRangeType('30d')}
            className={`btn ${rangeType === '30d' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
          >
            Last 30 Days
          </button>
          <button
            onClick={() => setRangeType('custom')}
            className={`btn ${rangeType === 'custom' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
          >
            Custom Range
          </button>

          {rangeType === 'custom' && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginLeft: '0.5rem' }}>
              <input
                type="date"
                className="form-input"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8125rem', width: '130px' }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>to</span>
              <input
                type="date"
                className="form-input"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8125rem', width: '130px' }}
              />
            </div>
          )}
        </div>

        {/* Time Bucket Periodicity */}
        <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(255,255,255,0.03)', padding: '0.25rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
          {(['hour', 'day', 'week'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: '0.375rem 0.75rem',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.8125rem',
                background: period === p ? 'var(--color-primary)' : 'transparent',
                color: period === p ? 'white' : 'var(--text-secondary)',
                transition: 'var(--transition-fast)'
              }}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Main Stats Summary Counters Grid */}
      {stats && (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1.5rem',
            marginBottom: '1.5rem'
          }}>
            {/* Card: Total clicks */}
            <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '1rem', position: 'relative', overflow: 'hidden' }}>
              <div style={{
                background: 'rgba(139, 92, 246, 0.12)',
                padding: '0.75rem',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-primary-light)'
              }}>
                <MousePointerClick size={24} />
              </div>
              <div>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Total Clicks
                </span>
                <h3 style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.25rem' }}>
                  {statsLoading ? '...' : stats.total_clicks}
                </h3>
              </div>
              {statsLoading && <Loader2 className="spinner" size={14} style={{ position: 'absolute', right: '1rem', top: '1rem' }} />}
            </div>

            {/* Card: Unique clicks */}
            <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '1rem', position: 'relative' }}>
              <div style={{
                background: 'rgba(59, 130, 246, 0.12)',
                padding: '0.75rem',
                borderRadius: 'var(--radius-md)',
                color: '#60a5fa'
              }}>
                <Users size={24} />
              </div>
              <div>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Unique Visitors
                </span>
                <h3 style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.25rem' }}>
                  {statsLoading ? '...' : stats.unique_clicks}
                </h3>
              </div>
            </div>

            {/* Card: Unique ratio percentage */}
            <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '1rem', position: 'relative' }}>
              <div style={{
                background: 'rgba(16, 185, 129, 0.12)',
                padding: '0.75rem',
                borderRadius: 'var(--radius-md)',
                color: '#34d399'
              }}>
                <TrendingUp size={24} />
              </div>
              <div>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Unique Clicks Ratio
                </span>
                <h3 style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.25rem' }}>
                  {statsLoading ? '...' : `${engagementRatio}%`}
                </h3>
              </div>
            </div>
          </div>

          {/* Timeline Chart Container Panel */}
          <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1.5rem 2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Clicks Timeline</h2>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                Activity aggregated by {period}
              </span>
            </div>
            <div style={{ height: '300px', position: 'relative' }}>
              {stats.clicks_over_time && stats.clicks_over_time.length > 0 ? (
                <Line data={getTimelineChartData()} options={lineOptions} />
              ) : (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-secondary)' }}>
                  No click activity recorded in this period.
                </div>
              )}
            </div>
          </div>

          {/* Double Columns: Devices Doughnut and Country breakdowns */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
            {/* Column A: Device Doughnut Graph */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Smartphone size={18} color="var(--color-primary-light)" />
                <span>Devices</span>
              </h2>
              <div style={{ flex: 1, height: '220px', position: 'relative' }}>
                {stats.by_device && stats.by_device.length > 0 ? (
                  <Doughnut data={getDeviceChartData()} options={doughnutOptions} />
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-secondary)' }}>
                    No device analytics available.
                  </div>
                )}
              </div>
            </div>

            {/* Column B: Countries breakdown bar-indicators */}
            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Globe size={18} color="var(--color-primary-light)" />
                <span>Top Countries</span>
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {stats.by_country && stats.by_country.length > 0 ? (
                  stats.by_country.map((c, index) => {
                    const pct = stats.total_clicks > 0 ? Math.round((c.count / stats.total_clicks) * 100) : 0;
                    return (
                      <div key={index}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                          <span style={{ fontWeight: 600, color: 'white' }}>{c.country === 'Unknown' ? 'Unknown/Proxy' : c.country}</span>
                          <span style={{ color: 'var(--text-secondary)' }}>{c.count} clicks ({pct}%)</span>
                        </div>
                        {/* Horizontal glass progress bar */}
                        <div style={{ height: '6px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-full)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                          <div style={{ 
                            height: '100%', 
                            width: `${pct}%`, 
                            background: 'linear-gradient(90deg, var(--color-primary) 0%, var(--color-primary-light) 100%)',
                            borderRadius: 'var(--radius-full)'
                          }} />
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                    No geolocated country statistics.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Referral Domains Breakdown Panel */}
          <div className="glass-panel">
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <MapPin size={18} color="var(--color-primary-light)" />
              <span>Top Referrers</span>
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {stats.by_referrer && stats.by_referrer.length > 0 ? (
                stats.by_referrer.map((r, index) => {
                  const pct = stats.total_clicks > 0 ? Math.round((r.count / stats.total_clicks) * 100) : 0;
                  return (
                    <div key={index}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                        <span style={{ fontWeight: 600, color: 'white' }}>{r.referrer}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{r.count} clicks ({pct}%)</span>
                      </div>
                      <div style={{ height: '6px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-full)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                        <div style={{ 
                          height: '100%', 
                          width: `${pct}%`, 
                          background: 'linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)',
                          borderRadius: 'var(--radius-full)'
                        }} />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                  No referrer metrics found.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default StatsDashboard;
