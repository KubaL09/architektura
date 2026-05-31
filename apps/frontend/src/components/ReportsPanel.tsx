import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { 
  Plus, 
  Download, 
  Clock, 
  Loader2, 
  AlertCircle, 
  CheckCircle,
  FileText
} from 'lucide-react';

interface ClientOption {
  id: string;
  email: string;
}

interface LinkOption {
  id: string;
  campaign_name: string;
  short_code: string;
  client_id: string | null;
}

interface ReportRecord {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  date_from: string;
  date_to: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  client_id: string | null;
  link_id: string | null;
}

export const ReportsPanel: React.FC = () => {
  const { fetchWithAuth } = useAuth();

  // Metadata dropdown lists
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [links, setLinks] = useState<LinkOption[]>([]);
  const [history, setHistory] = useState<ReportRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Form inputs
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedClient, setSelectedClient] = useState('');
  const [selectedLink, setSelectedLink] = useState('');
  
  // States
  const [generatingReportId, setGeneratingReportId] = useState<string | null>(null);
  const [activeReportStatus, setActiveReportStatus] = useState<'pending' | 'processing' | 'done' | 'failed' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);

  // Pagination for history
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  // Polling ref/timer
  const pollingIntervalRef = useRef<any | null>(null);

  // Prefill default dates on mount (start of current month to today)
  useEffect(() => {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    setDateFrom(startOfMonth.toISOString().split('T')[0]);
    setDateTo(today.toISOString().split('T')[0]);

    fetchClients();
    fetchLinks();
    fetchHistory();

    return () => {
      clearActivePolling();
    };
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [page]);

  const clearActivePolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

  const fetchClients = async () => {
    try {
      const res = await fetchWithAuth('/api/clients');
      if (res.ok) {
        const data = await res.json();
        setClients(data.data || []);
      }
    } catch (e) {
      console.error('Failed to fetch clients', e);
    }
  };

  const fetchLinks = async () => {
    try {
      const res = await fetchWithAuth('/api/links?limit=100');
      if (res.ok) {
        const data = await res.json();
        setLinks(data.data || []);
      }
    } catch (e) {
      console.error('Failed to fetch links', e);
    }
  };

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetchWithAuth(`/api/reports?page=${page}&limit=${limit}`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data.data || []);
        setTotal(data.total || 0);
      }
    } catch (e) {
      console.error('Failed to load reports history', e);
    } finally {
      setHistoryLoading(false);
    }
  };

  const startPolling = (reportId: string) => {
    clearActivePolling();
    setGeneratingReportId(reportId);
    setActiveReportStatus('pending');

    // Poll status every 3 seconds
    pollingIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetchWithAuth(`/api/reports/${reportId}`);
        if (!res.ok) {
          clearActivePolling();
          setGeneratingReportId(null);
          setActiveReportStatus(null);
          return;
        }

        const data = await res.json();
        setActiveReportStatus(data.status);

        if (data.status === 'done' || data.status === 'failed') {
          clearActivePolling();
          setGeneratingReportId(null);
          setActiveReportStatus(null);
          fetchHistory(); // refresh history list
        }
      } catch (err) {
        console.error('Error during report status check', err);
      }
    }, 3000);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dateFrom || !dateTo) {
      setFormError('Start date and end date are required.');
      return;
    }

    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);
    if (fromDate > toDate) {
      setFormError('Start date cannot be later than end date.');
      return;
    }

    setFormError(null);
    setSubmitLoading(true);

    try {
      // Setup payload matching POST /api/reports kontrakt
      const payload: any = {
        date_from: fromDate.toISOString(),
        date_to: new Date(toDate.setHours(23, 59, 59, 999)).toISOString()
      };

      if (selectedClient) payload.client_id = selectedClient;
      if (selectedLink) payload.link_id = selectedLink;

      const res = await fetchWithAuth('/api/reports', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Failed to order report compilation.');
      }

      // 202 Accepted triggered, begin polling
      startPolling(data.report_id);
    } catch (err: any) {
      setFormError(err.message || 'An error occurred.');
    } finally {
      setSubmitLoading(false);
    }
  };

  // Secure token-authenticated PDF download helper
  const handleDownload = async (reportId: string) => {
    try {
      const res = await fetchWithAuth(`/api/reports/${reportId}/download`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to fetch file stream.');
      }

      // Convert stream to file blob
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report_${reportId}.pdf`;
      document.body.appendChild(a);
      a.click();
      
      // Teardown temp object elements
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || 'Failed to download report file.');
    }
  };

  const getClientEmail = (clientId: string | null) => {
    if (!clientId) return 'Global (All Campaigns)';
    const found = clients.find(c => c.id === clientId);
    return found ? found.email : 'Client Account';
  };

  const getCampaignName = (linkId: string | null) => {
    if (!linkId) return 'Aggregate Scope';
    const found = links.find(l => l.id === linkId);
    return found ? found.campaign_name : 'Specific Link';
  };

  const formatShortDate = (isoStr: string) => {
    return new Date(isoStr).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      {/* Title */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, fontFamily: 'var(--font-heading)' }}>
          Campaign Reports
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
          Schedule and generate printable A4 campaign statistics summaries in PDF
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', marginBottom: '2rem', alignItems: 'start' }}>
        
        {/* Form panel: request a new PDF */}
        <div className="glass-panel">
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} color="var(--color-primary-light)" />
            <span>Generate New Report</span>
          </h2>

          <form onSubmit={handleGenerate}>
            {formError && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                color: '#f87171',
                borderRadius: 'var(--radius-md)',
                padding: '0.75rem 1rem',
                fontSize: '0.875rem',
                marginBottom: '1.25rem'
              }}>
                {formError}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label" htmlFor="dateFrom">Date From *</label>
                <input
                  type="date"
                  id="dateFrom"
                  className="form-input"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  disabled={submitLoading || !!generatingReportId}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="dateTo">Date To *</label>
                <input
                  type="date"
                  id="dateTo"
                  className="form-input"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  disabled={submitLoading || !!generatingReportId}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="clientScope">Filter by Client (Optional)</label>
              <select
                id="clientScope"
                className="form-input"
                value={selectedClient}
                onChange={(e) => {
                  setSelectedClient(e.target.value);
                  setSelectedLink(''); // reset link selection
                }}
                disabled={submitLoading || !!generatingReportId}
                style={{ appearance: 'none' }}
              >
                <option value="">All Clients (Internal / Agencja)</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.email}</option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: '1.5rem' }}>
              <label className="form-label" htmlFor="linkScope">Filter by Specific Link (Optional)</label>
              <select
                id="linkScope"
                className="form-input"
                value={selectedLink}
                onChange={(e) => setSelectedLink(e.target.value)}
                disabled={submitLoading || !!generatingReportId}
                style={{ appearance: 'none' }}
              >
                <option value="">All Campaigns (Aggregated)</option>
                {links
                  .filter(l => !selectedClient || l.client_id === selectedClient)
                  .map(l => (
                    <option key={l.id} value={l.id}>{l.campaign_name} ({l.short_code})</option>
                  ))
                }
              </select>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitLoading || !!generatingReportId}
              style={{ width: '100%' }}
            >
              {submitLoading ? (
                <>
                  <Loader2 className="spinner" size={16} style={{ borderWidth: '2px' }} />
                  <span>Ordering report...</span>
                </>
              ) : (
                <>
                  <FileText size={16} />
                  <span>Compile PDF Report</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Polling progress display */}
        {generatingReportId && (
          <div className="glass-panel" style={{
            border: '1px solid rgba(139, 92, 246, 0.25)',
            boxShadow: 'var(--shadow-primary)',
            animation: 'fadeIn 0.3s ease-out'
          }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', color: 'white' }}>
              Active Compilation Task
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem 0' }}>
              <Loader2 className="spinner" size={32} />
              <div>
                <p style={{ fontWeight: 600, color: 'white' }}>Compiling PDF layout...</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', marginTop: '0.25rem' }}>
                  Status: <strong style={{ color: 'var(--color-primary-light)', textTransform: 'uppercase' }}>{activeReportStatus}</strong>
                </p>
              </div>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', lineHeight: 1.4, marginTop: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: 'var(--radius-sm)' }}>
              Headless Puppeteer is loading analytics datasets, compiling custom scalable vector SVG bar-charts, and building print-optimized A4 pages. We are polling the server status every 3 seconds.
            </p>
          </div>
        )}
      </div>

      {/* Reports compilation history list */}
      <div className="glass-panel">
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Clock size={18} color="var(--color-primary-light)" />
          <span>Compilation Logs & History</span>
        </h2>

        {historyLoading && history.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <Loader2 className="spinner" />
          </div>
        ) : history.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
            No report logs compiled yet.
          </div>
        ) : (
          <>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Requested Date</th>
                    <th>Client Scope</th>
                    <th>Campaign Scope</th>
                    <th>Report Range</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <span style={{ fontSize: '0.875rem' }}>
                          {new Date(h.created_at).toLocaleString()}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                          {getClientEmail(h.client_id)}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                          {getCampaignName(h.link_id)}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: '0.8125rem', fontFamily: 'monospace' }}>
                          {formatShortDate(h.date_from)} - {formatShortDate(h.date_to)}
                        </span>
                      </td>
                      <td>
                        {/* Dynamic Status Badges */}
                        {h.status === 'done' && (
                          <span className="badge badge-client" style={{ background: 'rgba(16,185,129,0.15)', color: '#34d399', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <CheckCircle size={10} />
                            <span>Done</span>
                          </span>
                        )}
                        {h.status === 'failed' && (
                          <span className="badge badge-client" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }} title={h.error_message || 'Task failed'}>
                            <AlertCircle size={10} />
                            <span>Failed</span>
                          </span>
                        )}
                        {(h.status === 'pending' || h.status === 'processing') && (
                          <span className="badge badge-client" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Loader2 size={10} className="spinner" style={{ animationDuration: '2s' }} />
                            <span>{h.status}</span>
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {h.status === 'done' ? (
                          <button
                            onClick={() => handleDownload(h.id)}
                            className="btn btn-primary"
                            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
                            title="Download PDF Document"
                          >
                            <Download size={14} />
                            <span>Download</span>
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary"
                            disabled
                            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
                          >
                            <Download size={14} />
                            <span>Download</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* History Pagination */}
            {totalPages > 1 && (
              <div className="pagination">
                <span className="pagination-info">
                  Showing logs page {page} of {totalPages} ({total} total records)
                </span>
                <div className="pagination-buttons">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPage(p => Math.max(p - 1, 1))}
                    disabled={page === 1}
                    style={{ padding: '0.5rem 1rem' }}
                  >
                    Previous
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPage(p => Math.min(p + 1, totalPages))}
                    disabled={page === totalPages}
                    style={{ padding: '0.5rem 1rem' }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ReportsPanel;
