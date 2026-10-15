export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface PropertySummary {
  address: string;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  yearBuilt: number | null;
  lotSize: number | null;
  subdivision: string | null;
  success: boolean;
}

export interface ARVEstimate {
  method: string;
  estimate: number;
  confidence: ConfidenceLevel;
  dataPoints: number;
}

export interface BathroomAnalysis {
  subjectBaths: number;
  recommendAction: 'hold' | 'renovate' | 'sell_as_is';
  baselineCompsUsed: number;
  upgradeCompsUsed?: number;
}

export interface ComparableProperty {
  address: string;
  price?: number;
  sqft?: number;
  beds?: number;
  baths?: number;
  distance?: number;
  soldDate?: string;
  ppsf?: number;
  url?: string | null;
  source?: string | null;
}

export interface PropertyAnalysisResponse {
  subject: PropertySummary;
  arv: ARVEstimate | null;
  twoBathArv: (ARVEstimate & { valueAdd?: number; valueAddPercent?: number; roiEstimate?: number }) | null;
  bathroomAnalysis: BathroomAnalysis;
  renovationAnalysis: {
    likely_renovated: unknown[];
    likely_unrenovated: unknown[];
    market_average: unknown[];
  };
  compsUsed: ComparableProperty[];
  allComps: ComparableProperty[];
  confidenceScores: Record<string, number>;
  searchMetadata: {
    version: string;
    qualityScore: string;
    totalSearchTime: number;
  };
}

export interface SearchHistoryEntry {
  id: string;
  userId: string;
  address: string;
  status: 'pending' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  result?: PropertyAnalysisResponse;
  error?: string;
}

export interface SearchHistoryFilters {
  status?: 'all' | 'completed' | 'failed';
  dateRange?: {
    start: Date;
    end: Date;
  };
  limit?: number;
}
