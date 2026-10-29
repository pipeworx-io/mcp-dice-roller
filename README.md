# @pipeworx/dice-roller

Tabletop dice, coin flips and exact dice odds with real, reproducible randomness: roll any standard dice notation (2d6+3, 4d6kh3, 2d20kl1, 3d6!, 4dF, d%), flip up to 1,000 coins, or get the full probability distribution of a roll.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

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

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/roll_dice \
  -H 'Content-Type: application/json' \
  -d '{"notation":"4d6kh3","times":6}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/roll_dice`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-dice-roller` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/dice-roller/mcp` endpoint shown above. It needs network access;
there is no offline mode.

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

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

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
