# `usage/invalid-concurrency`

`--concurrency` is not a whole number of at least 1. Nothing was sent.

## Emitted by

Fan-out commands (`retrieve`, `execute`, `api`, `transfer`) and library
callers that pass `concurrency` *(code)*.

## Context

- `concurrency`: the rejected value.

## Fix

Pass a positive integer, for example `--concurrency 4`, or leave it out. The
default depends on the transport: 8 for REST, 4 for the native API.
