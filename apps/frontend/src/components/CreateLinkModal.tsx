import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';

interface ClientOption {
  id: string;
  email: string;
}

interface CreateLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateLinkModal: React.FC<CreateLinkModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { fetchWithAuth } = useAuth();
  const [originalUrl, setOriginalUrl] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [clientId, setClientId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Compute boundaries for date input (Max 365 days from now)
  const todayString = new Date().toISOString().split('T')[0];
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 365);
  const maxDateString = maxDate.toISOString().split('T')[0];

  useEffect(() => {
    if (isOpen) {
      fetchClients();
      // Reset form states
      setOriginalUrl('');
      setCampaignName('');
      setClientId('');
      setExpiresAt('');
      setError(null);
    }
  }, [isOpen]);

  const fetchClients = async () => {
    try {
      const res = await fetchWithAuth('/api/clients');
      if (res.ok) {
        const data = await res.json();
        setClients(data.data || []);
      }
    } catch (err) {
      console.error('Failed to load clients list', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!originalUrl || !campaignName) {
      setError('Original URL and Campaign Name are required fields.');
      return;
    }

    // Basic URL format validation
    try {
      new URL(originalUrl);
    } catch (_) {
      setError('Provided string is not a valid HTTP/HTTPS URL.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const body: any = {
        original_url: originalUrl,
        campaign_name: campaignName
      };

      if (clientId) body.client_id = clientId;
      if (expiresAt) {
        // Convert to ISO 8601 string
        const expDate = new Date(expiresAt);
        expDate.setHours(23, 59, 59, 999);
        body.expires_at = expDate.toISOString();
      }

      const res = await fetchWithAuth('/api/links', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Failed to create shortcode campaign.');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to register link.');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '550px', padding: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, fontFamily: 'var(--font-heading)' }}>
            Create Short Campaign Link
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: '1.5rem',
              cursor: 'pointer',
              lineHeight: 1
            }}
            disabled={loading}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              color: '#f87171',
              borderRadius: 'var(--radius-md)',
              padding: '0.75rem 1rem',
              fontSize: '0.875rem',
              marginBottom: '1.25rem'
            }}>
              {error}
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="originalUrl">Original Long URL *</label>
            <input
              type="url"
              id="originalUrl"
              className="form-input"
              placeholder="https://example.com/some/long/marketing/campaign/url"
              value={originalUrl}
              onChange={(e) => setOriginalUrl(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="campaignName">Campaign Name *</label>
            <input
              type="text"
              id="campaignName"
              className="form-input"
              placeholder="Summer Newsletter 2026"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="client">Assign Client (Optional)</label>
              <select
                id="client"
                className="form-input"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={loading}
                style={{ appearance: 'none', background: 'rgba(15, 23, 42, 0.4)' }}
              >
                <option value="">No Client (Internal)</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.email}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="expiresAt">Expiration Date (Max 1 Year)</label>
              <input
                type="date"
                id="expiresAt"
                className="form-input"
                min={todayString}
                max={maxDateString}
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? 'Creating...' : 'Create Short URL'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
