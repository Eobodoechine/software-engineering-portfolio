# PropertyVision

[Use the product](https://demo.neoventurez.com/) · [End-to-end walkthrough](SYSTEM.md) · [Existing public source repository](https://github.com/Eobodoechine/PropertyVision1)

PropertyVision is the project behind demo.neoventurez.com. It was my first production system and is my fully integrated, published product available for people to use. It brings property research, comparable sales, and an after-repair value estimate into one web application.

**Current status:** Live product, according to my account as its builder. The portfolio review observed the public page displaying a saved ARV report with six comparable properties and an address input for new analysis. It did not run a fresh valuation or assess valuation accuracy. The public source archive is not claimed to be the exact deployed revision.

## Selected code

The [TypeScript address sample](addressNormalizer.ts) normalizes address strings and compares components such as house number, street name, street type, unit, and ZIP code. This supports discussion of inconsistent provider data, duplicate detection, and cache-key normalization.

The matching rules are deliberately permissive: directionals are ignored, and a missing unit on one side can still match. Those choices can merge addresses that need to be distinguished. This is a heuristic to combine with other property evidence, not an authoritative identity service.

The tests show accepted aliases and rejected mismatches. A separate test makes the permissive directional and missing-unit behavior visible.

The [usage-budget sample](usage-budget.js) reserves estimated provider usage before requests, checks a persistent allowance, and restricts concurrent analysis. Its tests cover exhausted limits and invalid state without making cloud requests. The [system walkthrough](SYSTEM.md) explains how these controls fit into the product and their limits.

The source snapshots and their working-file status are recorded in the root provenance file. Only fictional example addresses were substituted in address-sample comments. No production property records are included.

