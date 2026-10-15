'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { Clock, CheckCircle, XCircle, ExternalLink, ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE_URL } from '@/lib/utils';
import type { SearchHistoryEntry } from '@/types/property';

interface SearchHistoryResponse {
  searches: SearchHistoryEntry[];
}

async function fetchSearchHistory(userId: string, limit = 10): Promise<SearchHistoryResponse> {
  const response = await fetch(`${API_BASE_URL}/api/search-history?userId=${userId}&limit=${limit}`);

  if (!response.ok) {
    throw new Error('Failed to fetch search history');
  }

  return response.json();
}

const statusConfig = {
  pending: {
    icon: Clock,
    label: 'Processing',
    className: 'bg-blue-100 text-blue-700 border-blue-200'
  },
  completed: {
    icon: CheckCircle,
    label: 'Completed',
    className: 'bg-green-100 text-green-700 border-green-200'
  },
  failed: {
    icon: XCircle,
    label: 'Failed',
    className: 'bg-red-100 text-red-700 border-red-200'
  }
};

interface SearchHistoryProps {
  onSelectSearch?: (search: SearchHistoryEntry) => void;
  limit?: number;
}

export function SearchHistory({ onSelectSearch, limit = 10 }: SearchHistoryProps) {
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ['searchHistory', user?.uid],
    queryFn: () => fetchSearchHistory(user!.uid, limit),
    enabled: !!user?.uid,
    refetchInterval: 30000 // Refetch every 30 seconds to update pending statuses
  });

  if (!user) {
    return null;
  }

  if (isLoading) {
    return (
      <Card className="border-0 bg-white shadow-sm shadow-slate-200/50">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Recent Searches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-0 bg-white shadow-sm shadow-slate-200/50">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Recent Searches</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Failed to load search history</p>
        </CardContent>
      </Card>
    );
  }

  const searches = data?.searches || [];

  if (searches.length === 0) {
    return (
      <Card className="border-0 bg-white shadow-sm shadow-slate-200/50">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Recent Searches</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">No searches yet. Analyze your first property to get started!</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 bg-white shadow-sm shadow-slate-200/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold">Recent Searches</CardTitle>
          <Badge variant="secondary">{searches.length} searches</Badge>
        </div>
        <CardDescription>
          Your property analysis history
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {searches.map((search) => {
          const statusInfo = statusConfig[search.status];
          const StatusIcon = statusInfo.icon;
          const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

          return (
            <div
              key={search.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/50 p-3 hover:bg-slate-100/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="font-medium text-slate-900 truncate">{search.address}</p>
                  <Badge className={`text-xs ${statusInfo.className}`}>
                    <StatusIcon className="h-3 w-3 mr-1" />
                    {statusInfo.label}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span>{new Date(search.createdAt).toLocaleDateString()}</span>
                  {search.status === 'completed' && search.result?.arv?.estimate && (
                    <span className="font-medium text-green-600">
                      ARV: {formatter.format(search.result.arv.estimate)}
                    </span>
                  )}
                  {search.status === 'failed' && search.error && (
                    <span className="text-red-600 truncate">Error: {search.error}</span>
                  )}
                </div>
              </div>
              {search.status === 'completed' && onSelectSearch && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelectSearch(search)}
                  className="ml-2"
                >
                  <span className="sr-only">View details</span>
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}