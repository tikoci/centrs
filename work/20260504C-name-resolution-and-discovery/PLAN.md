# Plan: name resolution and discovery policy

1. Capture the alpha-safe resolution order that already seems clear: explicit
   values, environment, and WinBox CDB lookup.
2. Separate that from the still-open discovery policy around MNDP wait time,
   cache freshness, and fallback behavior.
3. Promote only the durable policy into specs once the UX and expiry tradeoffs
   are grounded enough to avoid churn.
