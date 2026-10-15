import { NextRequest, NextResponse } from 'next/server';
import { ComprehensiveComparableSearchV5 } from '../../../server/comprehensive-comp-search-v5';
import logger, { logSearchRequest, logSearchResult, logSearchError } from '../../../server/utils/logger';

// Set maximum duration to 10 minutes for long-running analyses
export const maxDuration = 600;

let analysisService: ComprehensiveComparableSearchV5;

// Initialize the service (singleton pattern)
function getAnalysisService() {
  if (!analysisService) {
    analysisService = new ComprehensiveComparableSearchV5();
  }
  return analysisService;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip');

  try {
    const body = await request.json();
    const address = String(body?.address || '').trim();
    const userId = body?.userId || request.headers.get('x-user-id');
    const sessionId = body?.sessionId || request.headers.get('x-session-id');

    if (!address) {
      logSearchError({
        address: '',
        userId: userId || undefined,
        sessionId: sessionId || undefined,
        error: new Error('Address is required'),
        stage: 'validation',
      });
      return NextResponse.json(
        { error: 'Address is required' },
        { status: 400 }
      );
    }

    // Log incoming search request
    logSearchRequest({
      address,
      userId: userId || undefined,
      sessionId: sessionId || undefined,
      ip: ip || 'unknown',
    });

    const service = getAnalysisService();
    const result = await service.findComparables(address);
    const executionTimeMs = Date.now() - startTime;

    const responsePayload = {
      subject: result.subject,
      arv: result.arv ?? null,
      twoBathArv: result.twoBathARV ?? null,
      bathroomAnalysis: result.bathroomAnalysis,
      renovationAnalysis: result.renovation_analysis,
      compsUsed: result.qualified_comps,
      allComps: result.all_comps,
      confidenceScores: Object.fromEntries(result.consistency_scores.entries()),
      searchMetadata: result.searchMetadata,
    };

    // Log successful search result
    logSearchResult({
      address,
      userId: userId || undefined,
      sessionId: sessionId || undefined,
      arv: typeof result.arv === 'number' ? result.arv : (result.arv as any)?.estimate ?? null,
      twoBathArv: typeof result.twoBathARV === 'number' ? result.twoBathARV : (result.twoBathARV as any)?.estimate ?? null,
      compsCount: result.all_comps?.length || 0,
      qualifiedCompsCount: result.qualified_comps?.length || 0,
      executionTimeMs,
      success: true,
    });

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    const executionTimeMs = Date.now() - startTime;
    const message = error?.message || 'Analysis failed';

    // Try to get address if available
    let address = '';
    try {
      const body = await request.clone().json();
      address = String(body?.address || '');
    } catch {}

    // Log error with full context
    logSearchError({
      address,
      userId: undefined,
      sessionId: undefined,
      error: error instanceof Error ? error : new Error(message),
      stage: 'analysis',
    });

    logger.error('Analysis failed', {
      eventType: 'SEARCH_ERROR',
      address,
      executionTimeMs,
      errorMessage: message,
      errorStack: error?.stack,
    });

    return NextResponse.json(
      { error: 'Analysis failed', details: message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { message: 'Use POST method to analyze properties' },
    { status: 405 }
  );
}