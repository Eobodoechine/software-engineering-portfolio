// VertexAI Valuation Service
// Provides AI-driven PPSF analysis and ARV calculation using your proven valuation prompt

import 'dotenv/config';
import { readFileSync } from 'fs';
import { vertexGenerate } from './vertex-freeform.js';
import { jobLog } from '../utils/jobQueue';

export class VertexAIValuationService {
  constructor() {
    // Load service account credentials
    const saPath = process.env.GCP_SA_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '/app/agile-device-472202-i8-319f002d9438.json';
    this.sa = JSON.parse(readFileSync(saPath, 'utf8'));
    this.projectId = this.sa.project_id;
  }

  /**
   * The proven valuation prompt that produced $342,339 ARV
   */
  getValuationPrompt() {
    return `Role: You are a valuation assistant. Use only sale price and square footage (to compute PPSF). Do not use beds, baths, condition, or any hidden scoring. Follow the rules exactly and return the JSON schema at the end.

Inputs

You will receive JSON like:

{
  "subject": {"sqft": 2345, "property_type": "single_family"},
  "comps": [
    {"id":"C1","address":"123 Main St","unit":null,"price":350000,"sqft":2000,"sale_date":"2025-06-10","property_type":"single_family"}
    // ...
  ]
}

Rules (price & PPSF only)
0) Clean & prepare

Require price > 0 and sqft > 0. Compute ppsf = price / sqft for every comp.

Deduplicate: if two comps share the same {address, unit} (or the same address when unit is null), keep the most recent sale; mark the others "dup_address_unit".

Property type (if provided): prefer comps with the same property_type as the subject. If that leaves fewer than 3 comps, allow mixed types and set flags.mixed_types = true.

1) Order by PPSF and find obvious lows

Sort comps by PPSF (low → high). Compute the list of adjacent PPSF gaps between neighbors in this order.

If the lowest comp sits far below the pack (i.e., the first gap from it to the next comp is the largest gap among all adjacent gaps), drop that lowest comp as "low_ppsf_isolated". Re-check once after the drop.

2) Try to form a supported high cluster (preferred "optimistic" set)

Start at the highest PPSF and move downward to build the longest consecutive block at the top where no gap inside that block is the largest gap seen in the full list.

Require this block to have at least 3 comps.

Price confirmation inside the block: for each comp in the block, find its two closest prices (by absolute difference) among all comps. The comp is confirmed only if both of those closest prices are also inside the block.

The confirmed members of this block are the HighCluster. If at least 3 are confirmed, keep them and label each "high_cluster_supported". All other highs in the block are "high_no_support".

3) If no HighCluster → build a central–upper chain (baseline "conservative" set)

STRICT ALGORITHM FOR CENTRALUPPERCHAIN:

Step A: Sort all comps by PPSF (low to high). Let n = comps.length.

Step B: Find upper middle starting point:
- If n is odd: mid = floor(n/2) (0-based index)
- If n is even: mid = n/2 (upper middle, 0-based index)

Step C: Calculate lower-side max gap:
- Compute all adjacent PPSF gaps: gaps[i] = comps[i+1].ppsf - comps[i].ppsf
- lowerMaxGap = maximum gap among gaps[0] through gaps[mid-1] (all gaps strictly below mid)
- If mid = 0, set lowerMaxGap = -Infinity

Step D: Build contiguous upward chain from mid:
- Start with chain = [mid]
- For i = mid; i < n-1; i++:
  - If gaps[i] >= lowerMaxGap: STOP (large jump encountered)
  - Add i+1 to chain (next contiguous comp only)
  - If chain.length = 3: STOP (cap at 3 comps)

Step E: Mark kept comps as "central_upper_chain", all others as "outside_chain"
- Never leave reason_codes empty - always specify "outside_chain" for dropped comps
- If chain.length < 3: set flags.thin_market = true

CRITICAL: Chain must be contiguous indices only. No skipping comps. No backfilling from lower side.

MANDATORY OUTPUT REQUIREMENTS:
1. Show your PPSF sorting explicitly
2. Show your mid calculation with the formula
3. Show all gap calculations with values
4. Show your chain building step by step with comparisons
5. Use the median PPSF of the final chain for conservative ARV
6. Mark all non-chain comps as "outside_chain" in dropped_comps

4) Isolated high-price guard (when using step 3)

In the chosen chain from step 3, drop any comp whose two closest prices (by absolute difference) are both outside the chosen set. Mark "high_price_isolated".

5) Stability checks

Minimum comps: target 3 or more comps. If only 2 survive (flat or thin data), allow it but set flags.thin_market = true.

Internal spread sanity: within the chosen set, sort by PPSF. If the largest inside gap occurs at an endpoint (between the lowest member and its neighbor, or between the highest member and its neighbor), remove that endpoint ("spread_trim_low" or "spread_trim_high") once if this increases cohesion. Do not trim below 2 comps.

6) Compute ARV(s)

Conservative ARV: if a central–upper chain was used, compute the middle PPSF of the chosen set (if two values, average those two). ARV price = that PPSF × subject.sqft.

Aggressive ARV: if a HighCluster exists, compute the middle PPSF within the HighCluster the same way; ARV price = that PPSF × subject.sqft.
If no HighCluster, set aggressive = conservative and flags.no_high_cluster = true.

7) If fewer than 2 comps survive

Return "method_used": "insufficient_data", include all drop reasons, and set flags.thin_market = true.

Output JSON (return exactly this shape)
{
  "method_used": "HighCluster | CentralUpperChain | insufficient_data",
  "kept_comps": [
    {"id":"", "address":"", "price":0, "sqft":0, "ppsf":0, "reason":"high_cluster_supported|central_upper_chain|spread_trim_low|spread_trim_high"}
  ],
  "dropped_comps": [
    {"id":"", "reason_codes":["dup_address_unit","low_ppsf_isolated","high_no_support","high_price_isolated","mixed_types","bad_inputs"]}
  ],
  "conservative": {
    "arv_ppsf": 0,
    "arv_price": 0,
    "comp_ids": []
  },
  "aggressive": {
    "arv_ppsf": 0,
    "arv_price": 0,
    "comp_ids": [],
    "no_high_cluster": false
  },
  "flags": {
    "thin_market": false,
    "mixed_types": false
  },
  "notes": "Brief explanation of why each comp was kept/dropped and which fallback was used."
}

Guidance for the agent (implicit heuristics without percentages):

"Largest gap" means the widest step between two neighbors in PPSF order; "large jump" means a gap comparable to that largest step, clearly breaking a smooth run.

"Two closest prices" means the two smallest absolute price differences to that comp among all remaining comps.

When choosing "top 3" in a chain, prefer more members if they remain a smooth run; when forced to choose between 2 vs 3, prefer 3 if available.

Always explain your choices plainly (which gaps broke runs, which prices were nearest, why endpoints were trimmed).

Apply this to the following input data:

IMPORTANT: Calculate fresh results - timestamp: ${Date.now()}`;
  }

  /**
   * Convert PropertyVision comparables to VertexAI JSON format
   */
  formatCompsForVertexAI(subject, comparables) {
    const comps = comparables.map((comp, index) => ({
      id: `C${index + 1}`,
      address: comp.comp?.address || comp.address || 'Unknown Address',
      unit: null,
      price: comp.price || comp.comp?.price || 0,
      sqft: comp.sqft || comp.comp?.sqft || 0,
      sale_date: comp.saleDate || comp.comp?.saleDate || comp.sale_date || '2025-01-01',
      property_type: 'single_family'
    }));

    return {
      subject: {
        sqft: subject.sqft || 2345,
        property_type: 'single_family'
      },
      comps: comps
    };
  }

  /**
   * Call VertexAI with valuation prompt and comparable data
   */
  async calculateARVWithAI(subject, comparables, level = 1) {
    jobLog(`🤖 Level ${level}: Calling VertexAI for ARV calculation with ${comparables.length} comps`);

    try {
      // Format data for VertexAI
      const inputData = this.formatCompsForVertexAI(subject, comparables);

      // Create full prompt with data
      const fullPrompt = this.getValuationPrompt() + '\n\n' + JSON.stringify(inputData, null, 2);

      jobLog(`   📝 Sending ${comparables.length} comps to VertexAI...`);

      // Call VertexAI
      const response = await vertexGenerate({
        sa: this.sa,
        projectId: this.projectId,
        location: 'us-central1',
        model: 'gemini-2.0-flash-exp',
        prompt: fullPrompt,
        json: true,
        grounded: false,
        timeoutMs: 60000
      });

      // Parse response
      const result = JSON.parse(response);

      jobLog(`   ✅ VertexAI Analysis: ${result.method_used}`);
      jobLog(`   📊 Conservative ARV: $${result.conservative.arv_price?.toLocaleString() || 'N/A'}`);
      jobLog(`   📊 Aggressive ARV: $${result.aggressive.arv_price?.toLocaleString() || 'N/A'}`);
      jobLog(`   🏠 Final comps used: ${result.kept_comps?.length || 0}`);

      // Check if sufficient data
      if (result.method_used === 'insufficient_data') {
        jobLog(`   ❌ Level ${level}: VertexAI returned insufficient data`);
        return { success: false, reason: 'insufficient_data', details: result };
      }

      // Success case
      return {
        success: true,
        result: result,
        arv: {
          method: `vertex_ai_level_${level}_${result.method_used.toLowerCase()}`,
          estimate: result.conservative.arv_price,
          confidence: result.flags.thin_market ? 'LOW' : 'MEDIUM',
          dataPoints: result.kept_comps.length,
          details: {
            conservative: result.conservative,
            aggressive: result.aggressive,
            method_used: result.method_used,
            notes: result.notes
          }
        }
      };

    } catch (error) {
      jobLog(`   ❌ Level ${level}: VertexAI failed - ${error.message}`);
      return {
        success: false,
        reason: 'vertex_ai_error',
        error: error.message
      };
    }
  }
}