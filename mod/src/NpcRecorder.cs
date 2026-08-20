using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace FIHMapExport
{
    /// <summary>
    /// Writes down where the level's NPCs are, one press at a time.
    ///
    /// NPCs are not part of the level the way a checkpoint is: the game spawns them as you
    /// come near, so one scene dump only ever holds the two or three that happened to be
    /// loaded when it was taken - the map ended up with Beamer and the Microwaver and none
    /// of the other five. This merges into npcs.json instead of overwriting it, so walking
    /// the level and pressing the key at each NPC builds the full list across a session,
    /// or across as many sessions as it takes.
    /// </summary>
    internal static class NpcRecorder
    {
        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            WriteIndented = true
        };

        // A wide net, deliberately. The two NPCs we know are InteractableNPC_Phone and
        // InteractableNPC_Microwaver, but nothing promises the rest are named to match, and
        // a sighting that turns out to be scenery costs one line in a file - a missed one
        // costs another walk through the level. build-markers.mjs decides which of these
        // become markers; this only has to not miss anything.
        private const string Needle = "npc";

        // What an NPC is actually called, once the net has been cast.
        private const string NpcPrefix = "InteractableNPC_";

        public static void Run(Scene hostScene)
        {
            string file = Path.Combine(ExportPlugin.OutputDir.Value, "npcs.json");
            var known = Load(file);
            int before = known.Count;
            var found = new List<NpcSighting>();
            var npcs = new List<GameObject>();

            foreach (var scene in ScenesToWalk(hostScene))
            {
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (root == null) continue;

                    foreach (var transform in root.GetComponentsInChildren<Transform>(true))
                    {
                        if (transform == null) continue;
                        if (transform.name.IndexOf(Needle, StringComparison.OrdinalIgnoreCase) < 0) continue;

                        var sighting = Describe(transform, scene);
                        // Keyed by path, so the three TeleportTargetNPCs stay three things and
                        // a second sighting of one NPC refreshes it rather than piling up.
                        known[sighting.Path] = sighting;
                        found.Add(sighting);

                        // Only the real NPCs get their geometry taken: the wide net above also
                        // catches dialogue runners and empty teleport targets.
                        if (transform.name.StartsWith(NpcPrefix, StringComparison.Ordinal))
                        {
                            npcs.Add(transform.gameObject);
                        }
                    }
                }
            }

            Directory.CreateDirectory(ExportPlugin.OutputDir.Value);
            var dump = new NpcFile { RecordedAt = Now(), Sightings = new List<NpcSighting>(known.Values) };
            File.WriteAllText(file, JsonSerializer.Serialize(dump, Options));

            ExportPlugin.Logger.LogInfo(
                $"{found.Count} NPC-ish objects here, {known.Count - before} of them new "
                + $"({known.Count} recorded in total) -> {file}");

            WriteGeometry(npcs);

            foreach (var sighting in found)
            {
                ExportPlugin.Logger.LogInfo(
                    $"  {sighting.Name} at {sighting.Pos[0]:0.#}, {sighting.Pos[1]:0.#}, {sighting.Pos[2]:0.#} "
                    + $"[{sighting.Scene}] {sighting.Path}");
            }
        }

        /// <summary>
        /// What the NPCs draw, as a dump of its own.
        ///
        /// The level dump does not have it: all seven NPCs were in the hierarchy at once and
        /// the dump taken half a minute later held two, so whatever the full-scene walk does
        /// with them, it loses five. This takes their geometry straight off the objects the
        /// key just found, and tools/merge-dumps.mjs folds it into the level dump.
        /// </summary>
        private static void WriteGeometry(List<GameObject> npcs)
        {
            if (npcs.Count == 0) return;

            var dump = SceneDumper.Subtrees(SceneManager.GetActiveScene().name, npcs);

            string file = Path.Combine(ExportPlugin.OutputDir.Value, "npc-scene.json");
            File.WriteAllText(file, JsonSerializer.Serialize(dump, Options));

            ExportPlugin.Logger.LogInfo(
                $"{dump.Nodes.Count} nodes, {dump.Meshes.Count} meshes from {npcs.Count} NPCs "
                + $"({dump.Stats.Renderers} renderers seen, {dump.Stats.SkippedNoMesh} without a "
                + $"mesh) -> {file}");

            // Per NPC, because an empty one is the answer to why it is not on the map.
            foreach (var npc in npcs)
            {
                int nodes = 0;
                foreach (var node in dump.Nodes)
                {
                    if (node.Path.Contains(npc.name)) nodes++;
                }

                ExportPlugin.Logger.LogInfo($"  {npc.name}: {nodes} nodes");
            }
        }

        /// <summary>
        /// Every loaded scene, plus the one the plugin's own host sits in.
        ///
        /// That last one is how DontDestroyOnLoad objects are reached at all: Unity parks
        /// them in a scene SceneManager will not enumerate, and a networked NPC is exactly
        /// the kind of thing that lives there.
        /// </summary>
        private static IEnumerable<Scene> ScenesToWalk(Scene hostScene)
        {
            var seen = new HashSet<int>();

            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (scene.isLoaded && seen.Add(scene.handle)) yield return scene;
            }

            if (hostScene.IsValid() && hostScene.isLoaded && seen.Add(hostScene.handle)) yield return hostScene;
        }

        private static NpcSighting Describe(Transform transform, Scene scene)
        {
            return new NpcSighting
            {
                Name = transform.name,
                Path = HierarchyPath.Of(transform),
                Scene = scene.name,
                Pos = Vec(CentreOf(transform)),
                Active = transform.gameObject.activeInHierarchy,
                RecordedAt = Now()
            };
        }

        /// <summary>
        /// Where the character visually is: the middle of everything it draws.
        ///
        /// Not transform.position, which for these sits at the feet or wherever the prefab's
        /// origin happens to be, and these are not all phones - one of them is a plushie and
        /// another a Game Boy.
        /// </summary>
        private static Vector3 CentreOf(Transform transform)
        {
            var renderers = transform.GetComponentsInChildren<Renderer>(true);
            Bounds? bounds = null;

            foreach (var renderer in renderers)
            {
                if (renderer == null) continue;

                if (bounds == null) bounds = renderer.bounds;
                else
                {
                    var grown = bounds.Value;
                    grown.Encapsulate(renderer.bounds);
                    bounds = grown;
                }
            }

            return bounds?.center ?? transform.position;
        }

        private static Dictionary<string, NpcSighting> Load(string file)
        {
            var known = new Dictionary<string, NpcSighting>();
            if (!File.Exists(file)) return known;

            try
            {
                var previous = JsonSerializer.Deserialize<NpcFile>(File.ReadAllText(file));
                foreach (var sighting in previous?.Sightings ?? new List<NpcSighting>())
                {
                    if (!string.IsNullOrEmpty(sighting?.Path)) known[sighting.Path] = sighting;
                }
            }
            catch (Exception ex)
            {
                // Better to say so and keep recording than to lose the session over a file
                // somebody edited by hand.
                ExportPlugin.Logger.LogWarning($"Could not read {file}, starting a new list: {ex.Message}");
            }

            return known;
        }

        private static float[] Vec(Vector3 v) => new[] { v.x, v.y, v.z };

        private static string Now() => DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
    }
}
