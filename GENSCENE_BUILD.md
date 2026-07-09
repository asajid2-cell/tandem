# GENSCENE build ledger — autonomous overnight run

GOAL (strict, /goal hook active): ship the generative scene system end-to-end + robust.
any interior prompt -> real model (codex/claude CLI, NO hand recipe) composes a relational
Scene IR -> deterministic solver -> VALID layout (on-floor, in-room, non-overlapping, camera
unobstructed) -> engine renders -> vision-critique loop refines camera AND composition.
DONE only when ALL verified by rendered output + committed clean (no AI attribution, never
commit the Sketchfab token):
  (1) scene_gen.py "<prompt>" runs full compose->solve->render->critique->fix, no per-scene hand-tuning
  (2) INTENT honored: "a modern living room that is all pink everywhere" -> measurably pink room;
      + battery >=8 diverse untuned prompts (room/color/mood) each intent-matched by a vision check
  (3) automated validity passes on every battery scene (no floating / overlap / out-of-bounds / blocked cam)
  (4) robustness: bad asset -> role fallback; overlaps auto-resolve; heavy scene no-crash; model-down graceful
  (5) demo montage (prompt -> generated scene) for the battery + GRAPHICS_LOOPS.md updated

## Architecture (the bet: MODEL = designer, SOLVER = draftsman)
model emits RELATIONAL Scene IR (semantics: which assets, arranged how, palette/mood) ->
deterministic solver turns relations into VALID coords (footprints + clearance + no-overlap) ->
render -> vision critic -> fix (camera + composition deltas). Reuses: FootprintCache, the rich
CORTEX_ARCHITECT_COMMAND_JSON ingestion, the auto_scene.py vision-critique loop, material/light systems.

## Interfaces (contracts)
1. Catalog Summary (engine --dump-catalog -> json): {key, role, footprint_m, bbox, tags} for ~142 assets.
2. Scene IR (model->solver): relational (anchors wall:/corner:/near:/between:/under:/beside:, asset|role, tint, count, face).
3. Composer backend (pluggable): codex exec (primary) | claude -p (clean output) | deepseek (keyed). +validate/repair.
4. Critic: claude/codex -i vision -> {score, issue, fix} (camera AND composition). ALREADY BUILT (auto_scene.py).

## Findings (P0 investigation)
- CORTEX_ARCHITECT_COMMAND_JSON -> config.startupArchitectCommandJson -> CommandParser::ParseJSON (SceneCommands.cpp:156),
  submitted after scene init (Engine.cpp:1420). THE solver->engine contract.
- Command JSON schema is RICH: add_entity{name,asset,entity_type,position[xyz],scale[xyz],color[rgba],preset,metallic,roughness,ao},
  modify_transform{rotation[xyz]}, add_light{light_type dir/spot/point/area,position,color,intensity,range,cone},
  modify_camera{fov,...}, focus_camera, modify_material, clear_others, scene_plan, generate_texture/envmap.
- add_entity JSON does NOT parse rotation directly (rotation lives in modify_transform:538) -> may need to add, or emit modify_transform.
- CLI model drivers CONFIRMED headless-JSON-capable: `codex exec "<prompt>"` returns clean JSON (thin user/codex/tokens wrapper to strip);
  supports -i image + --oss local. `claude -p` returns clean JSON no wrapper (proven as the vision critic).
- Camera framing override levers ALREADY added (prior work): CORTEX_AUTOCAM_DOLLY/LIFT/YAW/FOV_ADD, CORTEX_AUTOEXPOSURE_MULT.

## Phase checklist
- [ ] P0 de-risk: drive a WHOLE scene via CORTEX_ARCHITECT_COMMAND_JSON (blank base + boxes+asset+light+camera). +--dump-catalog.
- [ ] P1 composer: scene_gen.py -> CLI model -> Scene IR; validate/repair; golden few-shot from existing recipes.
- [ ] P2 solver: anchors->coords, clearance+no-overlap, tints, lights, camera -> command JSON. PINK ROOM renders pink e2e.
- [ ] P3 loop: vision critic emits composition deltas -> re-solve -> converge.
- [ ] P4 battery (>=8) + validity check + robustness (bad asset / overlap / heavy / model-down) + demo montage.

## P0 DONE — engine side of the generative pipeline works (hand-written IR -> pink room)
- Rejected the CORTEX_ARCHITECT_COMMAND_JSON path: entangled (default gallery base + RegressionTests junk +
  auto-layout that scatters exact coords -- CommandQueue.cpp:572 auto-places anything at exactly (0,0,0)).
- CHOSE: a "generative" RECIPE (recipe path starts on a BLANK scene, Engine_Scenes.cpp:3125). Engine.cpp trigger:
  CORTEX_SCENE_IR_JSON set -> ScenePreset::RecipeRoom + m_recipeName="generative", skip prompt router.
- BuildGenerative (SceneRecipes.cpp): parses CORTEX_SCENE_IR_JSON -> BuildRoomShell(dims,palette) + Place(assets exact
  x,z,yaw,foot,tint) + AddPointLight. Reuses the ROBUST Place/BuildRoomShell (footprint-scale + ground-snap). Reuses the
  showcase sun/window/fog lighting + hero camera + 1.5x SSAA (recipe="generative" flows through BuildRecipeScene).
- Parameterized BuildRoomShell for palette (wallTint/accentTint). tools/render_ir.ps1 = the IR render harness.
- ★TINT: material textures (plaster/wood) + warm sun MUTE colour. Added g_primitiveTintStrength (file-static, default 0.25
  for hand recipes; BuildGenerative raises it from room.tint_strength). At 0.92 + saturated colours -> MEASURABLY pink walls/
  ceiling/table (pink_gen3.png). Wood floor still reads wood (grain dominates) -- pink WALLS are the signal, that's fine.
- Gated RunRegressionTests (Engine.cpp) when architect JSON set / CORTEX_DISABLE_REGRESSION.
- Camera: NOT solved by the IR -- the autonomous loop (auto_scene.py, already built) refines it. IR = room+objects+lights only.

## Next: P1 composer + P2 solver (the MODEL part)
scene_gen.py: prompt + catalog -> codex/claude CLI -> IR (assets + rough coords + palette + lights) -> SOLVER (clamp to
room, de-overlap via footprints, snap yaw) -> valid IR -> render_ir.ps1 -> auto_scene.py camera loop. Need: --dump-catalog
(assets+roles+footprints) so the model picks real assets; validate/repair (bad asset -> nearest by role).

## P1-P4 built + committed (98f9969, 828e919)
- tools/scene_gen.py = the full pipeline: compose (codex exec --skip-git-repo-check / claude -p / deepseek key /
  offline heuristic) -> validate/repair (every asset -> real catalog id, fallback by role) -> SOLVE (relational
  anchors -> exact x,z,yaw; height-capped sizing; no-overlap; in-bounds; front-centre CAMERA BAY reserved) ->
  render_ir -> claude -p vision critique (reframe via CORTEX_AUTOCAM_* deltas). validity_check() = independent gate.
- Engine: main.cpp --dump-catalog [--measure] (183 assets, id+role+nominal+measured bounds). Engine_Scenes.cpp
  wider generative establishing camera. SceneRecipes.cpp strongPalette (ts>0.6) -> FLAT-tinted shell (walls/ceiling/
  floor skip the muting plaster/wood texture) so "all pink everywhere" reads measurably pink.
- ★SIZING ROOT: engine normalizes largest-horiz -> IR foot; tiny Kenney meshes (chair horiz 0.2) blew up to 1.6m
  giants at foot 0.7. FIX = solver size_foot() caps by per-role target HEIGHT via measured aspect. chair 1.6m->1.05m.
- VERIFIED pink: vision critic score 4, room_ok+color_ok=true, dominant=pink, verdict=good.
- ROBUSTNESS (tools/scene_battery.py, all PASS): bad-asset->role fallback; 3 stacked objects auto-separate valid;
  model-unavailable->offline valid; unresolved-asset IR renders (empty-ish) without crash.

## KNOWN RESIDUAL (fix after battery IF montage shows it recurring)
Grey focal pieces: a TEXTURED model (ModernSofa has an albedo texture) IGNORES cmd->color tint -- CommandQueue.cpp:644
sets renderable.albedoColor = embeddedMaterial->baseColorFactor when the mesh has a texture, so the pink tint never
lands on the sofa. FIX = add cmd flag (set by Place when BuildGenerative passes an explicit tint) -> multiply
albedoColor by cmd->color for textured models too. Gated so hand recipes are unaffected. Only implement if needed.

## State / next action
SUPERSEDED BY V2: the system was extended overnight (2026-07-02) to full self-authoring --
arbitrary prompts including EXTERIORS (beach/forest/garden/lake/desert/campsite with real
sky HDRIs, animated water, 512-asset nature corpus) + an asset acquisition ladder
(catalog -> Sketchfab live fetch -> procedural generation). Canonical plan/ledger with all
gate evidence: **GENSCENE_V2.md** (same folder). Battery v2 = 12 mixed prompts + 6
robustness tests. Engine commit 397be7c.
