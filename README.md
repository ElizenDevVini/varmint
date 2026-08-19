# varmint city

A shared pixel terrarium. Everyone watches the same city; each visitor can release
one animal into it, name it, and follow it around. The animals run on scripted
species brains (fly, crow, cat, dog) and interact on their own. Nobody controls them.

## How it works

The world is a pure function of (agent roster, wall-clock time). Every browser runs
the identical deterministic sim locally (`public/sim.js`): integer-only math, seeded
int32 hashing, no `Math.random` at runtime, positions evaluable at any tick without
history. Two browsers at the same moment render the same world. The server only
stores the roster and streams roster changes over SSE.

- `server.js` — Express, SQLite roster, SSE stream, agent creation (per-IP throttle)
- `public/sim.js` — deterministic sim: map, species behaviors, event derivation
- `public/app.js` — canvas renderer, camera, feed, create/claim UI
- `public/assets/` — pixel sprites and tiles generated with Higgsfield
  (nano_banana_2, chroma-keyed and downscaled nearest-neighbor at assembly)

Species behaviors: flies swarm lamps at night and market stalls by day, crows hoard
shiny things at a stash and perch on rooftops, cats hold territory and nap in sun
patches, dogs live on the plaza and tail other animals. Day/night cycles every 30
minutes. The event feed is derived client-side from the same deterministic sim, so
every viewer sees the same stories.

## Run

```
npm install
node server.js   # PORT (default 4870), SQLITE_PATH, IP_SALT
```

## Deploy

Render blueprint in `render.yaml` (persistent disk at /data for the SQLite roster).

## Known limits (v1)

- Claims are a localStorage token, not accounts; one agent per browser, 5 per IP/day.
- Agents walk straight lines between goals and can clip building corners.
- No cross-client mid-sim mutations: the only world input is releasing a new agent.
