# `transport/edge-auth-failed`

An HTTP layer in front of RouterOS (auth proxy, tunnel edge, WAF) refused the
request before RouterOS answered it.

## How centrs tells

RouterOS answers every REST auth refusal with a JSON body whose `error` equals
the HTTP status (`{"error":401,"message":"Unauthorized"}`), adding
`WWW-Authenticate: Basic` only when no credentials were sent. A 401 or 403 with
any other body, or a challenge for another scheme (Cloudflare Access sends
`Bearer`), came from something in front of the router. `context` records the
challenge scheme, `server`, content type and whether a `cf-ray` header was
present. A `cf-ray` header alone does not decide it: a tunnel passes RouterOS's
own 401 through with one.

## Fix

centrs sends only RouterOS Basic credentials, so changing the RouterOS username
or password will not help. Point `--host` at an address that reaches RouterOS
directly, or at a local proxy that authenticates to the front layer for you.
The request never reached RouterOS, so a write was not applied.
