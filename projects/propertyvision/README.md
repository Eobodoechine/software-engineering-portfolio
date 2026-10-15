# PropertyVision

[Public demo](https://demo.neoventurez.com/) · [Existing public source repository](https://github.com/Eobodoechine/PropertyVision1) · [Code sample](addressNormalizer.ts)

PropertyVision was my first production system. It presents property research, comparable sales, and an after-repair value estimate through a web interface.

**Current status:** The anonymous analysis page loads and accepts a street-address input. This portfolio review did not run a new full analysis, validate valuation accuracy, or certify repeatability. The public source archive is not claimed to be the exact deployed revision.

## Selected code

The TypeScript sample normalizes address strings and compares components such as house number, street name, street type, unit, and ZIP code. This supports discussion of inconsistent provider data, duplicate detection, and cache-key normalization.

The matching rules are deliberately permissive: directionals are ignored, and a missing unit on one side can still match. Those choices can merge addresses that need to be distinguished. This is a heuristic to combine with other property evidence, not an authoritative identity service.

The tests show accepted aliases and rejected mismatches. A separate test makes the permissive directional and missing-unit behavior visible.

The source snapshot and its working-file status are recorded in the root provenance file. Only fictional example addresses were substituted in comments. No production property records are included.

