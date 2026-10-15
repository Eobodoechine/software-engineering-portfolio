'use client';

import { useState, useEffect } from 'react';

export default function TestProgressPage() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [address, setAddress] = useState('123 Example Drive, Example City, AL 35000');
  const [loading, setLoading] = useState(false);

  // Poll for job status
  useEffect(() => {
    if (!jobId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/analyze/status/${jobId}`);
        const data = await res.json();
        setStatus(data);

        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(interval);
        }
      } catch (error) {
        console.error('Failed to fetch status:', error);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [jobId]);

  const submitJob = async () => {
    setLoading(true);
    setJobId(null);
    setStatus(null);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address })
      });

      const data = await res.json();
      if (data.jobId) {
        setJobId(data.jobId);
      } else {
        alert('Failed to create job: ' + (data.error || 'Unknown error'));
      }
    } catch (error: any) {
      alert('Failed to submit: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;

    try {
      await fetch(`/api/analyze/cancel/${jobId}`, { method: 'POST' });
      alert('Cancellation requested');
    } catch (error: any) {
      alert('Failed to cancel: ' + error.message);
    }
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1 style={{ marginBottom: '30px' }}>🧪 Progress Tracking Test</h1>

      <div style={{ marginBottom: '20px' }}>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Enter property address"
          style={{
            width: '100%',
            padding: '12px',
            fontSize: '16px',
            border: '2px solid #ddd',
            borderRadius: '8px'
          }}
        />
      </div>

      <div style={{ marginBottom: '30px' }}>
        <button
          onClick={submitJob}
          disabled={loading || !!jobId}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            backgroundColor: loading || jobId ? '#ccc' : '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: loading || jobId ? 'not-allowed' : 'pointer',
            marginRight: '10px'
          }}
        >
          {loading ? 'Submitting...' : 'Start Analysis'}
        </button>

        {jobId && status?.status !== 'completed' && status?.status !== 'failed' && (
          <button
            onClick={cancelJob}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              backgroundColor: '#ff4444',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {jobId && (
        <div
          style={{
            padding: '20px',
            backgroundColor: '#f5f5f5',
            borderRadius: '12px',
            border: '2px solid #ddd'
          }}
        >
          <div style={{ marginBottom: '15px' }}>
            <strong>Job ID:</strong> <code>{jobId}</code>
          </div>

          {status && (
            <>
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <strong>Progress:</strong>
                  <span>{status.progress || 0}%</span>
                </div>
                <div
                  style={{
                    width: '100%',
                    height: '30px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '15px',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${status.progress || 0}%`,
                      height: '100%',
                      backgroundColor: status.status === 'failed' ? '#ff4444' : '#0070f3',
                      transition: 'width 0.5s ease',
                      borderRadius: '15px'
                    }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '10px' }}>
                <strong>Status:</strong>{' '}
                <span
                  style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor:
                      status.status === 'completed'
                        ? '#00cc66'
                        : status.status === 'failed'
                        ? '#ff4444'
                        : '#ffaa00',
                    color: 'white',
                    fontWeight: 'bold'
                  }}
                >
                  {status.status}
                </span>
              </div>

              {status.phase && (
                <div style={{ marginBottom: '10px' }}>
                  <strong>Phase:</strong> {status.phase}
                </div>
              )}

              {status.phaseMessage && (
                <div style={{ marginBottom: '10px', fontStyle: 'italic', color: '#666' }}>
                  {status.phaseMessage}
                </div>
              )}

              {status.estimatedTimeRemaining !== undefined && status.estimatedTimeRemaining > 0 && (
                <div style={{ marginBottom: '10px' }}>
                  <strong>ETA:</strong> ~{status.estimatedTimeRemaining} seconds
                </div>
              )}

              {status.error && (
                <div
                  style={{
                    marginTop: '15px',
                    padding: '10px',
                    backgroundColor: '#ffebee',
                    borderRadius: '8px',
                    color: '#c62828'
                  }}
                >
                  <strong>Error:</strong> {status.error}
                </div>
              )}

              {status.status === 'completed' && status.result && (
                <div
                  style={{
                    marginTop: '15px',
                    padding: '15px',
                    backgroundColor: '#e8f5e9',
                    borderRadius: '8px'
                  }}
                >
                  <strong>✅ Analysis Complete!</strong>
                  <div style={{ marginTop: '10px' }}>
                    <div>Address: {status.result.subject?.address}</div>
                    <div>Comparables Found: {status.result.qualified_comps?.length || 0}</div>
                    {status.result.arv && (
                      <div>
                        ARV: ${status.result.arv.estimate?.toLocaleString()} ({status.result.arv.method})
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: '40px', padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px' }}>
        <h3>🎯 What to Test:</h3>
        <ul>
          <li>Submit a job and watch the progress bar update</li>
          <li>Check that phase messages update (e.g., "Fetching property details...")</li>
          <li>Verify estimated time remaining counts down</li>
          <li>Test the cancel button mid-analysis</li>
          <li>Check that progress goes from 0% → 100% through all phases</li>
        </ul>
      </div>
    </div>
  );
}
