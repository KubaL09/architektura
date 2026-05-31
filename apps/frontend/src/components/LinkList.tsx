import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { CreateLinkModal } from './CreateLinkModal.js';
import { Search, Plus, ExternalLink, Copy, Check, BarChart2, Trash2 } from 'lucide-react';

interface LinkRecord {
  id: string;
  short_code: string;
  original_url: string;
  campaign_name: string;
  client_id: string | null;
  expires_at: string | null;
  created_at: string;
}

interface ClientOption {
  id: string;
  email: string;
}

interface LinkListProps {
  onSelectStats: (linkId: string) => void;
}

export const LinkList: React.FC<LinkListProps> = ({ onSelectStats }) => {
  const { fetchWithAuth, user, apiUrl } = useAuth();
  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Search & Filter state
  const [search, setSearch] = useState('');
  const [selectedClient, setSelectedClient] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  // Pagination
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    fetchLinks();
  }, [page, selectedClient]);

  // Debounced search trigger
  useEffect(() => {
    const timer = setTimeout(() => {
      if (page === 1) fetchLinks();
      else setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (user?.role === 'marketer') {
      fetchClients();
    }
  }, [user]);

  const fetchClients = async () => {
    try {
      const res = await fetchWithAuth('/api/clients');
      if (res.ok) {
        const data = await res.json();
        setClients(data.data || []);
      }
    } catch (e) {
      console.error('Failed to fetch clients list', e);
    }
  };

  const fetchLinks = async () => {
    setLoading(true);
    try {
      let query = `?page=${page}&limit=${limit}`;
      if (search) query += `&search=${encodeURIComponent(search)}`;
      if (selectedClient && user?.role === 'marketer') {
        query += `&client_id=${selectedClient}`;
      }

      const res = await fetchWithAuth(`/api/links${query}`);
      if (res.ok) {
        const data = await res.json();
        setLinks(data.data || []);
        setTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to load links data', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (id: string, shortCode: string) => {
    const redirectUrl = `${apiUrl}/${shortCode}`;
    navigator.clipboard.writeText(redirectUrl);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;

    try {
      const res = await fetchWithAuth(`/api/links/${deleteConfirmId}`, {
        method: 'DELETE'
      });

      if (res.ok) {
        setDeleteConfirmId(null);
        fetchLinks();
      }
    } catch (e) {
      console.error('Failed to soft delete link', e);
    }
  };

  const isExpired = (expiry: string | null) => {
    if (!expiry) return false;
    return new Date(expiry) < new Date();
  };

  const formatExpiry = (expiry: string | null) => {
    if (!expiry) return 'Never';
    const date = new Date(expiry);
    if (date < new Date()) {
      return <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>Expired</span>;
    }
    return date.toLocaleDateString();
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      {/* Dashboard Top Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '2rem',
        flexWrap: 'wrap',
        gap: '1rem'
      }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, fontFamily: 'var(--font-heading)' }}>
            Campaign Links
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
            {user?.role === 'marketer' ? 'Manage and track shortcodes across campaigns' : 'View click stats for your active campaigns'}
          </p>
        </div>

        {user?.role === 'marketer' && (
          <button
            onClick={() => setCreateOpen(true)}
            className="btn btn-primary"
          >
            <Plus size={16} />
            <span>New Link</span>
          </button>
        )}
      </div>

      {/* Filters Bar Panel */}
      <div className="glass-panel" style={{
        padding: '1rem',
        marginBottom: '1.5rem',
        display: 'flex',
        gap: '1rem',
        alignItems: 'center',
        flexWrap: 'wrap'
      }}>
        {/* Search Bar Input */}
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={16} color="var(--text-muted)" style={{
            position: 'absolute',
            left: '1rem',
            top: '50%',
            transform: 'translateY(-50%)'
          }} />
          <input
            type="text"
            className="form-input"
            placeholder="Search campaign name, URL, or shortcode..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: '2.5rem' }}
          />
        </div>

        {/* Client dropdown filter (Marketer only) */}
        {user?.role === 'marketer' && (
          <div style={{ minWidth: '200px' }}>
            <select
              className="form-input"
              value={selectedClient}
              onChange={(e) => setSelectedClient(e.target.value)}
              style={{ appearance: 'none' }}
            >
              <option value="">All Agency Clients</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.email}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Campaign List Area */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : links.length === 0 ? (
        <div className="glass-panel" style={{
          padding: '4rem 2rem',
          textAlign: 'center',
          color: 'var(--text-secondary)'
        }}>
          <p style={{ fontSize: '1.125rem', fontWeight: 500, marginBottom: '0.5rem' }}>No campaign links found</p>
          <p style={{ fontSize: '0.875rem' }}>Try modifying search parameters or create a new campaign link.</p>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign Name</th>
                  <th>Short Link</th>
                  <th>Destination URL</th>
                  <th>Expires</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id} style={{ opacity: isExpired(link.expires_at) ? 0.65 : 1 }}>
                    <td style={{ fontWeight: 600 }}>
                      {link.campaign_name}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ 
                          fontFamily: 'monospace', 
                          color: 'var(--color-primary-light)', 
                          fontWeight: 500 
                        }}>
                          {link.short_code}
                        </span>
                        
                        {/* Interactive Copy Button */}
                        <button
                          onClick={() => handleCopy(link.id, link.short_code)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: copiedId === link.id ? 'var(--color-success)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '0.25rem',
                            display: 'flex',
                            alignItems: 'center',
                            transition: 'var(--transition-fast)'
                          }}
                          title="Copy Link to Clipboard"
                        >
                          {copiedId === link.id ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', maxWidth: '300px' }}>
                        <span style={{ 
                          textOverflow: 'ellipsis', 
                          overflow: 'hidden', 
                          whiteSpace: 'nowrap',
                          fontSize: '0.875rem',
                          color: 'var(--text-secondary)'
                        }}>
                          {link.original_url}
                        </span>
                        <a 
                          href={link.original_url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}
                        >
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </td>
                    <td>
                      <span style={{ fontSize: '0.875rem' }}>
                        {formatExpiry(link.expires_at)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => onSelectStats(link.id)}
                          className="btn btn-secondary"
                          style={{ padding: '0.375rem 0.75rem', fontSize: '0.8125rem' }}
                          title="View Click Analytics"
                        >
                          <BarChart2 size={14} />
                          <span>Stats</span>
                        </button>
                        
                        {user?.role === 'marketer' && (
                          <button
                            onClick={() => setDeleteConfirmId(link.id)}
                            className="btn btn-danger"
                            style={{ padding: '0.375rem 0.5rem' }}
                            title="Soft Delete Link"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="pagination">
              <span className="pagination-info">
                Showing Page {page} of {totalPages} ({total} total campaigns)
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

      {/* Create New Link Slide-over Dialog */}
      <CreateLinkModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={fetchLinks}
      />

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ padding: '2rem', maxWidth: '420px', textAlign: 'center' }}>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'white' }}>Soft Delete Campaign?</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
              This will immediately deactivate the short redirect code. The campaign link will no longer resolve, but statistical database records will be preserved.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setDeleteConfirmId(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDelete}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
