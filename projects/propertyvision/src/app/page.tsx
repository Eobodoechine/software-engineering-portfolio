'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { Auth } from '@/components/Auth';
import { ArrowRight, ExternalLink, Loader2, MapPin } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchHistory } from '@/components/SearchHistory';
import { API_BASE_URL, cn } from '@/lib/utils';
import type { ComparableProperty, PropertyAnalysisResponse, SearchHistoryEntry } from '@/types/property';
import { useCountdown, useInterpolatedProgress } from '@/hooks/useJobProgress';

const DEFAULT_ADDRESS = '';

type FormState = {
  address: string;
};

// Note: This function needs access to setProgress and setJobStatus, so it will be defined inside HomePage component
function createAnalyzeProperty(
  setProgress: (progress: number) => void,
  setCurrentJobId: (jobId: string | null) => void,
  setJobStatus: (status: any) => void
) {
  return async function analyzeProperty(address: string): Promise<PropertyAnalysisResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 min timeout

    try {
      // Start async job
      const response = await fetch(`${API_BASE_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || 'Failed to start analysis');
      }

      const { jobId } = await response.json();
      setCurrentJobId(jobId);

      // Poll for results with backoff
      let pollInterval = 2000; // Start at 2 seconds for real-time ETA countdown
      return await new Promise<PropertyAnalysisResponse>((resolve, reject) => {
        const poll = async () => {
          try {
            const statusRes = await fetch(`${API_BASE_URL}/api/analyze/status/${jobId}`);

            if (!statusRes.ok) {
              reject(new Error('Failed to get job status'));
              return;
            }

            const status = await statusRes.json();
            setJobStatus(status); // Store full status object

            if (status.status === 'completed') {
              setCurrentJobId(null);
              window.history.replaceState(null, '', `?job=${encodeURIComponent(jobId)}`);
              resolve(status.result);
            } else if (status.status === 'failed') {
              setCurrentJobId(null);
              reject(new Error(status.error || 'Analysis failed'));
            } else {
              // Update progress
              setProgress(status.progress || 0);

              // Poll every 2 seconds for real-time ETA countdown
              setTimeout(poll, pollInterval);
            }
          } catch (error) {
            setCurrentJobId(null);
            reject(error);
          }
        };

        poll();
      });
    } catch (error) {
      clearTimeout(timeoutId);
      setCurrentJobId(null);
      throw error;
    }
  };
}

const confidenceStyles: Record<string, { label: string; className: string }> = {
  high: { label: 'High Confidence', className: 'bg-blue-100 text-blue-700 border-blue-200' },
  medium: { label: 'Medium Confidence', className: 'bg-amber-100 text-amber-700 border-amber-200' },
  low: { label: 'Low Confidence', className: 'bg-rose-100 text-rose-700 border-rose-200' }
};

const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function formatCurrency(value?: number | string | null, fallback = '—') {
  if (value === null || value === undefined) return fallback;
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return fallback;
  return formatter.format(Math.round(numeric as number));
}

function formatPpsf(price?: number | string | null, sqft?: number | string | null) {
  if (price === null || price === undefined || sqft === null || sqft === undefined) return '—';
  const priceNum = typeof price === 'string' ? Number(price) : price;
  const sqftNum = typeof sqft === 'string' ? Number(sqft) : sqft;
  if (!Number.isFinite(priceNum) || !Number.isFinite(sqftNum) || !sqftNum) return '—';
  return `$${Math.round(priceNum / sqftNum).toLocaleString()}`;
}

function formatDistance(distance?: number | string | null) {
  if (distance === null || distance === undefined) return '—';
  const value = typeof distance === 'string' ? Number(distance) : distance;
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(2)} miles`;
}

function formatSoldDate(date?: string) {
  if (!date) return '—';
  return date.slice(0, 10);
}

export default function HomePage() {
  const { user, loading: authLoading } = useAuth();
  const [formState, setFormState] = React.useState<FormState>({ address: DEFAULT_ADDRESS });
  const [progress, setProgress] = React.useState(0);
  const [selectedResult, setSelectedResult] = React.useState<PropertyAnalysisResponse | null>(null);
  const [currentJobId, setCurrentJobId] = React.useState<string | null>(null);
  const [jobStatus, setJobStatus] = React.useState<any>(null);

  const analyzeProperty = React.useMemo(
    () => createAnalyzeProperty(setProgress, setCurrentJobId, setJobStatus),
    [setProgress, setCurrentJobId, setJobStatus]
  );

  const mutation = useMutation<PropertyAnalysisResponse, Error, string>({
    mutationFn: analyzeProperty,
    onSettled: () => {
      setProgress(0);
      setCurrentJobId(null);
    }
  });

  const autoLoadRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    autoLoadRef.current = controller;
    const loadReport = (jobId: string) => {
      fetch(`${API_BASE_URL}/api/analyze/status/${jobId}`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then(saved => {
          if (controller.signal.aborted) return;
          if (saved?.status === 'completed' && saved.result?.subject) {
            setSelectedResult(saved.result);
            setFormState({ address: saved.result.subject.address });
          }
        }).catch(() => {});
    };

    const savedJob = new URLSearchParams(window.location.search).get('job');
    if (savedJob && /^[a-f0-9-]{36}$/i.test(savedJob)) {
      loadReport(savedJob);
    } else {
      // A shared link carries no job id, so the bare URL opens the newest finished report.
      fetch(`${API_BASE_URL}/api/analyze/latest`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then(latest => { if (latest?.jobId) loadReport(latest.jobId); })
        .catch(() => {});
    }

    return () => {
      controller.abort();
      if (autoLoadRef.current === controller) autoLoadRef.current = null;
    };
  }, []);

  // Progress is now updated by the polling mechanism in analyzeProperty

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = formState.address.trim();
    if (!address) return;
    setSelectedResult(null);
    // A newest-report load still in flight would otherwise land on top of this run.
    autoLoadRef.current?.abort();
    window.history.replaceState(null, '', window.location.pathname);
    mutation.mutate(address);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormState(prev => ({ ...prev, address: event.target.value }));
  };

  const handleSelectSearch = (search: SearchHistoryEntry) => {
    if (search.result) {
      // Load the saved search result
      setSelectedResult(search.result);
      setFormState({ address: search.address });
    }
  };

  const result = selectedResult || mutation.data;
  const loading = mutation.isPending;
  const error = mutation.isError ? (mutation.error as Error) : null;

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Auth />;
  }

  return (
    <main className="w-full">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pb-16 pt-10 md:px-6 lg:flex-row">
        <div className="flex-1 space-y-8">
          <Header />

          <Card className="border-0 bg-white/90 shadow-lg shadow-slate-200/40 backdrop-blur">
            <CardHeader className="gap-3">
              <CardTitle className="text-2xl font-semibold">Analyze Property</CardTitle>
              <CardDescription className="text-slate-500">
                Enter a full street address to generate ARV, property insights, and comparable sales.
                <br />
                <span className="text-xs text-slate-400 mt-1 block">Full analysis can take several minutes.</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3 md:flex-row" onSubmit={handleSubmit}>
                <Input
                  aria-label="Street address"
                  placeholder="Enter address"
                  value={formState.address}
                  onChange={handleChange}
                  disabled={loading}
                />
                <Button type="submit" className="md:w-44" disabled={loading}>
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Analyzing...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      Analyze Property
                      <ArrowRight className="h-4 w-4" />
                    </span>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {loading ? <LoadingState progress={progress} jobStatus={jobStatus} /> : null}
          {error ? <ErrorState message={error.message} onRetry={() => mutation.reset()} /> : null}

          {result ? (
            <section className="space-y-8">
              <AnalysisSummary data={result} />
              <PropertyDetails data={result} />
              <ComparableList comps={result.compsUsed} />
            </section>
          ) : null}
        </div>

        <aside className="w-full space-y-6 lg:w-80">
          {/* <SearchHistory onSelectSearch={handleSelectSearch} limit={15} /> */}
        </aside>
      </div>
    </main>
  );
}

function Header() {
  return (
    <header className="flex flex-col justify-between gap-4 rounded-3xl border border-slate-200 bg-white/90 px-6 py-5 shadow-sm shadow-slate-200/40 backdrop-blur md:flex-row md:items-center">
      <div>
        <p className="text-sm font-medium text-slate-500">PropertyVision</p>
        <h1 className="text-2xl font-semibold text-slate-900">ARV &amp; Comps Dashboard</h1>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="secondary">No sign-in required</Badge>
      </div>
    </header>
  );
}

function LoadingState({ progress: baseProgress, jobStatus }: { progress: number; jobStatus: any }) {
  // Use custom hooks for real-time countdown and smooth progress
  const countdown = useCountdown(jobStatus);
  const smoothProgress = useInterpolatedProgress(jobStatus);

  return (
    <Card className="border-0 bg-white/90 shadow shadow-slate-200/40">
      <CardHeader className="space-y-2">
        <CardTitle className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Loader2 className="h-5 w-5 animate-spin" /> Analyzing property…
        </CardTitle>
        <CardDescription className="text-slate-500">
          {jobStatus?.phaseMessage || "We're pulling property details, recent sales, and calculating ARV."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="font-medium">{jobStatus?.phase || 'Processing'}</span>
            <span className="text-slate-600">{smoothProgress}%</span>
          </div>

          {/* Visual progress bar */}
          <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
            <div
              className="h-full transition-all duration-300 ease-out"
              style={{ width: `${smoothProgress}%`, backgroundColor: '#10b981' }}
            />
          </div>

          {/* Real-time countdown with accessibility */}
          <div aria-live="polite" aria-atomic="true">
            {countdown > 0 ? (
              <p className="text-sm text-slate-500">
                ~{countdown} second{countdown !== 1 ? 's' : ''} remaining
              </p>
            ) : jobStatus?.status === 'processing' ? (
              <p className="text-sm text-amber-600">
                Taking longer than expected, still working...
              </p>
            ) : null}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive" title="Analysis failed">
      <p className="text-sm text-rose-600">{message || 'Something went wrong while analyzing the property.'}</p>
      <div className="mt-3 flex gap-3">
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href="mailto:support@propertyvision.app">Contact support</a>
        </Button>
      </div>
    </Alert>
  );
}

function AnalysisSummary({ data }: { data: PropertyAnalysisResponse }) {
  const subjectSqft = data.subject.sqft ?? undefined;
  const confidence = confidenceStyles[data.arv?.confidence || 'low'] || confidenceStyles.low;

  const perSqft = data.arv?.estimate && subjectSqft ? `$${Math.round(data.arv.estimate / subjectSqft)}/sq ft` : '—';

  return (
    <Card className="border-0 bg-white shadow-lg shadow-slate-200/40">
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle className="text-3xl font-semibold text-slate-900">ARV Summary</CardTitle>
          <CardDescription className="text-base text-slate-500">
            {data.subject.address}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm uppercase tracking-wide text-slate-500">After Repair Value</p>
        <p className="text-4xl font-semibold text-slate-900">
          {data.arv ? formatCurrency(data.arv.estimate) : 'ARV unavailable'}
        </p>
        <p className="text-sm text-slate-500">{perSqft}</p>
        <Badge className={confidence.className}>{confidence.label}</Badge>
      </CardContent>
    </Card>
  );
}

function PropertyDetails({ data }: { data: PropertyAnalysisResponse }) {
  const details = [
    { label: 'Bedrooms', value: data.subject.beds ?? '—' },
    { label: 'Bathrooms', value: data.subject.baths ?? '—' },
    { label: 'Square Feet', value: data.subject.sqft?.toLocaleString() ?? '—' },
    { label: 'Year Built', value: data.subject.yearBuilt ?? '—' }
  ];

  return (
    <Card className="border-0 bg-white shadow-sm shadow-slate-200/50">
      <CardContent className="grid gap-4 md:grid-cols-4">
        {details.map(detail => (
          <div key={detail.label} className="rounded-2xl bg-slate-100/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{detail.label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{detail.value}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ComparableList({ comps }: { comps: ComparableProperty[] }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-900">Comparable Properties</h2>
        <Badge variant="secondary">{comps.length} comps</Badge>
      </div>

      {comps.length === 0 ? (
        <Alert title="No comparable sales found">
          No comparable sales found within the filters.
        </Alert>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {comps.map(comp => {
            // Model-generated listing IDs are not verified. Offer an honest address lookup.
            const sourceUrl = `https://www.google.com/search?q=${encodeURIComponent(`${comp.address} sold listing`)}`;
            const price = typeof comp.price === 'string' ? Number(comp.price) : comp.price;
            const sqft = typeof comp.sqft === 'string' ? Number(comp.sqft) : comp.sqft;
            const beds = typeof comp.beds === 'string' ? Number(comp.beds) : comp.beds;
            const baths = typeof comp.baths === 'string' ? Number(comp.baths) : comp.baths;

            return (
              <Card key={`${comp.address}-${comp.soldDate ?? ''}`} className="border-0 bg-white shadow-sm shadow-slate-200/50">
                <CardContent className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                    <a
                      href={sourceUrl || undefined}
                      target={sourceUrl ? '_blank' : undefined}
                      rel={sourceUrl ? 'noreferrer' : undefined}
                      className="text-base font-semibold text-slate-900 hover:underline"
                    >
                      {comp.address}
                    </a>
                    <p className="flex items-center gap-1 text-sm text-slate-500">
                      <MapPin className="h-4 w-4" /> {formatDistance(comp.distance)}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-emerald-600">{formatCurrency(price)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  <span className="font-semibold text-blue-600">{formatPpsf(price, sqft)}</span>
                  <span>• {beds ?? '—'} bd</span>
                  <span>• {baths ?? '—'} ba</span>
                  <span>• {sqft?.toLocaleString() ?? '—'} sqft</span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Sold: {formatSoldDate(comp.soldDate)}</span>
                    <a
                      href={sourceUrl || undefined}
                      target={sourceUrl ? '_blank' : undefined}
                      rel={sourceUrl ? 'noreferrer' : undefined}
                      className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-600"
                    >
                      Find listing
                      {sourceUrl ? <ExternalLink className="h-3 w-3" /> : null}
                    </a>
                </div>
              </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

