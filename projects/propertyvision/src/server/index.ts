import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ComprehensiveComparableSearchV5 } from './comprehensive-comp-search-v5.js';
import logger, { logSearchRequest, logSearchResult, logSearchError } from './utils/logger';

const app = express();
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '0.0.0.0';

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : undefined;

app.use(corsOrigins?.length ? cors({ origin: corsOrigins, credentials: true }) : cors());
app.use(express.json({ limit: '1mb' }));

const analysisService = new ComprehensiveComparableSearchV5();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  const address = String(req.body?.address || '').trim();
  const userId = req.body?.userId || req.headers['x-user-id'];
  const sessionId = req.body?.sessionId || req.headers['x-session-id'];
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    if (!address) {
      logSearchError({
        address: '',
        userId,
        sessionId,
        error: new Error('Address is required'),
        stage: 'validation',
      });
      return res.status(400).json({ error: 'Address is required' });
    }

    // Log incoming search request
    logSearchRequest({
      address,
      userId,
      sessionId,
      ip: String(ip),
    });

    const result = await analysisService.findComparables(address);
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
      userId,
      sessionId,
      arv: typeof result.arv === 'number' ? result.arv : (result.arv as any)?.estimate ?? null,
      twoBathArv: typeof result.twoBathARV === 'number' ? result.twoBathARV : (result.twoBathARV as any)?.estimate ?? null,
      compsCount: result.all_comps?.length || 0,
      qualifiedCompsCount: result.qualified_comps?.length || 0,
      executionTimeMs,
      success: true,
    });

    res.json(responsePayload);
  } catch (error: any) {
    const executionTimeMs = Date.now() - startTime;
    const message = error?.message || 'Analysis failed';

    // Log error with full context
    logSearchError({
      address,
      userId,
      sessionId,
      error: error instanceof Error ? error : new Error(message),
      stage: 'analysis',
    });

    logger.error('Analysis failed', {
      eventType: 'SEARCH_ERROR',
      address,
      userId,
      sessionId,
      executionTimeMs,
      errorMessage: message,
      errorStack: error?.stack,
    });

    res.status(500).json({ error: 'Analysis failed', details: message });
  }
});

app.listen(port, host, () => {
  logger.info(`Comprehensive analysis API ready on http://${host}:${port}`, {
    eventType: 'SERVER_START',
    port,
    host,
    environment: process.env.NODE_ENV,
  });
});
