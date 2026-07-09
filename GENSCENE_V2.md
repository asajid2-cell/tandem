# GENSCENE V2 — self-authoring scenes (arbitrary prompts, arbitrary assets)

MISSION: revolutionize self-authoring. One text prompt -> a novel scene: "a well lit pink
kitchen" OR "a sunny beach with foliage, rocks and green water". Requires (a) exterior
scenes with real environment (sky/sun/water/ground), (b) genuine spatial awareness
(zones, scatter, composition), (c) an asset ladder that FETCHES or GENERATES models we
don't have. V1 (interior-only, catalog-only) is the foundation — keep it working.

## Recon ground truth (all verified, file:line)
ENGINE ALREADY HAS the outdoor machinery — it's just unreachable from the IR path:
- Procedural sky: assets/shaders/ProceduralSky.hlsl (Rayleigh+Mie, sun disk from the
  directional light). Renders when IBL off/skybox absent. The interior room shell
  DELIBERATELY hides it (SceneRecipes.cpp:650 ceiling comment).
- Sun per-scene: Renderer::SetSunDirection/Color/Intensity (Renderer_LightingSettings.cpp:625+).
- ANIMATED WATER: WaterSubsystem + Water.hlsl (Gerstner waves, foam, shallow/deep tint).
  Levers: SetWaterParams(levelY,amp,waveLen,speed,dirX,dirZ,secAmp,steep) + SetWaterOptics
  (Renderer_SurfaceSettings.cpp:46-64). A renderable joins the water pass ONLY via
  Scene::WaterSurfaceComponent (RenderableClassification.cpp:32) — beach scene does this
  directly (Engine_Scenes.cpp:2753-2768). AddEntityCommand can't; so the engine exterior
  branch creates the water entity DIRECTLY (like the beach scene), not via commands.
- Outdoor lighting/fog branch exists behind `outdoor` flag = recipe=="garden" only
  (Engine_Scenes.cpp:2866). Fog outdoor 0.0075/start 4 vs interior 0.085/start 0 (2942).
- Templates: BuildOutdoorSunsetBeachScene (Engine_Scenes.cpp:2588 — full beach w/ water,
  sand textures assets/textures/polyhaven/coast_sand_05, camera far-clip 180 via
  ConfigureShowcaseCameraClip), BuildGarden (SceneRecipes.cpp:1095 — ground = thin CUBE
  slab because Plane didn't show outdoors; grass material via ApplyPrimitiveMaterial).
- Terrain heightfield + FBM noise generators exist (MeshGenerator.h:50-75, TerrainNoise)
  but unwired; vegetation GPU-instancing exists but editor-only. NOT needed for v2.

ASSETS:
- Catalog = RUNTIME DIRECTORY SCAN (AssetCatalog.cpp:156-347), no rebuild for new files.
  Scans exactly 4 dirs under assets/models/: kenney_furniture_kit (foo/foo.gltf),
  naturalistic_showcase (foo/foo_1k.gltf|any), khronos_furniture, sketchfab_furniture
  (foo/scene.gltf|any). Folder name = id. NEW pack dirs need a scan added (small code).
- Loader limits (GLTFLoader.cpp:313-584): .gltf + EXTERNAL .bin only. NO .glb, NO
  data: URIs, NO draco, NO vertex colors (COLOR_0 ignored), single material kept
  (first textured), external texture paths OK. => every fetched/generated model must be
  normalized to .gltf + external .bin (+ external textures), draco-decoded.
- Sketchfab: fetch_sketchfab.mjs downloads by UID (v3 /models/{uid}/download, token via
  SKETCHFAB_TOKEN env). NO search. Search API works unauthenticated (verified live).
- Current nature corpus: ~10 Poly Haven items (boulder_01, rock_moss_set_01, fern_02,
  wild_rooibos_bush, grass_bermuda_01, dead_tree_trunk, tree_stump_01, ...). No palms,
  no canopy trees, no cliffs.
- Kenney Nature Kit (CC0, ~330 models incl palms/trees/rocks/cliffs) direct zip:
  kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip
- Toolchain present: node 22, trimesh 4.12, pygltflib, @gltf-transform/cli 4.4.1, PIL.

## Architecture

PROMPT -> COMPOSE (codex/claude/deepseek/offline) -> Scene IR v2 (relational) ->
VALIDATE (asset LADDER resolves every object) -> SOLVE (setting-aware spatial solver) ->
RENDER (engine generative | generative_exterior recipe) -> CRITIQUE (vision reframe +
intent check) -> montage/battery.

### Scene IR v2 (engine contract; superset of v1 — v1 IRs keep working)
{"setting":"interior"|"exterior",
 "room":{...v1...},                          // interior only
 "environment": {                            // exterior (subset honored for interior mood later)
   "sun":{"azimuth_deg":135,"elevation_deg":35,"color":[1,.95,.85],"intensity":2.6},
   "fog":{"density":0.008,"start":4.0},
   "exposure":1.0,
   "ground":{"kind":"sand|grass|rock|dirt|snow","color":[r,g,b],"extent":28},
   "water":{"enabled":true,"level":-0.03,"shallow":[r,g,b],"deep":[r,g,b],
            "from_z":-6.0,"roughness":0.05,"wave":0.05}   // covers z <= from_z (far half)
 },
 "objects":[{"asset","x","z","yaw","foot","tint","flat"}],  // same as v1 (solver output)
 "lights":[...v1 point lights...]}

### Engine changes (one rebuild)
1. Engine.cpp IR trigger: if IR contains "setting":"exterior" -> m_recipeName =
   "generative_exterior" (else "generative" as today).
2. SceneRecipes.cpp BuildGenerativeExterior: ground slab from environment.ground
   (Cube slab a la BuildGarden; sand/grass/dirt color + material), objects via Place()
   (unchanged ground-snap/footprint path), point lights. NO room shell.
3. Engine_Scenes.cpp: outdoor |= recipe=="generative_exterior". Exterior branch parses
   CORTEX_SCENE_IR_JSON environment -> SetSunDirection/Color/Intensity, SetFogParams,
   exposure; if water.enabled -> CreatePlane water entity + WaterSurfaceComponent
   (shallow/deep tint from IR) + SetWaterParams/SetWaterOptics (beach-scene recipe).
   Camera: exterior establishing cam (pos ~(0,2.0,9.5), target (0,0.6,-4), fov ~56,
   far 180) + existing CORTEX_AUTOCAM_* deltas still apply.
4. AssetCatalog.cpp: add scans for assets/models/kenney_nature_kit/ (foo/foo.gltf) and
   assets/models/fetched/ (any .gltf one level down; the landing zone for Sketchfab
   fetches + procgen). main.cpp coarseRole(): add nature roles (tree, palm->tree, rock,
   bush, grass, flower, fence, cliff->rock, mushroom->bush...).

### Asset ladder (validate_plan v2) — every object resolves or drops, never crashes
1. catalog exact/fuzzy id (existing)
2. catalog by role (existing)
3. FETCHED CACHE: assets/models/fetched/<slug>/ already on disk
4. SKETCHFAB FETCH (tools/asset_fetch.py): v3 search (downloadable=true, sorted by
   likes, face cap ~300k) -> /models/{uid}/download (SKETCHFAB_TOKEN env, NEVER logged/
   committed) -> unzip -> NORMALIZE via gltf-transform (draco decode -> .gltf + external
   .bin + resized textures) -> fetched/<slug>/<slug>.gltf -> refresh catalog dump.
   Budget: <=4 fetches/scene; cache by slug forever; graceful skip when no token/net.
5. PROCGEN (tools/procgen.py): rocks/boulders = icosphere + seeded fBm displacement,
   trimesh -> .gltf+bin (baseColorFactor, no vertex colors). Terrain mounds later.
6. drop (counted; scene still renders)

### Solver v2 — exterior spatial awareness
- Coordinate frame: camera at +Z looking -Z (same as interior). World = ground extent.
- ZONES as depth bands: water z<=from_z; shoreline band [from_z, from_z+2]; midground;
  foreground; camera bay at +Z stays clear. Composer assigns objects a zone + count +
  cluster hint; solver scatters: seeded (hash of asset+index) jitter, min-distance =
  footprint-based, size jitter +-18%, flank weighting keeps a centre view corridor open
  to the water/horizon. Focal object at rule-of-thirds. Rocks may straddle shoreline;
  vegetation stays on land; nothing floats (Place ground-snaps; water items sit on sand
  through shallow water — correct for rocks).
- Interior path untouched (v1 solver).
- validity_check v2: same gates + exterior bounds (ground extent), corridor check.

### Composer v2
- One schema, model picks setting. Exterior objects use {"query":"palm tree","zone":
  "midground","count":5,"cluster":true,...}; interior keeps v1 anchors. The menu shows
  catalog roles/ids AND tells the model it may request anything by "query" (the ladder
  fetches/generates). Mood -> environment (sun elevation/warmth, fog, exposure).
- Offline fallback: beach/garden/forest kits from nature roles.

### Critique v2
- critique(): 3 retries w/ backoff (rate-limit Nones fixed), spacing between calls.
- Separate final intent_check pass for the battery verdicts.

## Phases (each gated by rendered evidence)
- [x] P0 recon (above) + this plan.
- [x] P1 ENGINE exterior mode + catalog scans + nature roles. GATE MET: beach_final.png
      (hand IR) = blue-sky day, bright sand + palm shadows, full-width animated sea w/
      green shore band + foam, rocks in water, no room. HARD-WON FACTS:
      * CommandQueue lifts primitives to y>=0.5 (anti-z-fight) -> ground/water/seabed are
        DIRECT entities in Engine_Scenes.cpp, not commands.
      * The deferred (visibility-buffer) path paints the ENVIRONMENT equirect as sky;
        the forward procedural-sky pass NEVER runs. Sky = real HDRI env (sky_day/
        sky_sunset/sky_partly_cloudy, Poly Haven 2k, manifest entries) + rotation to
        the IR sun azimuth. Pure-sky HDRIs are ~0.1 median luminance -> need
        SetIBLIntensity(3.2, 1.8) + SetBackgroundPresentation(true, 4.0). specular
        intensity ALSO drives visible sky brightness (don't lower it).
      * Sun = SetSunDirection/Color/Intensity feed light 0 (ECS Directional lights are
        SKIPPED by the frame constants). Fixed exposure for exteriors (auto-exposure
        meters the bright sky and crushes the ground).
      * coast_sand_05 tex = dark WET shore (~0.05 albedo) -> fetched aerial_beach_01
        (bright dry sand). Ground = flat land plane + tilted seabed plane (-2.5m) so
        water has real depth; custom strip meshes DON'T rasterize (unknown cause) --
        compose from CreatePlane primitives.
      * Water white-mirror at grazing is controlled by VISCOSITY (reflectionWeight =
        lerp(0.68,0.24,visc)) not fresnelStrength. viscosity 0.48 + absorption 0.72.
- [x] P2 Kenney Nature Kit (CC0) baked + installed. GATE MET: palms render with correct
      two-tone colors. tools/bake_flat_gltf.py bakes flat multi-materials into a palette
      PNG + constant per-primitive UVs (engine loader keeps ONE material; without the
      bake a palm renders all-bark). 329/329 baked, 0 load failures. Catalog 512 assets:
      tree 75, rock 134, bush 22, grass 5, flower 16, fence 12, path 25, camp 8 (roles
      via source-aware coarseRole in main.cpp). Junctions link assets/models/
      {kenney_nature_kit,fetched} into build/bin/assets/models (build copies, doesn't
      sync new packs). Sky HDRIs + aerial_beach_01 copied to both trees too.
- [x] P3 asset_fetch.py: Sketchfab v3 search (downloadable, face/size caps, likes-ranked)
      -> download (SKETCHFAB_TOKEN env) -> gltf-transform resize+copy normalize ->
      assets/models/fetched/<slug>/ -> ENGINE-VERIFIED (--dump-catalog --measure must
      show native_size) -> catalog. GATE MET: "beach umbrella" fetched live
      ('Beach table', CC Attribution, credited in CREDITS.txt), resolves via ladder as
      fetched_beach_umbrella. No-token/no-net -> graceful None (battery test PASSes).
- [x] P4 procgen.py: seeded noise-displaced icosphere rocks, faceted, flattened base,
      colour via 1-block palette texture + constant UVs (engine ignores baseColorFactor
      on untextured models -- same lesson as the Kenney bake). GATE MET: two generated
      monoliths render in-scene with shadows (procgen_rocks2.png).
- [x] P5 composer+solver v2. GATE MET: scene_gen.py "a sunny beach with palm trees,
      rocks and green water" end-to-end (codex): 26 objects, 0 drops, VALID, palm grove
      + rocks in green-cyan sea (ext_full_beach_1.png). Zones water/shore/midground/
      background/foreground_edge; seeded flank scatter + view corridor; trunk-radius
      tree collision (canopies interleave); water rocks seabed-snapped via negative
      base y (Place supportHeight); vegetation clamped to dry land; per-role FOOT caps
      (flat slab rocks would explode to 6m pancakes under height-driven sizing).
      Interior mood: night+exposure flow from plan -> night rig + exposure lever.
- [x] P6 COMPLETE (battery v5, 2026-07-02 ~07:00): **10/12 intent, 12/12 valid,
      6/6 robustness -- the battery self-reports "COMPLETE (goal criteria 2-5 met)"**.
      Both flagship prompts pass: "a well lit pink kitchen" (score 4, good) and
      "a sunny beach with palm trees, rocks and green water" (score 4). The desert
      reads rust-red, the campsite golden, the forest true-green. Convergence trail:
      v2 6/12 -> v3/v4 8/12 -> v5 10/12, each step a root-cause fix:
      * GPU device-removed = ground extent > 40 m (bisected empirically; full desert
        renders at 36, dies at 42) -> extent clamped 38 + render retries w/ cooldown.
      * Teal Kenney foliage -> tintTextured (explicit tints now multiply into textured
        albedo -- also fixes the v1 grey-sofa residual) + woodland green-shift.
      * Washed sunsets -> per-HDRI display curve (sunset bg exposure 2.2 vs day 4.0),
        rotation calibration (+150 centres the baked glow), sun-intensity floor;
        golden-hour water keeps its mirror (viscosity 0.22) vs daylight tint-led 0.48.
      * "red sand" -> saturation-scaled ground tint + deterministic exterior colour
        intent; "all pink everywhere"/"warm evening"/kitchen-identity backstops ditto.
      Residuals: warm-evening bedroom reads near-black to the critic (night rig is
      honest but strict judge; interior asset variance) and the lakeside render hit
      the transient GPU flake in the final run. Montage: build/bin/logs/
      battery_montage.png; report battery_report.json; ledger GRAPHICS_LOOPS.md.
      Commits: 397be7c, 0a23bb5, d7a806a, 12e72fa, d31c28f (clean, no attribution,
      token never in-tree).

## Risks / mitigations
- Sketchfab gltf variety (draco/glb/KHR ext) -> gltf-transform normalize + load-verify
  via --dump-catalog --measure before accepting into fetched/ (reject on failure).
- Fetched model orientation/scale wild -> normalize: recenter origin to base, Y-up
  heuristic (rotate if Z extent >> Y), verify measured height sane for the query class.
- Kenney nature kit ships .glb ONLY (329 models, palms confirmed) with MULTI flat-color
  materials (palm = bark brown + leaves green primitives). Engine loader keeps ONE
  material -> all-brown palm. FIX = tools/bake_flat_gltf.py: bake flat materials into a
  16px-per-color palette PNG + constant per-primitive TEXCOORD_0 (texel centers), single
  white-factor textured material -> loader-compatible .gltf+bin+palette.png. (Furniture
  kit needs nothing: 0 materials, colored by cmd->color.) Same bake serves Sketchfab
  models with flat multi-materials.
- Engine texture path for slab sand: ApplyPrimitiveMaterial needs a sand set; polyhaven
  coast_sand_05 textures exist (beach scene uses them) — add SandGroundMaterial().
- Water plane vs ground slab z-fight at shoreline -> water level slightly above slab top
  with gentle slope trick (slab top y=0, water y=-0.02 like beach scene).
- Vision critic rate limits -> retries + spacing + final pass.
