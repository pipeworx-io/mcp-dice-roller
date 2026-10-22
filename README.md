# @pipeworx/dice-roller

Tabletop dice, coin flips and exact dice odds with real, reproducible randomness: roll any standard dice notation (2d6+3, 4d6kh3, 2d20kl1, 3d6!, 4dF, d%), flip up to 1,000 coins, or get the full probability distribution of a roll.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1866+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `roll_dice(notation, times?, seed?)` — rolls the notation and returns every die, which dice were kept, per-term subtotals, the total and a readable breakdown. `times` (up to 100) repeats the roll and adds min/max/mean across repeats. Answers "roll 4d6 drop the lowest", "roll with advantage", "roll 2d6+3 six times".
- `flip_coins(count?, seed?)` — flips up to 1,000 fair coins; returns the H/T sequence, heads and tails counts and the longest run.
- `dice_odds(notation, target?, comparison?, seed?)` — min, max, mean, standard deviation, mode, median and the probability of every total; with `target`, the chance the total is `>=` (default), `>`, `<=`, `<` or `==` it. Exact by enumeration for plain sums and for keep/drop pools up to 1,000,000 outcomes; otherwise (and always for exploding dice) a Monte Carlo estimate labelled `method: "monte_carlo"` with its sample count. Answers "what are the odds of 15+ on 3d6", "how much does advantage help against DC 15".

Every response carries `seed` and a `meta` envelope (`seed`, `procedure`, `deck`, `source`). Omit `seed` for a fresh random result; pass the returned seed back with the same arguments to reproduce it exactly. Results are random outcomes, not advice; the calling agent decides what they mean.

### Notation

`NdS` terms joined by `+` or `-`, with whole-number constants (`1d20+5`, `2d6+1d4-1`). `N` defaults to 1. `S` is a number, `%` (= 100) or `F` (fudge/Fate: -1, 0, +1). Modifiers go after the die, in this order: `!` (exploding: a max face rolls another die), then `kh`/`kl`/`dh`/`dl` with an optional count (keep highest, keep lowest, drop highest, drop lowest; `k` alone means `kh1`). Limits: 1,000 dice per notation, 10,000 sides per die, 100 extra dice per exploding chain. Anything malformed or over a limit is refused with the reason and the grammar.

## Auth

Keyless. No upstream, no outbound calls.

## Data sources

- Pipeworx dice engine v1 (the shared chance engine in this repo): an sfc32 pseudo-random generator seeded from a cyrb128 hash of the seed string. A call without a seed takes a 128-bit seed from the platform's cryptographic random source and returns it. Dice faces are drawn by rejection sampling, so no face is favoured at any die size.

The generated sequence for a given seed is pinned by a unit test. If a change to the engine re-deals seeded results, that test goes red, because people may have cited them.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "dice-roller": {
      "url": "https://gateway.pipeworx.io/dice-roller/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/dice-roller/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1866+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/roll_dice \
  -H 'Content-Type: application/json' \
  -d '{"notation":"4d6kh3","times":6}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/roll_dice`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "dice-roller": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-dice-roller"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-dice-roller
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Dice Roller data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
