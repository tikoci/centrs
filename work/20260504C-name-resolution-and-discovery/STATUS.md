# Status: name resolution and discovery policy

## Initial framing

- Alpha can plausibly resolve target identity from explicit values, environment,
  and WinBox CDB lookup without waiting for discovery.
- Discovery-backed `"name"` resolution is the uncovered topic: it raises CLI wait
  behavior, MNDP cache freshness, and expiry-policy questions that are broader
  than storage format alone.
- This gap is one reason `centrs check` should not lead the alpha yet.

## Immediate questions

1. What exact lookup order should apply when a user provides a non-DNS name?
2. When is it acceptable to wait briefly for MNDP instead of failing fast?
3. What freshness window should make a cached MNDP name usable, stale, or
   ignored?
4. How should verbose output explain when a name came from CDB, cache, DNS, or
   fresh discovery?
