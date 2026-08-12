# ADAPT Phase 2 — Privacy Invariants

## 1. Zero Personal Data Transmission
The `EvidencePacket` strictly excludes:
- Full DOM trees or arbitrary HTML
- Cookies, authentication headers, and session tokens
- Form input values, passwords, or personal identifying information
- URL query parameters containing authentication or session tokens
- Browsing history

## 2. Compact Signal Minimization
Only bounded geometric ratios, sanitized adblock keyword occurrences, and high-level interaction flags are included.

## 3. Privacy-Preserving Recipe Promotion
- SiteRecipes store only sanitized DOM action types, detector category classifications, and health verification outcomes.
- Raw model reasoning, page content, and user browsing trails are never stored in recipes.
